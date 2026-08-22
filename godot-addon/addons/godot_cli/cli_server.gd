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
const MAX_CAPTURE_FRAMES := 30
const MAX_BATCH_COMMANDS := 64
const MAX_FIND_RESULTS := 1024
const MAX_LOG_RETURNED := 512
const MAX_HIGHLIGHT_SECONDS := 60.0

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
	"metrics": true,
	"get_logs": true,
	"find_nodes": true,
	"list_signals": true,
	"query_ray": true,
	"query_point": true,
	"capture_sequence": true,
	"export_project_api": true,
	"batch_execute": true,
	"fuzzy_find_node": true,
	"inspect_children": true,
	"inspect_resources": true,
	"profile_performance": true,
	"record_metrics": true,
	"version": true,
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
	"emit_signal": true,
	"action_press": true,
	"action_release": true,
	"highlight_node": true,
	"clear_logs": true,
	"undo": true,
	"redo": true,
	"greformer_set_shading": true,
	"greformer_paint_color": true,
	"greformer_bevel_edges": true,
	"greformer_generate_stairs": true,
	"greformer_generate_terrain": true,
	"greformer_generate_tunnel": true,
	"greformer_generate_archway": true,
	"greformer_generate_collision": true,
	"greformer_array_duplicate": true,
}

const UNSAFE_COMMANDS := {
	"call_method": true,
	"eval": true,
	"create_file": true,
	"delete_file": true,
	"attach_script": true,
	"detach_script": true,
	"save_scene": true,
	"greformer_export_gltf": true,
}

var _auth_token := ""
var _allow_mutations := false
var _allow_unsafe := false
var _listen_port := DEFAULT_PORT

var _server: TCPServer = null
var _clients: Array[Dictionary] = []
var _pending_waits: Array[Dictionary] = []
var _log_buffer: Array[Dictionary] = []
var _pending_frames: Array[Dictionary] = []
var _pending_physics: Array[Dictionary] = []

# --- Lifecycle ---

func _ready() -> void:
	# PATCH 03: without this the autoload's _process() stops whenever the game
	# pauses (get_tree().paused = true), which silently wedges the TCP server
	# with no way to recover except restarting the engine.
	process_mode = Node.PROCESS_MODE_ALWAYS
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


func _physics_process(_delta: float) -> void:
	if _pending_physics.is_empty():
		return
	var queued := _pending_physics.duplicate()
	_pending_physics.clear()
	for job in queued:
		var result: Dictionary = {}
		if job["kind"] == "ray":
			result = _run_ray_query(job["params"])
		else:
			result = _run_point_query(job["params"])
		result["id"] = job["id"]
		_send(job["client"], result)


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
	_check_pending_frames()

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
		"metrics": return _cmd_metrics(params)
		"get_logs": return _cmd_get_logs(params)
		"find_nodes": return _cmd_find_nodes(params)
		"list_signals": return _cmd_list_signals(params)
		"emit_signal": return _cmd_emit_signal(params)
		"action_press": return _cmd_action_press(params)
		"action_release": return _cmd_action_release(params)
		"batch_execute": return _cmd_batch_execute(params)
		"query_ray":
			_queue_physics_query("ray", params, client, id)
			return null  # Response is deferred to _physics_process
		"query_point":
			_queue_physics_query("point", params, client, id)
			return null  # Response is deferred to _physics_process
		"export_project_api": return _cmd_export_project_api(params)
		"greformer_generate_terrain": return _cmd_greformer_generate_terrain(params)
		"greformer_generate_tunnel": return _cmd_greformer_generate_tunnel(params)
		"greformer_generate_archway": return _cmd_greformer_generate_archway(params)
		"greformer_generate_collision": return _cmd_greformer_generate_collision(params)
		"greformer_array_duplicate": return _cmd_greformer_array_duplicate(params)
		"capture_sequence":
			_cmd_capture_sequence(params, client, id)
			return null  # Response is deferred until all frames are captured
		"highlight_node":
			_cmd_highlight_node(params, client, id)
			return null  # Response is deferred until the highlight expires
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
		"inspect_resources": return _cmd_inspect_resources(params)
		"record_metrics": return _cmd_record_metrics(params)
		"version": return _cmd_version(params)
		"clear_logs": return _cmd_clear_logs(params)
		"inspect_children": return _cmd_inspect_children(params)
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
	# Default-deny: a command absent from all three catalogs is refused rather than
	# silently allowed. Previously this returned "" (allow), so any command not listed
	# bypassed the gate system entirely -- including scene-mutating and file-writing ones.
	return "Command is not present in the security catalog and is refused by default"


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
		return {"status": "error", "error": "Cannot open directory: " + error_string(DirAccess.get_open_error())}

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
	
	var node := get_node_or_null(node_path) as Node3D
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
	var node := get_node_or_null(node_path) as Node3D
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
	if val is Array and (val as Array).size() >= 3:
		var a := val as Array
		return Vector3(float(a[0]), float(a[1]), float(a[2]))
	# _deserialize already understands both the {"_type": "Vector3", ...} envelope and
	# the documented "Vector3(x, y, z)" constructor string (via Expression), so reuse it
	# instead of hand-rolling a string split.
	var decoded = _deserialize(val)
	if decoded is Vector3:
		return decoded
	if decoded is Vector3i:
		return Vector3(decoded)
	if val is String:
		var parts := (val as String).strip_edges().lstrip("([").rstrip(")]").split(",")
		if parts.size() >= 3:
			return Vector3(
				parts[0].strip_edges().to_float(),
				parts[1].strip_edges().to_float(),
				parts[2].strip_edges().to_float()
			)
	return Vector3.ZERO


func _parse_vector2(val: Variant) -> Vector2:
	if val is Vector2:
		return val
	if val is Array and (val as Array).size() >= 2:
		var a := val as Array
		return Vector2(float(a[0]), float(a[1]))
	var decoded = _deserialize(val)
	if decoded is Vector2:
		return decoded
	if decoded is Vector2i:
		return Vector2(decoded)
	if val is String:
		var parts := (val as String).strip_edges().lstrip("([").rstrip(")]").split(",")
		if parts.size() >= 2:
			return Vector2(parts[0].strip_edges().to_float(), parts[1].strip_edges().to_float())
	return Vector2.ZERO


# ============================================================
# Performance metrics
# ============================================================

