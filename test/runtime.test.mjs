import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getRuntimeStatus,
  readRuntimeLogs,
  startManagedRuntime,
  stopManagedRuntime,
} from "../dist/runtime.js";

const TOKEN = "runtime-test-token-".padEnd(64, "a");
const WRONG_TOKEN = "wrong-runtime-token-".padEnd(64, "b");

async function createFixture(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-runtime-test-"));
  const project = path.join(root, "project");
  const stateRoot = path.join(root, "state");
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(project, "project.godot"),
    'config_version=5\n\n[application]\nconfig/name="Runtime Test"\n',
    "utf8"
  );
  const script = path.join(project, "runtime-fixture.mjs");
  await fs.writeFile(
    script,
    `console.log("fixture boot");
let tick = 0;
setInterval(() => console.log("fixture tick " + (++tick)), 20);
process.on("SIGTERM", () => {
  console.log("fixture stopping");
  process.exit(0);
});
`,
    "utf8"
  );
  return {
    root,
    project,
    stateRoot,
    script,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms`);
}

async function cleanupFixture(fixture, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fixture.cleanup();
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function startFixture(fixture) {
  return startManagedRuntime({
    projectRoot: fixture.project,
    executable: process.execPath,
    arguments: [fixture.script],
    port: 19900,
    mode: "headless",
    token: TOKEN,
    stateRoot: fixture.stateRoot,
  });
}

function runCli(args, cwd, env) {
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
    child.once("exit", (code) => resolve({ code, stdout, stderr, cwd }));
  });
}

test("managed runtime owns one process, keeps bounded logs, and stops it", async (t) => {
  const fixture = await createFixture(t);
  const runtime = await startFixture(fixture);
  let stopped = false;
  t.after(async () => {
    if (!stopped) {
      await stopManagedRuntime(fixture.project, {
        token: TOKEN,
        stateRoot: fixture.stateRoot,
      }).catch(() => undefined);
    }
    await cleanupFixture(fixture);
  });

  assert.equal(runtime.phase, "running");
  assert.ok(runtime.pid > 0);
  assert.equal(runtime.arguments.some((entry) => entry.includes(TOKEN)), false);
  assert.equal("tokenHash" in runtime, false);
  const stateFile = (await fs.readdir(fixture.stateRoot)).find((entry) =>
    entry.endsWith(".json")
  );
  assert.ok(stateFile);
  const serializedState = await fs.readFile(
    path.join(fixture.stateRoot, stateFile),
    "utf8"
  );
  assert.equal(serializedState.includes(TOKEN), false);
  assert.deepEqual((await fs.readdir(fixture.project)).sort(), [
    "project.godot",
    "runtime-fixture.mjs",
  ]);

  const status = await getRuntimeStatus(fixture.project, {
    token: TOKEN,
    stateRoot: fixture.stateRoot,
  });
  assert.equal(status.status, "ok");
  assert.equal(status.running, true);
  assert.equal(status.owned, true);

  await assert.rejects(() => startFixture(fixture), /already running/);
  await assert.rejects(
    () => getRuntimeStatus(fixture.project, {
      token: WRONG_TOKEN,
      stateRoot: fixture.stateRoot,
    }),
    /does not match/
  );

  await waitFor(async () => {
    const logs = await readRuntimeLogs(fixture.project, {
      token: TOKEN,
      stateRoot: fixture.stateRoot,
      maxLines: 5,
      maxBytes: 4096,
    });
    return logs.lines.some((line) => line.includes("fixture tick"));
  });
  const logs = await readRuntimeLogs(fixture.project, {
    token: TOKEN,
    stateRoot: fixture.stateRoot,
    maxLines: 3,
    maxBytes: 4096,
  });
  assert.ok(logs.lines.length <= 3);
  assert.equal(logs.lines.join("\n").includes(TOKEN), false);
  assert.equal(logs.running, true);

  const result = await stopManagedRuntime(fixture.project, {
    token: TOKEN,
    stateRoot: fixture.stateRoot,
  });
  stopped = true;
  assert.equal(result.status, "ok");
  assert.equal(result.stopped, true);

  const after = await getRuntimeStatus(fixture.project, {
    token: TOKEN,
    stateRoot: fixture.stateRoot,
  });
  assert.equal(after.running, false);
  assert.equal(after.owned, true);
  assert.equal(after.runtime.phase, "stopped");
  const finalLogs = await readRuntimeLogs(fixture.project, {
    token: TOKEN,
    stateRoot: fixture.stateRoot,
  });
  assert.equal(finalLogs.runtime.phase, "stopped");
});

test("runtime stop fails closed when the process marker no longer matches", async (t) => {
  const fixture = await createFixture(t);
  const runtime = await startFixture(fixture);
  const stateFile = (await fs.readdir(fixture.stateRoot))
    .find((entry) => entry.endsWith(".json"));
  assert.ok(stateFile);
  const statePath = path.join(fixture.stateRoot, stateFile);
  const original = JSON.parse(await fs.readFile(statePath, "utf8"));
  const tampered = { ...original, instanceId: randomUUID() };
  await fs.writeFile(statePath, JSON.stringify(tampered, null, 2) + "\n", "utf8");
  let restored = false;
  t.after(async () => {
    if (!restored) {
      await fs.writeFile(statePath, JSON.stringify(original, null, 2) + "\n", "utf8")
        .catch(() => undefined);
    }
    await stopManagedRuntime(fixture.project, {
      token: TOKEN,
      stateRoot: fixture.stateRoot,
    }).catch(() => undefined);
    await cleanupFixture(fixture);
  });

  await assert.rejects(
    () => stopManagedRuntime(fixture.project, {
      token: TOKEN,
      stateRoot: fixture.stateRoot,
      timeoutMs: 1000,
    }),
    /Refusing to stop PID.*identity_mismatch/
  );
  assert.doesNotThrow(() => process.kill(runtime.pid, 0));

  await fs.writeFile(statePath, JSON.stringify(original, null, 2) + "\n", "utf8");
  restored = true;
  const result = await stopManagedRuntime(fixture.project, {
    token: TOKEN,
    stateRoot: fixture.stateRoot,
  });
  assert.equal(result.stopped, true);
});

test("runtime CLI rejects unbounded local requests before reading state", async (t) => {
  const fixture = await createFixture(t);
  t.after(() => cleanupFixture(fixture));
  const env = { ...process.env, GODOT_CLI_TOKEN: TOKEN };

  const excessiveLines = await runCli(
    ["runtime", "logs", fixture.project, "--lines", "2001"],
    fixture.project,
    env
  );
  assert.equal(excessiveLines.code, 1);
  assert.match(excessiveLines.stderr, /maxLines must be an integer between 1 and 2000/);

  const invalidTimeout = await runCli(
    ["runtime", "stop", fixture.project, "--timeout", "Infinity"],
    fixture.project,
    env
  );
  assert.equal(invalidTimeout.code, 1);
  assert.match(invalidTimeout.stderr, /timeoutMs must be an integer between 100 and 30000/);
});
