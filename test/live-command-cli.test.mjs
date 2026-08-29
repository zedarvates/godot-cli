import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "live-command-token-".padEnd(64, "x");

async function captureRequest(arguments_) {
  let request;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      request = JSON.parse(buffer.slice(0, newline));
      socket.end(JSON.stringify({ id: request.id, status: "ok", data: {} }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const child = spawn(
    process.execPath,
    [CLI, "--port", String(port), ...arguments_],
    {
      env: { ...process.env, GODOT_CLI_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  assert.equal(code, 0, stderr);
  return request;
}

test("add-node forwards --script without requiring a native type", async () => {
  const request = await captureRequest([
    "add-node",
    "/root/Main",
    "--script",
    "res://player.gd",
    "--name",
    "Player",
  ]);

  assert.equal(request.command, "add_node");
  assert.deepEqual(request.params, {
    parent: "/root/Main",
    script: "res://player.gd",
    name: "Player",
  });
});

test("attach-script forwards --no-activate as activate false", async () => {
  const request = await captureRequest([
    "attach-script",
    "/root/Main/Player",
    "res://player.gd",
    "--no-activate",
  ]);

  assert.equal(request.command, "attach_script");
  assert.deepEqual(request.params, {
    path: "/root/Main/Player",
    script: "res://player.gd",
    activate: false,
  });
});
