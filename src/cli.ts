#!/usr/bin/env node

import { Command } from "commander";
import { GodotClient, type GodotResponse } from "./client.js";
import { runMcpServer } from "./mcp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const program = new Command();

program
  .name("godot-cli")
  .description(
    "CLI tool for controlling the Godot game engine — like Playwright, but for games"
  )
  .version("0.2.0")
  .option("--host <host>", "Godot server host", "localhost")
  .option("--port <port>", "Godot server port", "9900")
  .option("--mcp", "Run as Stdio MCP (Model Context Protocol) Server for AI Agents");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseValue(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    // Pass as string — Godot will try Expression evaluation (e.g. "Vector2(1, 2)")
    return str;
  }
}

async function run(
  command: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number; exitOnFail?: (data: Record<string, unknown>) => boolean } = {}
): Promise<void> {
  const opts = program.opts();
  const client = new GodotClient({ host: opts.host, port: opts.port });
  try {
    const response: GodotResponse = await client.send(
      command,
      params,
      options.timeoutMs || 10000
    );
    if (response.status === "error") {
      process.stdout.write(JSON.stringify(response, null, 2) + "\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    // Allow commands to exit non-zero based on response data
    if (
      options.exitOnFail &&
      response.data &&
      options.exitOnFail(response.data as Record<string, unknown>)
    ) {
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

function printOverview(): void {
  process.stdout.write(`
godot-cli — like Playwright, but for the Godot game engine
===========================================================
Control a running Godot 4.6+ game from the command line.
All commands output JSON. Requires the GodotCLI addon enabled in your Godot project.

Options: --host <host> (default: localhost)  --port <port> (default: 9900)

SCENE TREE
  scene-tree [--depth N] [--root PATH]      Get the scene tree hierarchy
  load-scene <path>                         Load/change to a scene (res://...)
  save-scene [--path PATH]                  Save current scene to .tscn file

NODE OPERATIONS
  get-node <path>                           Get ALL properties of a node
  set-property <path> <prop> <value>        Set a property (supports Vector2, Color, etc.)
  add-node <parent> <type> [--name N]       Create a node (e.g. Node2D, Sprite2D)
  remove-node <path>                        Remove a node from the tree
  rename-node <path> <name>                 Rename a node
  reparent-node <path> <new-parent>         Move a node to a new parent
  call-method <path> <method> [args...]     Call any method on a node

SCRIPTS
  attach-script <node> <script>             Attach a .gd or .cs script to a node
  detach-script <node>                      Remove script from a node

GDSCRIPT EXECUTION
  eval <code>                               Run GDScript in the live game (single expr auto-returns)

INPUT SIMULATION
  click <x> <y> [--button left|right]       Simulate mouse click at coordinates
  press-key <key> [--shift] [--ctrl] [--alt]  Simulate key press (Space, A, Escape, Up...)
  mouse-move <x> <y>                        Move mouse to position

CAPTURE
  screenshot [--output file.png]            Capture the game viewport to PNG

FILE OPERATIONS
  create-file <path> --content "..."        Write a file in the Godot project
  read-file <path>                          Read a project file
  list-files [path] [--pattern *.gd]        List files in a project directory
  delete-file <path>                        Delete a project file

CLASS REFERENCE
  list-classes [--filter X] [--base Y]      List instantiable Godot engine classes
  class-info <class>                        Get properties, methods, signals for a class

VERIFICATION & TESTING
  wait-for <expr> [--timeout 10]            Wait until a GDScript expression becomes true
  assert <expr>                             Assert condition is true (exit 1 on failure)
  assert --path P --property X --equals V   Assert a node property value
  assert --exists <path>                    Assert a node exists in the tree
  assert --not-exists <path>                Assert a node does NOT exist
  validate-scene                            Structural lint (missing shapes, cameras, textures...)
  viewport-info                             FPS, draw calls, memory, node count, engine version
  visible-nodes [--type Sprite2D]           List nodes currently visible in the viewport

QUICK START
  1. Copy godot-addon/addons/godot_cli/ into your Godot project's addons/ folder
  2. Enable the GodotCLI plugin in Project Settings > Plugins
  3. Run your game — server starts on port 9900
  4. Run: godot-cli scene-tree

VALUE FORMATS
  Primitives:    true, 42, 3.14, "hello"
  Godot types:   "Vector2(100, 200)", "Color(1, 0, 0, 1)", "Rect2(0, 0, 64, 64)"
  JSON objects:  '{"_type": "Vector2", "x": 100, "y": 200}'

Run 'godot-cli <command> --help' for detailed usage of any command.
`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// Scene commands
// ---------------------------------------------------------------------------

program
  .command("scene-tree")
  .description("Get the scene tree hierarchy")
  .option("--depth <depth>", "Maximum depth", "10")
  .option("--root <path>", "Root node path")
  .action(async (opts: { depth: string; root?: string }) => {
    const params: Record<string, unknown> = { depth: parseInt(opts.depth) };
    if (opts.root) params.root = opts.root;
    await run("scene_tree", params);
  });

program
  .command("load-scene")
  .description("Load/change to a scene")
  .argument("<path>", "Scene path (e.g. res://main.tscn)")
  .action(async (scenePath: string) => {
    await run("load_scene", { path: scenePath });
  });

program
  .command("save-scene")
  .description("Save current scene to file")
  .option("--path <path>", "Output path (defaults to current scene path)")
  .action(async (opts: { path?: string }) => {
    const params: Record<string, unknown> = {};
    if (opts.path) params.path = opts.path;
    await run("save_scene", params);
  });

// ---------------------------------------------------------------------------
// Node commands
// ---------------------------------------------------------------------------

program
  .command("get-node")
  .description("Get all properties of a node")
  .argument("<path>", "Node path (e.g. /root/Main/Player)")
  .action(async (nodePath: string) => {
    await run("get_node", { path: nodePath });
  });

program
  .command("set-property")
  .description("Set a property on a node")
  .argument("<path>", "Node path")
  .argument("<property>", "Property name")
  .argument("<value>", 'Value — JSON or Godot expression (e.g. "Vector2(1,2)")')
  .action(async (nodePath: string, property: string, value: string) => {
    await run("set_property", {
      path: nodePath,
      property,
      value: parseValue(value),
    });
  });

program
  .command("add-node")
  .description("Add a new node to the scene tree")
  .argument("<parent>", "Parent node path")
  .argument("<type>", "Node class (e.g. Node2D, Sprite2D)")
  .option("--name <name>", "Node name")
  .option("--props <json>", "Initial properties as JSON object")
  .action(
    async (
      parent: string,
      type: string,
      opts: { name?: string; props?: string }
    ) => {
      const params: Record<string, unknown> = { parent, type };
      if (opts.name) params.name = opts.name;
      if (opts.props) params.properties = JSON.parse(opts.props);
      await run("add_node", params);
    }
  );

program
  .command("remove-node")
  .description("Remove a node from the scene tree")
  .argument("<path>", "Node path")
  .action(async (nodePath: string) => {
    await run("remove_node", { path: nodePath });
  });

program
  .command("reparent-node")
  .description("Move a node to a new parent")
  .argument("<path>", "Node path")
  .argument("<new-parent>", "New parent path")
  .action(async (nodePath: string, newParent: string) => {
    await run("reparent_node", { path: nodePath, new_parent: newParent });
  });

program
  .command("rename-node")
  .description("Rename a node")
  .argument("<path>", "Node path")
  .argument("<name>", "New name")
  .action(async (nodePath: string, name: string) => {
    await run("rename_node", { path: nodePath, name });
  });

program
  .command("call-method")
  .description("Call a method on a node")
  .argument("<path>", "Node path")
  .argument("<method>", "Method name")
  .argument("[args...]", "Method arguments (JSON values)")
  .action(async (nodePath: string, method: string, args: string[]) => {
    const parsedArgs = (args || []).map(parseValue);
    await run("call_method", { path: nodePath, method, args: parsedArgs });
  });

// ---------------------------------------------------------------------------
// Script commands
// ---------------------------------------------------------------------------

program
  .command("attach-script")
  .description("Attach a script to a node")
  .argument("<node-path>", "Node path")
  .argument("<script-path>", "Script path (e.g. res://player.gd)")
  .action(async (nodePath: string, scriptPath: string) => {
    await run("attach_script", { path: nodePath, script: scriptPath });
  });

program
  .command("detach-script")
  .description("Remove script from a node")
  .argument("<node-path>", "Node path")
  .action(async (nodePath: string) => {
    await run("detach_script", { path: nodePath });
  });

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

program
  .command("eval")
  .description("Execute GDScript code in the running game")
  .argument("<code>", "GDScript expression or code block")
  .action(async (code: string) => {
    await run("eval", { code });
  });

// ---------------------------------------------------------------------------
// Input simulation
// ---------------------------------------------------------------------------

program
  .command("click")
  .description("Simulate a mouse click")
  .argument("<x>", "X coordinate")
  .argument("<y>", "Y coordinate")
  .option(
    "--button <button>",
    "Mouse button (left, right, middle)",
    "left"
  )
  .action(async (x: string, y: string, opts: { button: string }) => {
    await run("click", {
      x: parseFloat(x),
      y: parseFloat(y),
      button: opts.button,
    });
  });

program
  .command("press-key")
  .description("Simulate a key press")
  .argument("<key>", "Key name (e.g. Space, A, Escape, Up)")
  .option("--shift", "Hold Shift")
  .option("--ctrl", "Hold Ctrl")
  .option("--alt", "Hold Alt")
  .action(
    async (
      key: string,
      opts: { shift?: boolean; ctrl?: boolean; alt?: boolean }
    ) => {
      await run("press_key", {
        key,
        shift: !!opts.shift,
        ctrl: !!opts.ctrl,
        alt: !!opts.alt,
      });
    }
  );

program
  .command("mouse-move")
  .description("Move mouse to position")
  .argument("<x>", "X coordinate")
  .argument("<y>", "Y coordinate")
  .action(async (x: string, y: string) => {
    await run("mouse_move", { x: parseFloat(x), y: parseFloat(y) });
  });

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

program
  .command("screenshot")
  .description("Capture the game viewport to PNG file or Base64 string")
  .option("--output <path>", "Output file path", "screenshot.png")
  .option("--base64", "Output raw base64 JSON response instead of saving file")
  .action(async (opts: { output: string; base64?: boolean }) => {
    const gopts = program.opts();
    const client = new GodotClient({ host: gopts.host, port: gopts.port });
    try {
      const response = await client.send("screenshot", {});
      if (response.status === "error") {
        process.stderr.write(`Error: ${response.error}\n`);
        process.exit(1);
      }
      const data = response.data as {
        base64_png: string;
        width: number;
        height: number;
      };
      if (opts.base64) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      const buffer = Buffer.from(data.base64_png, "base64");
      const outputPath = path.resolve(opts.output);
      fs.writeFileSync(outputPath, buffer);
      process.stdout.write(
        JSON.stringify(
          {
            status: "ok",
            data: { path: outputPath, width: data.width, height: data.height },
          },
          null,
          2
        ) + "\n"
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// File commands
// ---------------------------------------------------------------------------

program
  .command("create-file")
  .description("Create or overwrite a file in the Godot project")
  .argument("<path>", "File path (e.g. res://scripts/player.gd)")
  .option("--content <content>", "File content as a string")
  .option("--stdin", "Read content from stdin")
  .action(
    async (
      filePath: string,
      opts: { content?: string; stdin?: boolean }
    ) => {
      let content: string;
      if (opts.stdin) {
        content = await readStdin();
      } else if (opts.content != null) {
        content = opts.content;
      } else {
        process.stderr.write("Error: provide --content or --stdin\n");
        process.exit(1);
      }
      await run("create_file", { path: filePath, content });
    }
  );

program
  .command("read-file")
  .description("Read a file from the Godot project")
  .argument("<path>", "File path (e.g. res://scripts/player.gd)")
  .action(async (filePath: string) => {
    await run("read_file", { path: filePath });
  });

program
  .command("list-files")
  .description("List files in a project directory")
  .argument("[path]", "Directory path", "res://")
  .option("--pattern <glob>", "Filename pattern filter (e.g. *.gd)")
  .action(async (dirPath: string, opts: { pattern?: string }) => {
    const params: Record<string, unknown> = { path: dirPath };
    if (opts.pattern) params.pattern = opts.pattern;
    await run("list_files", params);
  });

program
  .command("delete-file")
  .description("Delete a file from the Godot project")
  .argument("<path>", "File path")
  .action(async (filePath: string) => {
    await run("delete_file", { path: filePath });
  });

// ---------------------------------------------------------------------------
// Class info
// ---------------------------------------------------------------------------

program
  .command("list-classes")
  .description("List available Godot engine classes")
  .option("--filter <text>", "Filter classes by name substring")
  .option("--base <class>", "Only show subclasses of this base class")
  .action(async (opts: { filter?: string; base?: string }) => {
    const params: Record<string, unknown> = {};
    if (opts.filter) params.filter = opts.filter;
    if (opts.base) params.base = opts.base;
    await run("list_classes", params);
  });

program
  .command("class-info")
  .description("Get properties, methods, and signals for a Godot class")
  .argument("<class>", "Class name (e.g. Node2D, Sprite2D, CharacterBody2D)")
  .action(async (className: string) => {
    await run("class_info", { class: className });
  });

// ---------------------------------------------------------------------------
// Verification commands
// ---------------------------------------------------------------------------

program
  .command("wait-for")
  .description("Wait until a condition becomes true (with timeout)")
  .argument(
    "[expr]",
    "GDScript expression that should evaluate to true"
  )
  .option("--path <path>", "Node path (alternative to expression)")
  .option("--property <prop>", "Property to check (used with --path)")
  .option("--equals <value>", "Expected value (used with --path)")
  .option("--timeout <seconds>", "Max seconds to wait", "10")
  .option(
    "--interval <seconds>",
    "Check interval in seconds",
    "0.1"
  )
  .action(
    async (
      expr: string | undefined,
      opts: {
        path?: string;
        property?: string;
        equals?: string;
        timeout: string;
        interval: string;
      }
    ) => {
      const timeout = parseFloat(opts.timeout);
      const interval = parseFloat(opts.interval);
      const params: Record<string, unknown> = { timeout, interval };

      if (expr) {
        params.expr = expr;
      } else if (opts.path && opts.property) {
        params.path = opts.path;
        params.property = opts.property;
        if (opts.equals != null) params.equals = parseValue(opts.equals);
      } else {
        process.stderr.write(
          "Error: provide an expression or --path + --property\n"
        );
        process.exit(1);
      }

      // Client timeout = Godot timeout + buffer for network
      await run("wait_for", params, {
        timeoutMs: (timeout + 5) * 1000,
      });
    }
  );

program
  .command("assert")
  .description("Assert conditions about the game state (exit 1 on failure)")
  .argument("[expr]", "GDScript expression that should be true")
  .option("--path <path>", "Node path for property check")
  .option("--property <prop>", "Property name")
  .option("--equals <value>", "Expected value")
  .option("--greater-than <value>", "Value should be greater than")
  .option("--less-than <value>", "Value should be less than")
  .option("--contains <text>", "String should contain text")
  .option("--exists <path>", "Assert node exists at path")
  .option("--not-exists <path>", "Assert node does NOT exist at path")
  .option("--checks <json>", "JSON array of check objects for batch assertions")
  .action(
    async (
      expr: string | undefined,
      opts: {
        path?: string;
        property?: string;
        equals?: string;
        greaterThan?: string;
        lessThan?: string;
        contains?: string;
        exists?: string;
        notExists?: string;
        checks?: string;
      }
    ) => {
      const params: Record<string, unknown> = {};

      if (opts.checks) {
        params.checks = JSON.parse(opts.checks);
      } else if (expr) {
        params.expr = expr;
      } else if (opts.exists) {
        params.checks = [{ exists: opts.exists }];
      } else if (opts.notExists) {
        params.checks = [{ not_exists: opts.notExists }];
      } else if (opts.path && opts.property) {
        const check: Record<string, unknown> = {
          path: opts.path,
          property: opts.property,
        };
        if (opts.equals != null) check.equals = parseValue(opts.equals);
        if (opts.greaterThan != null)
          check.greater_than = parseValue(opts.greaterThan);
        if (opts.lessThan != null)
          check.less_than = parseValue(opts.lessThan);
        if (opts.contains != null) check.contains = opts.contains;
        params.checks = [check];
      } else {
        process.stderr.write(
          "Error: provide an expression, --path + --property, --exists, --not-exists, or --checks\n"
        );
        process.exit(1);
      }

      await run("assert", params, {
        exitOnFail: (data) => data.passed === false,
      });
    }
  );

program
  .command("validate-scene")
  .description(
    "Run structural validation rules on the current scene (physics shapes, cameras, etc.)"
  )
  .action(async () => {
    await run("validate_scene", {}, {
      exitOnFail: (data) => !data.valid,
    });
  });

program
  .command("viewport-info")
  .description(
    "Get viewport and performance info (FPS, draw calls, memory, node count)"
  )
  .action(async () => {
    await run("viewport_info");
  });

program
  .command("visible-nodes")
  .description(
    "List nodes currently visible in the viewport"
  )
  .option("--root <path>", "Root node to start from")
  .option(
    "--type <class>",
    "Filter by node class (e.g. Sprite2D, Control)"
  )
  .action(async (opts: { root?: string; type?: string }) => {
    const params: Record<string, unknown> = {};
    if (opts.root) params.root = opts.root;
    if (opts.type) params.type = opts.type;
    await run("visible_nodes", params);
  });

program
  .command("ping")
  .description("Ping the running Godot game engine to check connection readiness")
  .action(async () => {
    await run("ping");
  });

program
  .command("batch-execute")
  .description("Execute multiple commands in a single TCP request")
  .argument("<json-commands>", "JSON string array of commands, e.g. '[{\"command\": \"ping\"}]'")
  .action(async (jsonStr: string) => {
    try {
      const commands = JSON.parse(jsonStr);
      await run("batch_execute", { commands });
    } catch {
      process.stderr.write("Error: Invalid JSON array format for batch-execute\n");
      process.exit(1);
    }
  });

program
  .command("get-logs")
  .description("Retrieve GDScript runtime logs, errors, and warnings")
  .option("--level <level>", "Filter level (info, warning, error)")
  .option("--clear", "Clear log buffer after fetching")
  .action(async (opts: { level?: string; clear?: boolean }) => {
    await run("get_logs", { level: opts.level, clear: opts.clear });
  });

program
  .command("list-signals")
  .description("List all signals of a node and connected target callables")
  .argument("<path>", "Node path")
  .action(async (nodePath: string) => {
    await run("list_signals", { path: nodePath });
  });

program
  .command("emit-signal")
  .description("Emit a GDScript signal on a node")
  .argument("<path>", "Node path")
  .argument("<signal>", "Signal name")
  .argument("[args...]", "Signal arguments")
  .action(async (nodePath: string, signalName: string, args: string[]) => {
    const parsedArgs = (args || []).map(parseValue);
    await run("emit_signal", { path: nodePath, signal: signalName, args: parsedArgs });
  });

program
  .command("query-ray")
  .description("Perform a 3D or 2D physics raycast query in the world space state")
  .option("--from <vector>", "Start position (e.g. Vector3(0,10,0))", "Vector3(0,10,0)")
  .option("--to <vector>", "End position (e.g. Vector3(0,0,0))", "Vector3(0,0,0)")
  .option("--2d", "Perform 2D raycast instead of 3D")
  .action(async (opts: { from: string; to: string; "2d"?: boolean }) => {
    await run("query_ray", { is_3d: !opts["2d"], from: opts.from, to: opts.to });
  });

program
  .command("query-point")
  .description("Query physics colliders at a specific 3D or 2D point")
  .argument("<point>", "Point position (e.g. Vector3(0,0,0) or Vector2(100,100))")
  .option("--2d", "Perform 2D point query instead of 3D")
  .action(async (pointStr: string, opts: { "2d"?: boolean }) => {
    await run("query_point", { is_3d: !opts["2d"], point: pointStr });
  });

program
  .command("action-press")
  .description("Simulate pressing an InputMap action (e.g. ui_accept, move_forward)")
  .argument("<action>", "Action name")
  .option("--strength <strength>", "Action strength (0.0 to 1.0)", "1.0")
  .action(async (actionName: string, opts: { strength: string }) => {
    await run("action_press", { action: actionName, strength: parseFloat(opts.strength) });
  });

program
  .command("action-release")
  .description("Simulate releasing an InputMap action")
  .argument("<action>", "Action name")
  .action(async (actionName: string) => {
    await run("action_release", { action: actionName });
  });

program
  .command("metrics")
  .description("Get detailed engine performance monitors (FPS, process/physics ms, draw calls, video memory)")
  .action(async () => {
    await run("metrics");
  });

program
  .command("find-nodes")
  .description("Find nodes matching wildcard pattern, class type, or node group")
  .option("--pattern <pattern>", "Name pattern (e.g. *Player* or Enemy*)")
  .option("--type <class>", "Node class (e.g. CharacterBody3D, Sprite2D)")
  .option("--group <group>", "Node group name")
  .option("--root <path>", "Root node path to search from")
  .action(async (opts: { pattern?: string; type?: string; group?: string; root?: string }) => {
    await run("find_nodes", {
      pattern: opts.pattern,
      type: opts.type,
      group: opts.group,
      root: opts.root,
    });
  });

program
  .command("replay")
  .description("Replay a JSON file containing a sequence of commands with delays")
  .argument("<file>", "JSON file path containing script sequence")
  .action(async (filePath: string) => {
    try {
      const fullPath = path.resolve(filePath);
      const content = fs.readFileSync(fullPath, "utf-8");
      const steps = JSON.parse(content);
      if (!Array.isArray(steps)) {
        throw new Error("Replay file must contain a JSON array of command objects");
      }
      const opts = program.opts();
      const client = new GodotClient({ host: opts.host, port: opts.port });
      for (const step of steps) {
        if (step.delay_ms && typeof step.delay_ms === "number" && step.delay_ms > 0) {
          await new Promise((r) => setTimeout(r, step.delay_ms));
        }
        const res = await client.send(step.command, step.params || {});
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Replay Error: ${msg}\n`);
      process.exit(1);
    }
  });

program
  .command("repl")
  .description("Interactive REPL shell connected to running Godot game")
  .action(async () => {
    const opts = program.opts();
    const client = new GodotClient({ host: opts.host, port: opts.port });
    process.stdout.write(`godot-cli REPL (connected to ${opts.host}:${opts.port})\nType 'exit' to quit.\n\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "godot> ",
    });

    rl.prompt();

    rl.on("line", async (line: string) => {
      const trimmed = line.trim();
      if (trimmed === "exit" || trimmed === "quit") {
        rl.close();
        return;
      }
      if (trimmed) {
        try {
          let res: GodotResponse;
          if (["ping", "metrics", "viewport_info", "scene_tree", "get_logs"].includes(trimmed)) {
            res = await client.send(trimmed);
          } else {
            res = await client.send("eval", { code: trimmed });
          }
          process.stdout.write(JSON.stringify(res, null, 2) + "\n");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`REPL Error: ${msg}\n`);
        }
      }
      rl.prompt();
    });
  });

program
  .command("assert-screenshot")
  .description("Assert visual match between current game viewport and golden reference image")
  .requiredOption("--golden <path>", "Golden reference PNG image path")
  .option("--threshold <tolerance>", "Maximum allowed pixel mismatch ratio (0.0 to 1.0)", "0.02")
  .option("--output <path>", "Save captured screenshot to file")
  .action(async (opts: { golden: string; threshold: string; output?: string }) => {
    const gopts = program.opts();
    const client = new GodotClient({ host: gopts.host, port: gopts.port });
    try {
      const response = await client.send("screenshot", {});
      if (response.status === "error") {
        process.stderr.write(`Error: ${response.error}\n`);
        process.exit(1);
      }
      const data = response.data as { base64_png: string; width: number; height: number };
      const currentBuf = Buffer.from(data.base64_png, "base64");

      if (opts.output) {
        fs.writeFileSync(path.resolve(opts.output), currentBuf);
      }

      const goldenPath = path.resolve(opts.golden);
      if (!fs.existsSync(goldenPath)) {
        process.stderr.write(`Error: Golden reference image not found at ${goldenPath}\n`);
        process.exit(1);
      }
      const goldenBuf = fs.readFileSync(goldenPath);

      let diffBytes = 0;
      const minLen = Math.min(currentBuf.length, goldenBuf.length);
      const maxLen = Math.max(currentBuf.length, goldenBuf.length);
      for (let i = 0; i < minLen; i++) {
        if (currentBuf[i] !== goldenBuf[i]) diffBytes++;
      }
      diffBytes += (maxLen - minLen);
      const diffRatio = diffBytes / maxLen;
      const thresholdNum = parseFloat(opts.threshold);

      const passed = diffRatio <= thresholdNum;
      const resultData = {
        passed,
        diff_ratio: parseFloat(diffRatio.toFixed(4)),
        threshold: thresholdNum,
        golden: goldenPath,
        width: data.width,
        height: data.height,
      };

      process.stdout.write(JSON.stringify({ status: passed ? "ok" : "error", data: resultData }, null, 2) + "\n");
      if (!passed) {
        process.exit(1);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Assert Screenshot Error: ${msg}\n`);
      process.exit(1);
    }
  });

program
  .command("spawn-3d")
  .description("Spawn a 3D object in the active Godot scene")
  .option("--type <type>", "Node class name", "MeshInstance3D")
  .option("--name <name>", "Object name", "New3DObject")
  .option("--parent <parent>", "Parent node path", "/root")
  .option("--position <pos>", "Position [x,y,z] or Vector3(x,y,z)")
  .option("--rotation <rot>", "Rotation [x,y,z]")
  .option("--scale <scale>", "Scale [x,y,z]")
  .action(async (opts) => {
    await run("spawn_3d_object", {
      type: opts.type,
      name: opts.name,
      parent_path: opts.parent,
      position: opts.position ? parseValue(opts.position) : undefined,
      rotation: opts.rotation ? parseValue(opts.rotation) : undefined,
      scale: opts.scale ? parseValue(opts.scale) : undefined,
    });
  });

program
  .command("transform-3d")
  .description("Transform a 3D node position, rotation, or scale")
  .argument("<node-path>", "Path to 3D node")
  .option("--position <pos>", "New position")
  .option("--rotation <rot>", "New rotation")
  .option("--scale <scale>", "New scale")
  .option("--relative", "Apply delta position/rotation relatively")
  .action(async (nodePath, opts) => {
    await run("transform_3d_node", {
      node_path: nodePath,
      position: opts.position ? parseValue(opts.position) : undefined,
      rotation: opts.rotation ? parseValue(opts.rotation) : undefined,
      scale: opts.scale ? parseValue(opts.scale) : undefined,
      relative: opts.relative,
    });
  });

program
  .command("inspect-level")
  .description("Inspect surrounding 3D level layout near a center position")
  .option("--center <pos>", "Center position [x,y,z]", "0,0,0")
  .option("--radius <radius>", "Search radius", "20")
  .option("--root <path>", "Root path", "/root")
  .action(async (opts) => {
    await run("inspect_level_layout", {
      center_position: parseValue(opts.center),
      radius: parseFloat(opts.radius),
      node_path: opts.root,
    });
  });

program
  .command("greformer-create")
  .description("Create a GReFormer editable primitive (Box, Stairs, Cylinder)")
  .option("--primitive <type>", "Box, Stairs, or Cylinder", "Box")
  .option("--name <name>", "Object name", "GReFormer_Object")
  .option("--position <pos>", "Position [x,y,z]")
  .action(async (opts) => {
    await run("greformer_create", {
      primitive_type: opts.primitive,
      name: opts.name,
      position: opts.position ? parseValue(opts.position) : undefined,
    });
  });

program
  .command("greformer-push-pull")
  .description("Extrude a GReFormer face along normal (SketchUp Push/Pull)")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--face <index>", "Face index", "0")
  .option("--distance <dist>", "Distance along normal", "1.0")
  .action(async (nodePath, opts) => {
    await run("greformer_push_pull", {
      node_path: nodePath,
      face_index: parseInt(opts.face, 10),
      distance: parseFloat(opts.distance),
    });
  });

program
  .command("greformer-hotspot")
  .description("Apply a Hotspot UV texture mapping to a face")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--face <index>", "Face index", "0")
  .option("--region <region>", "Hotspot region: Wood_Plank, Metal_Trim, Stone_Wall, Bricks", "Wood_Plank")
  .action(async (nodePath, opts) => {
    await run("greformer_apply_hotspot", {
      node_path: nodePath,
      face_index: parseInt(opts.face, 10),
      region_name: opts.region,
    });
  });

program
  .command("greformer-bake")
  .description("Bake a GReFormer editable mesh to standard MeshInstance3D with collision")
  .argument("<node-path>", "Path to GReFormer node")
  .action(async (nodePath) => {
    await run("greformer_bake", {
      node_path: nodePath,
    });
  });

program
  .command("capture-sequence")
  .description("Capture a multi-frame sequence of viewport screenshots as base64 images")
  .option("--count <count>", "Number of frames to capture (default 5, max 30)", "5")
  .action(async (opts: { count: string }) => {
    await run("capture_sequence", { count: parseInt(opts.count, 10) });
  });

program
  .command("export-project-api")
  .description("Scan loaded project GDScript scripts and export custom classes, properties, methods, and signals")
  .action(async () => {
    await run("export_project_api", {});
  });

program
  .command("greformer-export-obj")
  .description("Export a GReFormer node geometry to Wavefront .obj file")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--output <path>", "Output file path (default res://exported_mesh.obj)", "res://exported_mesh.obj")
  .action(async (nodePath, opts) => {
    await run("greformer_export_obj", {
      node_path: nodePath,
      output_path: opts.output,
    });
  });

program
  .command("greformer-preset")
  .description("Create an architectural blockout preset (Wall, Ramp, Pillar, Arch, Doorway)")
  .option("--preset <type>", "Wall, Ramp, Pillar, Arch, Doorway", "Wall")
  .option("--name <name>", "Object name", "GReFormer_Preset")
  .option("--position <pos>", "Position [x,y,z]")
  .action(async (opts) => {
    await run("greformer_create_preset", {
      preset: opts.preset,
      name: opts.name,
      position: opts.position ? parseValue(opts.position) : undefined,
    });
  });

program
  .command("greformer-snap")
  .description("Snap node to grid (0.25m, 0.5m, 1.0m, 2.0m)")
  .argument("<node-path>", "Path to node")
  .option("--step <number>", "Grid step (default 1.0)", "1.0")
  .action(async (nodePath, opts) => {
    await run("greformer_snap_grid", {
      node_path: nodePath,
      step: parseFloat(opts.step),
    });
  });

program
  .command("greformer-carve")
  .description("Carve doorway or window hole into GReFormer node")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--type <door|window>", "Hole type (door or window)", "door")
  .action(async (nodePath, opts) => {
    await run("greformer_carve_hole", {
      node_path: nodePath,
      hole_type: opts.type,
    });
  });

program
  .command("greformer-bevel")
  .description("Bevel / chamfer edges of a GReFormer node")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--offset <number>", "Bevel offset distance", "0.1")
  .action(async (nodePath, opts) => {
    await run("greformer_bevel_edges", {
      node_path: nodePath,
      offset: parseFloat(opts.offset),
    });
  });

program
  .command("greformer-stairs")
  .description("Generate parametric staircase with optional railings")
  .option("--parent <path>", "Parent node path", "/root")
  .option("--steps <number>", "Number of steps", "8")
  .option("--width <number>", "Step width", "2.0")
  .option("--height <number>", "Step height", "0.25")
  .option("--depth <number>", "Step depth", "0.4")
  .option("--railings <boolean>", "Add side railings", "true")
  .action(async (opts) => {
    await run("greformer_generate_stairs", {
      parent: opts.parent,
      step_count: parseInt(opts.steps),
      step_width: parseFloat(opts.width),
      step_height: parseFloat(opts.height),
      step_depth: parseFloat(opts.depth),
      has_railings: opts.railings === "true",
    });
  });

program
  .command("greformer-archway")
  .description("Generate parametric archway or curved tunnel portal")
  .option("--parent <path>", "Parent node path", "/root")
  .option("--width <number>", "Archway width", "3.0")
  .option("--height <number>", "Archway height", "4.0")
  .option("--depth <number>", "Archway depth", "1.0")
  .action(async (opts) => {
    await run("greformer_generate_archway", {
      parent: opts.parent,
      width: parseFloat(opts.width),
      height: parseFloat(opts.height),
      depth: parseFloat(opts.depth),
    });
  });

program
  .command("greformer-array")
  .description("Duplicate GReFormer node in linear or radial array")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--mode <linear|radial>", "Array mode (linear or radial)", "linear")
  .option("--count <number>", "Number of copies", "5")
  .action(async (nodePath, opts) => {
    await run("greformer_array_duplicate", {
      node_path: nodePath,
      mode: opts.mode,
      count: parseInt(opts.count),
    });
  });

program
  .command("greformer-collision")
  .description("Generate convex or trimesh collision shape for GReFormer node")
  .argument("<node-path>", "Path to GReFormer node")
  .option("--mode <convex|trimesh>", "Collision mode (convex or trimesh)", "convex")
  .action(async (nodePath, opts) => {
    await run("greformer_generate_collision", {
      node_path: nodePath,
      mode: opts.mode,
    });
  });

program
  .command("greformer-terrain")
  .description("Generate low-poly heightmap terrain grid")
  .option("--parent <path>", "Parent node path", "/root")
  .option("--width <number>", "Grid width in cells", "16")
  .option("--depth <number>", "Grid depth in cells", "16")
  .option("--height <number>", "Maximum height elevation", "3.0")
  .action(async (opts) => {
    await run("greformer_generate_terrain", {
      parent: opts.parent,
      grid_width: parseInt(opts.width),
      grid_depth: parseInt(opts.depth),
      max_height: parseFloat(opts.height),
    });
  });

program
  .command("greformer-tunnel")
  .description("Generate modular dungeon tunnel / catacomb section")
  .option("--parent <path>", "Parent node path", "/root")
  .option("--length <number>", "Tunnel length", "6.0")
  .option("--width <number>", "Tunnel width", "3.0")
  .option("--height <number>", "Tunnel height", "3.0")
  .action(async (opts) => {
    await run("greformer_generate_tunnel", {
      parent: opts.parent,
      length: parseFloat(opts.length),
      width: parseFloat(opts.width),
      height: parseFloat(opts.height),
    });
  });

program
  .command("undo")
  .description("Undo last editor or scene modification")
  .action(async () => {
    await run("undo", {});
  });

program
  .command("redo")
  .description("Redo previously undone modification")
  .action(async () => {
    await run("redo", {});
  });

program
  .command("fuzzy-find-node")
  .description("Fuzzy search scene tree nodes matching partial query string")
  .argument("<query>", "Partial node name query string")
  .action(async (query: string) => {
    await run("fuzzy_find_node", { query });
  });

program
  .command("profile-performance")
  .description("Deep performance profiler: FPS, frametime, draw calls, VRAM, and orphan node memory leaks")
  .action(async () => {
    await run("profile_performance", {});
  });

program
  .command("inspect-resources")
  .description("Inspect all attached resources (textures, shaders, audio, collision shapes) on a node")
  .argument("<node-path>", "Path to node")
  .action(async (nodePath: string) => {
    await run("inspect_resources", { path: nodePath });
  });

program
  .command("record-metrics")
  .description("Record time-series performance metrics (FPS, process/physics time, VRAM, draw calls)")
  .option("--duration <sec>", "Sample duration in seconds", "1.0")
  .action(async (opts: { duration: string }) => {
    await run("record_metrics", { duration: parseFloat(opts.duration) });
  });

program
  .command("version")
  .description("Get detailed engine version, build details, OS, and locale information")
  .action(async () => {
    await run("version", {});
  });

program
  .command("clear-logs")
  .description("Clear runtime print/warning/error log buffer")
  .action(async () => {
    await run("clear_logs", {});
  });

program
  .command("inspect-children")
  .description("Inspect direct or nested child nodes under a target path")
  .argument("[node-path]", "Path to node", "")
  .option("--depth <number>", "Inspection depth", "1")
  .action(async (nodePath: string, opts: { depth: string }) => {
    await run("inspect_children", { path: nodePath, depth: parseInt(opts.depth, 10) });
  });

program
  .command("init-mcp")
  .description("Generate or update .mcp.json snippet to register godot-cli-mcp server")
  .action(async () => {
    try {
      const mcpPath = path.resolve(".mcp.json");
      let mcpConfig: any = { mcpServers: {} };
      if (fs.existsSync(mcpPath)) {
        try {
          mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
          if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
        } catch {
          mcpConfig = { mcpServers: {} };
        }
      }
      mcpConfig.mcpServers["godot-cli"] = {
        command: "npx",
        args: ["-y", "godot-cli-mcp"],
      };
      fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
      process.stdout.write(JSON.stringify({
        status: "ok",
        message: "Successfully updated .mcp.json with godot-cli-mcp server entry!",
        path: mcpPath,
      }, null, 2) + "\n");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Init MCP Error: ${msg}\n`);
      process.exit(1);
    }
  });

program
  .command("install-addon")
  .description("Copy GodotCLI addon into target Godot project and enable it in project.godot")
  .argument("[target-path]", "Path to Godot project directory", "./")
  .action(async (targetPath: string) => {
    try {
      const projDir = path.resolve(targetPath);
      const projFile = path.join(projDir, "project.godot");
      if (!fs.existsSync(projFile)) {
        process.stderr.write(`Error: No project.godot found at ${projDir}\n`);
        process.exit(1);
      }

      const __dirname = path.dirname(new URL(import.meta.url).pathname);
      let addonSource = path.resolve(__dirname, "../../godot-addon/addons/godot_cli");
      if (!fs.existsSync(addonSource)) {
        addonSource = path.resolve(__dirname, "../godot-addon/addons/godot_cli");
      }

      const destAddonDir = path.join(projDir, "addons", "godot_cli");
      fs.mkdirSync(destAddonDir, { recursive: true });

      if (fs.existsSync(addonSource)) {
        const files = fs.readdirSync(addonSource);
        for (const file of files) {
          const srcFile = path.join(addonSource, file);
          const destFile = path.join(destAddonDir, file);
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, destFile);
          }
        }
      }

      let projContent = fs.readFileSync(projFile, "utf-8");
      const pluginEntry = "res://addons/godot_cli/plugin.cfg";
      if (!projContent.includes(pluginEntry)) {
        if (projContent.includes("[editor_plugins]")) {
          projContent = projContent.replace(
            "[editor_plugins]",
            `[editor_plugins]\n\nenabled=PackedStringArray("${pluginEntry}")`
          );
        } else {
          projContent += `\n[editor_plugins]\n\nenabled=PackedStringArray("${pluginEntry}")\n`;
        }
        fs.writeFileSync(projFile, projContent);
      }

      process.stdout.write(
        JSON.stringify(
          {
            status: "ok",
            message: "GodotCLI addon installed and enabled in project!",
            project: projFile,
            addon: destAddonDir,
          },
          null,
          2
        ) + "\n"
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Install Addon Error: ${msg}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------

program.action(async () => {
  const opts = program.opts();
  if (opts.mcp) {
    await runMcpServer({ host: opts.host, port: opts.port });
  } else {
    printOverview();
  }
});

program.parse();
