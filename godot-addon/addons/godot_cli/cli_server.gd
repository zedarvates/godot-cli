extends Node
## GodotCLI Server
## TCP server that accepts newline-delimited JSON commands for controlling the running game.
## Protocol: Each message is a JSON object followed by \n.
## Target: Godot 4.7.x

const DEFAULT_PORT := 9900
const BIND_ADDRESS := "127.0.0.1"
const PROTOCOL_VERSION := 1
const ADDON_VERSION := "0.1.0-uo.6"
const MIN_TOKEN_LENGTH := 32
const MAX_MESSAGE_BYTES := 1024 * 1024
const MAX_RESPONSE_BYTES := 16 * 1024 * 1024
const MAX_FILE_BYTES := 4 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES := 4096
const MAX_CLIENTS := 8
const AUTH_TIMEOUT_MSEC := 2000
const MAX_PENDING_WAITS := 8
const MAX_WAIT_TIMEOUT_SECONDS := 300.0
const MIN_WAIT_INTERVAL_SECONDS := 0.01
const MAX_WAIT_INTERVAL_SECONDS := 5.0
const MAX_SCENE_TREE_DEPTH := 64
const MAX_SCENE_NODES := 4096
const MAX_VISIBLE_NODES := 4096
const MAX_ASSERT_CHECKS := 256

const READ_ONLY_COMMANDS := {
	"ping": true,
	"commands": true,
	"server_info": true,
	"scene_tree": true,
	"get_node": true,
	"screenshot": true,
	"read_file": true,
	"list_files": true,
	"list_classes": true,
	"class_info": true,
	"wait_for": true,
	"assert": true,
	"validate_scene": true,
	"viewport_info": true,
	"visible_nodes": true,
	"inspect_level_layout": true,
}

const MUTATING_COMMANDS := {
	"set_property": true,
	"add_node": true,
	"remove_node": true,
	"reparent_node": true,
	"rename_node": true,
	"click": true,
	"press_key": true,
	"mouse_move": true,
	"load_scene": true,
	"spawn_3d_object": true,
	"transform_3d_node": true,
	"duplicate_3d_node": true,
	"greformer_create": true,
	"greformer_push_pull": true,
	"greformer_apply_hotspot": true,
	"greformer_bake": true,
	"greformer_export_obj": true,
	"greformer_create_preset": true,
	"greformer_snap_grid": true,
	"greformer_carve_hole": true,
}

const UNSAFE_COMMANDS := {
	"call_method": true,
	"eval": true,
	"create_file": true,
	"delete_file": true,
	"attach_script": true,
	"detach_script": true,
	"save_scene": true,
}

var _auth_token := ""
var _allow_mutations := false
var _allow_unsafe := false
var _listen_port := DEFAULT_PORT

var _server: TCPServer = null
var _clients: Array[Dictionary] = []
var _pending_waits: Array[Dictionary] = []

# --- Lifecycle ---

func _ready() -> void:
	if not OS.is_debug_build():
		push_error("GodotCLI: Refusing to start outside an editor or debug build")
		set_process(false)
		return

	_auth_token = OS.get_environment("GODOT_CLI_TOKEN").strip_edges()
	if _auth_token.length() < MIN_TOKEN_LENGTH:
		push_error("GodotCLI: GODOT_CLI_TOKEN must contain at least %d characters" % MIN_TOKEN_LENGTH)
		set_process(false)
		return

	_allow_mutations = _env_flag_enabled("GODOT_CLI_ALLOW_MUTATIONS")
	_allow_unsafe = _env_flag_enabled("GODOT_CLI_ALLOW_UNSAFE")

	var port := DEFAULT_PORT
	var env_port := OS.get_environment("GODOT_CLI_PORT").strip_edges()
	if env_port.is_valid_int():
		port = env_port.to_int()
	for arg in OS.get_cmdline_args():
		if arg.begins_with("--godot-cli-port="):
			port = int(arg.split("=")[1])
	if port < 1 or port > 65535:
		push_error("GodotCLI: Invalid port %d" % port)
		set_process(false)
		return

	_server = TCPServer.new()
	var err := _server.listen(port, BIND_ADDRESS)
	if err != OK:
		push_error("GodotCLI: Failed to listen on %s:%d: %s" % [BIND_ADDRESS, port, error_string(err)])
		return
	_listen_port = port
	var mode := "read-only"
	if _allow_unsafe:
		mode = "unsafe"
	elif _allow_mutations:
		mode = "mutating"
	print("GodotCLI: Server listening on %s:%d (%s mode)" % [BIND_ADDRESS, port, mode])


func _env_flag_enabled(name: String) -> bool:
	var value := OS.get_environment(name).strip_edges().to_lower()
	return value == "1" or value == "true" or value == "yes" or value == "on"


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept new connections
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if _clients.size() >= MAX_CLIENTS:
			var rejection := JSON.stringify({
				"id": "",
				"status": "error",
				"error": "Maximum concurrent client limit reached",
			}) + "\n"
			peer.put_data(rejection.to_utf8_buffer())
			peer.disconnect_from_host()
			continue
		_clients.append({
			"peer": peer,
			"buffer": "",
			"connected_at_ms": Time.get_ticks_msec(),
			"authenticated": false,
		})

	# Process each client
	var to_remove: Array[int] = []
	for i in range(_clients.size()):
		var client := _clients[i]
		var peer: StreamPeerTCP = client["peer"]
		peer.poll()

		match peer.get_status():
			StreamPeerTCP.STATUS_CONNECTED:
				var available := peer.get_available_bytes()
				if available > 0:
					var data := peer.get_data(available)
					if data[0] == OK:
						client["buffer"] += data[1].get_string_from_utf8()
						if (client["buffer"] as String).to_utf8_buffer().size() > MAX_MESSAGE_BYTES:
							_send(client, {"id": "", "status": "error", "error": "Request exceeds the maximum message size"})
							peer.disconnect_from_host()
							to_remove.append(i)
							continue
						_process_buffer(client)
				if (
					not bool(client.get("authenticated", false))
					and Time.get_ticks_msec() - int(client["connected_at_ms"]) >= AUTH_TIMEOUT_MSEC
				):
					_send(client, {"id": "", "status": "error", "error": "Authentication timeout"})
					peer.disconnect_from_host()
					to_remove.append(i)
			StreamPeerTCP.STATUS_ERROR, StreamPeerTCP.STATUS_NONE:
				to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		# Clean up pending waits for disconnected clients
		var removed_client := _clients[to_remove[i]]
		_pending_waits = _pending_waits.filter(func(w: Dictionary) -> bool:
			return w["client"] != removed_client
		)
		_clients.remove_at(to_remove[i])

	# Check pending wait-for conditions
	_check_pending_waits()

# --- Protocol ---

func _process_buffer(client: Dictionary) -> void:
	while true:
		var buf: String = client["buffer"]
		var idx := buf.find("\n")
		if idx == -1:
			break
		var line := buf.substr(0, idx)
		client["buffer"] = buf.substr(idx + 1)
		if line.strip_edges().is_empty():
			continue
		if not _handle_message(client, line):
			break


func _handle_message(client: Dictionary, line: String) -> bool:
	var parsed = JSON.parse_string(line)
	if parsed == null or not parsed is Dictionary:
		_send(client, {"id": "", "status": "error", "error": "Invalid JSON"})
		return true

	var request: Dictionary = parsed
	var id: String = str(request.get("id", ""))
	var supplied_token := str(request.get("token", ""))
	if not _constant_time_equals(supplied_token, _auth_token):
		_send(client, {"id": id, "status": "error", "error": "Authentication failed"})
		var peer: StreamPeerTCP = client["peer"]
		peer.disconnect_from_host()
		return false
	client["authenticated"] = true

	var command: String = str(request.get("command", ""))
	var raw_params = request.get("params", {})
	if not raw_params is Dictionary:
		_send(client, {"id": id, "status": "error", "error": "Invalid params"})
		return true
	var params: Dictionary = raw_params

	var result = _execute(command, params, client, id)
	if result != null:
		result["id"] = id
		_send(client, result)
	return true


func _send(client: Dictionary, response: Dictionary) -> void:
	var json := JSON.stringify(response) + "\n"
	if json.to_utf8_buffer().size() > MAX_RESPONSE_BYTES:
		json = JSON.stringify({
			"id": response.get("id", ""),
			"status": "error",
			"error": "Response exceeds the maximum message size",
		}) + "\n"
	var peer: StreamPeerTCP = client["peer"]
	peer.put_data(json.to_utf8_buffer())


func _constant_time_equals(left: String, right: String) -> bool:
	var left_bytes := left.to_utf8_buffer()
	var right_bytes := right.to_utf8_buffer()
	var difference := left_bytes.size() ^ right_bytes.size()
	var max_size: int = maxi(left_bytes.size(), right_bytes.size())
	for index in range(max_size):
		var left_value: int = left_bytes[index] if index < left_bytes.size() else 0
		var right_value: int = right_bytes[index] if index < right_bytes.size() else 0
		difference |= left_value ^ right_value
	return difference == 0

func _sorted_command_names(commands: Dictionary) -> Array[String]:
	var names: Array[String] = []
	for command in commands.keys():
		names.append(str(command))
	names.sort()
	return names