func _collect_performance_metrics() -> Dictionary:
	var viewport := get_viewport()
	return {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"process_time_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physics_time_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"navigation_time_ms": Performance.get_monitor(Performance.TIME_NAVIGATION_PROCESS) * 1000.0,
		"viewport_size": _serialize(viewport.get_visible_rect().size),
		"window_size": _serialize(Vector2i(DisplayServer.window_get_size())),
		"render": {
			"objects_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
			"draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
			"primitives_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
			"video_mem_used_bytes": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED),
			"texture_mem_used_bytes": Performance.get_monitor(Performance.RENDER_TEXTURE_MEM_USED),
			"buffer_mem_used_bytes": Performance.get_monitor(Performance.RENDER_BUFFER_MEM_USED),
			"method": RenderingServer.get_current_rendering_method(),
		},
		"physics": {
			"2d_active_objects": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
			"2d_collision_pairs": Performance.get_monitor(Performance.PHYSICS_2D_COLLISION_PAIRS),
			"2d_island_count": Performance.get_monitor(Performance.PHYSICS_2D_ISLAND_COUNT),
			"3d_active_objects": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
			"3d_collision_pairs": Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS),
			"3d_island_count": Performance.get_monitor(Performance.PHYSICS_3D_ISLAND_COUNT),
		},
		"memory": {
			"static_bytes": Performance.get_monitor(Performance.MEMORY_STATIC),
			"static_max_bytes": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
			"message_buffer_max_bytes": Performance.get_monitor(Performance.MEMORY_MESSAGE_BUFFER_MAX),
		},
		"objects": {
			"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
			"orphan_nodes": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
			"resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
			"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		},
		"audio": {
			"output_latency_ms": Performance.get_monitor(Performance.AUDIO_OUTPUT_LATENCY) * 1000.0,
		},
		"engine_version": Engine.get_version_info(),
	}


func _cmd_metrics(_params: Dictionary) -> Dictionary:
	return {"status": "ok", "data": _collect_performance_metrics()}

# ============================================================
# Runtime logs
# ============================================================

const LOG_LEVELS := {"info": 0, "warning": 1, "error": 2}


func _parse_engine_log_lines(text: String, out: Array) -> void:
	for raw_line in text.split("\n"):
		var line := (raw_line as String).strip_edges()
		if line.is_empty():
			continue
		var level := ""
		if line.begins_with("SCRIPT ERROR") or line.begins_with("ERROR") or line.begins_with("USER ERROR"):
			level = "error"
		elif line.begins_with("WARNING") or line.begins_with("USER WARNING"):
			level = "warning"
		if level.is_empty():
			continue
		out.append({"level": level, "message": line, "source": "engine_log"})


func _read_engine_log() -> Array:
	var entries: Array = []
	if not bool(ProjectSettings.get_setting("debug/file_logging/enable_file_logging", false)):
		return entries
	var log_path := str(ProjectSettings.get_setting("debug/file_logging/log_path", "user://logs/godot.log"))
	if not FileAccess.file_exists(log_path):
		return entries
	var file := FileAccess.open(log_path, FileAccess.READ)
	if file == null:
		return entries
	var size := file.get_length()
	if size > MAX_FILE_BYTES:
		file.seek(size - MAX_FILE_BYTES)
	var text := file.get_as_text()
	file.close()
	_parse_engine_log_lines(text, entries)
	return entries


func _cmd_get_logs(params: Dictionary) -> Dictionary:
	var level := str(params.get("level", "")).strip_edges().to_lower()
	if not level.is_empty() and not LOG_LEVELS.has(level):
		return {"status": "error", "error": "Unknown log level '%s'; expected info, warning or error" % level}

	var entries: Array = []
	for entry in _log_buffer:
		entries.append({
			"level": entry.get("level", "info"),
			"message": entry.get("message", ""),
			"timestamp_ms": entry.get("timestamp_ms", 0),
			"source": "godot_cli",
		})
	var engine_entries := _read_engine_log()
	entries.append_array(engine_entries)

	if not level.is_empty():
		var minimum: int = LOG_LEVELS[level]
		entries = entries.filter(func(e: Dictionary) -> bool:
			return int(LOG_LEVELS.get(str(e.get("level", "info")), 0)) >= minimum
		)

	var truncated := false
	if entries.size() > MAX_LOG_RETURNED:
		entries = entries.slice(entries.size() - MAX_LOG_RETURNED)
		truncated = true

	var error_count := 0
	var warning_count := 0
	for e in entries:
		match str(e.get("level", "")):
			"error": error_count += 1
			"warning": warning_count += 1

	var cleared := 0
	if bool(params.get("clear", false)):
		cleared = _log_buffer.size()
		_log_buffer.clear()

	return {"status": "ok", "data": {
		"logs": entries,
		"count": entries.size(),
		"error_count": error_count,
		"warning_count": warning_count,
		"truncated": truncated,
		"cleared": cleared,
		"engine_log_available": not engine_entries.is_empty() or bool(
			ProjectSettings.get_setting("debug/file_logging/enable_file_logging", false)
		),
	}}

# ============================================================
# Node discovery
# ============================================================

func _find_nodes_recursive(
	node: Node,
	pattern: String,
	type_name: String,
	group: String,
	results: Array
) -> void:
	if results.size() >= MAX_FIND_RESULTS:
		return
	var matches := true
	if not pattern.is_empty() and not str(node.name).match(pattern):
		matches = false
	if matches and not type_name.is_empty() and not node.is_class(type_name):
		matches = false
	if matches and not group.is_empty() and not node.is_in_group(group):
		matches = false
	if matches:
		var info := {
			"name": str(node.name),
			"type": node.get_class(),
			"path": str(node.get_path()),
			"groups": node.get_groups(),
		}
		if node is Node3D:
			info["position"] = _serialize((node as Node3D).global_position)
		elif node is Node2D:
			info["position"] = _serialize((node as Node2D).global_position)
		results.append(info)
	for child in node.get_children():
		_find_nodes_recursive(child, pattern, type_name, group, results)


func _cmd_find_nodes(params: Dictionary) -> Dictionary:
	var pattern := str(params.get("pattern", "")).strip_edges()
	var type_name := str(params.get("type", "")).strip_edges()
	var group := str(params.get("group", "")).strip_edges()
	var root_path := str(params.get("root", "")).strip_edges()

	if pattern.is_empty() and type_name.is_empty() and group.is_empty():
		return {"status": "error", "error": "Provide at least one of 'pattern', 'type' or 'group'"}
	if not type_name.is_empty() and not ClassDB.class_exists(type_name):
		return {"status": "error", "error": "Unknown node class: " + type_name}

	var root: Node = null
	if root_path.is_empty():
		root = get_tree().current_scene if get_tree().current_scene else get_tree().root
	else:
		root = get_node_or_null(root_path)
	if root == null:
		return {"status": "error", "error": "Root node not found: " + root_path}

	var results: Array = []
	_find_nodes_recursive(root, pattern, type_name, group, results)
	return {"status": "ok", "data": {
		"nodes": results,
		"count": results.size(),
		"truncated": results.size() >= MAX_FIND_RESULTS,
		"searched_from": str(root.get_path()),
	}}

