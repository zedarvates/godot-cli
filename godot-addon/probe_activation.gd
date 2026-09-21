extends Node3D

var ticks := 0
var ready_ran := false
var plain_var := 42
@onready var bound = self


func _ready() -> void:
	ready_ran = true


func _physics_process(_delta: float) -> void:
	ticks += 1
