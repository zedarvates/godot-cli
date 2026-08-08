# Ultimate Odycer Godot Runtime CLI

> Hardened local fork of [mattias800/godot-cli](https://github.com/mattias800/godot-cli).
> It is a development/testing tool, not a gameplay dependency. The fork uses
> the `uo-godot-cli` executable to avoid the unrelated `godot-cli` npm package.

A CLI tool for controlling the Godot game engine — like [Playwright](https://playwright.dev/), but for games.

Designed for **coding agents** (like Claude Code) to programmatically build, inspect, test, and verify Godot games at runtime. Connects to a running Godot 4.6+ game via TCP and provides 29 commands for full control.

## How it works

Two components:

1. **Godot addon** — A TCP server that runs inside your game as an autoload, accepting JSON commands
2. **CLI tool** — A Node.js client that sends commands and prints JSON results

```
┌─────────────┐     TCP/JSON     ┌──────────────────┐
│ uo-godot-cli │ ──────────────> │  Godot Game       │
│  (Node.js)   │ <────────────── │  (cli_server.gd)  │
└─────────────┘   localhost:9900 └──────────────────┘
```

## Setup

### 1. Build the local CLI

```bash
npm install
npm run build
npm link
```

The examples below retain the upstream `godot-cli` spelling for readability.
For this fork, replace that executable with `uo-godot-cli`; invoking the bare
`godot-cli` command may run the unrelated Godot-MCP npm package installed on
the workstation.

### Security prerequisites

Set a fresh token of at least 32 characters **before launching Godot** and in
the terminal running the CLI:

```powershell
$env:GODOT_CLI_TOKEN = '<fresh-random-token>'
```

The server binds only to `127.0.0.1`, refuses release builds, limits message
and file sizes, caps concurrent clients at eight, expires unauthenticated
connections after two seconds, bounds scene traversal/assertion batches, and
starts in read-only mode. The client revalidates
`localhost` DNS answers, caps outgoing requests, decodes split UTF-8 safely,
and verifies each response ID and status. Optional capabilities must be
enabled before launching Godot:

```powershell
$env:GODOT_CLI_ALLOW_MUTATIONS = '1' # scene/runtime mutations and input
$env:GODOT_CLI_ALLOW_UNSAFE = '1'    # eval, method calls, script/file writes
```

See [SECURITY.md](SECURITY.md) for the enforced boundary.

### Compatibility doctor

Run the authenticated compatibility gate after Godot starts:

```bash
uo-godot-cli doctor
```

It fails closed unless the addon version and protocol match, Godot 4.7 is
running as a debug build on loopback, and mutation/unsafe gates are disabled.
For an intentionally elevated development session, acknowledge that state:

```bash
uo-godot-cli doctor --allow-elevated
```

### Validation status

The P0 suite (version `0.1.0-uo.4`) passes 29/29 checks: seven isolated installer/status
controls, the Node protocol and security invariant controls, and four headless
runtime scenarios with Godot 4.7-dev5 against the isolated addon fixture. `validate-scene`
is fail-closed: it enforces a 4,096-node and 64-depth budget, returning `complete: false`,
`valid: false`, and a `validation_budget_exceeded` error when truncated. This is a real
CLI/addon protocol proof, not yet proof of integration into the canonical Ultimate Odycer
client; that step remains `[Scaffolding / Proxy]`.

### 2. Inspect and install the Godot addon

Inspect the project first. This command is read-only and does not require the
runtime token:

```bash
uo-godot-cli addon status /path/to/your/godot-project
```

Preview the installation, then apply it after reviewing the JSON result:

```bash
uo-godot-cli addon install /path/to/your/godot-project --dry-run
uo-godot-cli addon install /path/to/your/godot-project
```

The installer requires a real `project.godot`, copies only into
`addons/godot_cli`, verifies the bundled files, and does not edit or enable
anything in `project.godot`. An existing modified copy is refused unless
`--force` is explicitly supplied. If `godot_ai` is active, status reports the
overlapping-control-plane warning before activation.

### 3. Enable the plugin

In Godot: **Project → Project Settings → Plugins** → Enable **GodotCLI**

### 4. Run your game

The TCP server starts automatically when the game runs. You'll see:
```
GodotCLI: Server listening on 127.0.0.1:9900 (read-only mode)
```

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

- **Godot 4.7** (automated headless validation with 4.7-dev5; inherited
  upstream compatibility starts at 4.6)
- **Node.js 18+**

## License

MIT
