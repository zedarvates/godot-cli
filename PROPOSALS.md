# Proposals & Architectural Roadmap for `mattias800/godot-cli`

> **Author**: Sylvain Galliez ([@zedarvates](https://github.com/zedarvates))  
> **Target Repository**: [mattias800/godot-cli](https://github.com/mattias800/godot-cli)  
> **Reference Branch**: `feature/mcp-3d-resilience` on [zedarvates/godot-cli](https://github.com/zedarvates/godot-cli)

---

## 🌟 Overview & Value Proposition

`godot-cli` is a game-changing tool for AI agentic game development (like Playwright for web apps). To take it from a great CLI utility to the **standard protocol for AI-driven game engines**, we propose 5 key architectural enhancements:

---

## 🚀 Proposal 1: Native Stdio MCP (Model Context Protocol) Server (`--mcp`)

### Problem
Currently, coding agents (like Claude Code, Antigravity, Cursor) must invoke `godot-cli` as a CLI binary via shell execution for every single inspection step. This adds process spawning overhead and requires parsing raw CLI stdout text.

### Proposed Solution
Expose a native Stdio MCP Server mode when launching `godot-cli --mcp`.
- Implements JSON-RPC 2.0 (`tools/list` and `tools/call`).
- Registers `godot_scene_tree`, `godot_get_node`, `godot_set_property`, `godot_eval`, `godot_screenshot`, `godot_batch_execute`, etc.
- Allows AI agents to interact with running Godot games natively using standard MCP protocol without shell subprocesses.

---

## ⚡ Proposal 2: Atomic Batch Execution (`batch_execute`)

### Problem
Setting up scene trees or making multiple property checks currently requires $N$ separate TCP socket connections, adding network roundtrips and potential race conditions between frames.

### Proposed Solution
Add a `batch_execute` command to `cli_server.gd` and CLI client:
```json
{
  "command": "batch_execute",
  "params": {
    "commands": [
      { "command": "set_property", "params": { "path": "/root/Main/Player", "property": "speed", "value": 300 } },
      { "command": "call_method", "params": { "path": "/root/Main/Player", "method": "jump" } },
      { "command": "get_node", "params": { "path": "/root/Main/Player" } }
    ]
  }
}
```
All sub-commands execute within a single frame and return a consolidated array of results.

---

## 🧊 Proposal 3: Full 3D Spatial Type Support & Camera Controls

### Problem
Godot 4 games heavily rely on 3D spatial nodes (`Node3D`, `CharacterBody3D`, `MeshInstance3D`, `Camera3D`). The current documentation focuses primarily on 2D primitives.

### Proposed Solution
1. Standardize serialization for 3D types: `Vector3`, `Vector3i`, `Quaternion`, `Transform3D`, `Basis`, `AABB`.
2. Support `Transform3D` string expressions in `set-property` (e.g., `"Transform3D(Basis(), Vector3(0, 5, 10))"`).
3. Add 3D node visibility tracking in `visible_nodes` (with frustum/camera checks for 3D viewports).

---

## 📡 Proposal 4: Engine Readiness Probe (`ping`)

### Problem
Coding agents running automated tests need a clean way to check if the Godot game process has finished booting up and is ready to accept commands.

### Proposed Solution
Add a lightweight `ping` command:
```bash
godot-cli ping
# Response: { "status": "ok", "data": { "pong": true, "engine": "Godot 4.6.1.stable" } }
```

---

## 🔒 Proposal 5: Optional TCP Authentication Token (`--godot-cli-token`)

### Problem
When running games in multi-tenant environments or local networks, port 9900 is unauthenticated, allowing any local process to evaluate arbitrary GDScript.

### Proposed Solution
Add `--godot-cli-token=<secret>` command line argument to Godot execution. If configured, the CLI client must send `{"token": "..."}` in every JSON payload.

---

## 🛠 Status & Pull Request Availability

All proposals above have been implemented, built, and tested in our branch:
👉 **[https://github.com/zedarvates/godot-cli/tree/feature/mcp-3d-resilience](https://github.com/zedarvates/godot-cli/tree/feature/mcp-3d-resilience)**

We are ready to submit these improvements as modular Pull Requests to `mattias800/godot-cli`.
