extends Node3D
class_name FoveaSplat3D

## Test-only public-node fixture. The production CLI package does not ship it.

@export var source_path := ""
@export var quality_preset := 0
@export_range(0.0, 1.0) var opacity := 1.0
@export var generate_collisions := false
@export var is_static := true
