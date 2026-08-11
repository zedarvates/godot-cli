extends Node
## GodotCLI Server
## TCP server that accepts newline-delimited JSON commands for controlling the running game.
## Protocol: Each message is a JSON object followed by \n.
## Target: Godot 4.6.x

const DEFAULT_PORT := 9900

var _server: TCPServer = null
var _clients: Array[Dictionary] = []
var _pending_waits: Array[Dictionary] = []

# --- Lifecycle ---

func _ready() -> void:
	var port := DEFAULT_PORT
	for arg in OS.get_cmdline_args():
		if arg.begins_with("--godot-cli-port="):
			port = int(arg.split("=")[1])

	_server = TCPServer.new()
	var err := _server.listen(port)
	if err != OK:
		push_error("GodotCLI: Failed to listen on port %d: %s" % [port, error_string(err)])
		return
	print("GodotCLI: Server listening on port %d" % port)


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept new connections
	while _server.is_connection_available():
		var peer := _server.take_connection()
		_clients.append({"peer": peer, "buffer": ""})

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
						_process_buffer(client)
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
		_handle_message(client, line)


func _handle_message(client: Dictionary, line: String) -> void:
	var parsed = JSON.parse_string(line)
	if parsed == null:
		_send(client, {"id": "", "status": "error", "error": "Invalid JSON"})
		return

	var id: String = str(parsed.get("id", ""))
	var command: String = str(parsed.get("command", ""))
	var params: Dictionary = parsed.get("params", {})

	var result = _execute(command, params, client, id)
	if result != null:
		result["id"] = id
		_send(client, result)


func _send(client: Dictionary, response: Dictionary) -> void:
	var json := JSON.stringify(response) + "\n"
	var peer: StreamPeerTCP = client["peer"]
	peer.put_data(json.to_utf8_buffer())

# --- Command Dispatch ---

func _execute(command: String, params: Dictionary, client: Dictionary = {}, id: String = "") -> Variant:
	match command:
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
		"ping": return {"status": "ok", "data": {"pong": true, "engine": "Godot " + Engine.get_version_info()["string"]}}
		"batch_execute": return _cmd_batch_execute(params, client, id)
		_: return {"status": "error", "error": "Unknown command: " + command}

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
	var max_depth: int = params.get("depth", 10)
	var root_path: String = params.get("root", "")

	var root: Node
	if root_path.is_empty():
		root = get_tree().root
	else:
		root = get_tree().root.get_node_or_null(root_path)
		if root == null:
			return {"status": "error", "error": "Node not found: " + root_path}

	return {"status": "ok", "data": _build_tree(root, max_depth)}


func _build_tree(node: Node, max_depth: int, depth: int = 0) -> Dictionary:
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
			children.append(_build_tree(child, max_depth, depth + 1))
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
	var code: String = params.get("code", "")
	if code.is_empty():
		return {"status": "error", "error": "Missing 'code' parameter"}

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

