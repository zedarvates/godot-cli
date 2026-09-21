import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  MAX_MCP_IDENTITY_BYTES,
  probeGodotAiMcp,
} from "../dist/mcp-live.js";

async function startServer(context, handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return server.address().port;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sendIdentity(response) {
  sendJson(response, 200, {
    name: "godot-ai",
    server_version: "3.0.7",
    ws_port: 9500,
  });
}

test("modern MCP probe verifies identity and follows bounded pagination", async (t) => {
  const seenCursors = [];
  const port = await startServer(t, async (request, response) => {
    if (request.method === "GET" && request.url === "/godot-ai/status") {
      sendIdentity(response);
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/mcp");
    assert.equal(request.headers["mcp-protocol-version"], "2026-07-28");
    assert.equal(request.headers["mcp-method"], "tools/list");
    const body = await readJson(request);
    assert.equal(body.method, "tools/list");
    assert.equal(
      body.params._meta["io.modelcontextprotocol/clientInfo"].name,
      "uo-godot-cli"
    );
    seenCursors.push(body.params.cursor ?? null);
    const secondPage = body.params.cursor === "page-2";
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: secondPage
        ? { tools: [{ name: "scene_open" }] }
        : { tools: [{ name: "editor_state" }], nextCursor: "page-2" },
    });
  });

  const result = await probeGodotAiMcp({ port, timeoutMs: 2000 });

  assert.deepEqual(result.identity, {
    name: "godot-ai",
    version: "3.0.7",
    wsPort: 9500,
  });
  assert.deepEqual(result.protocol, {
    mode: "modern_stateless",
    version: "2026-07-28",
  });
  assert.deepEqual(result.toolNames, ["editor_state", "scene_open"]);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(seenCursors, [null, "page-2"]);
});

test("modern MCP probe accepts a matching SSE JSON-RPC response", async (t) => {
  const port = await startServer(t, async (request, response) => {
    if (request.url === "/godot-ai/status") {
      sendIdentity(response);
      return;
    }
    const body = await readJson(request);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "editor_state" }] },
      })}\n\n`
    );
  });

  const result = await probeGodotAiMcp({ port, timeoutMs: 2000 });

  assert.deepEqual(result.toolNames, ["editor_state"]);
  assert.equal(result.pageCount, 1);
});

test("MCP probe rejects a local service with the wrong identity", async (t) => {
  const port = await startServer(t, (_request, response) => {
    sendJson(response, 200, { name: "unrelated-service" });
  });

  await assert.rejects(
    () => probeGodotAiMcp({ port, timeoutMs: 1000 }),
    /does not identify a Godot AI MCP server/
  );
});

test("MCP probe falls back to the legacy initialized session", async (t) => {
  const methods = [];
  const port = await startServer(t, async (request, response) => {
    if (request.url === "/godot-ai/status") {
      sendIdentity(response);
      return;
    }
    if (request.method === "DELETE") {
      methods.push("DELETE");
      assert.equal(request.headers["mcp-session-id"], "test-session");
      response.writeHead(200);
      response.end();
      return;
    }
    const body = await readJson(request);
    methods.push(body.method);
    if (request.headers["mcp-protocol-version"] === "2026-07-28") {
      sendJson(response, 400, {
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32600, message: "Unsupported protocol version" },
      });
      return;
    }
    if (body.method === "initialize") {
      sendJson(
        response,
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Godot AI", version: "3.0.7" },
          },
        },
        { "Mcp-Session-Id": "test-session" }
      );
      return;
    }
    assert.equal(request.headers["mcp-session-id"], "test-session");
    if (body.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: [{ name: "editor_state" }] },
    });
  });

  const result = await probeGodotAiMcp({ port, timeoutMs: 2000 });

  assert.deepEqual(result.protocol, {
    mode: "legacy_session",
    version: "2025-06-18",
  });
  assert.deepEqual(methods, [
    "tools/list",
    "initialize",
    "notifications/initialized",
    "tools/list",
    "DELETE",
  ]);
});

test("MCP probe rejects a repeated pagination cursor", async (t) => {
  const port = await startServer(t, async (request, response) => {
    if (request.url === "/godot-ai/status") {
      sendIdentity(response);
      return;
    }
    const body = await readJson(request);
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [{ name: body.params.cursor ? "scene_open" : "editor_state" }],
        nextCursor: "same-cursor",
      },
    });
  });

  await assert.rejects(
    () => probeGodotAiMcp({ port, timeoutMs: 2000 }),
    /repeated a pagination cursor/
  );
});

test("MCP identity response is bounded before parsing", async (t) => {
  const port = await startServer(t, (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_MCP_IDENTITY_BYTES + 1),
    });
    response.end("{}");
  });

  await assert.rejects(
    () => probeGodotAiMcp({ port, timeoutMs: 1000 }),
    new RegExp(`response exceeded ${MAX_MCP_IDENTITY_BYTES} bytes`)
  );
});
