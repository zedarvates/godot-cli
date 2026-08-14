import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";


function runCli(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.GODOT_CLI_TOKEN;
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


test("Fovea CLI rejects invalid quality before connecting", async () => {
  const result = await runCli([
    "fovea",
    "add",
    "/root/Main",
    "res://asset.ply",
    "--quality",
    "ultra",
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--quality must be/);
  assert.doesNotMatch(result.stderr, /GODOT_CLI_TOKEN/);
});


test("Fovea CLI rejects non-finite opacity before connecting", async () => {
  const result = await runCli([
    "fovea",
    "add",
    "/root/Main",
    "res://asset.ply",
    "--opacity",
    "Infinity",
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--opacity must be a finite number/);
  assert.doesNotMatch(result.stderr, /GODOT_CLI_TOKEN/);
});
