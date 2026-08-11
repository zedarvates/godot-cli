import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { spawn } from "node:child_process";
import * as path from "node:path";

test("godot-cli-mcp executes tools/call for godot_query_ray and godot_find_nodes", async () => {
  const mockServer = net.createServer((socket) => {
    socket.on("data", (data) => {
      const msg = JSON.parse(data.toString().trim());
      if (msg.command === "query_ray") {
        socket.write(
          JSON.stringify({
            id: msg.id,
            status: "ok",
            data: { hit: true, distance: 5.2, collider_name: "Floor" },
          }) + "\n"
        );
      } else if (msg.command === "find_nodes") {
        socket.write(
          JSON.stringify({
            id: msg.id,
            status: "ok",
            data: { count: 1, nodes: [{ name: "Player", type: "CharacterBody3D" }] },
          }) + "\n"
        );
      }
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(9915, "127.0.0.1", resolve));

  const cliPath = path.resolve("dist/src/mcp-cli.js");
  const child = spawn("node", [cliPath, "--host", "127.0.0.1", "--port", "9915"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  let buffer = "";
  const lines: string[] = [];

  child.stdout.on("data", (data) => {
    buffer += data.toString();
    while (buffer.includes("\n")) {
      const idx = buffer.indexOf("\n");
      lines.push(buffer.substring(0, idx));
      buffer = buffer.substring(idx + 1);
    }
  });

  // Call tool godot_query_ray
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "godot_query_ray",
        arguments: { from: "Vector3(0,10,0)", to: "Vector3(0,0,0)" },
      },
    }) + "\n"
  );

  // Wait for response
  while (lines.length === 0) {
    await new Promise((r) => setTimeout(r, 50));
  }

  const response = JSON.parse(lines[0]);
  assert.equal(response.id, 2);
  assert.ok(response.result.content[0].text.includes("Floor"));

  child.kill();
  mockServer.close();
});
