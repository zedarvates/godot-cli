import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { spawn } from "node:child_process";
import * as path from "node:path";

test("godot-cli --mcp responds to JSON-RPC initialize and tools/list", async () => {
  const mockServer = net.createServer((socket) => {
    socket.on("data", (data) => {
      const msg = JSON.parse(data.toString().trim());
      socket.write(JSON.stringify({ id: msg.id, status: "ok", data: { pong: true } }) + "\n");
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(9902, "localhost", resolve));

  const cliPath = path.resolve("dist/src/cli.js");
  const child = spawn("node", [cliPath, "--mcp", "--port", "9902"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  let outputBuffer = "";

  const responsePromise = new Promise<void>((resolve) => {
    child.stdout.on("data", (data) => {
      outputBuffer += data.toString();
      if (outputBuffer.includes("\n")) {
        resolve();
      }
    });
  });

  // Send initialize
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await responsePromise;

  const initResponse = JSON.parse(outputBuffer.trim());
  assert.equal(initResponse.id, 1);
  assert.equal(initResponse.result.serverInfo.name, "godot-cli-mcp");

  child.kill();
  mockServer.close();
});
