import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const GODOT_BIN = process.env.GODOT_BIN;

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

test(
  "asset import proves a real disposable Godot load without changing canonical sources",
  { skip: !GODOT_BIN, timeout: 90_000 },
  async (t) => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-asset-godot-"));
    t.after(() => fs.rm(project, { recursive: true, force: true }));
    await fs.writeFile(path.join(project, "project.godot"), "config_version=5\n", "utf8");
    const positions = Buffer.alloc(36);
    const values = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    values.forEach((value, index) => positions.writeFloatLE(value, index * 4));
    await fs.writeFile(path.join(project, "mesh.bin"), positions);
    const document = JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "mesh.bin", byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    });
    await fs.writeFile(path.join(project, "model.gltf"), document, "utf8");
    const originals = new Map([
      ["project.godot", await fs.readFile(path.join(project, "project.godot"))],
      ["mesh.bin", await fs.readFile(path.join(project, "mesh.bin"))],
      ["model.gltf", await fs.readFile(path.join(project, "model.gltf"))],
    ]);
    const env = { ...process.env, GODOT_BIN };
    env.GODOT_CLI_TOKEN = "must-not-reach-import-child";
    env.GODOT_CLI_ALLOW_MUTATIONS = "1";
    env.GODOT_CLI_ALLOW_UNSAFE = "1";

    const result = await runCli(
      [
        "asset",
        "validate",
        "res://model.gltf",
        "--project",
        project,
        "--godot-import",
        "--godot",
        GODOT_BIN,
        "--timeout",
        "30",
      ],
      env
    );

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.proof.godotImport.status, "ok");
    assert.equal(report.proof.godotImport.complete, true);
    assert.ok(report.proof.godotImport.summary.meshes >= 1);
    assert.equal(report.integrity.unchanged, true);
    assert.doesNotMatch(result.stdout, /must-not-reach-import-child/);
    for (const [name, original] of originals) {
      assert.deepEqual(await fs.readFile(path.join(project, name)), original);
    }

    await fs.writeFile(
      path.join(project, "collision-policy.json"),
      JSON.stringify({
        schema: "uo-godot-asset-policy/1",
        require_godot_import: true,
        require_collision_nodes: true,
      }),
      "utf8"
    );
    const collisionRequired = await runCli(
      [
        "asset",
        "validate",
        "res://model.gltf",
        "--project",
        project,
        "--policy",
        "res://collision-policy.json",
        "--godot-import",
        "--godot",
        GODOT_BIN,
        "--timeout",
        "30",
      ],
      env
    );
    assert.equal(collisionRequired.code, 1);
    const collisionReport = JSON.parse(collisionRequired.stdout);
    assert.equal(collisionReport.proof.godotImport.status, "ok");
    assert.ok(
      collisionReport.findings.some(
        (finding) => finding.code === "ASSET_COLLISION_REQUIRED"
      )
    );
  }
);
