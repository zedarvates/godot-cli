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
config/name="Managed Runtime Integration"
run/main_scene="res://main.tscn"
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

const SCENE = `[gd_scene format=3]

[node name="ManagedRuntimeIntegration" type="Node"]
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

test(
  "managed runtime starts, probes, logs, and stops real Godot 4.7",
  { skip: !GODOT_BIN, timeout: 60_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-runtime-godot-"));
    const project = path.join(root, "project");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(path.join(project, "addons"), { recursive: true });
    await fs.cp(ADDON, path.join(project, "addons", "godot_cli"), {
      recursive: true,
    });
    await fs.writeFile(path.join(project, "project.godot"), PROJECT, "utf8");
    await fs.writeFile(path.join(project, "main.tscn"), SCENE, "utf8");
    const projectBefore = await fs.readFile(path.join(project, "project.godot"));
    const token = crypto.randomBytes(32).toString("hex");
    const port = await reservePort();
    const env = {
      ...process.env,
      GODOT_BIN,
      GODOT_CLI_TOKEN: token,
      UO_GODOT_CLI_STATE_DIR: stateRoot,
    };
    delete env.GODOT_CLI_ALLOW_MUTATIONS;
    delete env.GODOT_CLI_ALLOW_UNSAFE;
    let pid = 0;
    let stopped = false;
    t.after(async () => {
      if (!stopped) {
        await runCli(["runtime", "stop", project, "--timeout", "2"], env)
          .catch(() => undefined);
      }
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The managed process already exited.
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    });

    const started = await runCli(
      [
        "--port",
        String(port),
        "runtime",
        "start",
        project,
        "--godot",
        GODOT_BIN,
        "--timeout",
        "20",
      ],
      env
    );
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.status, "ok");
    assert.equal(startReport.ready, true);
    assert.equal(startReport.runtime.phase, "running");
    assert.equal(startReport.runtime.mutationsEnabled, false);
    assert.equal(startReport.runtime.unsafeEnabled, false);
    pid = startReport.runtime.pid;

    const status = await runCli(["runtime", "status", project], env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).owned, true);

    const ping = await runCli(["--port", String(port), "ping"], env);
    assert.equal(ping.code, 0, ping.stderr);
    assert.equal(JSON.parse(ping.stdout).data.ready, true);

    const logs = await runCli(
      ["runtime", "logs", project, "--lines", "100", "--bytes", "65536"],
      env
    );
    assert.equal(logs.code, 0, logs.stderr);
    const logReport = JSON.parse(logs.stdout);
    assert.equal(logReport.running, true);
    assert.match(logReport.lines.join("\n"), /Server listening on 127\.0\.0\.1/);
    assert.equal(logReport.lines.join("\n").includes(token), false);

    const stoppedResult = await runCli(
      ["runtime", "stop", project, "--timeout", "10"],
      env
    );
    assert.equal(stoppedResult.code, 0, stoppedResult.stderr);
    assert.equal(JSON.parse(stoppedResult.stdout).stopped, true);
    stopped = true;
    pid = 0;

    const after = await runCli(["runtime", "status", project], env);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).running, false);
    assert.deepEqual(
      await fs.readFile(path.join(project, "project.godot")),
      projectBefore
    );
    assert.equal(
      (await fs.readdir(project)).some((entry) => entry.startsWith("runtime-")),
      false
    );
  }
);
