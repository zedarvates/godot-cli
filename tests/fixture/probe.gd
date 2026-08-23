extends Node3D
## Probe for the activation tests: exercises _ready, a process callback and an
## @onready binding, all three of which stay dead if a script is attached to a
## node that is already in the tree without the ready notification.

var ticks := 0
var ready_ran := false
var plain_var := 42
@onready var bound = self


func _ready() -> void:
	ready_ran = true


func _physics_process(_delta: float) -> void:
	ticks += 1
