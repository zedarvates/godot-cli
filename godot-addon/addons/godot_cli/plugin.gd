@tool
extends EditorPlugin

const AUTOLOAD_NAME = "GodotCLI"
const AUTOLOAD_PATH = "res://addons/godot_cli/cli_server.gd"

var _autoload_added_by_plugin := false

func _enter_tree() -> void:
	# `install-addon` persists the autoload directly in project.godot so the TCP
	# server is also present when the project is started without opening the editor.
	# Do not add a duplicate entry if it is already configured.
	if not ProjectSettings.has_setting("autoload/%s" % AUTOLOAD_NAME):
		add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)
		_autoload_added_by_plugin = true
		print("GodotCLI: Plugin enabled - autoload added")
	else:
		print("GodotCLI: Plugin enabled - persistent autoload already configured")

func _exit_tree() -> void:
	# Only remove an autoload that this editor-plugin session created itself.
	# A persistent entry installed by the CLI belongs to the project and must not
	# disappear merely because the editor plugin is disabled or reloaded.
	if _autoload_added_by_plugin:
		remove_autoload_singleton(AUTOLOAD_NAME)
		_autoload_added_by_plugin = false
		print("GodotCLI: Plugin disabled - session autoload removed")
