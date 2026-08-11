import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { GodotClient } from "../src/client.js";

test("GodotClient connects and sends JSON newline-delimited command", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", (data) => {
      const msg = JSON.parse(data.toString().trim());
      assert.equal(msg.command, "ping");
      socket.write(JSON.stringify({ id: msg.id, status: "ok", data: { pong: true } }) + "\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(9911, "127.0.0.1", resolve));

  try {
    const client = new GodotClient({ host: "127.0.0.1", port: 9911 });
    const res = await client.send("ping");
    assert.equal(res.status, "ok");
    assert.deepEqual(res.data, { pong: true });
  } finally {
    server.close();
  }
});
