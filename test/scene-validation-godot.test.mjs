import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const GODOT_BIN = process.env.GODOT_BIN;
const ADDON = new URL("../godot-addon/addons/godot_cli/", import.meta.url);

const PROJECT = `config_version=5

[application]
config/name="Scene Validation Integration"
run/main_scene="res://Good.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[autoload]
GodotCLI="*res://addons/godot_cli/cli_server.gd"

[display]
window/size/viewport_width=320
window/size/viewport_height=180

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;

const GOOD_SCENE = `[gd_scene format=3]

[node name="GoodScene" type="Node3D"]

[node name="Camera3D" type="Camera3D" parent="."]
current = true
`;

const BAD_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://broken.gd" id="1"]

[node name="BadScene" type="Node"]
script = ExtResource("1")
`;

const STRUCTURAL_BAD_SCENE = `[gd_scene format=3]

[node name="StructuralBadScene" type="Node3D"]

[node name="BodyWithoutCollision" type="StaticBody3D" parent="."]

[node name="Camera3D" type="Camera3D" parent="."]
current = true
`;

const BROKEN_SCRIPT = `extends Node

func _ready(
  pass
`;

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function cleanupWithRetry(root, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

test(
  "scene validate proves a clean scene and detects a real script parse error",
  { skip: !GODOT_BIN, timeout: 90_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-scene-godot-"));
    const project = path.join(root, "project");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(path.join(project, "addons"), { recursive: true });
    await fs.cp(ADDON, path.join(project, "addons", "godot_cli"), {
      recursive: true,
    });
    await fs.writeFile(path.join(project, "project.godot"), PROJECT, "utf8");
    await fs.writeFile(path.join(project, "Good.tscn"), GOOD_SCENE, "utf8");
    await fs.writeFile(path.join(project, "Bad.tscn"), BAD_SCENE, "utf8");
    await fs.writeFile(
      path.join(project, "StructuralBad.tscn"),
      STRUCTURAL_BAD_SCENE,
      "utf8"
    );
    await fs.writeFile(path.join(project, "broken.gd"), BROKEN_SCRIPT, "utf8");
    const originals = new Map();
    for (const name of [
      "project.godot",
      "Good.tscn",
      "Bad.tscn",
      "StructuralBad.tscn",
      "broken.gd",
    ]) {
      originals.set(name, await fs.readFile(path.join(project, name)));
    }
    const token = crypto.randomBytes(32).toString("hex");
    const env = {
      ...process.env,
      GODOT_BIN,
      GODOT_CLI_TOKEN: token,
      UO_GODOT_CLI_STATE_DIR: stateRoot,
    };
    delete env.GODOT_CLI_ALLOW_MUTATIONS;
    delete env.GODOT_CLI_ALLOW_UNSAFE;
    t.after(async () => {
      await runCli(["runtime", "stop", project, "--timeout", "2"], env)
        .catch(() => undefined);
      await cleanupWithRetry(root);
    });

    const goodPort = await reservePort();
    const good = await runCli(
      [
        "--port",
        String(goodPort),
        "scene",
        "validate",
        "res://Good.tscn",
        "--project",
        project,
        "--godot",
        GODOT_BIN,
        "--timeout",
        "20",
      ],
      env
    );
    assert.equal(good.code, 0, `${good.stdout}\n${good.stderr}`);
    const goodReport = JSON.parse(good.stdout);
    assert.equal(goodReport.status, "ok");
    assert.equal(goodReport.valid, true);
    assert.equal(goodReport.complete, true);
    assert.equal(goodReport.doctor.status, "ok");
    assert.equal(goodReport.structural.valid, true);
    assert.equal(goodReport.structural.complete, true);
    assert.equal(goodReport.logs.errorCount, 0);
    assert.equal(goodReport.runtime.stop.runtime.phase, "stopped");
    assert.equal(goodReport.integrity.scene.unchanged, true);
    assert.equal(goodReport.integrity.project.unchanged, true);

    const badPort = await reservePort();
    const bad = await runCli(
      [
        "--port",
        String(badPort),
        "scene",
        "validate",
        "res://Bad.tscn",
        "--project",
        project,
        "--godot",
        GODOT_BIN,
        "--timeout",
        "20",
      ],
      env
    );
    assert.equal(bad.code, 1, `${bad.stdout}\n${bad.stderr}`);
    const badReport = JSON.parse(bad.stdout);
    assert.equal(badReport.status, "error");
    assert.equal(badReport.valid, false);
    assert.ok(badReport.logs.errorCount > 0);
    assert.ok(
      badReport.logs.diagnostics.some((entry) =>
        ["script_error", "parse_error", "resource_error", "engine_error"].includes(
          entry.category
        )
      )
    );
    assert.equal(badReport.integrity.scene.unchanged, true);
    assert.equal(badReport.integrity.project.unchanged, true);

    const structuralPort = await reservePort();
    const structuralBad = await runCli(
      [
        "--port",
        String(structuralPort),
        "scene",
        "validate",
        "res://StructuralBad.tscn",
        "--project",
        project,
        "--godot",
        GODOT_BIN,
        "--timeout",
        "20",
      ],
      env
    );
    assert.equal(
      structuralBad.code,
      1,
      `${structuralBad.stdout}\n${structuralBad.stderr}`
    );
    const structuralReport = JSON.parse(structuralBad.stdout);
    assert.equal(structuralReport.status, "error");
    assert.equal(structuralReport.valid, false);
    assert.equal(structuralReport.complete, true);
    assert.equal(structuralReport.structural.valid, false);
    assert.equal(structuralReport.structural.complete, true);
    assert.ok(structuralReport.structural.errorCount > 0);
    assert.equal(structuralReport.logs.errorCount, 0);
    assert.equal(structuralReport.integrity.scene.unchanged, true);
    assert.equal(structuralReport.integrity.project.unchanged, true);

    for (const [name, original] of originals) {
      assert.deepEqual(await fs.readFile(path.join(project, name)), original);
    }
  }
);
