import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildDoctorReport,
  CLI_VERSION,
  EXPECTED_PROTOCOL_VERSION,
} from "../dist/doctor.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCli(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.GODOT_CLI_TOKEN;
    const child = spawn(process.execPath, [CLI, ...args], {
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

function serverInfo(overrides = {}) {
  return {
    protocol_version: EXPECTED_PROTOCOL_VERSION,
    addon_version: CLI_VERSION,
    engine: { major: 4, minor: 7, string: "4.7.dev5" },
    debug_build: true,
    endpoint: { bind_address: "127.0.0.1", port: 9900 },
    gates: { mutations_enabled: false, unsafe_enabled: false },
    limits: {
      max_scene_tree_depth: 64,
      max_scene_nodes: 4096,
      max_visible_nodes: 4096,
      max_assert_checks: 256,
    },
    ...overrides,
  };
}

test("doctor accepts the exact safe Godot 4.7 contract", () => {
  const report = buildDoctorReport(serverInfo());

  assert.equal(report.status, "ok");
  assert.equal(report.compatible, true);
  assert.equal(report.safeMode, true);
  assert.equal(report.checks.every((entry) => entry.ok), true);
});

test("doctor fails closed on a protocol mismatch", () => {
  const report = buildDoctorReport(serverInfo({ protocol_version: 2 }));

  assert.equal(report.status, "error");
  assert.equal(report.compatible, false);
  assert.equal(
    report.checks.find((entry) => entry.name === "protocol_version").ok,
    false
  );
});

test("doctor rejects elevated gates unless explicitly allowed", () => {
  const elevated = serverInfo({
    gates: { mutations_enabled: true, unsafe_enabled: true },
  });

  const rejected = buildDoctorReport(elevated);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.compatible, true);
  assert.equal(rejected.safeMode, false);

  const accepted = buildDoctorReport(elevated, { allowElevated: true });
  assert.equal(accepted.status, "ok");
  assert.equal(accepted.safeMode, false);
});

test("doctor rejects malformed server metadata", () => {
  const report = buildDoctorReport("not-an-object");

  assert.equal(report.status, "error");
  assert.equal(report.compatible, false);
  assert.equal(report.server, null);
});

test("CLI rejects non-finite wait bounds before connecting", async () => {
  const invalidTimeout = await runCli([
    "wait-for",
    "--path",
    "/root/Probe",
    "--property",
    "visible",
    "--timeout",
    "NaN",
  ]);
  assert.equal(invalidTimeout.code, 1);
  assert.match(invalidTimeout.stderr, /--timeout must be a positive finite number/);

  const invalidInterval = await runCli([
    "wait-for",
    "--path",
    "/root/Probe",
    "--property",
    "visible",
    "--interval",
    "Infinity",
  ]);
  assert.equal(invalidInterval.code, 1);
  assert.match(invalidInterval.stderr, /--interval must be a positive finite number/);
});

test("CLI rejects unbounded scene and assertion requests before connecting", async () => {
  const excessiveDepth = await runCli(["scene-tree", "--depth", "65"]);
  assert.equal(excessiveDepth.code, 1);
  assert.match(excessiveDepth.stderr, /integer between 0 and 64/);

  const checks = Array.from({ length: 257 }, () => ({ exists: "/root" }));
  const excessiveChecks = await runCli([
    "assert",
    "--checks",
    JSON.stringify(checks),
  ]);
  assert.equal(excessiveChecks.code, 1);
  assert.match(excessiveChecks.stderr, /at most 256 entries/);
});
