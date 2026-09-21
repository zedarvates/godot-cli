extends Node
## GodotCLI Server
## TCP server that accepts newline-delimited JSON commands for controlling the running game.
## Protocol: Each message is a JSON object followed by \n.
## Target: Godot 4.7.x

const DEFAULT_PORT := 9900
const BIND_ADDRESS := "127.0.0.1"
const PROTOCOL_VERSION := 1
const ADDON_VERSION := "0.1.0-uo.7"
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
const FOVEA_BRIDGE_PATH := "res://addons/foveacore/scripts/integration/fovea_cli_bridge.gd"
const FOVEA_CONTRACT_VERSION := 1

const CONDITIONALLY_UNSAFE_COMMANDS := {
	"add_node": true,
	"wait_for": true,
	"assert": true,
}

const EVAL_STATEMENT_KEYWORDS := {
	"var": true, "const": true, "static": true, "enum": true, "signal": true,
	"func": true, "class": true, "class_name": true, "extends": true,
	"if": true, "elif": true, "else": true, "for": true, "while": true,
	"match": true, "when": true, "return": true, "pass": true, "break": true,
	"continue": true, "breakpoint": true, "assert": true,
}

const COMMAND_DESCRIPTIONS := {
	"ping": "Probe authenticated Godot runtime readiness.",
	"commands": "List live commands, capability gates, and agent-facing safety metadata.",
	"server_info": "Return the runtime, endpoint, security gates, and protocol limits.",
	"scene_tree": "Inspect a bounded hierarchy of the live scene tree.",
	"get_node": "Read the serialized properties of one live node.",
	"screenshot": "Capture the current viewport as PNG data without writing a project file.",
	"read_file": "Read one bounded project file contained inside res://.",
	"list_files": "List a bounded set of project files contained inside res://.",
	"list_classes": "List bounded Godot engine class metadata.",
	"class_info": "Inspect properties, methods, and signals for one Godot class.",
	"wait_for": "Wait for a bounded property condition or gated expression to become true.",
	"assert": "Evaluate bounded property checks or gated expressions and report pass or fail.",
	"validate_scene": "Run bounded structural validation on the current scene.",
	"fovea_status": "Inspect the optional FoveaCore bridge and live splat nodes.",
	"fovea_validate": "Validate the optional FoveaCore bridge and live splat nodes.",
	"viewport_info": "Read live viewport, rendering, physics, memory, and engine metrics.",
	"visible_nodes": "List a bounded set of nodes visible in the current viewport.",
	"set_property": "Set one property on one live node.",
	"add_node": "Create one unsaved node under a live parent node.",
	"remove_node": "Remove one live node and its descendants.",
	"reparent_node": "Move one live node beneath a different parent.",
	"rename_node": "Rename one live node.",
	"click": "Inject one mouse click into the running project.",
	"press_key": "Inject one bounded key press into the running project.",
	"mouse_move": "Move the simulated mouse pointer to an absolute position.",
	"load_scene": "Replace the current live scene with an existing res:// scene.",
	"fovea_add_splat": "Add one unsaved FoveaSplat3D through the versioned FoveaCore bridge.",
	"call_method": "Invoke an arbitrary method on one live node.",
	"eval": "Compile and execute gated GDScript in the running project.",
	"create_file": "Create or overwrite one bounded project file inside res://.",
	"delete_file": "Delete one project file contained inside res://.",
	"attach_script": "Attach an existing res:// script to one live node.",
	"detach_script": "Detach the script from one live node.",
	"save_scene": "Persist the current live scene to a bounded res:// path.",
}

## Conservative MCP-compatible hints. They improve agent planning but never
## replace the server's authentication, path validation, or capability gates.
const DESTRUCTIVE_COMMANDS := {
	"wait_for": true,
	"assert": true,
	"remove_node": true,
	"load_scene": true,
	"call_method": true,
	"eval": true,
	"create_file": true,
	"delete_file": true,
	"attach_script": true,
	"detach_script": true,
	"save_scene": true,
}

