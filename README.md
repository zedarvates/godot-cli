# godot-cli (Enhanced Agentic Edition)

A CLI & Stdio MCP tool for controlling the Godot game engine — like [Playwright](https://playwright.dev/), but for games.

Designed for **coding agents** (Antigravity, Claude Code, Cursor, Windsurf) to programmatically build, inspect, test, and verify Godot games at runtime. Connects to a running Godot game via TCP and provides 31+ commands and native MCP integration.

## Features & Enhancements

- 🤖 **Native Stdio MCP Server (`--mcp`)**: Connect AI agents directly via JSON-RPC 2.0 without shell subprocess overhead.
- ⚡ **Atomic Batch Execution (`batch-execute`)**: Run multiple commands in a single low-latency TCP payload.
- 📡 **Readiness Probe (`ping`)**: Instantly verify Godot engine availability.
- 🧊 **3D Spatial Types**: Native serialization for `Vector3`, `Quaternion`, `Transform3D`, `Basis`, `AABB`.

## How it works

Two components:

1. **Godot addon** — A TCP server that runs inside your game as an autoload, accepting JSON commands
2. **CLI & MCP Tool** — A Node.js client / Stdio MCP server that sends commands and prints JSON results

```
┌─────────────────────┐     TCP/JSON     ┌──────────────────┐
│  godot-cli (--mcp)  │ ──────────────> │  Godot Game       │
│  (Node.js / Stdio)  │ <────────────── │  (cli_server.gd)  │
└─────────────────────┘   localhost:9900 └──────────────────┘
```

## Setup

### 1. Build the CLI

This package is **not** published to npm. The name `godot-cli` on the public registry
belongs to an unrelated project, so `npm install -g godot-cli` installs someone else's
tool. Build from this checkout instead:

```bash
npm install
npm run build
```

The examples below write `godot-cli`; point that at your build:

```bash
alias godot-cli='node "$PWD/dist/src/cli.js"'
```

### 2. Install the addon into your project

```bash
godot-cli install-addon /path/to/your/godot-project
```

This copies `godot-addon/addons/godot_cli/` into the project and writes the three
`project.godot` entries the server needs:

- the plugin under `[editor_plugins]`,
- the `GodotCLI` **autoload** — without it the running game has no TCP server at all,
- `debug/file_logging/enable_file_logging`, which is where `get-logs` reads
  engine-level errors and warnings from.

### 3. Set the auth token

The server refuses to start without `GODOT_CLI_TOKEN`, and the CLI must present the same
value. It has to be at least 32 characters:

```bash
export GODOT_CLI_TOKEN=$(openssl rand -hex 32)
```

Most commands need a gate opened as well — see
[Authentication and gates](#authentication-and-gates).

### 4. Run your game

```bash
godot --path /path/to/your/godot-project
```

With the autoload installed and the token set, you will see:

```
GodotCLI: Server listening on port 9900
```

If you do not, check the engine output: the server reports why it refused to start and
disables itself, rather than failing at connect time.

## Commands

### Scene tree

```bash
# Get the full scene tree
godot-cli scene-tree

# Get tree from a specific root, limited depth
godot-cli scene-tree --root /root/Main --depth 3

# Load a different scene
godot-cli load-scene res://levels/level2.tscn

# Save the current scene
godot-cli save-scene --path res://scenes/modified.tscn
```

### Node inspection & mutation

```bash
# Get all properties of a node
godot-cli get-node /root/Main/Player

# Set a property
godot-cli set-property /root/Main/Player position "Vector2(100, 200)"
godot-cli set-property /root/Main/Player visible false
godot-cli set-property /root/Main/Player speed 300

# Add a new node
godot-cli add-node /root/Main Sprite2D --name Enemy
godot-cli add-node /root/Main CharacterBody2D --name Player \
  --props '{"position": "Vector2(400, 300)"}'

# Remove, rename, reparent
godot-cli remove-node /root/Main/OldNode
godot-cli rename-node /root/Main/Sprite2D Player
godot-cli reparent-node /root/Main/Weapon /root/Main/Player

# Call a method
godot-cli call-method /root/Main/Player take_damage 25
```

### Scripts

```bash
# Attach a script to a node
godot-cli attach-script /root/Main/Player res://scripts/player.gd

# Detach script
godot-cli detach-script /root/Main/Player
```

### Execute GDScript

```bash
# Single expression (auto-returns the result)
godot-cli eval "get_tree().current_scene.name"
godot-cli eval "get_node('/root/Main/Player').position"

# Multi-line code
godot-cli eval "var p = get_node('/root/Main/Player')
p.position = Vector2(100, 200)
return p.position"
```

### Signals & Events

```bash
# List all signals of a node and target listeners
godot-cli list-signals /root/Main/Player

# Emit a signal programmatically
godot-cli emit-signal /root/Main/Player health_changed 75
```

### Physics & Spatial Queries

```bash
# Perform a 3D raycast query in world physics space
godot-cli query-ray --from "Vector3(0,10,0)" --to "Vector3(0,0,0)"

# Perform a 2D raycast query
godot-cli query-ray --from "Vector2(0,0)" --to "Vector2(500,500)" --2d

# Query physics colliders at a point
godot-cli query-point "Vector3(0, 1, 0)"
```

### Input Map Actions

```bash
# Trigger InputMap action (e.g. ui_accept, move_forward)
godot-cli action-press ui_accept --strength 1.0
godot-cli action-release ui_accept
```

### Runtime Logs & Diagnostics

```bash
# Retrieve GDScript runtime logs, errors, and warnings
godot-cli get-logs --level error
godot-cli get-logs --clear

# Detailed engine performance & render metrics
godot-cli metrics

# Highlight a node in the viewport for visual screenshots
godot-cli highlight-node /root/Main/Player --duration 3.0

# Capability discovery: what this server accepts, and under which gate
godot-cli commands
godot-cli server-info
```

### GReFormer compatibility

Most 3D generation commands are now implemented directly in `godot-cli` and **do not require GReFormer**. The following eight legacy/interoperability commands still require an external addon installed at `res://addons/greformer/`:

| External GReFormer required | Built into godot-cli |
|---|---|
| `greformer_create` | `greformer_generate_stairs` |
| `greformer_push_pull` | `greformer_generate_terrain` |
| `greformer_apply_hotspot` | `greformer_generate_tunnel` |
| `greformer_bake` | `greformer_generate_archway` |
| `greformer_export_obj` | `greformer_generate_collision` |
| `greformer_create_preset` | `greformer_array_duplicate` |
| `greformer_snap_grid` | `greformer_set_shading` |
| `greformer_carve_hole` | `greformer_paint_color` |

The external addon is **optional**. A normal `godot-cli` installation is complete without it. If one of the eight interoperability commands is called without `res://addons/greformer/`, the command must be treated as unavailable rather than as a failure of the core CLI. `greformer_bevel` remains an explicit unsupported operation rather than returning a false success.

This separation is intentional: agents can rely on the built-in command set on a clean Godot project, while projects that already use GReFormer retain compatibility hooks.

### Input simulation

```bash
# Mouse click
godot-cli click 400 300
godot-cli click 400 300 --button right

# Key press
godot-cli press-key Space
godot-cli press-key A --shift
godot-cli press-key S --ctrl

# Mouse move
godot-cli mouse-move 500 400
```

### Screenshots

```bash
# Capture to file (default: screenshot.png)
godot-cli screenshot
godot-cli screenshot --output gameplay.png
```

### File operations

```bash
# Create a script file in the project
godot-cli create-file res://scripts/enemy.gd --content "extends CharacterBody2D

var speed = 100.0

func _physics_process(delta):
    velocity = Vector2(speed, 0)
    move_and_slide()"

# Read a file
godot-cli read-file res://scripts/player.gd

# List project files
godot-cli list-files res://scripts --pattern "*.gd"

# Delete a file
godot-cli delete-file res://scripts/old_script.gd
```

### Class info

```bash
# List all instantiable classes
godot-cli list-classes --filter Sprite
godot-cli list-classes --base Node2D

# Get full class info (properties, methods, signals)
godot-cli class-info CharacterBody2D
```

### Verification & testing

These commands enable coding agents to verify their work:

```bash
# Wait for a condition (polls until true or timeout)
godot-cli wait-for "get_node('/root/Main/Player').is_on_floor()" --timeout 5
godot-cli wait-for --path /root/Main/Player --property is_on_floor --timeout 3

# Assert game state (exit code 1 on failure)
godot-cli assert "get_tree().current_scene.name == 'Main'"
godot-cli assert --path /root/Main/Player --property visible --equals true
godot-cli assert --path /root/Main/Player --property health --greater-than 0
godot-cli assert --exists /root/Main/HUD
godot-cli assert --not-exists /root/Main/GameOverScreen

# Batch assertions
godot-cli assert --checks '[
  {"expr": "get_tree().current_scene.name == \"Main\""},
  {"path": "/root/Main/Player", "property": "visible", "equals": true},
  {"exists": "/root/Main/HUD"}
]'

# Structural validation (checks physics shapes, cameras, sprites, etc.)
godot-cli validate-scene

# Performance & rendering info
godot-cli viewport-info

# What's visible on screen right now
godot-cli visible-nodes
godot-cli visible-nodes --type Control
godot-cli visible-nodes --type Sprite2D
```

## Example: agent workflow

A coding agent building a platformer might do this:

```bash
# 1. Create a player script
godot-cli create-file res://player.gd --content "extends CharacterBody2D
const SPEED = 300.0
const JUMP_VELOCITY = -400.0

func _physics_process(delta):
    if not is_on_floor():
        velocity += get_gravity() * delta
    if Input.is_action_just_pressed('ui_accept') and is_on_floor():
        velocity.y = JUMP_VELOCITY
    var direction = Input.get_axis('ui_left', 'ui_right')
    velocity.x = direction * SPEED
    move_and_slide()"

# 2. Build the scene tree
godot-cli add-node /root/Main CharacterBody2D --name Player
godot-cli add-node /root/Main/Player CollisionShape2D --name Collision
godot-cli add-node /root/Main/Player Sprite2D --name Sprite
godot-cli attach-script /root/Main/Player res://player.gd

# 3. Validate the scene structure
godot-cli validate-scene

# 4. Take a screenshot to visually verify
godot-cli screenshot --output after_setup.png

# 5. Test: press jump key and verify player moves up
godot-cli press-key Space
godot-cli wait-for "get_node('/root/Main/Player').velocity.y < 0" --timeout 1
godot-cli assert --path /root/Main/Player --property velocity --less-than 0

# 6. Check performance
godot-cli viewport-info
```

## Configuration

### Authentication and gates

Four environment variables are read by the addon when the game starts. They must be set
in the environment Godot itself is launched from, not the CLI's.

| variable | required | effect |
|---|---|---|
| `GODOT_CLI_TOKEN` | **yes** | Shared secret, minimum 32 characters. The server exits during `_ready()` without it, and rejects any client that presents a different value. The CLI reads the same variable. |
| `GODOT_CLI_ALLOW_MUTATIONS` | no | Opens the commands that change the running game — `set-property`, `add-node`, `call-method`, the input and greformer commands. Refused by default. |
| `GODOT_CLI_ALLOW_UNSAFE` | no | Opens `eval` and the commands that write files. Refused by default. |
| `GODOT_CLI_PORT` | no | Listen port, default `9900`. Equivalent to `--godot-cli-port=`. |

The two gate variables accept `1`, `true`, `yes` or `on`.

Every command is catalogued as read-only, mutating or unsafe, and anything not in the
catalogue is refused. Ask the running server what it will accept:

```bash
godot-cli commands      # every command and the gate it requires
godot-cli server-info   # protocol version, which gates are open, size limits
```

The server also refuses to start unless `OS.is_debug_build()` is true, so it is inert in
an exported release build.

**Port**: Default is `9900`. Override via command line when launching Godot:

```bash
godot --godot-cli-port=8080
```

Or in the CLI:

```bash
godot-cli --port 8080 scene-tree
```

## Value formats

When setting properties, you can use:

- **JSON primitives**: `true`, `42`, `3.14`, `"hello"`
- **Godot expressions**: `"Vector2(100, 200)"`, `"Color(1, 0, 0, 1)"`, `"Rect2(0, 0, 64, 64)"`
- **Typed JSON objects**: `'{"_type": "Vector2", "x": 100, "y": 200}'`

## Target

- **Godot 4.6** (verified against 4.6.stable, build `89cea1439`)
- **Node.js 18+**

## License

MIT