# ============================================================
# Signals
# ============================================================

func _cmd_list_signals(params: Dictionary) -> Dictionary:
	var node_path := str(params.get("path", ""))
	var node := get_node_or_null(node_path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + node_path}

	var signals: Array = []
	for sig in node.get_signal_list():
		var sig_name := str(sig.get("name", ""))
		var args: Array = []
		for arg in sig.get("args", []):
			args.append({
				"name": str(arg.get("name", "")),
				"type": type_string(int(arg.get("type", TYPE_NIL))),
			})
		var connections: Array = []
		for conn in node.get_signal_connection_list(sig_name):
			var callable_value = conn.get("callable")
			var target_desc := ""
			if callable_value is Callable:
				var target_obj = (callable_value as Callable).get_object()
				if target_obj is Node:
					target_desc = str((target_obj as Node).get_path())
				elif target_obj != null:
					target_desc = str(target_obj)
				connections.append({
					"target": target_desc,
					"method": str((callable_value as Callable).get_method()),
				})
		signals.append({
			"name": sig_name,
			"args": args,
			"connections": connections,
			"connection_count": connections.size(),
		})

	return {"status": "ok", "data": {
		"path": str(node.get_path()),
		"signals": signals,
		"count": signals.size(),
	}}


func _cmd_emit_signal(params: Dictionary) -> Dictionary:
	var node_path := str(params.get("path", ""))
	var signal_name := str(params.get("signal", "")).strip_edges()
	var node := get_node_or_null(node_path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + node_path}
	if signal_name.is_empty():
		return {"status": "error", "error": "Missing 'signal' parameter"}
	if not node.has_signal(signal_name):
		return {"status": "error", "error": "Node has no signal '%s'" % signal_name}

	var raw_args = params.get("args", [])
	if not raw_args is Array:
		return {"status": "error", "error": "'args' must be an array"}
	var call_args: Array = [signal_name]
	for arg in raw_args:
		call_args.append(_deserialize(arg))

	var connection_count := 0
	for conn in node.get_signal_connection_list(signal_name):
		connection_count += 1

	# Object.emit_signal() returns ERR_UNAVAILABLE when the signal has no connections.
	# The signal's existence was already validated above, so that is a normal outcome
	# for an unobserved signal -- not a failure.
	var err = node.callv("emit_signal", call_args)
	if err is int and int(err) != OK and int(err) != ERR_UNAVAILABLE:
		return {"status": "error", "error": "emit_signal failed: " + error_string(int(err))}

	_add_log("info", "Emitted signal %s on %s" % [signal_name, node_path])
	return {"status": "ok", "data": {
		"path": str(node.get_path()),
		"signal": signal_name,
		"arg_count": raw_args.size(),
		"listeners_notified": connection_count,
	}}

# ============================================================
# Physics queries
# ============================================================

func _serialize_collider(hit: Dictionary) -> Dictionary:
	var out: Dictionary = {}
	for key in hit.keys():
		var value = hit[key]
		if key == "collider":
			if value is Node:
				out["collider"] = str((value as Node).get_path())
				out["collider_name"] = str((value as Node).name)
				out["collider_type"] = (value as Node).get_class()
			else:
				out["collider"] = str(value)
		elif key == "rid":
			continue
		else:
			out[key] = _serialize(value)
	return out


func _run_ray_query(params: Dictionary) -> Dictionary:
	var is_3d := bool(params.get("is_3d", true))
	if is_3d:
		var world := get_viewport().find_world_3d()
		if world == null:
			return {"status": "error", "error": "No 3D world available for raycast"}
		var query := PhysicsRayQueryParameters3D.create(
			_parse_vector3(params.get("from", Vector3.ZERO)),
			_parse_vector3(params.get("to", Vector3.ZERO))
		)
		query.collide_with_areas = bool(params.get("collide_with_areas", false))
		query.collide_with_bodies = bool(params.get("collide_with_bodies", true))
		var hit := world.direct_space_state.intersect_ray(query)
		return {"status": "ok", "data": {
			"hit": not hit.is_empty(),
			"space": "3d",
			"result": _serialize_collider(hit),
		}}

	var world_2d := get_viewport().find_world_2d()
	if world_2d == null:
		return {"status": "error", "error": "No 2D world available for raycast"}
	var query_2d := PhysicsRayQueryParameters2D.create(
		_parse_vector2(params.get("from", Vector2.ZERO)),
		_parse_vector2(params.get("to", Vector2.ZERO))
	)
	query_2d.collide_with_areas = bool(params.get("collide_with_areas", false))
	query_2d.collide_with_bodies = bool(params.get("collide_with_bodies", true))
	var hit_2d := world_2d.direct_space_state.intersect_ray(query_2d)
	return {"status": "ok", "data": {
		"hit": not hit_2d.is_empty(),
		"space": "2d",
		"result": _serialize_collider(hit_2d),
	}}


func _run_point_query(params: Dictionary) -> Dictionary:
	var is_3d := bool(params.get("is_3d", true))
	var max_results := clampi(int(params.get("max_results", 32)), 1, 256)
	if is_3d:
		var world := get_viewport().find_world_3d()
		if world == null:
			return {"status": "error", "error": "No 3D world available for point query"}
		var query := PhysicsPointQueryParameters3D.new()
		query.position = _parse_vector3(params.get("point", Vector3.ZERO))
		query.collide_with_areas = bool(params.get("collide_with_areas", true))
		query.collide_with_bodies = bool(params.get("collide_with_bodies", true))
		var hits := world.direct_space_state.intersect_point(query, max_results)
		var out: Array = []
		for hit in hits:
			out.append(_serialize_collider(hit))
		return {"status": "ok", "data": {"space": "3d", "count": out.size(), "colliders": out}}

	var world_2d := get_viewport().find_world_2d()
	if world_2d == null:
		return {"status": "error", "error": "No 2D world available for point query"}
	var query_2d := PhysicsPointQueryParameters2D.new()
	query_2d.position = _parse_vector2(params.get("point", Vector2.ZERO))
	query_2d.collide_with_areas = bool(params.get("collide_with_areas", true))
	query_2d.collide_with_bodies = bool(params.get("collide_with_bodies", true))
	var hits_2d := world_2d.direct_space_state.intersect_point(query_2d, max_results)
	var out_2d: Array = []
	for hit in hits_2d:
		out_2d.append(_serialize_collider(hit))
	return {"status": "ok", "data": {"space": "2d", "count": out_2d.size(), "colliders": out_2d}}


