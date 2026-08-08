#!/usr/bin/env node

import { Command } from "commander";
import { GodotClient, type GodotResponse } from "./client.js";
import { inspectAddon, installAddon } from "./addon.js";
import {
  buildDoctorReport,
  CLI_VERSION,
  MAX_ASSERT_CHECKS,
  MAX_SCENE_TREE_DEPTH,
} from "./doctor.js";
import * as fs from "node:fs";
import * as path from "node:path";

const program = new Command();

program
  .name("uo-godot-cli")
  .description(
    "CLI tool for controlling the Godot game engine — like Playwright, but for games"
  )
  .version(CLI_VERSION)
  .option("--host <host>", "Loopback Godot server host", "127.0.0.1")
  .option("--port <port>", "Godot server port", "9900");

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
uo-godot-cli — hardened runtime control for Ultimate Odycer
===========================================================
Control a running Godot 4.7 game from the command line.
All commands output JSON. Requires the GodotCLI addon enabled in your Godot project.
GODOT_CLI_TOKEN (32+ characters) must be set for both Godot and this CLI.

Options: --host <host> (loopback only)  --port <port> (default: 9900)

ADDON MANAGEMENT
  addon status <project>                    Inspect installation and coexistence
  addon install <project> [--dry-run]       Install without enabling the plugin
  addon install <project> --force           Atomically replace a modified copy

COMPATIBILITY
  doctor [--allow-elevated]                 Verify protocol, Godot and safety gates

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
  1. Run: uo-godot-cli addon install /path/to/project --dry-run
  2. Run again without --dry-run after reviewing the JSON plan
  3. Enable the GodotCLI plugin in Project Settings > Plugins
  4. Run your game — server starts on port 9900
  5. Run: uo-godot-cli scene-tree

VALUE FORMATS
  Primitives:    true, 42, 3.14, "hello"
  Godot types:   "Vector2(100, 200)", "Color(1, 0, 0, 1)", "Rect2(0, 0, 64, 64)"
  JSON objects:  '{"_type": "Vector2", "x": 100, "y": 200}'

Run 'uo-godot-cli <command> --help' for detailed usage of any command.
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

function printLocalResult(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function reportLocalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

async function runDoctor(options: { allowElevated?: boolean }): Promise<void> {
  const rootOptions = program.opts();
  const client = new GodotClient({
    host: rootOptions.host,
    port: rootOptions.port,
  });
  try {
    const response = await client.send("server_info");
    if (response.status === "error") {
      printLocalResult(response);
      process.exitCode = 1;
      return;
    }
    const report = buildDoctorReport(response.data, {
      allowElevated: options.allowElevated,
    });
    printLocalResult(report);
    if (report.status !== "ok") process.exitCode = 1;
  } catch (error) {
    reportLocalError(error);
  }
}

// ---------------------------------------------------------------------------
// Compatibility gate
// ---------------------------------------------------------------------------

program
  .command("doctor")
  .description("Verify addon protocol, Godot version and capability gates")
  .option(
    "--allow-elevated",
    "Accept explicitly enabled mutation and unsafe capability gates"
  )
  .action(runDoctor);

// ---------------------------------------------------------------------------
// Addon lifecycle commands (local filesystem only; no runtime token required)
// ---------------------------------------------------------------------------

const addon = program
  .command("addon")
  .description("Inspect or install the bundled GodotCLI addon");

addon
  .command("status")
  .description("Inspect addon integrity and coexistence with godot_ai")
  .argument("<project>", "Godot project directory containing project.godot")
  .action(async (project: string) => {
    try {
      printLocalResult(await inspectAddon(project));
    } catch (error) {
      reportLocalError(error);
    }
  });

addon
  .command("install")
  .description("Install the addon without enabling it in project.godot")
  .argument("<project>", "Godot project directory containing project.godot")
  .option("--dry-run", "Report the planned action without writing files")
  .option("--force", "Atomically replace an existing modified addon")
  .action(
    async (
      project: string,
      options: { dryRun?: boolean; force?: boolean }
    ) => {
      try {
        printLocalResult(
          await installAddon({
            project,
            dryRun: options.dryRun,
            force: options.force,
          })
        );
      } catch (error) {
        reportLocalError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Scene commands
// ---------------------------------------------------------------------------

program
  .command("scene-tree")
  .description("Get the scene tree hierarchy")
  .option("--depth <depth>", "Maximum depth", "10")
  .option("--root <path>", "Root node path")
  .action(async (opts: { depth: string; root?: string }) => {
    const depth = Number(opts.depth);
    if (
      !Number.isInteger(depth) ||
      depth < 0 ||
      depth > MAX_SCENE_TREE_DEPTH
    ) {
      process.stderr.write(
        `Error: --depth must be an integer between 0 and ${MAX_SCENE_TREE_DEPTH}\n`
      );
      process.exitCode = 1;
      return;
    }
    const params: Record<string, unknown> = { depth };
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
  .description("Capture a screenshot of the game viewport")
  .option("--output <path>", "Output file path", "screenshot.png")
  .action(async (opts: { output: string }) => {
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
      const timeout = Number(opts.timeout);
      const interval = Number(opts.interval);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        process.stderr.write("Error: --timeout must be a positive finite number\n");
        process.exitCode = 1;
        return;
      }
      if (!Number.isFinite(interval) || interval <= 0) {
        process.stderr.write("Error: --interval must be a positive finite number\n");
        process.exitCode = 1;
        return;
      }
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
        const checks: unknown = JSON.parse(opts.checks);
        if (!Array.isArray(checks)) {
          throw new Error("--checks must contain a JSON array");
        }
        if (checks.length > MAX_ASSERT_CHECKS) {
          throw new Error(
            `--checks supports at most ${MAX_ASSERT_CHECKS} entries`
          );
        }
        if (checks.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) {
          throw new Error("--checks entries must be JSON objects");
        }
        params.checks = checks;
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

// ---------------------------------------------------------------------------

// Show overview when no command is given
program.action(() => {
  printOverview();
});

program.parseAsync().catch(reportLocalError);