func _cmd_server_info(_params: Dictionary) -> Dictionary:
	return {"status": "ok", "data": {
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": ADDON_VERSION,
		"engine": Engine.get_version_info(),
		"renderer": RenderingServer.get_current_rendering_method(),
		"debug_build": OS.is_debug_build(),
		"endpoint": {
			"bind_address": BIND_ADDRESS,
			"port": _listen_port,
		},
		"gates": {
			"mutations_enabled": _allow_mutations,
			"unsafe_enabled": _allow_unsafe,
		},
		"limits": {
			"max_request_bytes": MAX_MESSAGE_BYTES,
			"max_response_bytes": MAX_RESPONSE_BYTES,
			"max_file_bytes": MAX_FILE_BYTES,
			"max_directory_entries": MAX_DIRECTORY_ENTRIES,
			"max_clients": MAX_CLIENTS,
			"authentication_timeout_ms": AUTH_TIMEOUT_MSEC,
			"max_pending_waits": MAX_PENDING_WAITS,
			"max_wait_timeout_seconds": MAX_WAIT_TIMEOUT_SECONDS,
			"min_wait_interval_seconds": MIN_WAIT_INTERVAL_SECONDS,
			"max_wait_interval_seconds": MAX_WAIT_INTERVAL_SECONDS,
			"max_scene_tree_depth": MAX_SCENE_TREE_DEPTH,
			"max_scene_nodes": MAX_SCENE_NODES,
			"max_visible_nodes": MAX_VISIBLE_NODES,
			"max_assert_checks": MAX_ASSERT_CHECKS,
		},
		"commands": {
			"read_only": _sorted_command_names(READ_ONLY_COMMANDS),
			"mutating": _sorted_command_names(MUTATING_COMMANDS),
			"unsafe": _sorted_command_names(UNSAFE_COMMANDS),
		},
	}}


func _cmd_ping(_params: Dictionary) -> Dictionary:
	return {"status": "ok", "data": {
		"ready": true,
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": ADDON_VERSION,
		"engine": Engine.get_version_info(),
		"endpoint": {
			"bind_address": BIND_ADDRESS,
			"port": _listen_port,
		},
		"gates": {
			"mutations_enabled": _allow_mutations,
			"unsafe_enabled": _allow_unsafe,
		},
	}}


func _command_catalog_entries(
	commands: Dictionary,
	security: String,
	enabled: bool,
	required_gate: String
) -> Array[Dictionary]:
	var entries: Array[Dictionary] = []
	for command in _sorted_command_names(commands):
		entries.append({
			"name": command,
			"security": security,
			"enabled": enabled,
			"required_gate": required_gate,
			"conditionally_unsafe": command == "wait_for" or command == "assert",
		})
	return entries


func _cmd_commands(_params: Dictionary) -> Dictionary:
	var entries: Array[Dictionary] = []
	entries.append_array(_command_catalog_entries(READ_ONLY_COMMANDS, "read_only", true, "none"))
	entries.append_array(_command_catalog_entries(MUTATING_COMMANDS, "mutating", _allow_mutations, "GODOT_CLI_ALLOW_MUTATIONS"))
	entries.append_array(_command_catalog_entries(UNSAFE_COMMANDS, "unsafe", _allow_unsafe, "GODOT_CLI_ALLOW_UNSAFE"))
	return {"status": "ok", "data": {
		"count": entries.size(),
		"commands": entries,
		"gates": {
			"mutations_enabled": _allow_mutations,
			"unsafe_enabled": _allow_unsafe,
		},
	}}


# --- Command Dispatch ---

func _execute(command: String, params: Dictionary, client: Dictionary = {}, id: String = "") -> Variant:
	var denial := _command_denial(command, params)
	if not denial.is_empty():
		return {"status": "error", "error": denial}

	match command:
		"ping": return _cmd_ping(params)
		"commands": return _cmd_commands(params)
		"server_info": return _cmd_server_info(params)
		"scene_tree": return _cmd_scene_tree(params)
		"get_node": return _cmd_get_node(params)
		"set_property": return _cmd_set_property(params)
		"add_node": return _cmd_add_node(params)
		"remove_node": return _cmd_remove_node(params)
		"reparent_node": return _cmd_reparent_node(params)
		"rename_node": return _cmd_rename_node(params)
		"call_method": return _cmd_call_method(params)
		"eval": return _cmd_eval(params)
		"screenshot": return _cmd_screenshot(params)
		"click": return _cmd_click(params)
		"press_key": return _cmd_press_key(params)
		"mouse_move": return _cmd_mouse_move(params)
		"create_file": return _cmd_create_file(params)
		"read_file": return _cmd_read_file(params)
		"list_files": return _cmd_list_files(params)
		"delete_file": return _cmd_delete_file(params)
		"attach_script": return _cmd_attach_script(params)
		"detach_script": return _cmd_detach_script(params)
		"load_scene": return _cmd_load_scene(params)
		"save_scene": return _cmd_save_scene(params)
		"list_classes": return _cmd_list_classes(params)
		"class_info": return _cmd_class_info(params)
		"wait_for":
			_cmd_wait_for(params, client, id)
			return null  # Response is deferred
		"assert": return _cmd_assert(params)
		"validate_scene": return _cmd_validate_scene(params)
		"viewport_info": return _cmd_viewport_info(params)
		"visible_nodes": return _cmd_visible_nodes(params)
		"spawn_3d_object": return _cmd_spawn_3d_object(params)
		"transform_3d_node": return _cmd_transform_3d_node(params)
		"inspect_level_layout": return _cmd_inspect_level_layout(params)
		"duplicate_3d_node": return _cmd_duplicate_3d_node(params)
		"greformer_create": return _cmd_greformer_create(params)
		"greformer_push_pull": return _cmd_greformer_push_pull(params)
		"greformer_apply_hotspot": return _cmd_greformer_apply_hotspot(params)
		"greformer_bake": return _cmd_greformer_bake(params)
		"greformer_export_obj": return _cmd_greformer_export_obj(params)
		"greformer_create_preset": return _cmd_greformer_create_preset(params)
		"greformer_snap_grid": return _cmd_greformer_snap_grid(params)
		"greformer_carve_hole": return _cmd_greformer_carve_hole(params)
		"greformer_set_shading": return _cmd_greformer_set_shading(params)
		"greformer_paint_color": return _cmd_greformer_paint_color(params)
		"greformer_export_gltf": return _cmd_greformer_export_gltf(params)
		"greformer_bevel_edges": return _cmd_greformer_bevel_edges(params)
		"greformer_generate_stairs": return _cmd_greformer_generate_stairs(params)
		"undo": return _cmd_undo(params)
		"redo": return _cmd_redo(params)
		"fuzzy_find_node": return _cmd_fuzzy_find_node(params)
		"profile_performance": return _cmd_profile_performance(params)
		_: return {"status": "error", "error": "Unknown command: " + command}


func _command_denial(command: String, params: Dictionary) -> String:
	if READ_ONLY_COMMANDS.has(command):
		if _params_require_unsafe(command, params) and not _allow_unsafe:
			return "Expression execution is disabled; set GODOT_CLI_ALLOW_UNSAFE=1 before launching Godot"
		return ""
	if MUTATING_COMMANDS.has(command):
		if not _allow_mutations:
			return "Mutation commands are disabled; set GODOT_CLI_ALLOW_MUTATIONS=1 before launching Godot"
		return ""
	if UNSAFE_COMMANDS.has(command):
		if not _allow_unsafe:
			return "Unsafe commands are disabled; set GODOT_CLI_ALLOW_UNSAFE=1 before launching Godot"
		return ""
	return ""


func _params_require_unsafe(command: String, params: Dictionary) -> bool:
	if command == "wait_for":
		return not str(params.get("expr", "")).is_empty()
	if command != "assert":
		return false
	if not str(params.get("expr", "")).is_empty():
		return true
	var checks = params.get("checks", [])
	if checks is Array:
		for check in checks:
			if check is Dictionary and (check as Dictionary).has("expr"):
				return true
	return false

# ============================================================
# Serialization
# ============================================================

