# Godot CLI & MCP Agentic Integration Guide

> Complete guide for connecting AI Coding Agents (Antigravity, Claude Code, Cursor, Windsurf) to running Godot game engine instances.

---

## 🤖 1. Quick MCP Setup for AI Agents

To equip your AI Coding Agent with native control over Godot:

```bash
# 1. Install Godot CLI globally or in your project
npm install -g godot-cli

# 2. Auto-generate .mcp.json in your project directory
godot-cli init-mcp
```

This registers the `godot-cli-mcp` Stdio server in `.mcp.json`:

```json
{
  "mcpServers": {
    "godot-cli": {
      "command": "npx",
      "args": ["-y", "godot-cli-mcp"]
    }
  }
}
```

---

## 🎮 2. Installing the Godot Addon

In your target Godot project directory:

```bash
godot-cli install-addon ./
```

This automatically copies `addons/godot_cli` into your project and enables the `GodotCLI` plugin in `project.godot`. When you launch your game, the TCP server listens on port `9900`.

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

To run automated game engine tests on GitHub Actions:

```yaml
- name: Run Godot Game Tests
  run: |
    godot --headless --path ./project &
    npx godot-cli ping
    npx godot-cli assert --exists /root/Main/Player
    npx godot-cli assert-screenshot --golden tests/ref.png
```
