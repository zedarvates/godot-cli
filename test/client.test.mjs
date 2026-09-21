import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { GodotClient } from "../dist/client.js";

const TOKEN = "test-token-".padEnd(64, "x");

async function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.testSockets = sockets;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  const closed = new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  for (const socket of server.testSockets) socket.destroy();
  await closed;
}

test("requires a launch token", () => {
  const previous = process.env.GODOT_CLI_TOKEN;
  delete process.env.GODOT_CLI_TOKEN;
  try {
    assert.throws(() => new GodotClient(), /at least 32 characters/);
  } finally {
    if (previous === undefined) delete process.env.GODOT_CLI_TOKEN;
    else process.env.GODOT_CLI_TOKEN = previous;
  }
});

test("rejects non-loopback hosts", () => {
  assert.throws(
    () => new GodotClient({ host: "192.0.2.10", token: TOKEN }),
    /Remote Godot hosts are disabled/
  );
});

test("rejects localhost when DNS resolves outside loopback", async () => {
  const client = new GodotClient({
    host: "localhost",
    port: 9900,
    token: TOKEN,
    hostResolver: async () => [{ address: "203.0.113.10" }],
  });

  await assert.rejects(
    () => client.send("scene_tree"),
    /resolved outside the loopback interface/
  );
});

test("connects to the verified loopback address for localhost", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim());
      socket.end(JSON.stringify({ id: request.id, status: "ok" }) + "\n");
    });
  });

  const port = await listen(server);
  try {
    const client = new GodotClient({
      host: "localhost",
      port,
      token: TOKEN,
      hostResolver: async () => [
        { address: "::1" },
        { address: "127.0.0.1" },
      ],
    });
    const response = await client.send("scene_tree");
    assert.equal(response.status, "ok");
  } finally {
    await close(server);
  }
});

test("adds the token to each protocol request", async () => {
  let request;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      request = JSON.parse(buffer.slice(0, newline));
      socket.end(
        JSON.stringify({ id: request.id, status: "ok", data: { seen: true } }) +
          "\n"
      );
    });
  });

  const port = await listen(server);
  try {
    const client = new GodotClient({ port, token: TOKEN });
    const response = await client.send("scene_tree");
    assert.equal(request.token, TOKEN);
    assert.equal(request.command, "scene_tree");
    assert.equal(response.status, "ok");
  } finally {
    await close(server);
  }
});

test("rejects oversized responses", async () => {
  const server = net.createServer((socket) => {
    socket.end(
      JSON.stringify({ status: "ok", data: { value: "x".repeat(256) } }) + "\n"
    );
  });

  const port = await listen(server);
  try {
    const client = new GodotClient({
      port,
      token: TOKEN,
      maxResponseBytes: 64,
    });
    await assert.rejects(
      () => client.send("scene_tree"),
      /response exceeded 64 bytes/
    );
  } finally {
    await close(server);
  }
});

test("rejects oversized requests before opening a connection", async () => {
  const client = new GodotClient({
    token: TOKEN,
    maxRequestBytes: 128,
  });

  await assert.rejects(
    () => client.send("eval", { expression: "x".repeat(256) }),
    /request exceeded 128 bytes/
  );
});

test("rejects a response with a mismatched request ID", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(JSON.stringify({ id: "wrong-id", status: "ok" }) + "\n");
    });
  });

  const port = await listen(server);
  try {
    const client = new GodotClient({ port, token: TOKEN });
    await assert.rejects(
      () => client.send("scene_tree"),
      /response ID does not match/
    );
  } finally {
    await close(server);
  }
});

test("rejects an invalid response status", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim());
      socket.end(
        JSON.stringify({ id: request.id, status: "maybe" }) + "\n"
      );
    });
  });

  const port = await listen(server);
  try {
    const client = new GodotClient({ port, token: TOKEN });
    await assert.rejects(
      () => client.send("scene_tree"),
      /Invalid response status/
    );
  } finally {
    await close(server);
  }
});

test("preserves UTF-8 split across TCP chunks", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim());
      const response = Buffer.from(
        JSON.stringify({
          id: request.id,
          status: "ok",
          data: { label: "givre ❄" },
        }) + "\n",
        "utf8"
      );
      const snowflake = response.indexOf(Buffer.from("❄", "utf8"));
      socket.write(response.subarray(0, snowflake + 1));
      setImmediate(() => socket.end(response.subarray(snowflake + 1)));
    });
  });

  const port = await listen(server);
  try {
    const client = new GodotClient({ port, token: TOKEN });
    const response = await client.send("scene_tree");
    assert.deepEqual(response.data, { label: "givre ❄" });
  } finally {
    await close(server);
  }
});