func _cmd_create_file(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	var content: String = params.get("content", "")

	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var abs_path := path
	if path.begins_with("res://"):
		abs_path = ProjectSettings.globalize_path(path)

	# Ensure parent directory exists
	DirAccess.make_dir_recursive_absolute(abs_path.get_base_dir())

	var file := FileAccess.open(abs_path, FileAccess.WRITE)
	if file == null:
		return {"status": "error", "error": "Cannot write file: " + error_string(FileAccess.get_open_error())}

	file.store_string(content)
	file.close()

	return {"status": "ok", "data": {"path": path, "size": content.length()}}


func _cmd_read_file(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "")
	if path.is_empty():
		return {"status": "error", "error": "Missing 'path' parameter"}

	var abs_path := path
	if path.begins_with("res://"):
		abs_path = ProjectSettings.globalize_path(path)

	var file := FileAccess.open(abs_path, FileAccess.READ)
	if file == null:
		return {"status": "error", "error": "Cannot read file: " + error_string(FileAccess.get_open_error())}

	var content := file.get_as_text()
	file.close()

	return {"status": "ok", "data": {"path": path, "content": content}}


func _cmd_list_files(params: Dictionary) -> Dictionary:
	var path: String = params.get("path", "res://")
	var pattern: String = params.get("pattern", "")

	var abs_path := path
	if path.begins_with("res://"):
		abs_path = ProjectSettings.globalize_path(path)

	var dir := DirAccess.open(abs_path)
	if dir == null:
		return {"status": "error", "error": "Cannot open directory: " + error_string(DirAccess.get_open_error())}

	var files: Array = []
	var dirs: Array = []

	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not file_name.begins_with("."):
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

	var abs_path := path
	if path.begins_with("res://"):
		abs_path = ProjectSettings.globalize_path(path)

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
	var timeout: float = params.get("timeout", 10.0)
	var interval: float = params.get("interval", 0.1)

	if expr.is_empty() and (node_path.is_empty() or property.is_empty()):
		_send(client, {"id": id, "status": "error", "error": "Provide 'expr' or 'path' + 'property'"})
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

	_pending_waits.append({
		"client": client,
		"id": id,
		"expr": expr,
		"path": node_path,
		"property": property,
		"equals": params.get("equals"),
		"timeout": timeout,
		"interval": interval,
		"script": compiled_script,
		"description": description,
		"start_ms": Time.get_ticks_msec(),
		"last_check_ms": 0,
	})

# --- Assert ---

func _cmd_assert(params: Dictionary) -> Dictionary:
	var checks: Array = params.get("checks", [])

	# Support single expression shorthand
	var expr: String = params.get("expr", "")
	if not expr.is_empty():
		checks = [{"expr": expr}]

	# Support single property check shorthand
	if checks.is_empty() and params.has("path"):
		checks = [params]

	if checks.is_empty():
		return {"status": "error", "error": "No checks provided. Use 'expr', 'path'+'property', or 'checks' array."}

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

	_validate_recursive(root, errors, warnings)
	_validate_cameras(root, errors, warnings)

	return {"status": "ok", "data": {
		"valid": errors.is_empty(),
		"error_count": errors.size(),
		"warning_count": warnings.size(),
		"errors": errors,
		"warnings": warnings,
	}}


func _validate_recursive(node: Node, errors: Array, warnings: Array) -> void:
	var path := str(node.get_path())

	# Rule: Physics bodies must have collision shapes
	if node is PhysicsBody2D or node is Area2D:
		var has_shape := false
		for child in node.get_children():
			if child is CollisionShape2D or child is CollisionPolygon2D:
				has_shape = true
				break
		if not has_shape:
			errors.append({
				"rule": "physics_body_needs_shape",
				"path": path,
				"type": node.get_class(),
				"message": "%s has no CollisionShape2D or CollisionPolygon2D child" % node.get_class(),
			})

	if node is PhysicsBody3D or node is Area3D:
		var has_shape := false
		for child in node.get_children():
			if child is CollisionShape3D or child is CollisionPolygon3D:
				has_shape = true
				break
		if not has_shape:
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
		_validate_recursive(child, errors, warnings)


func _validate_cameras(root: Node, errors: Array, warnings: Array) -> void:
	# Check 2D cameras
	var cameras_2d: Array[Camera2D] = []
	_find_nodes_of_type(root, "Camera2D", cameras_2d)
	if cameras_2d.size() > 0:
		var any_current := false
		for cam in cameras_2d:
			if cam.is_current():
				any_current = true
				break
		if not any_current:
			warnings.append({
				"rule": "no_current_camera",
				"message": "Found %d Camera2D nodes but none is current" % cameras_2d.size(),
			})

	# Check 3D cameras
	var cameras_3d: Array[Camera3D] = []
	_find_nodes_of_type(root, "Camera3D", cameras_3d)
	if cameras_3d.size() > 0:
		var any_current := false
		for cam in cameras_3d:
			if cam.current:
				any_current = true
				break
		if not any_current:
			warnings.append({
				"rule": "no_current_camera",
				"message": "Found %d Camera3D nodes but none is current" % cameras_3d.size(),
			})


func _find_nodes_of_type(node: Node, type_name: String, result: Array) -> void:
	if node.is_class(type_name):
		result.append(node)
	for child in node.get_children():
		_find_nodes_of_type(child, type_name, result)

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
	_collect_visible_nodes(root, visible_nodes, type_filter, viewport_rect)

	return {"status": "ok", "data": {
		"viewport": _serialize(viewport_rect),
		"count": visible_nodes.size(),
		"nodes": visible_nodes,
	}}


func _collect_visible_nodes(node: Node, result: Array, type_filter: String, viewport_rect: Rect2) -> void:
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

	# Always recurse — children might be in viewport even if parent position is outside
	for child in node.get_children():
		_collect_visible_nodes(child, result, type_filter, viewport_rect)


func _cmd_batch_execute(params: Dictionary, client: Dictionary, id: String) -> Dictionary:
	var commands: Array = params.get("commands", [])
	var results: Array = []
	for cmd in commands:
		if cmd is Dictionary:
			var c_name: String = str(cmd.get("command", ""))
			var c_params: Dictionary = cmd.get("params", {})
			var res = _execute(c_name, c_params, client, id)
			results.append(res)
		else:
			results.append({"status": "error", "error": "Invalid batch item format"})
	return {"status": "ok", "data": {"results": results}}