## Physics queries are deferred to _physics_process: direct_space_state is only
## guaranteed to be current inside a physics callback.
func _queue_physics_query(kind: String, params: Dictionary, client: Dictionary, id: String) -> void:
	if _pending_physics.size() >= MAX_PENDING_WAITS:
		_send(client, {"id": id, "status": "error", "error": "Too many pending physics queries"})
		return
	_pending_physics.append({"kind": kind, "params": params, "client": client, "id": id})

# ============================================================
# InputMap actions
# ============================================================

func _cmd_action_press(params: Dictionary) -> Dictionary:
	var action := str(params.get("action", "")).strip_edges()
	if action.is_empty():
		return {"status": "error", "error": "Missing 'action' parameter"}
	if not InputMap.has_action(action):
		return {"status": "error", "error": "InputMap has no action '%s'" % action}
	var raw_strength = params.get("strength", 1.0)
	if not (raw_strength is int or raw_strength is float):
		return {"status": "error", "error": "'strength' must be numeric"}
	var strength := clampf(float(raw_strength), 0.0, 1.0)
	Input.action_press(action, strength)
	_add_log("info", "Pressed action %s (strength %.2f)" % [action, strength])
	return {"status": "ok", "data": {"action": action, "strength": strength, "pressed": true}}


func _cmd_action_release(params: Dictionary) -> Dictionary:
	var action := str(params.get("action", "")).strip_edges()
	if action.is_empty():
		return {"status": "error", "error": "Missing 'action' parameter"}
	if not InputMap.has_action(action):
		return {"status": "error", "error": "InputMap has no action '%s'" % action}
	Input.action_release(action)
	_add_log("info", "Released action %s" % action)
	return {"status": "ok", "data": {"action": action, "pressed": false}}

# ============================================================
# Batch execution
# ============================================================

const BATCH_FORBIDDEN := {
	"batch_execute": true,
	"wait_for": true,
	"capture_sequence": true,
	"highlight_node": true,
	"query_ray": true,
	"query_point": true,
}


func _cmd_batch_execute(params: Dictionary) -> Dictionary:
	var raw = params.get("commands", [])
	if not raw is Array:
		return {"status": "error", "error": "'commands' must be an array"}
	var commands: Array = raw
	if commands.is_empty():
		return {"status": "error", "error": "'commands' must not be empty"}
	if commands.size() > MAX_BATCH_COMMANDS:
		return {
			"status": "error",
			"error": "Batch exceeds the maximum of %d commands" % MAX_BATCH_COMMANDS,
		}

	var results: Array = []
	var ok_count := 0
	var error_count := 0
	for entry in commands:
		if not entry is Dictionary:
			results.append({"status": "error", "error": "Each batch entry must be an object"})
			error_count += 1
			continue
		var item: Dictionary = entry
		var name := str(item.get("command", ""))
		var item_params = item.get("params", {})
		if not item_params is Dictionary:
			results.append({"command": name, "status": "error", "error": "Invalid params"})
			error_count += 1
			continue
		if BATCH_FORBIDDEN.has(name):
			results.append({
				"command": name,
				"status": "error",
				"error": "'%s' returns a deferred response and cannot run inside a batch" % name,
			})
			error_count += 1
			continue
		# _execute applies _command_denial per command, so each entry is gated individually.
		var result = _execute(name, item_params)
		if result == null:
			result = {"status": "error", "error": "Command produced no response"}
		var item_result: Dictionary = result
		item_result["command"] = name
		results.append(item_result)
		if str(item_result.get("status", "")) == "ok":
			ok_count += 1
		else:
			error_count += 1

	return {"status": "ok", "data": {
		"results": results,
		"total": results.size(),
		"ok_count": ok_count,
		"error_count": error_count,
	}}

# ============================================================
# Frame-deferred commands (capture sequences, timed highlights)
# ============================================================

func _check_pending_frames() -> void:
	if _pending_frames.is_empty():
		return
	var now := Time.get_ticks_msec()
	var to_remove: Array[int] = []

	for i in range(_pending_frames.size()):
		var job := _pending_frames[i]
		match str(job["kind"]):
			"capture":
				var image := get_viewport().get_texture().get_image()
				if image == null:
					_send(job["client"], {
						"id": job["id"],
						"status": "error",
						"error": "Failed to capture viewport",
					})
					to_remove.append(i)
					continue
				var frames: Array = job["frames"]
				frames.append({
					"index": frames.size(),
					"base64_png": Marshalls.raw_to_base64(image.save_png_to_buffer()),
					"width": image.get_width(),
					"height": image.get_height(),
					"timestamp_ms": now,
				})
				if frames.size() >= int(job["count"]):
					_send(job["client"], {
						"id": job["id"],
						"status": "ok",
						"data": {"frames": frames, "count": frames.size()},
					})
					to_remove.append(i)
			"highlight":
				if now >= int(job["expires_at_ms"]):
					var marker = job["marker"]
					if is_instance_valid(marker):
						(marker as Node).queue_free()
					_send(job["client"], {
						"id": job["id"],
						"status": "ok",
						"data": {
							"path": str(job["path"]),
							"duration": float(job["duration"]),
							"highlighted": true,
						},
					})
					to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		_pending_frames.remove_at(to_remove[i])


func _cmd_capture_sequence(params: Dictionary, client: Dictionary, id: String) -> void:
	var raw_count = params.get("count", 5)
	if not (raw_count is int or raw_count is float):
		_send(client, {"id": id, "status": "error", "error": "'count' must be numeric"})
		return
	var count := int(raw_count)
	if count < 1 or count > MAX_CAPTURE_FRAMES:
		_send(client, {
			"id": id,
			"status": "error",
			"error": "'count' must be between 1 and %d" % MAX_CAPTURE_FRAMES,
		})
		return
	if _pending_frames.size() >= MAX_PENDING_WAITS:
		_send(client, {"id": id, "status": "error", "error": "Too many pending frame jobs"})
		return
	_pending_frames.append({
		"kind": "capture",
		"client": client,
		"id": id,
		"count": count,
		"frames": [],
	})


