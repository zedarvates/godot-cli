extends RefCounted

## Test-only contract fixture for the optional FoveaCore protocol surface.
## The real implementation lives in the FoveaEngine repository.

const FoveaSplat3DScript := preload("res://fovea_stub.gd")


func contract() -> Dictionary:
	return {
		"name": "foveacore-cli",
		"version": 1,
		"public_node": "FoveaSplat3D",
		"supported_extensions": ["fovea", "ply", "splat"],
		"operations": ["status", "validate", "add_splat"],
		"writes_files": false,
		"starts_network_listener": false,
	}


func status(tree: SceneTree, max_nodes: int) -> Dictionary:
	var splats: Array[Dictionary] = []
	var visited := 0
	var stack: Array[Node] = []
	if tree.current_scene != null:
		stack.append(tree.current_scene)
	while not stack.is_empty() and visited < max_nodes:
		var node: Node = stack.pop_back()
		visited += 1
		if node.get_script() == FoveaSplat3DScript:
			splats.append({
				"path": str(node.get_path()),
				"source_path": str(node.get("source_path")),
			})
		for child: Node in node.get_children():
			stack.append(child)
	return {"ok": true, "data": {
		"available": true,
		"contract": contract(),
		"scene_present": tree.current_scene != null,
		"splat_count": splats.size(),
		"splats": splats,
		"complete": stack.is_empty(),
		"visited_nodes": visited,
		"max_nodes": max_nodes,
	}}


func validate(tree: SceneTree, max_nodes: int) -> Dictionary:
	var status_result: Dictionary = status(tree, max_nodes)
	var data: Dictionary = status_result["data"]
	var errors: Array[Dictionary] = []
	for item_value: Variant in data["splats"]:
		var item: Dictionary = item_value as Dictionary
		if not FileAccess.file_exists(str(item["source_path"])):
			errors.append({"rule": "fovea_source_invalid", "path": item["path"]})
	return {"ok": true, "data": {
		"available": true,
		"contract": contract(),
		"valid": errors.is_empty(),
		"complete": data["complete"],
		"splat_count": data["splat_count"],
		"visited_nodes": data["visited_nodes"],
		"max_nodes": max_nodes,
		"error_count": errors.size(),
		"warning_count": 0,
		"errors": errors,
		"warnings": [],
	}}


func add_splat(tree: SceneTree, params: Dictionary) -> Dictionary:
	var parent_path := str(params.get("parent", ""))
	var source_path := str(params.get("source_path", ""))
	if not source_path.begins_with("res://") or ".." in source_path:
		return {"ok": false, "error": "Fovea source path must stay inside res://"}
	if not FileAccess.file_exists(source_path):
		return {"ok": false, "error": "Fovea source file not found: " + source_path}
	var parent: Node = tree.root.get_node_or_null(parent_path)
	if parent == null:
		return {"ok": false, "error": "Parent not found: " + parent_path}
	var splat: Node3D = FoveaSplat3DScript.new()
	splat.name = str(params.get("name", "CliFixtureSplat"))
	splat.set("source_path", source_path)
	splat.set("quality_preset", 2 if params.get("quality") == "balanced" else 0)
	splat.set("opacity", float(params.get("opacity", 1.0)))
	splat.set("generate_collisions", bool(params.get("generate_collisions", false)))
	splat.set("is_static", bool(params.get("is_static", true)))
	parent.add_child(splat)
	if tree.current_scene != null:
		splat.owner = tree.current_scene
	return {"ok": true, "data": {
		"contract_version": 1,
		"path": str(splat.get_path()),
		"name": str(splat.name),
		"type": "FoveaSplat3D",
		"source_path": source_path,
		"quality": str(params.get("quality", "auto")),
		"opacity": splat.get("opacity"),
		"generate_collisions": splat.get("generate_collisions"),
		"is_static": splat.get("is_static"),
		"persisted": false,
	}}
