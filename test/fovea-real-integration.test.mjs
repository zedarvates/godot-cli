import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GodotClient } from "../dist/client.js";

const GODOT_BIN = process.env.GODOT_BIN;
const FOVEA_PROJECT_ROOT = process.env.FOVEA_PROJECT_ROOT;
const CLI_ADDON = new URL("../godot-addon/addons/godot_cli/", import.meta.url);
const FOVEA_CONTRACT_DIRECTORIES = [
  "icons",
  "resources",
  "scenes",
  "scripts",
  "shaders",
  "test",
];

const PROJECT = `config_version=5

[application]
config/name="Fovea CLI Integration Fixture"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "Forward Plus")

[autoload]
EyeTrackingBridge="*res://addons/foveacore/scripts/advanced/gaze_tracker_linker.gd"
ReconstructionManager="*res://addons/foveacore/scripts/reconstruction/reconstruction_manager.gd"
FoveaCoreManager="*res://addons/foveacore/scripts/foveacore_manager.gd"
GodotCLI="*res://addons/godot_cli/cli_server.gd"

[display]
window/size/viewport_width=320
window/size/viewport_height=180

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;

const SCAN_PROJECT = `config_version=5

[application]
config/name="Fovea CLI Class Scan Fixture"
config/features=PackedStringArray("4.7", "Forward Plus")

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;

const SCENE = `[gd_scene format=3]

[node name="FoveaCliIntegrationFixture" type="Node3D"]
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


function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Godot process timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}


async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}


test(
  "real CLI controls the real FoveaCore bridge without modifying its repository",
  { skip: !GODOT_BIN || !FOVEA_PROJECT_ROOT, timeout: 60_000 },
  async (t) => {
    const sourceAddon = path.join(FOVEA_PROJECT_ROOT, "addons", "foveacore");
    const bridgePath = path.join(
      sourceAddon,
      "scripts",
      "integration",
      "fovea_cli_bridge.gd"
    );
    const sourceFixture = path.join(
      sourceAddon,
      "test",
      "fixtures",
      "minimal_cli_fixture.ply"
    );
    await fs.access(bridgePath);
    await fs.access(sourceFixture);

    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "fovea-cli-real-"));
    const targetAddon = path.join(fixture, "addons", "foveacore");
    t.after(async () => {
      for (const directory of FOVEA_CONTRACT_DIRECTORIES) {
        await fs
          .unlink(path.join(targetAddon, directory))
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
      }
      await fs.rm(fixture, { recursive: true, force: true });
    });
    await fs.mkdir(path.join(fixture, "addons"), { recursive: true });
    await fs.cp(CLI_ADDON, path.join(fixture, "addons", "godot_cli"), {
      recursive: true,
    });
    await fs.mkdir(targetAddon, { recursive: true });
    for (const directory of FOVEA_CONTRACT_DIRECTORIES) {
      await fs.symlink(
        path.join(sourceAddon, directory),
        path.join(targetAddon, directory),
        process.platform === "win32" ? "junction" : "dir"
      );
    }
    await fs.writeFile(
      path.join(fixture, "project.godot"),
      SCAN_PROJECT,
      "utf8"
    );
    await fs.writeFile(path.join(fixture, "main.tscn"), SCENE, "utf8");

    let importOutput = "";
    const importer = spawn(
      GODOT_BIN,
      ["--headless", "--path", fixture, "--import"],
      {
        cwd: fixture,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    importer.stdout.on("data", (chunk) => (importOutput += chunk.toString()));
    importer.stderr.on("data", (chunk) => (importOutput += chunk.toString()));
    assert.equal(await waitForExit(importer, 30_000), 0, importOutput);
    assert.doesNotMatch(importOutput, /SCRIPT ERROR|Parse Error|Failed to load script/);
    await fs.writeFile(path.join(fixture, "project.godot"), PROJECT, "utf8");

    const port = await reservePort();
    const token = crypto.randomBytes(32).toString("hex");
    let runtimeOutput = "";
    const runtime = spawn(
      GODOT_BIN,
      ["--headless", "--xr-mode", "off", "--audio-driver", "Dummy", "--path", fixture],
      {
        cwd: fixture,
        env: {
          ...process.env,
          GODOT_CLI_PORT: String(port),
          GODOT_CLI_TOKEN: token,
          GODOT_CLI_ALLOW_MUTATIONS: "1",
          GODOT_CLI_ALLOW_UNSAFE: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    runtime.stdout.on("data", (chunk) => (runtimeOutput += chunk.toString()));
    runtime.stderr.on("data", (chunk) => (runtimeOutput += chunk.toString()));

    try {
      const client = new GodotClient({ port, token });
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const ping = await client.send("ping", {}, 1000);
          if (ping.status === "ok") {
            ready = true;
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      assert.equal(ready, true, runtimeOutput);

      const status = await client.send("fovea_status");
      assert.equal(status.status, "ok");
      assert.equal(status.data.available, true);
      assert.equal(status.data.compatible, true);
      assert.equal(status.data.contract.version, 1);
      assert.equal(status.data.splat_count, 0);

      const added = await client.send("fovea_add_splat", {
        parent: "/root/FoveaCliIntegrationFixture",
        source_path:
          "res://addons/foveacore/test/fixtures/minimal_cli_fixture.ply",
        name: "RealCliSplat",
        quality: "balanced",
        opacity: 0.75,
        generate_collisions: false,
        is_static: true,
      });
      assert.equal(added.status, "ok", JSON.stringify(added));
      assert.equal(added.data.type, "FoveaSplat3D");
      assert.equal(added.data.loaded_splat_count, 1);
      assert.equal(added.data.persisted, false);

      const validation = await client.send("fovea_validate");
      assert.equal(validation.status, "ok");
      assert.equal(validation.data.valid, true, JSON.stringify(validation));
      assert.equal(validation.data.complete, true);
      assert.equal(validation.data.splat_count, 1);
    } finally {
      await stop(runtime);
    }

    assert.doesNotMatch(runtimeOutput, /SCRIPT ERROR|Parse Error|Failed to load script/);
    assert.match(runtimeOutput, /PLYLoader: Successfully loaded 1 splats/);
  }
);