## Builds a bright unshaded wireframe box around the node's visual bounds. A separate
## marker node is used rather than mutating the target's material, so nothing has to be
## restored if the client disconnects mid-highlight.
## Union of a node's own visual bounds and those of its descendants, in the node's
## local space. Lets us frame nodes that carry no mesh themselves (a CharacterBody3D
## whose geometry lives on a child MeshInstance3D, which is the common case).
func _visual_bounds_3d(node: Node3D, root: Node3D) -> AABB:
	var bounds := AABB()
	var has_bounds := false
	if node is VisualInstance3D:
		var local := (node as VisualInstance3D).get_aabb()
		var offset := root.to_local(node.global_position)
		bounds = AABB(local.position + offset, local.size)
		has_bounds = true
	for child in node.get_children():
		if not child is Node3D:
			continue
		var child_bounds := _visual_bounds_3d(child as Node3D, root)
		if child_bounds.size == Vector3.ZERO:
			continue
		if has_bounds:
			bounds = bounds.merge(child_bounds)
		else:
			bounds = child_bounds
			has_bounds = true
	return bounds


## Builds a bright unshaded box around the node's visual bounds. A separate marker node
## is used rather than mutating the target's material, so nothing has to be restored if
## the client disconnects mid-highlight.
func _build_highlight_marker(node: Node) -> Node:
	if node is Node3D:
		var target := node as Node3D
		var bounds := _visual_bounds_3d(target, target)
		var size := bounds.size * 1.08
		# Nodes with no geometry at all still get a small locator box.
		size.x = maxf(size.x, 0.25)
		size.y = maxf(size.y, 0.25)
		size.z = maxf(size.z, 0.25)
		var mesh := BoxMesh.new()
		mesh.size = size
		var material := StandardMaterial3D.new()
		material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		material.albedo_color = Color(1.0, 0.85, 0.1, 0.4)
		material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		material.cull_mode = BaseMaterial3D.CULL_DISABLED
		var marker := MeshInstance3D.new()
		marker.name = "GodotCLIHighlight"
		marker.mesh = mesh
		marker.material_override = material
		target.add_child(marker)
		marker.position = bounds.get_center()
		return marker

	if node is CanvasItem:
		var outline := ReferenceRect.new()
		outline.name = "GodotCLIHighlight"
		outline.border_color = Color(1.0, 0.85, 0.1, 1.0)
		outline.border_width = 3.0
		outline.editor_only = false
		if node is Control:
			outline.size = (node as Control).size
		else:
			outline.size = Vector2(64, 64)
		(node as CanvasItem).add_child(outline)
		return outline

	return null


func _cmd_highlight_node(params: Dictionary, client: Dictionary, id: String) -> void:
	var node_path := str(params.get("path", ""))
	var node := get_node_or_null(node_path)
	if node == null:
		_send(client, {"id": id, "status": "error", "error": "Node not found: " + node_path})
		return
	var raw_duration = params.get("duration", 2.0)
	if not (raw_duration is int or raw_duration is float):
		_send(client, {"id": id, "status": "error", "error": "'duration' must be numeric"})
		return
	var duration := float(raw_duration)
	if duration <= 0.0 or duration > MAX_HIGHLIGHT_SECONDS:
		_send(client, {
			"id": id,
			"status": "error",
			"error": "'duration' must be greater than 0 and at most %.0f seconds" % MAX_HIGHLIGHT_SECONDS,
		})
		return
	if _pending_frames.size() >= MAX_PENDING_WAITS:
		_send(client, {"id": id, "status": "error", "error": "Too many pending frame jobs"})
		return

	var marker := _build_highlight_marker(node)
	if marker == null:
		_send(client, {
			"id": id,
			"status": "error",
			"error": "Cannot highlight %s: not a VisualInstance3D or CanvasItem" % node.get_class(),
		})
		return

	_add_log("info", "Highlighting %s for %.1fs" % [node_path, duration])
	_pending_frames.append({
		"kind": "highlight",
		"client": client,
		"id": id,
		"path": str(node.get_path()),
		"duration": duration,
		"marker": marker,
		"expires_at_ms": Time.get_ticks_msec() + int(duration * 1000.0),
	})

# ============================================================
# Procedural mesh helpers
# ============================================================

const BOX_FACES := [
	[Vector3(-1, -1, 1), Vector3(1, -1, 1), Vector3(1, 1, 1), Vector3(-1, 1, 1)],      # +Z
	[Vector3(1, -1, -1), Vector3(-1, -1, -1), Vector3(-1, 1, -1), Vector3(1, 1, -1)],  # -Z
	[Vector3(1, -1, 1), Vector3(1, -1, -1), Vector3(1, 1, -1), Vector3(1, 1, 1)],      # +X
	[Vector3(-1, -1, -1), Vector3(-1, -1, 1), Vector3(-1, 1, 1), Vector3(-1, 1, -1)],  # -X
	[Vector3(-1, 1, 1), Vector3(1, 1, 1), Vector3(1, 1, -1), Vector3(-1, 1, -1)],      # +Y
	[Vector3(-1, -1, -1), Vector3(1, -1, -1), Vector3(1, -1, 1), Vector3(-1, -1, 1)],  # -Y
]


func _add_quad(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, d: Vector3) -> void:
	st.add_vertex(a)
	st.add_vertex(b)
	st.add_vertex(c)
	st.add_vertex(a)
	st.add_vertex(c)
	st.add_vertex(d)


func _add_box(st: SurfaceTool, center: Vector3, size: Vector3) -> void:
	var half := size * 0.5
	for face in BOX_FACES:
		_add_quad(
			st,
			center + face[0] * half,
			center + face[1] * half,
			center + face[2] * half,
			center + face[3] * half
		)


func _commit_generated_mesh(st: SurfaceTool, node_name: String, parent: Node) -> MeshInstance3D:
	st.generate_normals()
	st.generate_tangents()
	var instance := MeshInstance3D.new()
	instance.name = node_name
	instance.mesh = st.commit()
	parent.add_child(instance)
	if get_tree().edited_scene_root:
		instance.owner = get_tree().edited_scene_root
	return instance


func _resolve_generation_parent(params: Dictionary) -> Node:
	var parent_path := str(params.get("parent", "/root"))
	var parent := get_node_or_null(parent_path)
	if parent == null:
		parent = get_tree().current_scene if get_tree().current_scene else get_tree().root
	return parent


## Returns an editable SurfaceTool seeded from a MeshInstance3D's current surface,
## or null when the node has no committed geometry to read back.
func _surface_tool_from(instance: MeshInstance3D) -> SurfaceTool:
	if instance.mesh == null:
		return null
	var array_mesh := instance.mesh
	if not array_mesh is ArrayMesh:
		var converter := SurfaceTool.new()
		converter.create_from(instance.mesh, 0)
		var committed := converter.commit()
		if committed == null:
			return null
		array_mesh = committed
	if (array_mesh as ArrayMesh).get_surface_count() == 0:
		return null
	var st := SurfaceTool.new()
	st.create_from(array_mesh, 0)
	return st

