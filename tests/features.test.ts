import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { GodotClient } from "../src/client.js";

test("GodotClient handles metrics, get_logs, and action_press commands", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", (data) => {
      const msg = JSON.parse(data.toString().trim());
      if (msg.command === "metrics") {
        socket.write(JSON.stringify({
          id: msg.id,
          status: "ok",
          data: { fps: 60, draw_calls: 12, active_objects_3d: 5 }
        }) + "\n");
      } else if (msg.command === "get_logs") {
        socket.write(JSON.stringify({
          id: msg.id,
          status: "ok",
          data: { logs: [{ level: "info", message: "Server listening" }], count: 1 }
        }) + "\n");
      } else if (msg.command === "action_press") {
        socket.write(JSON.stringify({
          id: msg.id,
          status: "ok",
          data: { action: msg.params.action, pressed: true }
        }) + "\n");
      } else if (msg.command === "find_nodes") {
        socket.write(JSON.stringify({
          id: msg.id,
          status: "ok",
          data: { count: 1, nodes: [{ name: "Player", type: "CharacterBody3D", path: "/root/Main/Player" }] }
        }) + "\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(9903, "localhost", resolve));

  try {
    const client = new GodotClient({ port: 9903 });

    const metricsRes = await client.send("metrics");
    assert.equal(metricsRes.status, "ok");
    assert.equal((metricsRes.data as any).fps, 60);

    const logsRes = await client.send("get_logs", { level: "info" });
    assert.equal(logsRes.status, "ok");
    assert.equal((logsRes.data as any).count, 1);

    const actionRes = await client.send("action_press", { action: "ui_accept" });
    assert.equal(actionRes.status, "ok");
    assert.equal((actionRes.data as any).pressed, true);

    const findRes = await client.send("find_nodes", { pattern: "*Player*" });
    assert.equal(findRes.status, "ok");
    assert.equal((findRes.data as any).count, 1);
  } finally {
    server.close();
  }
});
