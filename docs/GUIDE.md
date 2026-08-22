# Godot CLI & MCP Agentic Integration Guide

> Complete guide for connecting AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf) to running Godot game engine instances.

---

## 🤖 1. Quick MCP Setup for AI Agents

To equip your AI Coding Agent with native control over Godot:

```bash
# 1. Build the CLI from this checkout. It is not on npm -- the name `godot-cli`
#    on the public registry belongs to an unrelated project.
npm install && npm run build
alias godot-cli='node "$PWD/dist/src/cli.js"'

# 2. Auto-generate .mcp.json in your project directory
godot-cli init-mcp
```

This registers a Stdio server pointing at the `mcp-cli.js` of *this* installation:

```json
{
  "mcpServers": {
    "godot-cli": {
      "command": "/usr/bin/node",
      "args": ["/abs/path/to/godot-cli/dist/src/mcp-cli.js"],
      "env": { "GODOT_CLI_TOKEN": "${GODOT_CLI_TOKEN}" }
    }
  }
}
```

`GODOT_CLI_TOKEN` must hold the same value the game was launched with, or every
tool call fails the handshake. See the README's
[Authentication and gates](../README.md#authentication-and-gates).

---

## 🎮 2. Installing the Godot Addon

In your target Godot project directory:

```bash
godot-cli install-addon ./
```

This copies `addons/godot_cli` into your project and writes the `[editor_plugins]`,
`[autoload]` and file-logging entries into `project.godot`. The autoload is what matters:
`plugin.gd` alone registers it on `_enter_tree` and drops it again on `_exit_tree`, so a
project without the `project.godot` entry runs with no server.

Then launch the game with a token in the environment:

```bash
export GODOT_CLI_TOKEN=$(openssl rand -hex 32)
export GODOT_CLI_ALLOW_MUTATIONS=1   # needed for anything that changes the game
godot --path ./
```

The TCP server then listens on port `9900`.

---

## ⚡ 3. Common Agent Workflows & Tool Examples

### A. Runtime Visual & Spatial Inspection
```bash
# Get scene tree structure
godot-cli scene-tree --depth 3

# Search for specific player or enemy nodes
godot-cli find-nodes --pattern "*Player*" --type CharacterBody3D

# Query 3D line-of-sight or physics raycast
godot-cli query-ray --from "Vector3(0,10,0)" --to "Vector3(0,0,0)"

# Capture viewport screenshot (with node highlight)
godot-cli highlight-node /root/Main/Player --duration 2.0
godot-cli screenshot --output gameplay.png
```

### B. Live GDScript Debugging & Logging
```bash
# Inspect runtime GDScript errors and warnings
godot-cli get-logs --level error

# Live GDScript expression evaluation
godot-cli eval "get_tree().paused = true"
godot-cli eval "get_node('/root/Main/Player').velocity"
```

### C. InputMap Action & Input Simulation
```bash
# Press InputMap actions (ui_accept, move_forward, etc.)
godot-cli action-press ui_accept --strength 1.0
godot-cli action-release ui_accept

# Simulate key press or mouse click
godot-cli press-key Space
godot-cli click 400 300
```

### D. Automated Visual Regression Testing
```bash
# Assert game view matches reference golden image
godot-cli assert-screenshot --golden tests/golden_level1.png --threshold 0.02
```

---

## 🧪 4. CI/CD Integration

Four things the obvious recipe gets wrong: the server will not start without a token, a
project without the `[autoload]` entry has no server to talk to, `npx godot-cli` fetches
an unrelated package from npm, and `--headless` renders no viewport texture, so the
screenshot commands have nothing to capture.

A working GitHub Actions step:

```yaml
- name: Run Godot game tests
  env:
    # At least 32 characters. A per-run value is fine -- the game and the CLI just
    # have to agree, and both read this same variable.
    GODOT_CLI_TOKEN: ${{ github.run_id }}-${{ github.sha }}
    GODOT_CLI_ALLOW_MUTATIONS: "1"
  run: |
    npm ci && npm run build
    godot_cli() { node dist/src/cli.js "$@"; }

    # Writes the autoload into project.godot. Without this the game starts with
    # no TCP server and every command below fails to connect.
    godot_cli install-addon ./project

    godot --headless --path ./project &
    GODOT_PID=$!
    trap 'kill $GODOT_PID' EXIT

    # The engine needs a moment to boot; there is nothing to connect to yet.
    for i in $(seq 30); do
      godot_cli ping >/dev/null 2>&1 && break
      sleep 1
    done
    godot_cli ping

    godot_cli assert --exists /root/Main/Player
    godot_cli query-ray --from "Vector3(0, 10, 0)" --to "Vector3(0, -10, 0)"
```

### Screenshots in CI

`screenshot` and `assert-screenshot` read the viewport texture, which `--headless` never
allocates. Give the engine a virtual display instead of `--headless`:

```yaml
- run: sudo apt-get install -y xvfb
- run: |
    xvfb-run -a godot --path ./project &
    # ... same readiness loop, then:
    godot_cli assert-screenshot --golden tests/ref.png
```

This repository's own `.github/workflows/ci.yml` runs the headless variant against
`tests/fixture/` on every push and pull request; `tests/integration.test.ts` is the
executable version of the recipe above.