# ============================================================
# Procedural generation commands
# ============================================================

func _cmd_greformer_generate_terrain(params: Dictionary) -> Dictionary:
	var grid_width := clampi(int(params.get("grid_width", params.get("width", 16))), 1, 128)
	var grid_depth := clampi(int(params.get("grid_depth", params.get("depth", 16))), 1, 128)
	var max_height := float(params.get("max_height", params.get("height", 3.0)))
	var cell_size := float(params.get("cell_size", 1.0))
	var noise_seed := int(params.get("seed", 0))
	var parent := _resolve_generation_parent(params)

	var noise := FastNoiseLite.new()
	noise.seed = noise_seed
	noise.frequency = float(params.get("frequency", 0.08))

	var heights: Array = []
	for x in range(grid_width + 1):
		var row: Array = []
		for z in range(grid_depth + 1):
			row.append(noise.get_noise_2d(float(x), float(z)) * max_height)
		heights.append(row)

	var origin := Vector3(-grid_width * cell_size * 0.5, 0.0, -grid_depth * cell_size * 0.5)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for x in range(grid_width):
		for z in range(grid_depth):
			var p00 := origin + Vector3(x * cell_size, heights[x][z], z * cell_size)
			var p10 := origin + Vector3((x + 1) * cell_size, heights[x + 1][z], z * cell_size)
			var p11 := origin + Vector3((x + 1) * cell_size, heights[x + 1][z + 1], (z + 1) * cell_size)
			var p01 := origin + Vector3(x * cell_size, heights[x][z + 1], (z + 1) * cell_size)
			# Wound so generate_normals() produces +Y normals; the reverse order leaves
			# the surface back-face culled when viewed from above.
			_add_quad(st, p00, p10, p11, p01)

	var instance := _commit_generated_mesh(st, str(params.get("name", "Terrain")), parent)
	instance.position = _parse_vector3(params.get("position", Vector3.ZERO))
	_add_log("info", "Generated %dx%d terrain under %s" % [grid_width, grid_depth, parent.get_path()])
	return {"status": "ok", "data": {
		"path": str(instance.get_path()),
		"grid_width": grid_width,
		"grid_depth": grid_depth,
		"max_height": max_height,
		"seed": noise_seed,
		"vertex_count": instance.mesh.surface_get_array_len(0),
	}}


func _cmd_greformer_generate_archway(params: Dictionary) -> Dictionary:
	var width := maxf(float(params.get("width", 3.0)), 0.1)
	var height := maxf(float(params.get("height", 4.0)), 0.2)
	var depth := maxf(float(params.get("depth", 1.0)), 0.05)
	var segments := clampi(int(params.get("segments", 12)), 3, 64)
	var parent := _resolve_generation_parent(params)

	var radius := width * 0.5
	var leg_height := maxf(height - radius, 0.05)
	var thickness := maxf(float(params.get("thickness", 0.4)), 0.05)
	var half_depth := depth * 0.5

	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	# Two vertical legs
	for side in [-1.0, 1.0]:
		_add_box(
			st,
			Vector3(side * (radius + thickness * 0.5), leg_height * 0.5, 0.0),
			Vector3(thickness, leg_height, depth)
		)

	# Semicircular arch band spanning the legs
	for i in range(segments):
		var a0 := PI * float(i) / float(segments)
		var a1 := PI * float(i + 1) / float(segments)
		var inner0 := Vector3(cos(a0) * radius, leg_height + sin(a0) * radius, 0.0)
		var inner1 := Vector3(cos(a1) * radius, leg_height + sin(a1) * radius, 0.0)
		var outer0 := Vector3(
			cos(a0) * (radius + thickness),
			leg_height + sin(a0) * (radius + thickness),
			0.0
		)
		var outer1 := Vector3(
			cos(a1) * (radius + thickness),
			leg_height + sin(a1) * (radius + thickness),
			0.0
		)
		var front := Vector3(0.0, 0.0, half_depth)
		var back := Vector3(0.0, 0.0, -half_depth)
		_add_quad(st, outer0 + front, outer1 + front, inner1 + front, inner0 + front)
		_add_quad(st, inner0 + back, inner1 + back, outer1 + back, outer0 + back)
		_add_quad(st, outer0 + back, outer1 + back, outer1 + front, outer0 + front)
		_add_quad(st, inner0 + front, inner1 + front, inner1 + back, inner0 + back)

	var instance := _commit_generated_mesh(st, str(params.get("name", "Archway")), parent)
	instance.position = _parse_vector3(params.get("position", Vector3.ZERO))
	_add_log("info", "Generated archway under %s" % parent.get_path())
	return {"status": "ok", "data": {
		"path": str(instance.get_path()),
		"width": width,
		"height": height,
		"depth": depth,
		"segments": segments,
		"vertex_count": instance.mesh.surface_get_array_len(0),
	}}


func _cmd_greformer_generate_tunnel(params: Dictionary) -> Dictionary:
	var length := maxf(float(params.get("length", 10.0)), 0.1)
	var width := maxf(float(params.get("width", 4.0)), 0.1)
	var height := maxf(float(params.get("height", 3.0)), 0.1)
	var segments := clampi(int(params.get("segments", 16)), 3, 64)
	var parent := _resolve_generation_parent(params)

	var radius_x := width * 0.5
	var half_length := length * 0.5
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	# Inward-facing half-pipe: the walls you see from inside the tunnel.
	for i in range(segments):
		var a0 := PI * float(i) / float(segments)
		var a1 := PI * float(i + 1) / float(segments)
		var p0 := Vector3(cos(a0) * radius_x, sin(a0) * height, 0.0)
		var p1 := Vector3(cos(a1) * radius_x, sin(a1) * height, 0.0)
		var back := Vector3(0.0, 0.0, -half_length)
		var front := Vector3(0.0, 0.0, half_length)
		_add_quad(st, p0 + back, p0 + front, p1 + front, p1 + back)

	var instance := _commit_generated_mesh(st, str(params.get("name", "Tunnel")), parent)
	instance.position = _parse_vector3(params.get("position", Vector3.ZERO))
	_add_log("info", "Generated tunnel under %s" % parent.get_path())
	return {"status": "ok", "data": {
		"path": str(instance.get_path()),
		"length": length,
		"width": width,
		"height": height,
		"segments": segments,
		"vertex_count": instance.mesh.surface_get_array_len(0),
	}}