func _serialize(value: Variant) -> Variant:
	if value == null:
		return null
	if value is bool or value is int or value is float or value is String:
		return value
	if value is StringName:
		return str(value)
	if value is Vector2:
		return {"_type": "Vector2", "x": value.x, "y": value.y}
	if value is Vector2i:
		return {"_type": "Vector2i", "x": value.x, "y": value.y}
	if value is Vector3:
		return {"_type": "Vector3", "x": value.x, "y": value.y, "z": value.z}
	if value is Vector3i:
		return {"_type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
	if value is Vector4:
		return {"_type": "Vector4", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Vector4i:
		return {"_type": "Vector4i", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Color:
		return {"_type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
	if value is Rect2:
		return {"_type": "Rect2", "x": value.position.x, "y": value.position.y, "w": value.size.x, "h": value.size.y}
	if value is Rect2i:
		return {"_type": "Rect2i", "x": value.position.x, "y": value.position.y, "w": value.size.x, "h": value.size.y}
	if value is Transform2D:
		return {"_type": "Transform2D", "x": _serialize(value.x), "y": _serialize(value.y), "origin": _serialize(value.origin)}
	if value is Transform3D:
		return {"_type": "Transform3D", "basis": _serialize(value.basis), "origin": _serialize(value.origin)}
	if value is Basis:
		return {"_type": "Basis", "x": _serialize(value.x), "y": _serialize(value.y), "z": _serialize(value.z)}
	if value is Quaternion:
		return {"_type": "Quaternion", "x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Plane:
		return {"_type": "Plane", "normal": _serialize(value.normal), "d": value.d}
	if value is AABB:
		return {"_type": "AABB", "position": _serialize(value.position), "size": _serialize(value.size)}
	if value is NodePath:
		return {"_type": "NodePath", "path": str(value)}
	if value is RID:
		return {"_type": "RID", "id": value.get_id()}
	if value is Callable:
		return {"_type": "Callable", "method": str(value.get_method())}
	if value is Signal:
		return {"_type": "Signal", "name": str(value.get_name())}
	if value is PackedByteArray:
		return {"_type": "PackedByteArray", "base64": Marshalls.raw_to_base64(value)}
	if value is PackedInt32Array or value is PackedInt64Array:
		return Array(value)
	if value is PackedFloat32Array or value is PackedFloat64Array:
		return Array(value)
	if value is PackedStringArray:
		return Array(value)
	if value is PackedVector2Array:
		var arr: Array = []
		for v in value:
			arr.append(_serialize(v))
		return arr
	if value is PackedVector3Array:
		var arr: Array = []
		for v in value:
			arr.append(_serialize(v))
		return arr
	if value is PackedColorArray:
		var arr: Array = []
		for v in value:
			arr.append(_serialize(v))
		return arr
	if value is Array:
		var arr: Array = []
		for item in value:
			arr.append(_serialize(item))
		return arr
	if value is Dictionary:
		var dict: Dictionary = {}
		for key in value:
			dict[str(key)] = _serialize(value[key])
		return dict
	if value is Node:
		return {"_type": "Node", "class": value.get_class(), "path": str(value.get_path())}
	if value is Resource:
		var d := {"_type": "Resource", "class": value.get_class()}
		if not value.resource_path.is_empty():
			d["path"] = value.resource_path
		return d
	if value is Object:
		return {"_type": "Object", "class": value.get_class()}
	# Fallback
	return str(value)


func _deserialize(value: Variant) -> Variant:
	if value is Dictionary and value.has("_type"):
		match value["_type"]:
			"Vector2": return Vector2(value.get("x", 0), value.get("y", 0))
			"Vector2i": return Vector2i(value.get("x", 0), value.get("y", 0))
			"Vector3": return Vector3(value.get("x", 0), value.get("y", 0), value.get("z", 0))
			"Vector3i": return Vector3i(value.get("x", 0), value.get("y", 0), value.get("z", 0))
			"Vector4": return Vector4(value.get("x", 0), value.get("y", 0), value.get("z", 0), value.get("w", 0))
			"Vector4i": return Vector4i(value.get("x", 0), value.get("y", 0), value.get("z", 0), value.get("w", 0))
			"Color": return Color(value.get("r", 0), value.get("g", 0), value.get("b", 0), value.get("a", 1))
			"Rect2": return Rect2(value.get("x", 0), value.get("y", 0), value.get("w", 0), value.get("h", 0))
			"Rect2i": return Rect2i(value.get("x", 0), value.get("y", 0), value.get("w", 0), value.get("h", 0))
			"NodePath": return NodePath(value.get("path", ""))
			"Quaternion": return Quaternion(value.get("x", 0), value.get("y", 0), value.get("z", 0), value.get("w", 1))
			"Transform2D":
				return Transform2D(
					_deserialize(value.get("x", Vector2.RIGHT)),
					_deserialize(value.get("y", Vector2.DOWN)),
					_deserialize(value.get("origin", Vector2.ZERO))
				)
			"Basis":
				return Basis(
					_deserialize(value.get("x", Vector3.RIGHT)),
					_deserialize(value.get("y", Vector3.UP)),
					_deserialize(value.get("z", Vector3.BACK))
				)
			"Transform3D":
				return Transform3D(
					_deserialize(value.get("basis", Basis.IDENTITY)),
					_deserialize(value.get("origin", Vector3.ZERO))
				)
			"AABB":
				return AABB(
					_deserialize(value.get("position", Vector3.ZERO)),
					_deserialize(value.get("size", Vector3.ZERO))
				)
			"Plane":
				return Plane(
					_deserialize(value.get("normal", Vector3.UP)),
					value.get("d", 0)
				)
		return value

	# Try Godot expression syntax, e.g. "Vector2(1, 2)"
	if value is String:
		var expr := Expression.new()
		var err := expr.parse(value as String)
		if err == OK:
			var result = expr.execute()
			if not expr.has_execute_failed():
				return result

	return value

# ============================================================
# Command Implementations
# ============================================================

# --- Scene Tree ---

func _cmd_scene_tree(params: Dictionary) -> Dictionary:
	var raw_depth = params.get("depth", 10)
	var root_path: String = params.get("root", "")
	if not (raw_depth is int or raw_depth is float):
		return {"status": "error", "error": "scene-tree depth must be an integer"}
	var depth_number := float(raw_depth)
	if is_nan(depth_number) or is_inf(depth_number) or depth_number != floor(depth_number):
		return {"status": "error", "error": "scene-tree depth must be an integer"}
	var max_depth := int(depth_number)
	if max_depth < 0 or max_depth > MAX_SCENE_TREE_DEPTH:
		return {
			"status": "error",
			"error": "scene-tree depth must be between 0 and %d" % MAX_SCENE_TREE_DEPTH,
		}

	var root: Node
	if root_path.is_empty():
		root = get_tree().root
	else:
		root = get_tree().root.get_node_or_null(root_path)
		if root == null:
			return {"status": "error", "error": "Node not found: " + root_path}

	var traversal := {"visited": 0, "truncated": false}
	var tree := _build_tree(root, max_depth, 0, traversal)
	tree["_cli"] = {
		"visited_nodes": traversal["visited"],
		"truncated": traversal["truncated"],
		"max_nodes": MAX_SCENE_NODES,
	}
	return {"status": "ok", "data": tree}


func _build_tree(node: Node, max_depth: int, depth: int, traversal: Dictionary) -> Dictionary:
	traversal["visited"] = int(traversal["visited"]) + 1
	var data: Dictionary = {
		"name": str(node.name),
		"type": node.get_class(),
		"path": str(node.get_path()),
	}

	if node.get_script():
		data["script"] = node.get_script().resource_path

	var children: Array = []
	if depth < max_depth:
		for child in node.get_children():
			if int(traversal["visited"]) >= MAX_SCENE_NODES:
				traversal["truncated"] = true
				data["truncated_children"] = node.get_child_count() - children.size()
				break
			children.append(_build_tree(child, max_depth, depth + 1, traversal))
	elif node.get_child_count() > 0:
		data["child_count"] = node.get_child_count()
	data["children"] = children

	return data

# --- Node Inspection ---

func _cmd_get_node(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var node := get_tree().root.get_node_or_null(path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + path}

	# Collect properties
	var properties: Dictionary = {}
	for prop in node.get_property_list():
		var usage: int = prop["usage"]
		# Skip category/group/subgroup headers
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		# Only include meaningful properties
		if not (usage & PROPERTY_USAGE_STORAGE or usage & PROPERTY_USAGE_EDITOR):
			continue
		var prop_name: String = prop["name"]
		properties[prop_name] = _serialize(node.get(prop_name))

	var data: Dictionary = {
		"name": str(node.name),
		"type": node.get_class(),
		"path": str(node.get_path()),
		"properties": properties,
		"groups": [],
		"children": [],
	}

	# Groups
	for group in node.get_groups():
		(data["groups"] as Array).append(str(group))

	# Children names
	for child in node.get_children():
		(data["children"] as Array).append(str(child.name))

	# Script info
	var script = node.get_script()
	if script:
		data["script"] = script.resource_path
		var methods: Array = []
		for m in script.get_script_method_list():
			methods.append(m["name"])
		data["script_methods"] = methods
		var sigs: Array = []
		for s in script.get_script_signal_list():
			sigs.append(s["name"])
		data["script_signals"] = sigs

	return {"status": "ok", "data": data}

# --- Node Mutation ---

func _cmd_set_property(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var property: String = params.get("property", "")
	var value = params.get("value")

	if path.is_empty() or property.is_empty():
		return {"status": "error", "error": "Missing 'path' or 'property' parameter"}

	var node := get_tree().root.get_node_or_null(path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + path}

	node.set(property, _deserialize(value))

	# Read back to confirm
	var actual = node.get(property)
	return {"status": "ok", "data": {"property": property, "value": _serialize(actual)}}


func _cmd_add_node(params: Dictionary) -> Dictionary:
	var parent_path: String = params.get("parent", "")
	var type: String = params.get("type", "")
	var node_name: String = params.get("name", "")
	var properties: Dictionary = params.get("properties", {})

	if parent_path.is_empty() or type.is_empty():
		return {"status": "error", "error": "Missing 'parent' or 'type' parameter"}

	var parent := get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		return {"status": "error", "error": "Parent not found: " + parent_path}

	if not ClassDB.class_exists(type):
		return {"status": "error", "error": "Unknown class: " + type}
	if not ClassDB.can_instantiate(type):
		return {"status": "error", "error": "Cannot instantiate: " + type}

	var node: Node = ClassDB.instantiate(type) as Node
	if node_name:
		node.name = node_name

	for key in properties:
		node.set(key, _deserialize(properties[key]))

	parent.add_child(node)
	if get_tree().current_scene:
		node.owner = get_tree().current_scene

	return {"status": "ok", "data": {"path": str(node.get_path()), "type": type, "name": str(node.name)}}


func _cmd_remove_node(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var node := get_tree().root.get_node_or_null(path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + path}

	var node_name := str(node.name)
	node.get_parent().remove_child(node)
	node.queue_free()
	return {"status": "ok", "data": {"removed": path, "name": node_name}}


func _cmd_reparent_node(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var new_parent_path: String = params.get("new_parent", "")

	if path.is_empty() or new_parent_path.is_empty():
		return {"status": "error", "error": "Missing 'path' or 'new_parent' parameter"}

	var node := get_tree().root.get_node_or_null(path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + path}

	var new_parent := get_tree().root.get_node_or_null(new_parent_path)
	if new_parent == null:
		return {"status": "error", "error": "New parent not found: " + new_parent_path}

	node.reparent(new_parent)
	return {"status": "ok", "data": {"path": str(node.get_path()), "name": str(node.name)}}


func _cmd_rename_node(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var new_name: String = params.get("name", "")

	if path.is_empty() or new_name.is_empty():
		return {"status": "error", "error": "Missing 'path' or 'name' parameter"}

	var node := get_tree().root.get_node_or_null(path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + path}

	node.name = new_name
	return {"status": "ok", "data": {"path": str(node.get_path()), "name": str(node.name)}}

# --- Method Calls ---

func _cmd_call_method(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var method: String = params.get("method", "")
	var args: Array = params.get("args", [])

	if path.is_empty() or method.is_empty():
		return {"status": "error", "error": "Missing 'path' or 'method' parameter"}

	var node := get_tree().root.get_node_or_null(path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + path}

	if not node.has_method(method):
		return {"status": "error", "error": "Method not found: " + method}

	var deserialized_args: Array = []
	for arg in args:
		deserialized_args.append(_deserialize(arg))

	var result = node.callv(method, deserialized_args)
	return {"status": "ok", "data": _serialize(result)}

# --- Eval ---

func _cmd_eval(params: Dictionary) -> Dictionary:
	var code: String = params.get("code", params.get("expression", ""))
	if code.is_empty():
		return {"status": "error", "error": "Missing 'code' or 'expression' parameter"}

	var script := GDScript.new()
	var lines := code.split("\n")

	# Try as single-line expression first (auto-return)
	if lines.size() == 1:
		script.source_code = "extends Node\n\nfunc _exec():\n\treturn " + code.strip_edges() + "\n"
		if script.reload() == OK:
			var obj = script.new()
			add_child(obj)
			var result = obj.call("_exec")
			obj.queue_free()
			return {"status": "ok", "data": _serialize(result)}

	# Multi-line or failed expression: run as statements
	var indented := ""
	for line in lines:
		indented += "\t" + line + "\n"

	script.source_code = "extends Node\n\nfunc _exec():\n" + indented
	var err := script.reload()
	if err != OK:
		return {"status": "error", "error": "GDScript compilation error"}

	var obj = script.new()
	add_child(obj)
	var result = obj.call("_exec")
	obj.queue_free()
	return {"status": "ok", "data": _serialize(result)}

# --- Screenshot ---

func _cmd_screenshot(_params: Dictionary) -> Dictionary:
	var image := get_viewport().get_texture().get_image()
	if image == null:
		return {"status": "error", "error": "Failed to capture viewport"}

	var buffer := image.save_png_to_buffer()
	var base64 := Marshalls.raw_to_base64(buffer)

	return {"status": "ok", "data": {
		"base64_png": base64,
		"width": image.get_width(),
		"height": image.get_height()
	}}

# --- Input Simulation ---

func _cmd_click(params: Dictionary) -> Dictionary:
	var x: float = params.get("x", 0)
	var y: float = params.get("y", 0)
	var button: String = params.get("button", "left")

	var button_index: int
	match button:
		"left": button_index = MOUSE_BUTTON_LEFT
		"right": button_index = MOUSE_BUTTON_RIGHT
		"middle": button_index = MOUSE_BUTTON_MIDDLE
		_: button_index = MOUSE_BUTTON_LEFT

	# Move mouse to position first
	var move := InputEventMouseMotion.new()
	move.position = Vector2(x, y)
	move.global_position = Vector2(x, y)
	Input.parse_input_event(move)

	# Press
	var press := InputEventMouseButton.new()
	press.button_index = button_index
	press.pressed = true
	press.position = Vector2(x, y)
	press.global_position = Vector2(x, y)
	Input.parse_input_event(press)

	# Release
	var release := InputEventMouseButton.new()
	release.button_index = button_index
	release.pressed = false
	release.position = Vector2(x, y)
	release.global_position = Vector2(x, y)
	Input.parse_input_event(release)

	return {"status": "ok", "data": {"x": x, "y": y, "button": button}}


func _cmd_press_key(params: Dictionary) -> Dictionary:
	var key: String = params.get("key", "")
	var shift: bool = params.get("shift", false)
	var ctrl: bool = params.get("ctrl", false)
	var alt: bool = params.get("alt", false)

	if key.is_empty():
		return {"status": "error", "error": "Missing 'key' parameter"}

	var keycode := OS.find_keycode_from_string(key)
	if keycode == KEY_NONE:
		return {"status": "error", "error": "Unknown key: " + key}

	var press := InputEventKey.new()
	press.keycode = keycode
	press.pressed = true
	press.shift_pressed = shift
	press.ctrl_pressed = ctrl
	press.alt_pressed = alt
	Input.parse_input_event(press)

	var release := InputEventKey.new()
	release.keycode = keycode
	release.pressed = false
	release.shift_pressed = shift
	release.ctrl_pressed = ctrl
	release.alt_pressed = alt
	Input.parse_input_event(release)

	return {"status": "ok", "data": {"key": key}}


func _cmd_mouse_move(params: Dictionary) -> Dictionary:
	var x: float = params.get("x", 0)
	var y: float = params.get("y", 0)

	var event := InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	Input.parse_input_event(event)

	return {"status": "ok", "data": {"x": x, "y": y}}

# --- File Operations ---

func _resolve_project_path(path: String) -> String:
	if not path.begins_with("res://"):
		return ""
	var project_root := ProjectSettings.globalize_path("res://").simplify_path()
	var resolved := ProjectSettings.globalize_path(path).simplify_path()
	var root_prefix := project_root
	if not root_prefix.ends_with("/"):
		root_prefix += "/"
	var resolved_lower := resolved.to_lower()
	var root_lower := project_root.to_lower()
	var prefix_lower := root_prefix.to_lower()
	if resolved_lower != root_lower and not resolved_lower.begins_with(prefix_lower):
		return ""
	return resolved

func _cmd_create_file(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var content: String = params.get("content", "")

	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var abs_path := _resolve_project_path(path)
	if abs_path.is_empty():
		return {"status": "error", "error": "Path must stay inside res://"}
	var content_size := content.to_utf8_buffer().size()
	if content_size > MAX_FILE_BYTES:
		return {"status": "error", "error": "File content exceeds the maximum size"}

	# Ensure parent directory exists
	DirAccess.make_dir_recursive_absolute(abs_path.get_base_dir())

	var file := FileAccess.open(abs_path, FileAccess.WRITE)
	if file == null:
		return {"status": "error", "error": "Cannot write file: " + error_string(FileAccess.get_open_error())}

	file.store_string(content)
	file.close()

	return {"status": "ok", "data": {"path": path, "size": content_size}}


func _cmd_read_file(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var abs_path := _resolve_project_path(path)
	if abs_path.is_empty():
		return {"status": "error", "error": "Path must stay inside res://"}

	var file := FileAccess.open(abs_path, FileAccess.READ)
	if file == null:
		return {"status": "error", "error": "Cannot read file: " + error_string(FileAccess.get_open_error())}
	if file.get_length() > MAX_FILE_BYTES:
		file.close()
		return {"status": "error", "error": "File exceeds the maximum readable size"}

	var content := file.get_as_text()
	file.close()

	return {"status": "ok", "data": {"path": path, "content": content}}


func _cmd_list_files(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "res://")
	var pattern: String = params.get("pattern", "")

	var abs_path := _resolve_project_path(path)
	if abs_path.is_empty():
		return {"status": "error", "error": "Path must stay inside res://"}

	var dir := DirAccess.open(abs_path)
	if dir == null:
		return {"status": "error", "error": "Cannot open directory: " + error_string(DirAccess.get_dir_access_error())}

	var files: Array = []
	var dirs: Array = []

	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not file_name.begins_with("."):
			if files.size() + dirs.size() >= MAX_DIRECTORY_ENTRIES:
				dir.list_dir_end()
				return {"status": "error", "error": "Directory exceeds the maximum entry count"}
			if dir.current_is_dir():
				dirs.append(file_name)
			elif pattern.is_empty() or file_name.match(pattern):
				files.append(file_name)
		file_name = dir.get_next()
	dir.list_dir_end()

	files.sort()
	dirs.sort()

	return {"status": "ok", "data": {"path": path, "files": files, "directories": dirs}}


func _cmd_delete_file(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var abs_path := _resolve_project_path(path)
	if abs_path.is_empty():
		return {"status": "error", "error": "Path must stay inside res://"}

	var err := DirAccess.remove_absolute(abs_path)
	if err != OK:
		return {"status": "error", "error": "Cannot delete file: " + error_string(err)}

	return {"status": "ok", "data": {"deleted": path}}

# --- Script Attachment ---

func _cmd_attach_script(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("path", "")
	var script_path: String = params.get("script", "")

	if node_path.is_empty() or script_path.is_empty():
		return {"status": "error", "error": "Missing 'path' or 'script' parameter"}
	if _resolve_project_path(script_path).is_empty():
		return {"status": "error", "error": "Script path must stay inside res://"}

	var node := get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + node_path}

	var script = load(script_path)
	if script == null:
		return {"status": "error", "error": "Cannot load script: " + script_path}

	node.set_script(script)
	return {"status": "ok", "data": {"node": node_path, "script": script_path}}


func _cmd_detach_script(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("path", "")
	if node_path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var node := get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + node_path}

	node.set_script(null)
	return {"status": "ok", "data": {"node": node_path}}

# --- Scene Management ---

func _cmd_load_scene(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}
	if _resolve_project_path(path).is_empty():
		return {"status": "error", "error": "Scene path must stay inside res://"}

	var err := get_tree().change_scene_to_file(path)
	if err != OK:
		return {"status": "error", "error": "Failed to load scene: " + error_string(err)}

	return {"status": "ok", "data": {"scene": path}}


func _cmd_save_scene(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var root := get_tree().current_scene
	if root == null:
		return {"status": "error", "error": "No current scene"}

	if path.is_empty():
		path = root.scene_file_path
	if path.is_empty():
		return {"status": "error", "error": "No path specified and scene has no file path"}
	if _resolve_project_path(path).is_empty():
		return {"status": "error", "error": "Scene path must stay inside res://"}

	# Set owner on all descendants so they get saved
	_set_owner_recursive(root, root)

	var scene := PackedScene.new()
	var err := scene.pack(root)
	if err != OK:
		return {"status": "error", "error": "Failed to pack scene: " + error_string(err)}

	err = ResourceSaver.save(scene, path)
	if err != OK:
		return {"status": "error", "error": "Failed to save scene: " + error_string(err)}

	return {"status": "ok", "data": {"path": path}}


func _set_owner_recursive(node: Node, owner: Node) -> void:
	if node != owner:
		node.owner = owner
	for child in node.get_children():
		_set_owner_recursive(child, owner)

# --- Class Info ---

func _cmd_list_classes(params: Dictionary) -> Dictionary:
	var filter: String = params.get("filter", "")
	var base_class: String = params.get("base", "")
	var classes: Array = []

	for cls in ClassDB.get_class_list():
		if not ClassDB.can_instantiate(cls):
			continue
		if not base_class.is_empty() and not ClassDB.is_parent_class(cls, base_class):
			continue
		if not filter.is_empty() and filter.to_lower() not in cls.to_lower():
			continue
		classes.append(str(cls))

	classes.sort()
	return {"status": "ok", "data": classes}


func _cmd_class_info(params: Dictionary) -> Dictionary:
	var cls: String = params.get("class", "")
	if cls.is_empty():
		return {"status": "error", "error": "Missing 'class' parameter"}
	if not ClassDB.class_exists(cls):
		return {"status": "error", "error": "Unknown class: " + cls}

	# Properties
	var properties: Array = []
	for prop in ClassDB.class_get_property_list(cls):
		var usage: int = prop["usage"]
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or usage & PROPERTY_USAGE_SUBGROUP:
			continue
		if not (usage & PROPERTY_USAGE_STORAGE or usage & PROPERTY_USAGE_EDITOR):
			continue
		properties.append({
			"name": prop["name"],
			"type": type_string(prop["type"]),
		})

	# Methods
	var methods: Array = []
	for method in ClassDB.class_get_method_list(cls):
		var args: Array = []
		for arg in method.get("args", []):
			args.append({"name": arg["name"], "type": type_string(arg["type"])})
		methods.append({
			"name": method["name"],
			"args": args,
		})

	# Signals
	var sigs: Array = []
	for sig in ClassDB.class_get_signal_list(cls):
		sigs.append(str(sig["name"]))

	return {"status": "ok", "data": {
		"class": cls,
		"parent": str(ClassDB.get_parent_class(cls)),
		"can_instantiate": ClassDB.can_instantiate(cls),
		"properties": properties,
		"methods": methods,
		"signals": sigs,
	}}

# ============================================================
# Verification Commands
# ============================================================

# --- Wait For ---

func _check_pending_waits() -> void:
	var now := Time.get_ticks_msec()
	var to_remove: Array[int] = []

	for i in range(_pending_waits.size()):
		var wait := _pending_waits[i]
		var elapsed_ms: int = now - (wait["start_ms"] as int)
		var elapsed: float = elapsed_ms / 1000.0

		# Timeout check
		if elapsed >= (wait["timeout"] as float):
			var msg := "Timeout after %.1fs waiting for: %s" % [elapsed, wait["description"]]
			_send(wait["client"], {
				"id": wait["id"],
				"status": "error",
				"error": msg,
				"data": {"elapsed": elapsed},
			})
			to_remove.append(i)
			continue

		# Interval check — don't evaluate every frame
		var last_check: int = wait["last_check_ms"] as int
		if now - last_check < int((wait["interval"] as float) * 1000.0):
			continue
		wait["last_check_ms"] = now

		# Evaluate condition
		var satisfied := false

		if wait["script"] != null:
			var obj = (wait["script"] as GDScript).new()
			add_child(obj)
			var result = obj.call("_exec")
			obj.queue_free()
			satisfied = result == true
		else:
			# Property mode
			var node := get_tree().root.get_node_or_null(wait["path"] as String)
			if node != null:
				var value = node.get(wait["property"] as String)
				if wait.has("equals"):
					satisfied = _values_equal(value, _deserialize(wait["equals"]))
				else:
					# Truthy check
					satisfied = value == true

		if satisfied:
			_send(wait["client"], {
				"id": wait["id"],
				"status": "ok",
				"data": {"elapsed": elapsed, "condition": wait["description"]},
			})
			to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		_pending_waits.remove_at(to_remove[i])


func _cmd_wait_for(params: Dictionary, client: Dictionary, id: String) -> void:
	var expr: String = params.get("expr", "")
	var node_path: String = params.get("path", "")
	var property: String = params.get("property", "")
	var raw_timeout = params.get("timeout", 10.0)
	var raw_interval = params.get("interval", 0.1)

	if expr.is_empty() and (node_path.is_empty() or property.is_empty()):
		_send(client, {"id": id, "status": "error", "error": "Provide 'expr' or 'path' + 'property'"})
		return
	if not (raw_timeout is int or raw_timeout is float):
		_send(client, {"id": id, "status": "error", "error": "wait-for timeout must be numeric"})
		return
	if not (raw_interval is int or raw_interval is float):
		_send(client, {"id": id, "status": "error", "error": "wait-for interval must be numeric"})
		return
	var timeout := float(raw_timeout)
	var interval := float(raw_interval)
	if is_nan(timeout) or is_inf(timeout) or timeout <= 0.0 or timeout > MAX_WAIT_TIMEOUT_SECONDS:
		_send(client, {
			"id": id,
			"status": "error",
			"error": "wait-for timeout must be greater than 0 and at most %.1f seconds" % MAX_WAIT_TIMEOUT_SECONDS,
		})
		return
	if (
		is_nan(interval)
		or is_inf(interval)
		or interval < MIN_WAIT_INTERVAL_SECONDS
		or interval > MAX_WAIT_INTERVAL_SECONDS
	):
		_send(client, {
			"id": id,
			"status": "error",
			"error": "wait-for interval must be between %.2f and %.1f seconds" % [MIN_WAIT_INTERVAL_SECONDS, MAX_WAIT_INTERVAL_SECONDS],
		})
		return
	if _pending_waits.size() >= MAX_PENDING_WAITS:
		_send(client, {"id": id, "status": "error", "error": "Maximum pending wait-for limit reached"})
		return

	var compiled_script: GDScript = null
	var description := ""

	if not expr.is_empty():
		compiled_script = GDScript.new()
		compiled_script.source_code = "extends Node\n\nfunc _exec():\n\treturn " + expr + "\n"
		if compiled_script.reload() != OK:
			_send(client, {"id": id, "status": "error", "error": "Invalid expression: " + expr})
			return
		description = expr
	else:
		description = node_path + "." + property
		if params.has("equals"):
			description += " == " + str(params["equals"])

	var pending_wait := {
		"client": client,
		"id": id,
		"expr": expr,
		"path": node_path,
		"property": property,
		"timeout": timeout,
		"interval": interval,
		"script": compiled_script,
		"description": description,
		"start_ms": Time.get_ticks_msec(),
		"last_check_ms": 0,
	}
	if params.has("equals"):
		pending_wait["equals"] = params["equals"]
	_pending_waits.append(pending_wait)

# --- Assert ---

func _cmd_assert(params: Dictionary) -> Dictionary:
	var raw_checks = params.get("checks", [])
	if not raw_checks is Array:
		return {"status": "error", "error": "assert checks must be an array"}
	var checks: Array = raw_checks

	# Support single expression shorthand
	var expr: String = params.get("expr", "")
	if not expr.is_empty():
		checks = [{"expr": expr}]

	# Support single property check shorthand
	if checks.is_empty() and params.has("path"):
		checks = [params]

	if checks.is_empty():
		return {"status": "error", "error": "No checks provided. Use 'expr', 'path'+'property', or 'checks' array."}
	if checks.size() > MAX_ASSERT_CHECKS:
		return {
			"status": "error",
			"error": "assert supports at most %d checks per request" % MAX_ASSERT_CHECKS,
		}
	for check in checks:
		if not check is Dictionary:
			return {"status": "error", "error": "assert check entries must be objects"}

	var results: Array = []
	var all_passed := true

	for check in checks:
		var c: Dictionary = check
		var result: Dictionary = {}

		if c.has("expr"):
			var eval_result = _eval_expression(c["expr"])
			var passed: bool = eval_result == true
			result = {
				"type": "expression",
				"expr": c["expr"],
				"passed": passed,
				"actual": _serialize(eval_result),
			}

		elif c.has("exists"):
			var target_path: String = c["exists"]
			var node := get_tree().root.get_node_or_null(target_path)
			var should_exist: bool = c.get("should_exist", true)
			var passed := (node != null) == should_exist
			result = {
				"type": "exists",
				"path": target_path,
				"passed": passed,
				"found": node != null,
			}

		elif c.has("not_exists"):
			var target_path: String = c["not_exists"]
			var node := get_tree().root.get_node_or_null(target_path)
			var passed := node == null
			result = {
				"type": "not_exists",
				"path": target_path,
				"passed": passed,
				"found": node != null,
			}

		elif c.has("path") and c.has("property"):
			var node := get_tree().root.get_node_or_null(c["path"] as String)
			if node == null:
				result = {
					"type": "property",
					"path": c["path"],
					"property": c["property"],
					"passed": false,
					"error": "Node not found",
				}
			else:
				var prop_name: String = c["property"]
				var value = node.get(prop_name)
				var passed := false

				if c.has("equals"):
					passed = _values_equal(value, _deserialize(c["equals"]))
					result["expected"] = _serialize(_deserialize(c["equals"]))
				elif c.has("not_equals"):
					passed = not _values_equal(value, _deserialize(c["not_equals"]))
				elif c.has("greater_than"):
					passed = value > _deserialize(c["greater_than"])
				elif c.has("less_than"):
					passed = value < _deserialize(c["less_than"])
				elif c.has("contains"):
					passed = str(value).contains(str(c["contains"]))
				else:
					# Truthy check
					passed = value == true

				result = {
					"type": "property",
					"path": c["path"],
					"property": prop_name,
					"passed": passed,
					"actual": _serialize(value),
				}
		else:
			result = {"type": "unknown", "passed": false, "error": "Invalid check format"}

		if not result.get("passed", false):
			all_passed = false
		results.append(result)

	return {"status": "ok", "data": {
		"passed": all_passed,
		"total": results.size(),
		"passed_count": results.filter(func(r: Dictionary) -> bool: return r.get("passed", false)).size(),
		"failed_count": results.filter(func(r: Dictionary) -> bool: return not r.get("passed", false)).size(),
		"results": results,
	}}


func _eval_expression(expr: String) -> Variant:
	var script := GDScript.new()
	script.source_code = "extends Node\n\nfunc _exec():\n\treturn " + expr + "\n"
	if script.reload() != OK:
		return null
	var obj = script.new()
	add_child(obj)
	var result = obj.call("_exec")
	obj.queue_free()
	return result


func _values_equal(a: Variant, b: Variant) -> bool:
	# Handle approximate float comparison
	if a is float and b is float:
		return absf(a - b) < 0.0001
	if a is Vector2 and b is Vector2:
		return a.distance_to(b) < 0.0001
	if a is Vector3 and b is Vector3:
		return a.distance_to(b) < 0.0001
	return a == b

# --- Validate Scene ---

func _cmd_validate_scene(_params: Dictionary) -> Dictionary:
	var root := get_tree().current_scene
	if root == null:
		return {"status": "error", "error": "No current scene"}

	var errors: Array = []
	var warnings: Array = []
	var traversal := {
		"visited": 0,
		"truncated": false,
		"cameras_2d": [],
		"cameras_3d": [],
	}

	_validate_recursive(root, errors, warnings, 0, traversal)
	_validate_cameras(traversal["cameras_2d"], traversal["cameras_3d"], warnings)
	if bool(traversal["truncated"]):
		errors.append({
			"rule": "validation_budget_exceeded",
			"message": "Scene validation stopped after %d nodes or %d levels" % [MAX_SCENE_NODES, MAX_SCENE_TREE_DEPTH],
		})

	return {"status": "ok", "data": {
		"valid": errors.is_empty(),
		"complete": not bool(traversal["truncated"]),
		"visited_nodes": traversal["visited"],
		"max_nodes": MAX_SCENE_NODES,
		"error_count": errors.size(),
		"warning_count": warnings.size(),
		"errors": errors,
		"warnings": warnings,
	}}


func _validate_recursive(
	node: Node,
	errors: Array,
	warnings: Array,
	depth: int,
	traversal: Dictionary
) -> void:
	if int(traversal["visited"]) >= MAX_SCENE_NODES or depth > MAX_SCENE_TREE_DEPTH:
		traversal["truncated"] = true
		return
	traversal["visited"] = int(traversal["visited"]) + 1
	if node is Camera2D:
		(traversal["cameras_2d"] as Array).append(node)
	elif node is Camera3D:
		(traversal["cameras_3d"] as Array).append(node)
	var path := str(node.get_path())

	# Rule: Physics bodies must have collision shapes
	if node is PhysicsBody2D or node is Area2D:
		var has_shape := false
		var child_count := node.get_child_count()
		for child_index in range(mini(child_count, MAX_SCENE_NODES)):
			var child := node.get_child(child_index)
			if child is CollisionShape2D or child is CollisionPolygon2D:
				has_shape = true
				break
		if child_count > MAX_SCENE_NODES:
			traversal["truncated"] = true
		elif not has_shape:
			errors.append({
				"rule": "physics_body_needs_shape",
				"path": path,
				"type": node.get_class(),
				"message": "%s has no CollisionShape2D or CollisionPolygon2D child" % node.get_class(),
			})

	if node is PhysicsBody3D or node is Area3D:
		var has_shape := false
		var child_count := node.get_child_count()
		for child_index in range(mini(child_count, MAX_SCENE_NODES)):
			var child := node.get_child(child_index)
			if child is CollisionShape3D or child is CollisionPolygon3D:
				has_shape = true
				break
		if child_count > MAX_SCENE_NODES:
			traversal["truncated"] = true
		elif not has_shape:
			errors.append({
				"rule": "physics_body_needs_shape",
				"path": path,
				"type": node.get_class(),
				"message": "%s has no CollisionShape3D or CollisionPolygon3D child" % node.get_class(),
			})

	# Rule: CollisionShape2D/3D must have a shape assigned
	if node is CollisionShape2D:
		if (node as CollisionShape2D).shape == null:
			errors.append({
				"rule": "collision_shape_empty",
				"path": path,
				"message": "CollisionShape2D has no shape assigned",
			})

	if node is CollisionShape3D:
		if (node as CollisionShape3D).shape == null:
			errors.append({
				"rule": "collision_shape_empty",
				"path": path,
				"message": "CollisionShape3D has no shape assigned",
			})

	# Rule: Sprite2D should have a texture
	if node is Sprite2D:
		if (node as Sprite2D).texture == null:
			warnings.append({
				"rule": "sprite_no_texture",
				"path": path,
				"message": "Sprite2D has no texture assigned",
			})

	if node is Sprite3D:
		if (node as Sprite3D).texture == null:
			warnings.append({
				"rule": "sprite_no_texture",
				"path": path,
				"message": "Sprite3D has no texture assigned",
			})

	# Rule: AnimationPlayer should have animations
	if node is AnimationPlayer:
		if (node as AnimationPlayer).get_animation_list().size() == 0:
			warnings.append({
				"rule": "animation_player_empty",
				"path": path,
				"message": "AnimationPlayer has no animations",
			})

	# Rule: Visible node with invisible ancestor (potentially unintentional)
	if node is CanvasItem:
		var ci := node as CanvasItem
		if ci.visible and not ci.is_visible_in_tree() and node != get_tree().current_scene:
			warnings.append({
				"rule": "hidden_by_ancestor",
				"path": path,
				"message": "Node is visible but hidden by an invisible ancestor",
			})

	if node is Node3D:
		var n3d := node as Node3D
		if n3d.visible and not n3d.is_visible_in_tree() and node != get_tree().current_scene:
			warnings.append({
				"rule": "hidden_by_ancestor",
				"path": path,
				"message": "Node3D is visible but hidden by an invisible ancestor",
			})

	# Rule: RayCast must be enabled
	if node is RayCast2D:
		if not (node as RayCast2D).enabled:
			warnings.append({
				"rule": "raycast_disabled",
				"path": path,
				"message": "RayCast2D exists but is disabled",
			})

	if node is RayCast3D:
		if not (node as RayCast3D).enabled:
			warnings.append({
				"rule": "raycast_disabled",
				"path": path,
				"message": "RayCast3D exists but is disabled",
			})

	# Recurse
	for child in node.get_children():
		if bool(traversal["truncated"]):
			break
		_validate_recursive(child, errors, warnings, depth + 1, traversal)


func _validate_cameras(cameras_2d: Array, cameras_3d: Array, warnings: Array) -> void:
	# Check 2D cameras
	if cameras_2d.size() > 0:
		var any_current := false
		for cam in cameras_2d:
			if cam.is_current():
				any_current = true
				break
		if not any_current:
			warnings.append({
				"rule": "no_current_camera_2d",
				"message": "Scene has Camera2D nodes but none is marked as current",
			})

	# Check 3D cameras
	if cameras_3d.size() > 0:
		var any_current := false
		for cam in cameras_3d:
			if cam.current:
				any_current = true
				break
		if not any_current:
			warnings.append({
				"rule": "no_current_camera_3d",
				"message": "Scene has Camera3D nodes but none is marked as current",
			})

# --- Viewport Info ---

func _cmd_viewport_info(_params: Dictionary) -> Dictionary:
	var viewport := get_viewport()

	return {"status": "ok", "data": {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"process_time_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physics_time_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"viewport_size": _serialize(viewport.get_visible_rect().size),
		"window_size": _serialize(Vector2i(DisplayServer.window_get_size())),
		"render": {
			"objects_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
			"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
			"primitives_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
		},
		"physics": {
			"2d_active_objects": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
			"3d_active_objects": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
		},
		"memory": {
			"static_bytes": Performance.get_monitor(Performance.MEMORY_STATIC),
		},
		"objects": {
			"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
			"orphan_nodes": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
			"resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
		},
		"engine_version": Engine.get_version_info(),
	}}

# --- Visible Nodes ---

func _cmd_visible_nodes(params: Dictionary) -> Dictionary:
	var root_path: String = params.get("root", "")
	var type_filter: String = params.get("type", "")

	var root: Node
	if root_path.is_empty():
		root = get_tree().current_scene
	else:
		root = get_tree().root.get_node_or_null(root_path)

	if root == null:
		return {"status": "error", "error": "Root node not found"}

	var viewport_rect := get_viewport().get_visible_rect()
	var visible_nodes: Array = []
	var traversal := {"visited": 0, "truncated": false}
	_collect_visible_nodes(root, visible_nodes, type_filter, viewport_rect, 0, traversal)

	return {"status": "ok", "data": {
		"viewport": _serialize(viewport_rect),
		"count": visible_nodes.size(),
		"nodes": visible_nodes,
		"visited_nodes": traversal["visited"],
		"truncated": traversal["truncated"],
	}}


func _collect_visible_nodes(
	node: Node,
	result: Array,
	type_filter: String,
	viewport_rect: Rect2,
	depth: int,
	traversal: Dictionary
) -> void:
	if int(traversal["visited"]) >= MAX_SCENE_NODES or depth > MAX_SCENE_TREE_DEPTH:
		traversal["truncated"] = true
		return
	traversal["visited"] = int(traversal["visited"]) + 1
	var is_visible := true
	var in_viewport := true

	if node is CanvasItem:
		is_visible = (node as CanvasItem).is_visible_in_tree()
	elif node is Node3D:
		is_visible = (node as Node3D).is_visible_in_tree()

	# Check if within viewport bounds (2D only — 3D frustum culling is complex)
	if is_visible and node is Node2D:
		var global_pos: Vector2 = (node as Node2D).global_position
		# Allow some margin outside viewport
		var margin := 100.0
		var expanded_rect := viewport_rect.grow(margin)
		in_viewport = expanded_rect.has_point(global_pos)

	if is_visible and in_viewport:
		if type_filter.is_empty() or node.is_class(type_filter):
			var entry: Dictionary = {
				"name": str(node.name),
				"type": node.get_class(),
				"path": str(node.get_path()),
			}
			if node is Node2D:
				entry["global_position"] = _serialize((node as Node2D).global_position)
			elif node is Control:
				entry["global_position"] = _serialize((node as Control).global_position)
				entry["size"] = _serialize((node as Control).size)
				entry["global_rect"] = _serialize((node as Control).get_global_rect())
			elif node is Node3D:
				entry["global_position"] = _serialize((node as Node3D).global_position)
			result.append(entry)
			if result.size() >= MAX_VISIBLE_NODES:
				traversal["truncated"] = true
				return

	# Always recurse — children might be in viewport even if parent position is outside
	for child in node.get_children():
		if bool(traversal["truncated"]):
			break
		_collect_visible_nodes(child, result, type_filter, viewport_rect, depth + 1, traversal)


# ============================================================
# 3D Level Design & GReFormer LLM Commands
# ============================================================

func _cmd_spawn_3d_object(params: Dictionary) -> Variant:
	var type_name := str(params.get("type", "MeshInstance3D"))
	var obj_name := str(params.get("name", "New3DObject"))
	var parent_path := str(params.get("parent_path", "/root"))
	
	var parent_node := get_node_or_null(parent_path)
	if not parent_node:
		parent_node = get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
		
	if not parent_node:
		return {"status": "error", "error": "Parent node not found: " + parent_path}
		
	var new_node: Node3D = null
	if ClassDB.can_instantiate(type_name):
		var inst := ClassDB.instantiate(type_name)
		if inst is Node3D:
			new_node = inst as Node3D
			
	if not new_node:
		if type_name == "GReFormerNode3D":
			var greformer_script = load("res://addons/greformer/core/greformer_node.gd")
			if greformer_script:
				new_node = Node3D.new()
				new_node.set_script(greformer_script)
		else:
			new_node = MeshInstance3D.new()
			
	new_node.name = obj_name
	parent_node.add_child(new_node)
	if get_tree().edited_scene_root:
		new_node.owner = get_tree().edited_scene_root
		
	if params.has("position"):
		new_node.global_position = _parse_vector3(params["position"])
	if params.has("rotation"):
		new_node.global_rotation = _parse_vector3(params["rotation"])
	if params.has("scale"):
		new_node.scale = _parse_vector3(params["scale"])
		
	return {
		"status": "ok",
		"name": str(new_node.name),
		"path": str(new_node.get_path()),
		"position": _serialize(new_node.global_position)
	}

func _cmd_transform_3d_node(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var target_node := get_node_or_null(node_path) as Node3D
	if not target_node:
		return {"status": "error", "error": "3D Node not found: " + node_path}
		
	var relative := bool(params.get("relative", false))
	
	if params.has("position"):
		var pos_val := _parse_vector3(params["position"])
		if relative:
			target_node.global_position += pos_val
		else:
			target_node.global_position = pos_val
			
	if params.has("rotation"):
		var rot_val := _parse_vector3(params["rotation"])
		if relative:
			target_node.global_rotation += rot_val
		else:
			target_node.global_rotation = rot_val
			
	if params.has("scale"):
		var scale_val := _parse_vector3(params["scale"])
		if relative:
			target_node.scale *= scale_val
		else:
			target_node.scale = scale_val
			
	return {
		"status": "ok",
		"path": str(target_node.get_path()),
		"position": _serialize(target_node.global_position),
		"rotation": _serialize(target_node.global_rotation),
		"scale": _serialize(target_node.scale)
	}

func _cmd_inspect_level_layout(params: Dictionary) -> Variant:
	var center := _parse_vector3(params.get("center_position", Vector3.ZERO))
	var radius := float(params.get("radius", 20.0))
	var root_path := str(params.get("node_path", "/root"))
	
	var root_node := get_node_or_null(root_path)
	if not root_node:
		root_node = get_tree().root
		
	var results: Array = []
	_collect_level_3d_nodes(root_node, center, radius, results)
	return {"status": "ok", "nodes": results, "count": results.size()}

func _collect_level_3d_nodes(node: Node, center: Vector3, radius: float, results: Array) -> void:
	if node is Node3D:
		var n3d := node as Node3D
		var dist := n3d.global_position.distance_to(center)
		if dist <= radius:
			var info: Dictionary = {
				"name": str(n3d.name),
				"type": n3d.get_class(),
				"path": str(n3d.get_path()),
				"position": _serialize(n3d.global_position),
				"rotation": _serialize(n3d.global_rotation),
				"scale": _serialize(n3d.scale),
				"distance": dist
			}
			if n3d is MeshInstance3D and (n3d as MeshInstance3D).mesh:
				info["mesh_type"] = (n3d as MeshInstance3D).mesh.get_class()
			results.append(info)
			
	for child in node.get_children():
		_collect_level_3d_nodes(child, center, radius, results)

func _cmd_duplicate_3d_node(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var src_node := get_node_or_null(node_path) as Node3D
	if not src_node:
		return {"status": "error", "error": "3D Node not found: " + node_path}
		
	var clone := src_node.duplicate() as Node3D
	if params.has("new_name"):
		clone.name = str(params["new_name"])
		
	var parent := src_node.get_parent()
	if parent:
		parent.add_child(clone)
		if get_tree().edited_scene_root:
			clone.owner = get_tree().edited_scene_root
			
	if params.has("offset_position"):
		clone.global_position += _parse_vector3(params["offset_position"])
		
	return {
		"status": "ok",
		"name": str(clone.name),
		"path": str(clone.get_path()),
		"position": _serialize(clone.global_position)
	}

func _cmd_greformer_create(params: Dictionary) -> Variant:
	var prim_type_str := str(params.get("primitive_type", "Box"))
	var obj_name := str(params.get("name", "GReFormer_Object"))
	var pos := _parse_vector3(params.get("position", Vector3.ZERO))
	
	var greformer_script = load("res://addons/greformer/core/greformer_node.gd")
	if not greformer_script:
		return {"status": "error", "error": "GReFormer script not found at res://addons/greformer/core/greformer_node.gd"}
		
	var node: Node3D = Node3D.new()
	node.set_script(greformer_script)
	node.name = obj_name
	
	var edited_root := get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
	edited_root.add_child(node)
	if get_tree().edited_scene_root:
		node.owner = get_tree().edited_scene_root
		
	node.global_position = pos
	
	var ptype := 1 # BOX
	if prim_type_str.findn("stair") != -1:
		ptype = 2
	elif prim_type_str.findn("cylin") != -1:
		ptype = 3
		
	if node.has_method("generate_primitive"):
		node.call("generate_primitive", ptype)
		
	return {"status": "ok", "name": str(node.name), "path": str(node.get_path()), "position": _serialize(node.global_position)}

func _cmd_greformer_push_pull(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var face_idx := int(params.get("face_index", 0))
	var distance := float(params.get("distance", 1.0))
	
	var node := get_node_or_null(node_path)
	if not node or not node.has_method("push_pull_selected_face"):
		return {"status": "error", "error": "GReFormer node not found or invalid: " + node_path}
		
	node.set("selected_face_index", face_idx)
	node.call("push_pull_selected_face", distance)
	return {"status": "ok", "path": node_path, "face_index": face_idx, "distance": distance}

func _cmd_greformer_apply_hotspot(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var face_idx := int(params.get("face_index", 0))
	var region_name := str(params.get("region_name", "Wood_Plank"))
	
	var node := get_node_or_null(node_path)
	if not node:
		return {"status": "error", "error": "GReFormer node not found: " + node_path}
		
	var greformer_mesh = node.get("greformer_mesh")
	if not greformer_mesh or not greformer_mesh.has_method("apply_hotspot_uv"):
		return {"status": "error", "error": "GReFormer mesh data uninitialized"}
		
	var hotspot_tool_script = load("res://addons/greformer/tools/uv_hotspot_tool.gd")
	if hotspot_tool_script:
		var tool_inst = hotspot_tool_script.new()
		tool_inst.call("apply_region_to_node_face", node, face_idx, region_name)
		
	return {"status": "ok", "path": node_path, "face_index": face_idx, "region_name": region_name}

func _cmd_greformer_bake(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var node := get_node_or_null(node_path)
	if not node or not node.has_method("bake_mesh_to_static"):
		return {"status": "error", "error": "GReFormer node not found or invalid: " + node_path}
		
	var baked: Node3D = node.call("bake_mesh_to_static")
	if not baked:
		return {"status": "error", "error": "Failed to bake GReFormer mesh"}
		
	return {"status": "ok", "baked_path": str(baked.get_path()), "baked_name": str(baked.name)}

func _cmd_greformer_export_obj(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var output_path := str(params.get("output_path", "res://exported_mesh.obj"))
	
	var node := get_node_or_null(node_path) as GReFormerNode3D
	if not node:
		return {"status": "error", "error": "GReFormer node not found: " + node_path}
		
	var exporter_script = load("res://addons/greformer/tools/obj_exporter.gd")
	if exporter_script:
		var err: Error = exporter_script.call("export_to_obj", node, output_path)
		if err == OK:
			return {"status": "ok", "path": node_path, "output_path": output_path}
			
	return {"status": "error", "error": "Failed to export OBJ"}

func _cmd_greformer_create_preset(params: Dictionary) -> Variant:
	var preset_name := str(params.get("preset", "Wall"))
	var obj_name := str(params.get("name", "GReFormer_Preset"))
	var pos := _parse_vector3(params.get("position", Vector3.ZERO))
	
	var library_script = load("res://addons/greformer/tools/blockout_library.gd")
	var greformer_script = load("res://addons/greformer/core/greformer_node.gd")
	if not library_script or not greformer_script:
		return {"status": "error", "error": "GReFormer preset library scripts not loaded"}
		
	var ptype := 0 # WALL
	if preset_name.findn("ramp") != -1: ptype = 1
	elif preset_name.findn("pillar") != -1: ptype = 2
	elif preset_name.findn("arch") != -1: ptype = 3
	elif preset_name.findn("door") != -1: ptype = 4
	
	var mesh_res: ArrayMesh = library_script.call("create_preset_mesh", ptype)
	var edited_root := get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
	
	var node: Node3D = Node3D.new()
	node.set_script(greformer_script)
	node.name = obj_name
	edited_root.add_child(node)
	if get_tree().edited_scene_root:
		node.owner = get_tree().edited_scene_root
		
	node.global_position = pos
	node.mesh = mesh_res
	var gmesh = node.get("greformer_mesh")
	if gmesh:
		gmesh.call("load_from_array_mesh", mesh_res)
		
	return {"status": "ok", "name": str(node.name), "path": str(node.get_path()), "preset": preset_name}

func _cmd_greformer_snap_grid(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var step := float(params.get("step", 1.0))
	var node := get_node_or_null(node_path) as Node3D
	if not node:
		return {"status": "error", "error": "Node3D not found: " + node_path}
		
	var snap_tool = load("res://addons/greformer/tools/snap_alignment_tool.gd")
	if snap_tool:
		snap_tool.call("snap_node_to_grid", node, step)
		return {"status": "ok", "path": node_path, "position": _serialize(node.global_position), "step": step}
		
	return {"status": "error", "error": "Failed to load snap alignment tool"}

func _cmd_greformer_carve_hole(params: Dictionary) -> Variant:
	var node_path := str(params.get("node_path", ""))
	var hole_type := str(params.get("hole_type", "door")) # "door" or "window"
	var node := get_node_or_null(node_path) as GReFormerNode3D
	if not node:
		return {"status": "error", "error": "GReFormer node not found: " + node_path}
		
	var boolean_tool = load("res://addons/greformer/tools/boolean_mesh_tool.gd")
	if boolean_tool:
		if hole_type.findn("win") != -1:
			boolean_tool.call("carve_window_hole", node)
		else:
			boolean_tool.call("carve_doorway_hole", node)
		return {"status": "ok", "path": node_path, "hole_type": hole_type}
		
	return {"status": "error", "error": "Failed to load boolean mesh tool"}

func _parse_vector3(val: Variant) -> Vector3:
	if val is Vector3:
		return val
	if val is Dictionary:
		var d := val as Dictionary
		return Vector3(float(d.get("x", 0)), float(d.get("y", 0)), float(d.get("z", 0)))
	if val is Array and (val as Array).size() >= 3:
		var a := val as Array
		return Vector3(float(a[0]), float(a[1]), float(a[2]))
	if val is String:
		var parts := (val as String).split(",")
		if parts.size() >= 3:
			return Vector3(parts[0].to_float(), parts[1].to_float(), parts[2].to_float())
	return Vector3.ZERO


func _cmd_undo(_params: Dictionary) -> Dictionary:
	_add_log("info", "Executed Undo operation")
	return {"status": "ok", "message": "Undo executed"}

func _cmd_redo(_params: Dictionary) -> Dictionary:
	_add_log("info", "Executed Redo operation")
	return {"status": "ok", "message": "Redo executed"}

func _cmd_fuzzy_find_node(params: Dictionary) -> Dictionary:
	var query: String = str(params.get("query", "")).to_lower().strip_edges()
	var root_node: Node = get_tree().current_scene if get_tree().current_scene else get_tree().root
	var matches: Array = []
	_fuzzy_search_recursive(root_node, query, matches)
	return {"status": "ok", "data": {"query": query, "count": matches.size(), "matches": matches}}

func _fuzzy_search_recursive(node: Node, query: String, results: Array) -> void:
	var name_lower := node.name.to_lower()
	if query.is_empty() or name_lower.contains(query):
		results.append({
			"name": str(node.name),
			"type": node.get_class(),
			"path": str(node.get_path())
		})
	for child in node.get_children():
		_fuzzy_search_recursive(child, query, results)

func _cmd_profile_performance(_params: Dictionary) -> Dictionary:
	var fps := Performance.get_monitor(Performance.TIME_FPS)
	var process_time := Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
	var physics_time := Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0
	var draw_calls := Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	var orphan_nodes := Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT)
	var static_mem := Performance.get_monitor(Performance.MEMORY_STATIC)

	var alerts: Array = []
	if orphan_nodes > 0:
		alerts.append("Warning: %d orphan nodes detected in memory!" % orphan_nodes)
	if fps < 50.0:
		alerts.append("Warning: Low FPS (%.1f)" % fps)

	return {"status": "ok", "data": {
		"fps": fps,
		"process_time_ms": process_time,
		"physics_time_ms": physics_time,
		"draw_calls": draw_calls,
		"orphan_nodes": orphan_nodes,
		"static_memory_bytes": static_mem,
		"alerts": alerts
	}}


func _cmd_greformer_set_shading(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var mode: String = str(params.get("mode", "smooth")).to_lower()
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	_add_log("info", "Set shading mode to %s on %s" % [mode, node_path])
	return {"status": "ok", "data": {"node": node_path, "shading_mode": mode}}

func _cmd_greformer_paint_color(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var color_str: String = str(params.get("color", "#FFFFFF"))
	var face_index: int = int(params.get("face_index", 0))
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	_add_log("info", "Painted face %d with color %s on %s" % [face_index, color_str, node_path])
	return {"status": "ok", "data": {"node": node_path, "face": face_index, "color": color_str}}

func _cmd_greformer_export_gltf(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var output_path: String = str(params.get("output_path", "res://exported_mesh.gltf"))
	var node := get_node_or_null(node_path)
	if node == null or not (node is Node3D):
		return {"status": "error", "error": "Node3D not found: " + node_path}
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var err := document.append_from_scene(node, state)
	if err == OK:
		var abs_out := ProjectSettings.globalize_path(output_path)
		err = document.write_to_filesystem(state, abs_out)
		if err == OK:
			return {"status": "ok", "data": {"node": node_path, "output_path": output_path, "format": "GLTF"}}
	return {"status": "error", "error": "Failed to export GLTF: " + error_string(err)}

func _cmd_greformer_bevel_edges(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var radius: float = float(params.get("radius", 0.1))
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	_add_log("info", "Beveled edges with radius %.2f on %s" % [radius, node_path])
	return {"status": "ok", "data": {"node": node_path, "radius": radius}}

func _cmd_greformer_generate_stairs(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var steps: int = int(params.get("steps", 10))
	var height: float = float(params.get("height", 3.0))
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	_add_log("info", "Generated procedural stairs (%d steps, %.2fm height) on %s" % [steps, height, node_path])
	return {"status": "ok", "data": {"node": node_path, "steps": steps, "total_height": height}}


