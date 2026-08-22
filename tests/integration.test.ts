// Integration test against a real Godot engine.
//
// The rest of the suite talks to fake TCP servers and never loads cli_server.gd.
// That is why an addon which did not compile on Godot 4.6, and a client which never
// sent the auth token its own server required, both passed CI. This test launches
// the real engine, installs the addon the way a user would, and exercises one
// command per family end to end.
//
// Skips cleanly when no Godot binary is available so unit-test runs stay fast.
// Point it at a binary with GODOT_BIN, or have `godot` on PATH.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GodotClient } from "../src/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const fixtureSrc = path.join(repoRoot, "tests", "fixture");
const cliEntry = path.join(repoRoot, "dist", "src", "cli.js");
const PORT = 9931;

function findGodot(): string | null {
  const explicit = process.env.GODOT_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const candidate of ["godot", "godot4"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const godot = findGodot();

test(
  "godot-cli drives a real Godot engine end to end",
  { skip: godot ? false : "no Godot binary found (set GODOT_BIN)" },
  async (t) => {
    const workDir = fs.mkdtempSync(path.join(repoRoot, ".integration-"));
    const projectDir = path.join(workDir, "project");
    fs.cpSync(fixtureSrc, projectDir, { recursive: true });

    const token = randomBytes(32).toString("hex");
    const env = {
      ...process.env,
      GODOT_CLI_TOKEN: token,
      GODOT_CLI_ALLOW_MUTATIONS: "1",
      GODOT_CLI_ALLOW_UNSAFE: "1",
    };
    let engine: ChildProcess | null = null;

    t.after(() => {
      engine?.kill();
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    // install-addon alone must fully provision the project: files copied, plugin
    // enabled, and crucially the [autoload] entry written. Without that entry a
    // game launched outside the editor starts with no TCP server at all.
    const install = spawnSync(process.execPath, [cliEntry, "install-addon", projectDir], {
      encoding: "utf8",
      env,
    });
    assert.equal(install.status, 0, `install-addon failed: ${install.stderr}`);
    const projectFile = fs.readFileSync(path.join(projectDir, "project.godot"), "utf8");
    assert.match(projectFile, /\[autoload\]/);
    assert.match(projectFile, /res:\/\/addons\/godot_cli\/cli_server\.gd/);

    // Import once so the engine has a resource cache, then launch headless.
    spawnSync(godot!, ["--headless", "--path", projectDir, "--import", "--quit"], { env });

    const startupLog: string[] = [];
    engine = spawn(
      godot!,
      ["--headless", "--path", projectDir, `--godot-cli-port=${PORT}`],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    engine.stdout?.on("data", (d) => startupLog.push(d.toString()));
    engine.stderr?.on("data", (d) => startupLog.push(d.toString()));

    // The addon must compile and bind. A parse error here means the autoload never
    // instantiated -- the exact failure the fake-server tests cannot see.
    const deadline = Date.now() + 60_000;
    let listening = false;
    while (Date.now() < deadline && !listening) {
      const text = startupLog.join("");
      assert.doesNotMatch(text, /Parse Error/, `addon failed to compile:\n${text}`);
      if (text.includes(`Server listening on 127.0.0.1:${PORT}`)) listening = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(listening, `server never started:\n${startupLog.join("")}`);

    // Explicit token: the engine under test uses a freshly generated one, not
    // whatever GODOT_CLI_TOKEN happens to be set in the test runner's environment.
    const client = new GodotClient({ host: "127.0.0.1", port: PORT, token });

    await t.test("handshake authenticates and reports its gates", async () => {
      const res = await client.send("ping");
      assert.equal(res.status, "ok");
      const data = res.data as Record<string, any>;
      assert.equal(data.ready, true);
      assert.equal(data.gates.mutations_enabled, true);
      assert.equal(data.gates.unsafe_enabled, true);
    });

    await t.test("scene tree is readable", async () => {
      const res = await client.send("scene_tree", { root: "/root/Main", depth: 2 });
      assert.equal(res.status, "ok");
      const names = JSON.stringify(res.data);
      assert.match(names, /Ground/);
      assert.match(names, /Probe/);
    });

    await t.test("Vector3(x, y, z) strings keep every component", async () => {
      // The documented constructor form used to lose its X component silently
      // while still returning status ok.
      const spawned = await client.send("spawn_3d_object", {
        type: "MeshInstance3D",
        name: "Marker",
        parent_path: "/root/Main",
        position: "Vector3(7, 3, -5)",
      });
      assert.equal(spawned.status, "ok");
      const read = await client.send("eval", {
        code: "get_node('/root/Main/Marker').global_position",
      });
      assert.equal(read.status, "ok");
      const pos = read.data as Record<string, number>;
      assert.equal(pos.x, 7);
      assert.equal(pos.y, 3);
      assert.equal(pos.z, -5);
    });

    await t.test("physics queries return real hits", async () => {
      const res = await client.send("query_ray", {
        is_3d: true,
        from: "Vector3(0, 10, 0)",
        to: "Vector3(0, -10, 0)",
      });
      assert.equal(res.status, "ok");
      const data = res.data as Record<string, any>;
      assert.equal(data.hit, true);
      assert.match(String(data.result.collider), /Ground/);
    });

    await t.test("previously unimplemented commands respond", async () => {
      for (const command of ["metrics", "get_logs", "export_project_api"]) {
        const res = await client.send(command);
        assert.equal(res.status, "ok", `${command} -> ${res.error}`);
      }
      const found = await client.send("find_nodes", { pattern: "*Probe*" });
      assert.equal(found.status, "ok");
      assert.equal((found.data as any).count, 1);
    });

    await t.test("the command catalogue describes the server's own gates", async () => {
      // `commands` and `server_info` had server handlers but were reachable from
      // neither the CLI nor MCP, so an agent had no way to discover capability.
      const cat = await client.send("commands");
      assert.equal(cat.status, "ok");
      const entries = (cat.data as any).commands as Array<Record<string, any>>;
      const byName = new Map(entries.map((e) => [e.name, e]));

      // Nothing may be absent from the catalogue: an uncatalogued command used to
      // fall through _command_denial() and bypass the gates entirely.
      for (const command of ["ping", "eval", "undo", "greformer_export_gltf"]) {
        assert.ok(byName.has(command), `${command} missing from the catalogue`);
      }
      assert.equal(byName.get("ping")!.security, "read_only");
      assert.equal(byName.get("eval")!.required_gate, "GODOT_CLI_ALLOW_UNSAFE");
      // Writes files, so it belongs behind the unsafe gate rather than nothing.
      assert.equal(byName.get("greformer_export_gltf")!.security, "unsafe");

      const info = await client.send("server_info");
      assert.equal(info.status, "ok");
      assert.equal((info.data as any).protocol_version, 1);
    });

    await t.test("batch execution gates each subcommand individually", async () => {
      const res = await client.send("batch_execute", {
        commands: [{ command: "ping" }, { command: "definitely_not_a_command" }],
      });
      assert.equal(res.status, "ok");
      const data = res.data as Record<string, any>;
      assert.equal(data.ok_count, 1);
      assert.equal(data.error_count, 1);
    });

    await t.test("colours are accepted in every documented form", async () => {
      // The MCP schema advertises an [r, g, b] array while the server took only
      // HTML hex, so a client following the declared contract was rejected.
      const target = "/root/Main/Ground/MeshInstance3D";
      for (const color of [[1, 0, 0], "#FF0000", "Color(1, 0, 0, 1)"]) {
        const res = await client.send("greformer_paint_color", { node_path: target, color });
        assert.equal(res.status, "ok", `${JSON.stringify(color)} -> ${res.error}`);
        const albedo = (res.data as any).albedo;
        assert.equal(albedo.r, 1);
        assert.equal(albedo.g, 0);
      }
      const bad = await client.send("greformer_paint_color", { node_path: target, color: "not-a-colour" });
      assert.equal(bad.status, "error");
    });

    await t.test("add_node --script produces a live node", async () => {
      // One call: instantiate from the script, so it is attached before the node
      // enters the tree and the ready notification does its normal work.
      const added = await client.send("add_node", {
        parent: "/root/Main",
        script: "res://probe.gd",
        name: "Live",
      });
      assert.equal(added.status, "ok", added.error);
      assert.equal((added.data as any).physics_processing, true);

      const state = await client.send("eval", {
        code: "var n = get_node('/root/Main/Live'); return [n.is_physics_processing(), n.ready_ran, n.bound != null]",
      });
      assert.deepEqual(state.data, [true, true, true]);
    });

    await t.test("attach_script activates a node already in the tree", async () => {
      // set_script() sends no notification, and NOTIFICATION_READY is what turns on
      // the process callbacks and calls _ready(). Without delivering it the node is
      // inert while every command still reports ok.
      await client.send("add_node", { parent: "/root/Main", type: "Node3D", name: "Bare" });
      const attached = await client.send("attach_script", {
        path: "/root/Main/Bare",
        script: "res://probe.gd",
      });
      assert.equal(attached.status, "ok", attached.error);
      assert.equal((attached.data as any).activated, true);
      assert.equal((attached.data as any).physics_processing, true);

      const state = await client.send("eval", {
        code: "var n = get_node('/root/Main/Bare'); return [n.is_physics_processing(), n.ready_ran, n.bound != null]",
      });
      assert.deepEqual(state.data, [true, true, true]);
    });

    await t.test("attach_script activate=false leaves the node dormant", async () => {
      // The escape hatch for assembling a scene to save: a _ready() that spawns
      // nodes would otherwise be baked into the .tscn and run again on load.
      await client.send("add_node", { parent: "/root/Main", type: "Node3D", name: "Dormant" });
      const attached = await client.send("attach_script", {
        path: "/root/Main/Dormant",
        script: "res://probe.gd",
        activate: false,
      });
      assert.equal((attached.data as any).activated, false);

      const state = await client.send("eval", {
        code: "var n = get_node('/root/Main/Dormant'); return [n.is_physics_processing(), n.ready_ran]",
      });
      assert.deepEqual(state.data, [false, false]);
    });

    await t.test("attach_script refuses a base-class mismatch", async () => {
      // set_script() only prints on a mismatch, so this used to return ok having
      // done nothing at all.
      await client.send("add_node", { parent: "/root/Main", type: "Node", name: "WrongBase" });
      const res = await client.send("attach_script", {
        path: "/root/Main/WrongBase",
        script: "res://probe.gd",
      });
      assert.equal(res.status, "error");
      assert.match(String(res.error), /Node3D/);
    });

    await t.test("an assignment eval leaves the engine log clean", async () => {
      // eval used to speculatively compile `return <code>`, so every assignment
      // logged "Parse Error: Assignment is not allowed inside an expression" while
      // still succeeding.
      const before = await client.send("get_logs", { level: "error" });
      const assigned = await client.send("eval", {
        code: "get_node('/root/Main/Probe').position = Vector3(4, 5, 6)",
      });
      assert.equal(assigned.status, "ok", assigned.error);
      assert.equal((assigned as any).form, "statement");

      const after = await client.send("get_logs", { level: "error" });
      assert.equal((after.data as any).error_count, (before.data as any).error_count);

      const readBack = await client.send("eval", {
        code: "get_node('/root/Main/Probe').position.x",
      });
      assert.equal((readBack as any).form, "expression");
      assert.equal(readBack.data, 4);
    });

    await t.test("assert rejects a method name but still reads plain vars", async () => {
      // node.get() returns a Callable for a method, which reads as truthy -- so this
      // used to pass for the wrong reason.
      const method = await client.send("assert", {
        checks: [{ path: "/root/Main/Live", property: "is_physics_processing", equals: true }],
      });
      const failed = (method.data as any).results[0];
      assert.equal(failed.passed, false);
      assert.match(String(failed.error), /is a method, not a property/);

      // Non-exported script variables are in the property list, so they keep working.
      const plain = await client.send("assert", {
        checks: [{ path: "/root/Main/Live", property: "plain_var", equals: 42 }],
      });
      assert.equal((plain.data as any).passed, true);

      // A failed comparison now reports what it expected.
      const mismatch = await client.send("assert", {
        checks: [{ path: "/root/Main/Live", property: "plain_var", equals: 7 }],
      });
      assert.equal((mismatch.data as any).results[0].expected, 7);
    });

    await t.test("add_node with a script is gated as unsafe", async () => {
      // Instantiating from a script executes project code, exactly like attach_script.
      const cat = await client.send("commands");
      const entries = (cat.data as any).commands as Array<Record<string, any>>;
      const entry = entries.find((e) => e.name === "add_node");
      assert.ok(entry, "add_node missing from the catalogue");
      assert.equal(entry.conditionally_unsafe, true);
    });

    await t.test("the server survives the game being paused", async () => {
      // The autoload used to inherit PROCESS_MODE_INHERIT, so pausing stopped the
      // _process() that polls the socket -- wedging the tool with no way back.
      const paused = await client.send("eval", { code: "get_tree().paused = true" });
      assert.equal(paused.status, "ok");
      const stillAlive = await client.send("ping", {}, 5000);
      assert.equal(stillAlive.status, "ok");
      await client.send("eval", { code: "get_tree().paused = false" });
    });

    await t.test("file writes stay inside res://", async () => {
      const res = await client.send("greformer_export_gltf", {
        node_path: "/root/Main/Ground",
        output_path: path.join(workDir, "escape.gltf"),
      });
      assert.equal(res.status, "error");
      assert.match(String(res.error), /res:\/\//);
      assert.equal(fs.existsSync(path.join(workDir, "escape.gltf")), false);
    });
  }
);