func _cmd_greformer_generate_collision(params: Dictionary) -> Dictionary:
	var node_path := str(params.get("node_path", ""))
	var mode := str(params.get("mode", "trimesh")).to_lower()
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	var instance := node as MeshInstance3D
	if instance.mesh == null:
		return {"status": "error", "error": "Node has no mesh to build collision from: " + node_path}

	var before: Array[String] = []
	for child in instance.get_children():
		before.append(str(child.name))

	if mode.begins_with("convex"):
		instance.create_convex_collision()
	elif mode.begins_with("tri") or mode.begins_with("concave"):
		instance.create_trimesh_collision()
	else:
		return {"status": "error", "error": "Unknown collision mode '%s'; expected trimesh or convex" % mode}

	var created: Array[String] = []
	for child in instance.get_children():
		if not before.has(str(child.name)):
			created.append(str(child.get_path()))
			if get_tree().edited_scene_root:
				_set_owner_recursive(child, get_tree().edited_scene_root)

	if created.is_empty():
		return {"status": "error", "error": "Collision generation produced no body"}

	_add_log("info", "Generated %s collision for %s" % [mode, node_path])
	return {"status": "ok", "data": {"node": node_path, "mode": mode, "created": created}}


func _cmd_greformer_array_duplicate(params: Dictionary) -> Dictionary:
	var node_path := str(params.get("node_path", ""))
	var mode := str(params.get("mode", "linear")).to_lower()
	var count := clampi(int(params.get("count", 3)), 1, 128)
	var source := get_node_or_null(node_path)
	if source == null or not (source is Node3D):
		return {"status": "error", "error": "3D node not found: " + node_path}
	var src := source as Node3D
	var parent := src.get_parent()
	if parent == null:
		return {"status": "error", "error": "Node has no parent to duplicate into: " + node_path}

	var offset := _parse_vector3(params.get("offset", Vector3(2.0, 0.0, 0.0)))
	var radius := float(params.get("radius", 4.0))
	var created: Array[String] = []

	for i in range(1, count + 1):
		var clone := src.duplicate() as Node3D
		clone.name = "%s_%d" % [str(src.name), i]
		parent.add_child(clone)
		if get_tree().edited_scene_root:
			_set_owner_recursive(clone, get_tree().edited_scene_root)
		if mode.begins_with("rad"):
			var angle := TAU * float(i) / float(count + 1)
			clone.global_position = src.global_position + Vector3(
				cos(angle) * radius, 0.0, sin(angle) * radius
			)
			clone.rotate_y(angle)
		else:
			clone.global_position = src.global_position + offset * float(i)
		created.append(str(clone.get_path()))

	_add_log("info", "Array-duplicated %s x%d (%s)" % [node_path, count, mode])
	return {"status": "ok", "data": {
		"source": node_path,
		"mode": mode,
		"count": created.size(),
		"created": created,
	}}

# ============================================================
# Project API export
# ============================================================

func _collect_gd_scripts(dir_path: String, out: Array) -> void:
	if out.size() >= MAX_DIRECTORY_ENTRIES:
		return
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while entry != "":
		if entry.begins_with("."):
			entry = dir.get_next()
			continue
		var full := dir_path.path_join(entry)
		if dir.current_is_dir():
			if entry != "addons":
				_collect_gd_scripts(full, out)
		elif entry.ends_with(".gd"):
			out.append(full)
		entry = dir.get_next()
	dir.list_dir_end()


func _cmd_export_project_api(params: Dictionary) -> Dictionary:
	var root := str(params.get("path", "res://"))
	var abs_root := _resolve_project_path(root)
	if abs_root.is_empty():
		return {"status": "error", "error": "Path must stay inside res://"}

	var paths: Array = []
	_collect_gd_scripts(abs_root, paths)

	var scripts: Array = []
	for path in paths:
		var script = load(path)
		if script == null or not script is Script:
			continue
		var gd := script as Script
		var methods: Array = []
		for m in gd.get_script_method_list():
			var args: Array = []
			for a in m.get("args", []):
				args.append({
					"name": str(a.get("name", "")),
					"type": type_string(int(a.get("type", TYPE_NIL))),
				})
			methods.append({
				"name": str(m.get("name", "")),
				"args": args,
				"return_type": type_string(int(m.get("return", {}).get("type", TYPE_NIL))),
			})
		var signals: Array = []
		for sg in gd.get_script_signal_list():
			signals.append({"name": str(sg.get("name", ""))})
		var properties: Array = []
		for pr in gd.get_script_property_list():
			var prop_name := str(pr.get("name", ""))
			if prop_name.is_empty() or prop_name.ends_with(".gd"):
				continue
			properties.append({
				"name": prop_name,
				"type": type_string(int(pr.get("type", TYPE_NIL))),
			})
		scripts.append({
			"path": path,
			"class_name": str(gd.get_global_name()),
			"base_type": str(gd.get_instance_base_type()),
			"methods": methods,
			"signals": signals,
			"properties": properties,
		})

	return {"status": "ok", "data": {
		"scripts": scripts,
		"count": scripts.size(),
		"searched_from": root,
		"truncated": paths.size() >= MAX_DIRECTORY_ENTRIES,
	}}

func _cmd_undo(_params: Dictionary) -> Dictionary:
	# There is no undo stack behind this at runtime -- UndoRedo is an editor facility
	# and the addon runs inside the game. Reporting ok would be a lie.
	return {
		"status": "error",
		"error": "undo is not supported at runtime: the addon runs inside the running game, which has no UndoRedo history",
	}
func _cmd_redo(_params: Dictionary) -> Dictionary:
	return {
		"status": "error",
		"error": "redo is not supported at runtime: the addon runs inside the running game, which has no UndoRedo history",
	}
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
	if mode != "smooth" and mode != "flat":
		return {"status": "error", "error": "Unknown shading mode '%s'; expected smooth or flat" % mode}
	var instance := node as MeshInstance3D
	var st := _surface_tool_from(instance)
	if st == null:
		return {"status": "error", "error": "Node has no readable surface geometry: " + node_path}

	# Flat shading needs per-face normals, so drop the shared-vertex index buffer first.
	if mode == "flat":
		st.deindex()
	st.generate_normals()
	st.generate_tangents()
	instance.mesh = st.commit()

	_add_log("info", "Set shading mode to %s on %s" % [mode, node_path])
	return {"status": "ok", "data": {
		"node": node_path,
		"shading_mode": mode,
		"vertex_count": instance.mesh.surface_get_array_len(0),
	}}