const IDEMPOTENT_MUTATING_COMMANDS := {
	"set_property": true,
	"mouse_move": true,
}

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
	"fovea_status": true,
	"fovea_validate": true,
	"viewport_info": true,
	"visible_nodes": true,
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
	"fovea_add_splat": true,
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
		var conditionally_unsafe := CONDITIONALLY_UNSAFE_COMMANDS.has(command)
		var read_only := security == "read_only" and not conditionally_unsafe
		entries.append({
			"name": command,
			"title": command.replace("_", " ").capitalize(),
			"description": str(COMMAND_DESCRIPTIONS.get(command, "Godot runtime command.")),
			"security": security,
			"enabled": enabled,
			"required_gate": required_gate,
			"conditionally_unsafe": conditionally_unsafe,
			"annotations": {
				"readOnlyHint": read_only,
				"destructiveHint": DESTRUCTIVE_COMMANDS.has(command),
				"idempotentHint": read_only or IDEMPOTENT_MUTATING_COMMANDS.has(command),
				"openWorldHint": true,
			},
		})
	return entries


func _cmd_commands(_params: Dictionary) -> Dictionary:
	var entries: Array[Dictionary] = []
	entries.append_array(_command_catalog_entries(READ_ONLY_COMMANDS, "read_only", true, "none"))
	entries.append_array(_command_catalog_entries(MUTATING_COMMANDS, "mutating", _allow_mutations, "GODOT_CLI_ALLOW_MUTATIONS"))
	entries.append_array(_command_catalog_entries(UNSAFE_COMMANDS, "unsafe", _allow_unsafe, "GODOT_CLI_ALLOW_UNSAFE"))
	return {"status": "ok", "data": {
		"catalog_version": 1,
		"protocol": "godot_cli_tcp_ndjson",
		"mcp_server": false,
		"annotations_are_security_controls": false,
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
		"fovea_status": return _cmd_fovea_status(params)
		"fovea_validate": return _cmd_fovea_validate(params)
		"fovea_add_splat": return _cmd_fovea_add_splat(params)
		"viewport_info": return _cmd_viewport_info(params)
		"visible_nodes": return _cmd_visible_nodes(params)
		_: return {"status": "error", "error": "Unknown command: " + command}


func _command_denial(command: String, params: Dictionary) -> String:
	if READ_ONLY_COMMANDS.has(command):
		if _params_require_unsafe(command, params) and not _allow_unsafe:
			return "Expression execution is disabled; set GODOT_CLI_ALLOW_UNSAFE=1 before launching Godot"
		return ""
	if MUTATING_COMMANDS.has(command):
		if not _allow_mutations:
			return "Mutation commands are disabled; set GODOT_CLI_ALLOW_MUTATIONS=1 before launching Godot"
		if _params_require_unsafe(command, params) and not _allow_unsafe:
			return "Unsafe commands are disabled; set GODOT_CLI_ALLOW_UNSAFE=1 before launching Godot"
		return ""
	if UNSAFE_COMMANDS.has(command):
		if not _allow_unsafe:
			return "Unsafe commands are disabled; set GODOT_CLI_ALLOW_UNSAFE=1 before launching Godot"
		return ""
	return "Command is not present in the security catalog and is refused by default"


func _params_require_unsafe(command: String, params: Dictionary) -> bool:
	if command == "add_node":
		return not str(params.get("script", "")).is_empty()
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
	var script_path: String = params.get("script", "")

	if parent_path.is_empty():
		return {"status": "error", "error": "Missing 'parent' parameter"}
	if type.is_empty() and script_path.is_empty():
		return {"status": "error", "error": "Provide 'type', 'script', or both"}

	var parent := get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		return {"status": "error", "error": "Parent not found: " + parent_path}

	var node: Node = null
	if not script_path.is_empty():
		if _resolve_project_path(script_path).is_empty():
			return {"status": "error", "error": "Script path must stay inside res://"}
		var script := _load_script(script_path)
		if script == null:
			return {"status": "error", "error": "Cannot load script: " + script_path}
		var instance = script.new()
		if not (instance is Node):
			if instance is Object:
				(instance as Object).free()
			return {"status": "error", "error": "Script does not extend Node: " + script_path}
		node = instance as Node
		if not type.is_empty() and not node.is_class(type):
			var actual_type := node.get_class()
			node.free()
			return {"status": "error", "error": "Script instantiates a %s, not a %s" % [actual_type, type]}
	else:
		if not ClassDB.class_exists(type):
			return {"status": "error", "error": "Unknown class: " + type}
		if not ClassDB.can_instantiate(type):
			return {"status": "error", "error": "Cannot instantiate: " + type}
		node = ClassDB.instantiate(type) as Node
	if node_name:
		node.name = node_name

	for key in properties:
		node.set(key, _deserialize(properties[key]))

	parent.add_child(node)
	if get_tree().current_scene:
		_set_owner_recursive(node, get_tree().current_scene)

	return {"status": "ok", "data": {
		"path": str(node.get_path()),
		"type": node.get_class(),
		"name": str(node.name),
		"script": script_path,
		"processing": node.is_processing(),
		"physics_processing": node.is_physics_processing(),
	}}


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

	var lines := code.split("\n")
	var trimmed := code.strip_edges()

	if _eval_has_await(trimmed):
		return {"status": "error", "error": "eval cannot await; use wait-for with an expression instead"}

	if lines.size() == 1 and not trimmed.is_empty() and _eval_is_expression(trimmed):
		var expression_result := _eval_run("extends Node\n\nfunc _exec():\n\treturn " + trimmed + "\n", true)
		if bool(expression_result["ok"]):
			return {"status": "ok", "form": "expression", "data": _serialize(expression_result["value"])}

	var indented := ""
	for line in lines:
		indented += "\t" + line + "\n"

	var statement_result := _eval_run("extends Node\n\nfunc _exec():\n" + indented, false)
	if not bool(statement_result["ok"]):
		return {"status": "error", "error": "GDScript compilation error"}
	return {"status": "ok", "form": "statement", "data": _serialize(statement_result["value"])}


func _eval_run(source: String, silence_parse_errors: bool) -> Dictionary:
	var script := GDScript.new()
	script.source_code = source
	var err: int
	if silence_parse_errors:
		var was_printing := Engine.print_error_messages
		Engine.print_error_messages = false
		err = script.reload()
		Engine.print_error_messages = was_printing
	else:
		err = script.reload()
	if err != OK:
		return {"ok": false, "value": null}
	var obj = script.new()
	add_child(obj)
	var value = obj.call("_exec")
	obj.queue_free()
	return {"ok": true, "value": value}


func _eval_is_expression(line: String) -> bool:
	if line.begins_with("@"):
		return false
	if EVAL_STATEMENT_KEYWORDS.has(_eval_leading_word(line)):
		return false
	return not _eval_has_top_level_assignment(line)


func _eval_leading_word(line: String) -> String:
	var out := ""
	for i in range(line.length()):
		var c := line[i]
		var alpha := (c >= "a" and c <= "z") or (c >= "A" and c <= "Z") or c == "_"
		var digit := c >= "0" and c <= "9"
		if alpha or (not out.is_empty() and digit):
			out += c
		else:
			break
	return out


func _eval_has_top_level_assignment(line: String) -> bool:
	var depth := 0
	var i := 0
	var n := line.length()
	while i < n:
		var c := line[i]
		if c == "#":
			return false
		if c == "\"" or c == "'":
			i = _eval_skip_string(line, i)
			continue
		if c == "(" or c == "[" or c == "{":
			depth += 1
		elif c == ")" or c == "]" or c == "}":
			depth -= 1
		elif c == "=" and depth <= 0:
			if i + 1 < n and line[i + 1] == "=":
				i += 2
				continue
			var previous := line[i - 1] if i > 0 else " "
			if previous == "<" or previous == ">":
				if i >= 2 and line[i - 2] == previous:
					return true
				i += 1
				continue
			if previous == "!" or previous == "=":
				i += 1
				continue
			return true
		i += 1
	return false


func _eval_skip_string(line: String, start: int) -> int:
	var quote := line[start]
	var n := line.length()
	if start + 2 < n and line[start + 1] == quote and line[start + 2] == quote:
		var close := line.find(quote + quote + quote, start + 3)
		return n if close == -1 else close + 3
	var i := start + 1
	while i < n:
		var c := line[i]
		if c == "\\":
			i += 2
			continue
		if c == quote:
			return i + 1
		i += 1
	return n


func _eval_has_await(line: String) -> bool:
	return _eval_leading_word(line) == "await" or line.contains(" await ")

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
	if node == self:
		return {"status": "error", "error": "Refusing to script the CLI server itself"}
	if node == get_tree().root:
		return {"status": "error", "error": "Refusing to script the root Window"}

	var script := _load_script(script_path)
	if script == null:
		return {"status": "error", "error": "Cannot load script: " + script_path}

	var native_base := script.get_instance_base_type()
	if not native_base.is_empty() and not node.is_class(native_base):
		return {"status": "error", "error": "Script extends %s but %s is a %s" % [native_base, node_path, node.get_class()]}

	node.set_script(script)
	if node.get_script() != script:
		return {"status": "error", "error": "set_script() was rejected for " + node_path}

	var activate := true
	if params.has("activate"):
		activate = bool(params["activate"])
	elif bool(params.get("no_activate", false)):
		activate = false
	if activate:
		node.notification(NOTIFICATION_READY)

	return {"status": "ok", "data": {
		"node": node_path,
		"script": script_path,
		"activated": activate,
		"processing": node.is_processing(),
		"physics_processing": node.is_physics_processing(),
	}}


func _load_script(script_path: String) -> Script:
	return ResourceLoader.load(script_path, "", ResourceLoader.CACHE_MODE_IGNORE) as Script


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
				var read := _read_property(node, wait["property"] as String)
				if not bool(read["ok"]):
					_send(wait["client"], {
						"id": wait["id"],
						"status": "error",
						"error": read["error"],
					})
					to_remove.append(i)
					continue
				var value = read["value"]
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
				var read := _read_property(node, prop_name)
				if not bool(read["ok"]):
					results.append({
						"type": "property",
						"path": c["path"],
						"property": prop_name,
						"passed": false,
						"error": read["error"],
					})
					all_passed = false
					continue
				var value = read["value"]
				var passed := false
				var expected = null

				if c.has("equals"):
					passed = _values_equal(value, _deserialize(c["equals"]))
					expected = _serialize(_deserialize(c["equals"]))
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
				if expected != null:
					result["expected"] = expected
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


# --- Optional FoveaCore automation contract ---

func _probe_fovea_bridge() -> Dictionary:
	if not ResourceLoader.exists(FOVEA_BRIDGE_PATH):
		return {
			"ok": false,
			"reason": "foveacore_bridge_not_found",
			"message": "FoveaCore automation bridge is not installed",
		}
	var bridge_script := load(FOVEA_BRIDGE_PATH) as Script
	if bridge_script == null:
		return {
			"ok": false,
			"reason": "foveacore_bridge_load_failed",
			"message": "FoveaCore automation bridge could not be loaded",
		}
	var bridge := bridge_script.new() as RefCounted
	if bridge == null or not bridge.has_method("contract"):
		return {
			"ok": false,
			"reason": "foveacore_bridge_contract_missing",
			"message": "FoveaCore automation bridge does not expose contract()",
		}
	var contract_value: Variant = bridge.call("contract")
	if not contract_value is Dictionary:
		return {
			"ok": false,
			"reason": "foveacore_bridge_contract_invalid",
			"message": "FoveaCore automation contract must be a dictionary",
		}
	var contract: Dictionary = contract_value as Dictionary
	if int(contract.get("version", -1)) != FOVEA_CONTRACT_VERSION:
		return {
			"ok": false,
			"reason": "foveacore_bridge_version_mismatch",
			"message": "Expected FoveaCore automation contract version %d" % FOVEA_CONTRACT_VERSION,
			"contract": contract,
		}
	if contract.get("writes_files", true) != false \
			or contract.get("starts_network_listener", true) != false:
		return {
			"ok": false,
			"reason": "foveacore_bridge_security_contract_rejected",
			"message": "FoveaCore bridge must not write files or start a network listener",
			"contract": contract,
		}
	var operations_value: Variant = contract.get("operations", [])
	if not operations_value is Array:
		return {
			"ok": false,
			"reason": "foveacore_bridge_operations_invalid",
			"message": "FoveaCore automation operations must be an array",
			"contract": contract,
		}
	var operations: Array = operations_value as Array
	for operation: String in ["status", "validate", "add_splat"]:
		if operation not in operations:
			return {
				"ok": false,
				"reason": "foveacore_bridge_operation_missing",
				"message": "FoveaCore automation contract is missing operation: " + operation,
				"contract": contract,
			}
	for method: String in ["status", "validate", "add_splat"]:
		if not bridge.has_method(method):
			return {
				"ok": false,
				"reason": "foveacore_bridge_method_missing",
				"message": "FoveaCore automation bridge is missing method: " + method,
				"contract": contract,
			}
	return {
		"ok": true,
		"bridge": bridge,
		"contract": contract,
	}


func _call_fovea_bridge(method: String, arguments: Array) -> Dictionary:
	var probe: Dictionary = _probe_fovea_bridge()
	if not bool(probe.get("ok", false)):
		return {
			"status": "error",
			"error": str(probe.get("message", "FoveaCore automation bridge is unavailable")),
			"data": {
				"available": false,
				"compatible": false,
				"reason": probe.get("reason", "foveacore_bridge_unavailable"),
				"expected_contract_version": FOVEA_CONTRACT_VERSION,
				"contract": probe.get("contract", null),
			},
		}
	var bridge: RefCounted = probe["bridge"] as RefCounted
	var result_value: Variant = bridge.callv(method, arguments)
	if not result_value is Dictionary:
		return {"status": "error", "error": "FoveaCore bridge returned an invalid response"}
	var result: Dictionary = result_value as Dictionary
	if not bool(result.get("ok", false)):
		return {"status": "error", "error": str(result.get("error", "FoveaCore operation failed"))}
	var data_value: Variant = result.get("data", {})
	if not data_value is Dictionary:
		return {"status": "error", "error": "FoveaCore bridge data must be a dictionary"}
	var data: Dictionary = data_value as Dictionary
	data["compatible"] = true
	return {"status": "ok", "data": data}


func _cmd_fovea_status(_params: Dictionary) -> Dictionary:
	var result: Dictionary = _call_fovea_bridge("status", [get_tree(), MAX_SCENE_NODES])
	if result.get("status") == "error" and result.has("data"):
		# FoveaCore is optional: discovery remains a successful read-only probe.
		return {"status": "ok", "data": result["data"]}
	return result


func _read_property(node: Object, property: String) -> Dictionary:
	for entry in node.get_property_list():
		if entry["name"] == property:
			return {"ok": true, "value": node.get(property)}
	if node.has_method(property):
		return {"ok": false, "error": "'%s' is a method, not a property; use call-method or an expression" % property}
	return {"ok": true, "value": node.get(property)}


func _cmd_fovea_validate(_params: Dictionary) -> Dictionary:
	var result: Dictionary = _call_fovea_bridge("validate", [get_tree(), MAX_SCENE_NODES])
	if result.get("status") == "error" and result.has("data"):
		var data: Dictionary = result["data"] as Dictionary
		data["valid"] = false
		data["complete"] = true
		data["error_count"] = 1
		data["warning_count"] = 0
		data["errors"] = [{
			"rule": str(data.get("reason", "foveacore_bridge_unavailable")),
			"message": str(result.get("error", "FoveaCore automation bridge is unavailable")),
		}]
		data["warnings"] = []
		return {"status": "ok", "data": data}
	return result


func _cmd_fovea_add_splat(params: Dictionary) -> Dictionary:
	return _call_fovea_bridge("add_splat", [get_tree(), params])

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
