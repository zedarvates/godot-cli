@tool
extends EditorPlugin

const AUTOLOAD_NAME = "GodotCLI"

func _enter_tree() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, "res://addons/godot_cli/cli_server.gd")
	print("GodotCLI: Plugin enabled - autoload added")

func _exit_tree() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
	print("GodotCLI: Plugin disabled - autoload removed")