func _cmd_greformer_paint_color(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var color_str: String = str(params.get("color", "#FFFFFF"))
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	if not Color.html_is_valid(color_str.lstrip("#")):
		return {"status": "error", "error": "Invalid colour: " + color_str}
	var color := Color.html(color_str.lstrip("#"))
	var instance := node as MeshInstance3D

	var material := instance.material_override as StandardMaterial3D
	if material == null:
		material = StandardMaterial3D.new()
	material.albedo_color = color
	instance.material_override = material

	_add_log("info", "Painted %s with colour %s" % [node_path, color_str])
	return {"status": "ok", "data": {
		"node": node_path,
		"color": color_str,
		"albedo": _serialize(color),
	}}
func _cmd_greformer_export_gltf(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var output_path: String = str(params.get("output_path", "res://exported_mesh.gltf"))
	var node := get_node_or_null(node_path)
	if node == null or not (node is Node3D):
		return {"status": "error", "error": "Node3D not found: " + node_path}
	# C4: output_path went straight to globalize_path() with no containment check,
	# so this wrote anywhere the process could write -- and it was ungated, so it did
	# so even in read-only mode. Use the same res:// containment every other file
	# command applies.
	var abs_out := _resolve_project_path(output_path)
	if abs_out.is_empty():
		return {"status": "error", "error": "Output path must stay inside res://"}
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var err := document.append_from_scene(node, state)
	if err == OK:
		err = document.write_to_filesystem(state, abs_out)
		if err == OK:
			return {"status": "ok", "data": {"node": node_path, "output_path": output_path, "format": "GLTF"}}
	return {"status": "error", "error": "Failed to export GLTF: " + error_string(err)}

func _cmd_greformer_bevel_edges(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("node_path", ""))
	var node := get_node_or_null(node_path)
	if node == null or not (node is MeshInstance3D):
		return {"status": "error", "error": "MeshInstance3D not found: " + node_path}
	# Previously this logged a line and returned ok having changed nothing. Real edge
	# bevelling needs adjacency analysis that this addon does not implement, and a
	# false success is worse for a calling agent than an explicit refusal.
	return {
		"status": "error",
		"error": "greformer-bevel is not implemented: edge bevelling requires mesh adjacency analysis that this addon does not provide",
	}
func _cmd_greformer_generate_stairs(params: Dictionary) -> Dictionary:
	var steps := clampi(int(params.get("steps", 8)), 1, 128)
	var step_width := maxf(float(params.get("width", 2.0)), 0.05)
	var total_height := maxf(float(params.get("height", 0.25)) * float(steps), 0.05)
	var step_depth := maxf(float(params.get("depth", 0.4)), 0.05)
	var railings := bool(params.get("railings", false))
	var parent := _resolve_generation_parent(params)

	var step_height := total_height / float(steps)
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for i in range(steps):
		# Each tread is a solid box running from the ground up to its own height, so
		# the staircase reads as a solid ramp rather than floating slabs.
		var rise := step_height * float(i + 1)
		_add_box(
			st,
			Vector3(0.0, rise * 0.5, -step_depth * (float(i) + 0.5)),
			Vector3(step_width, rise, step_depth)
		)
	if railings:
		var rail_thickness := 0.08
		var rail_height := 0.9
		for side in [-1.0, 1.0]:
			for i in range(steps):
				var rise := step_height * float(i + 1)
				_add_box(
					st,
					Vector3(
						side * (step_width * 0.5 - rail_thickness * 0.5),
						rise + rail_height * 0.5,
						-step_depth * (float(i) + 0.5)
					),
					Vector3(rail_thickness, rail_height, step_depth)
				)

	var instance := _commit_generated_mesh(st, str(params.get("name", "Stairs")), parent)
	instance.position = _parse_vector3(params.get("position", Vector3.ZERO))
	_add_log("info", "Generated %d-step staircase under %s" % [steps, parent.get_path()])
	return {"status": "ok", "data": {
		"path": str(instance.get_path()),
		"steps": steps,
		"total_height": total_height,
		"step_depth": step_depth,
		"railings": railings,
		"vertex_count": instance.mesh.surface_get_array_len(0),
	}}
func _cmd_inspect_resources(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var node := get_node_or_null(node_path)
	if node == null:
		return {"status": "error", "error": "Node not found: " + node_path}
	var res_list: Array = []
	for p in node.get_property_list():
		var val = node.get(p.get("name"))
		if val is Resource:
			var res := val as Resource
			res_list.append({
				"property": str(p.get("name")),
				"type": res.get_class(),
				"resource_path": res.resource_path if res.resource_path else "in_memory"
			})
	return {"status": "ok", "data": {"node": node_path, "count": res_list.size(), "resources": res_list}}

func _cmd_record_metrics(params: Dictionary) -> Dictionary:
	var duration: float = float(params.get("duration", 1.0))
	var fps := Performance.get_monitor(Performance.TIME_FPS)
	var process_time := Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
	var physics_time := Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0
	var draw_calls := Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	var vram := Performance.get_monitor(Performance.RENDER_TEXTURE_MEM_USED)
	return {"status": "ok", "data": {
		"duration_sec": duration,
		"fps": fps,
		"process_time_ms": process_time,
		"physics_time_ms": physics_time,
		"draw_calls": draw_calls,
		"vram_bytes": vram
	}}

func _cmd_version(_params: Dictionary) -> Dictionary:
	return {"status": "ok", "data": {
		"engine_version": Engine.get_version_info()["string"],
		"major": Engine.get_version_info()["major"],
		"minor": Engine.get_version_info()["minor"],
		"patch": Engine.get_version_info()["patch"],
		"os_name": OS.get_name(),
		"locale": OS.get_locale(),
		"is_debug": OS.is_debug_build()
	}}


# PATCH 02: _add_log() is called in 6 places but was never defined.
const MAX_LOG_ENTRIES := 512

func _add_log(level: String, message: String) -> void:
	_log_buffer.append({
		"level": level,
		"message": message,
		"timestamp_ms": Time.get_ticks_msec(),
	})
	while _log_buffer.size() > MAX_LOG_ENTRIES:
		_log_buffer.remove_at(0)

func _cmd_clear_logs(_params: Dictionary) -> Dictionary:
	var cleared := _log_buffer.size()
	_log_buffer.clear()
	return {"status": "ok", "data": {"cleared_logs": cleared}}

func _cmd_inspect_children(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var depth: int = int(params.get("depth", 1))
	var node := get_node_or_null(node_path)
	if node == null:
		node = get_tree().current_scene if get_tree().current_scene else get_tree().root
	var children: Array = []
	for child in node.get_children():
		var info: Dictionary = {
			"name": str(child.name),
			"type": child.get_class(),
			"path": str(child.get_path())
		}
		if child is Node2D: info["position"] = _serialize((child as Node2D).position)
		elif child is Node3D: info["position"] = _serialize((child as Node3D).position)
		children.append(info)
	return {"status": "ok", "data": {"parent": str(node.get_path()), "count": children.size(), "children": children}}




