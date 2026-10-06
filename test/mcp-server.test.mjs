import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI_VERSION } from "../dist/doctor.js";
import { GodotClient } from "../dist/client.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "mcp-fixture-".padEnd(64, "x");
const NODE = {
  name: "Player", type: "CharacterBody3D", path: "/root/Main/Player",
  properties: { position: { x: 0, y: 2, z: 3 }, health: 0, visible: false, optional: null, unrelated: "private-unrequested-context" },
  groups: ["private-unrequested-group"], children: ["private-unrequested-child"],
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function info(overrides = {}) {
  return {
    protocol_version: 1, addon_version: CLI_VERSION,
    engine: { major: 4, minor: 7 }, debug_build: true,
    endpoint: { bind_address: "127.0.0.1", port: 9900 },
    gates: { mutations_enabled: false, unsafe_enabled: false },
    limits: { max_scene_tree_depth: 64, max_assert_checks: 256, max_scene_nodes: 4096, max_visible_nodes: 4096 },
    commands: { read_only: ["commands", "ping", "server_info"], mutating: [], unsafe: [] },
    ...overrides,
  };
}

function defaultResponse(request) {
  const data = {
    server_info: info(), get_node: NODE, ping: { pong: true },
    scene_tree: { name: "Main", type: "Node", path: "/root/Main", children: [], _cli: { visited_nodes: 1, max_nodes: 4096, truncated: false } },
    validate_scene: { valid: true, complete: true, errors: [], warnings: [] },
    viewport_info: { fps: 60, objects: { node_count: 5 } },
  }[request.command];
  assert.notEqual(data, undefined, `Unexpected runtime command: ${request.command}`);
  return { status: "ok", data };
}

async function fixture(t, respond = defaultResponse, token = TOKEN, requestedProtocol) {
  const requests = [], sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const end = input.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      const request = JSON.parse(input.slice(0, end));
      requests.push(request);
      const response = respond(request, socket, requests.length);
      if (response !== undefined) socket.end(JSON.stringify({ ...response, id: request.id }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "--port", String(server.address().port), "mcp", "serve"],
    env: { ...process.env, GODOT_CLI_TOKEN: token }, stderr: "pipe",
  });
  let protocol;
  transport.onmessage = (message) => {
    if (message.result?.protocolVersion) protocol = message.result.protocolVersion;
  };
  if (requestedProtocol) {
    const send = transport.send.bind(transport);
    transport.send = (message) => send(message.method === "initialize"
      ? { ...message, params: { ...message.params, protocolVersion: requestedProtocol } } : message);
  }
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const client = new Client({ name: "godot-mcp-fixture", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.ok(!stderr.includes(token), "Runtime token appeared on stderr");
  });
  await client.connect(transport);
  return { client, transport, requests, sockets, server, get stderr() { return stderr; }, get protocol() { return protocol; } };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return { result, output: JSON.parse(result.content[0].text) };
}

test("official MCP client initializes and discovers a stable read-only catalog without connecting to Godot", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const a = await f.client.listTools(), b = await f.client.listTools();
  assert.deepEqual(a, b);
  assert.deepEqual(a.tools.map((tool) => tool.name), ["godot_doctor", "godot_get_node", "godot_ping", "godot_scene_tree", "godot_validate_scene", "godot_viewport_info"]);
  for (const tool of a.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(f.requests, []);
  assert.equal(f.protocol, "2025-11-25");
  assert.equal(f.stderr, "");
});

test("MCP negotiates the supported 2025-06-18 protocol with an older client", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, defaultResponse, TOKEN, "2025-06-18");
  assert.equal(f.protocol, "2025-06-18");
  assert.equal((await f.client.listTools()).tools.length, 6);
  assert.notEqual((await call(f.client, "godot_ping")).result.isError, true);
  assert.equal(f.requests.length, 1);
});

test("MCP routes all six tools through the existing authenticated protocol and projects exact node values", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const doctor = await call(f.client, "godot_doctor");
  assert.equal(doctor.output.data.compatible, true);
  const node = await call(f.client, "godot_get_node", { path: NODE.path, properties: ["health", "visible", "optional"] });
  assert.deepEqual(node.output.data.properties, { health: 0, visible: false, optional: null });
  assert.equal(node.output.data.path, NODE.path);
  assert.ok(!JSON.stringify(node.result).includes("private-unrequested"));
  for (const name of ["godot_ping", "godot_scene_tree", "godot_validate_scene", "godot_viewport_info"]) {
    const { result } = await call(f.client, name);
    assert.notEqual(result.isError, true);
  }
  assert.deepEqual(f.requests.map((request) => request.command), ["server_info", "get_node", "ping", "scene_tree", "validate_scene", "viewport_info"]);
  assert.deepEqual(f.requests[1].params, { path: NODE.path });
  assert.deepEqual(f.requests[3].params, { depth: 2 });
  assert.ok(f.requests.every((request) => request.token === TOKEN));
  const narrowed = await call(f.client, "godot_scene_tree", { root: "/root/Main", depth: 0 });
  assert.notEqual(narrowed.result.isError, true);
  assert.deepEqual(f.requests.at(-1).params, { root: "/root/Main", depth: 0 });
});

test("unknown tools, mutations, extra fields, wrong types and path/property bounds fail before TCP", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const bad = [
    ["execute_code", {}], ["set_property", {}], ["__proto__", {}],
    ["godot_ping", { command: "eval" }], ["godot_doctor", { allowElevated: true }],
    ["godot_scene_tree", { depth: "2" }], ["godot_scene_tree", { depth: 9 }],
    ["godot_scene_tree", { depth: -1 }], ["godot_scene_tree", { depth: 0.5 }],
    ["godot_scene_tree", { root: " " }], ["godot_scene_tree", { root: "x\n" }],
    ["godot_scene_tree", { root: "é".repeat(2049) }],
    ["godot_get_node", { path: NODE.path }],
    ["godot_get_node", { path: NODE.path, properties: [] }],
    ["godot_get_node", { path: NODE.path, properties: ["position", "position"] }],
    ["godot_get_node", { path: NODE.path, properties: ["position\0"] }],
    ["godot_get_node", { path: NODE.path, properties: ["é".repeat(65)] }],
    ["godot_get_node", { path: NODE.path, properties: Array.from({ length: 33 }, (_, i) => `p${i}`) }],
  ];
  for (const [name, args] of bad) {
    const { result } = await call(f.client, name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
  }
  assert.deepEqual(f.requests, []);
});

test("missing properties and runtime errors never fall back to full node context", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, (request) => request.params.path === "/missing"
    ? { status: "error", error: "Node not found" } : defaultResponse(request));
  const missing = await call(f.client, "godot_get_node", { path: NODE.path, properties: ["position", "missing"] });
  assert.equal(missing.result.isError, true);
  assert.match(missing.output.error, /every requested property/);
  assert.ok(!JSON.stringify(missing.result).includes("private-unrequested"));
  const rejected = await call(f.client, "godot_get_node", { path: "/missing", properties: ["position"] });
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.output.error, "Node not found");
});

test("MCP rejects oversized selected output while a small selection remains usable", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, () => ({ status: "ok", data: { ...NODE, properties: { ...NODE.properties, huge: "x".repeat(70 * 1024) } } }));
  const huge = await call(f.client, "godot_get_node", { path: NODE.path, properties: ["huge"] });
  assert.equal(huge.result.isError, true);
  assert.match(huge.output.error, /64 KiB/);
  assert.ok(huge.result.content[0].text.length < 1024);
  const small = await call(f.client, "godot_get_node", { path: NODE.path, properties: ["health"] });
  assert.notEqual(small.result.isError, true);
  assert.deepEqual(small.output.data.properties, { health: 0 });
  assert.ok(Buffer.byteLength(small.result.content[0].text) < 1024);
});

test("MCP fails closed when a runtime response exceeds its 1 MiB wire budget", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, (request, _socket, count) => count === 1
    ? { status: "ok", data: { huge: "x".repeat(1024 * 1024) } } : defaultResponse(request));
  const large = await call(f.client, "godot_ping");
  assert.equal(large.result.isError, true);
  assert.match(large.output.error, /response exceeded 1048576/);
  assert.notEqual((await call(f.client, "godot_ping")).result.isError, true);
});

test("deep or excessive selected values are rejected without retaining the failed output", { timeout: 10000 }, async (t) => {
  let deep = {};
  for (let i = 0; i < 30; i++) deep = { nested: deep };
  const f = await fixture(t, () => ({ status: "ok", data: { ...NODE, properties: { deep, many: Array(16_385).fill(0) } } }));
  for (const property of ["deep", "many"]) {
    const { result, output } = await call(f.client, "godot_get_node", { path: NODE.path, properties: [property] });
    assert.equal(result.isError, true);
    assert.match(output.error, /budget/);
    assert.ok(result.content[0].text.length < 1024);
  }
});

test("runtime token is redacted in successful values and errors, including JSON escaping", { timeout: 10000 }, async (t) => {
  const token = "escaped-token-".padEnd(60, "x") + '\\"\tend';
  const f = await fixture(t, (request) => request.command === "ping"
    ? { status: "error", error: `Rejected ${token}` }
    : { status: "ok", data: { ...NODE, properties: { secret: token } } }, token);
  const error = await call(f.client, "godot_ping");
  assert.equal(error.result.isError, true);
  assert.equal(error.output.error, "Rejected [redacted]");
  const node = await call(f.client, "godot_get_node", { path: NODE.path, properties: ["secret"] });
  assert.equal(node.output.data.properties.secret, "[redacted]");
  for (const item of [error, node]) {
    assert.ok(!JSON.stringify(item.result).includes(JSON.stringify(token).slice(1, -1)));
  }
});

test("truncated trees, incomplete validation and invalid scenes cannot report tool success", { timeout: 10000 }, async (t) => {
  const responses = [
    { status: "ok", data: { _cli: { truncated: true } } },
    { status: "ok", data: { _cli: {} } },
    { status: "ok", data: { complete: false, valid: true } },
    { status: "ok", data: { complete: true, valid: false, errors: [{ rule: "physics_body_needs_shape" }] } },
    { status: "ok", data: { complete: true } },
  ];
  const f = await fixture(t, () => responses.shift());
  for (const name of ["godot_scene_tree", "godot_scene_tree", "godot_validate_scene", "godot_validate_scene", "godot_validate_scene"]) {
    const { result } = await call(f.client, name);
    assert.equal(result.isError, true);
  }
});

test("MCP doctor preserves the existing compatibility and safety checks", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, () => ({ status: "ok", data: info({ protocol_version: 2, gates: { mutations_enabled: true, unsafe_enabled: false } }) }));
  const { result, output } = await call(f.client, "godot_doctor");
  assert.equal(result.isError, true);
  assert.equal(output.data.compatible, false);
  assert.equal(output.data.safeMode, false);
});

test("at most four concurrent reads reach Godot and rejected reads are not queued or retried", { timeout: 10000 }, async (t) => {
  const ready = deferred(), held = [];
  const f = await fixture(t, (request, socket, count) => {
    if (count <= 4) {
      held.push({ request, socket });
      if (count === 4) ready.resolve();
      return undefined;
    }
    return defaultResponse(request);
  });
  const running = Array.from({ length: 4 }, () => call(f.client, "godot_ping"));
  await within(ready.promise);
  const busy = await call(f.client, "godot_ping");
  assert.equal(busy.result.isError, true);
  assert.match(busy.output.error, /at most four/);
  assert.equal(f.requests.length, 4);
  for (const { request, socket } of held) socket.end(JSON.stringify({ ...defaultResponse(request), id: request.id }) + "\n");
  const done = await Promise.all(running);
  assert.ok(done.every(({ result }) => result.isError !== true));
  assert.notEqual((await call(f.client, "godot_ping")).result.isError, true);
  assert.equal(f.requests.length, 5);
});

test("MCP cancellation closes the corresponding Godot socket and the session remains usable", { timeout: 10000 }, async (t) => {
  const received = deferred(), closed = deferred();
  const f = await fixture(t, (request, socket, count) => {
    if (count === 1) {
      socket.once("close", closed.resolve);
      received.resolve();
      return undefined;
    }
    return defaultResponse(request);
  });
  const controller = new AbortController();
  const pending = f.client.callTool({ name: "godot_ping", arguments: {} }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /aborted|cancelled/i);
  await within(received.promise);
  controller.abort();
  await rejected;
  await within(closed.promise);
  assert.notEqual((await call(f.client, "godot_ping")).result.isError, true);
  assert.equal(f.requests.length, 2);
});

test("stdio EOF closes an active runtime socket without waiting for its request deadline", { timeout: 10000 }, async (t) => {
  const received = deferred(), closed = deferred();
  const f = await fixture(t, (_request, socket) => {
    socket.once("close", closed.resolve);
    received.resolve();
    return undefined;
  });
  const pending = f.client.callTool({ name: "godot_ping", arguments: {} }).catch(() => undefined);
  await within(received.promise);
  await within(f.client.close());
  await within(closed.promise);
  await pending;
});

test("a stalled Godot read reaches its deadline, closes its socket and does not retry", { timeout: 15000 }, async (t) => {
  const closed = deferred();
  const f = await fixture(t, (request, socket, count) => {
    if (count === 1) {
      socket.once("close", closed.resolve);
      return undefined;
    }
    return defaultResponse(request);
  });
  const { result, output } = await call(f.client, "godot_ping");
  assert.equal(result.isError, true);
  assert.match(output.error, /timed out/i);
  await within(closed.promise);
  assert.equal(f.requests.length, 1);
  assert.notEqual((await call(f.client, "godot_ping")).result.isError, true);
  assert.equal(f.requests.length, 2);
});

test("CLI exits when a Linux MCP client fills stdout instead of reading it", { timeout: 12000, skip: process.platform !== "linux" }, async (t) => {
  const firstBatchClosed = deferred();
  let closed = 0;
  const f = await fixture(t, (request, socket) => {
    socket.once("close", () => { if (++closed === 4) firstBatchClosed.resolve(); });
    return request.command === "get_node"
      ? { status: "ok", data: { ...NODE, properties: { huge: "\\".repeat(31 * 1024) } } } : defaultResponse(request);
  });
  const child = spawn(process.execPath, [CLI, "--port", String(f.server.address().port), "mcp", "serve"], {
    env: { ...process.env, GODOT_CLI_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  const initialized = new Promise((resolve) => {
    let input = "";
    const read = (chunk) => {
      input += chunk.toString();
      const end = input.indexOf("\n");
      if (end < 0) return;
      child.stdout.off("data", read);
      child.stdout.pause();
      resolve(JSON.parse(input.slice(0, end)));
    };
    child.stdout.on("data", read);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "blocked-output-fixture", version: "1.0.0" },
  } }) + "\n");
  assert.equal((await within(initialized)).result.protocolVersion, "2025-11-25");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  for (let id = 1; id <= 4; id++) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "godot_get_node", arguments: { path: NODE.path, properties: ["huge"] },
  } }) + "\n");
  await within(firstBatchClosed.promise);
  // The first batch can fit in OS/reader buffers. Send one more bounded batch
  // after Godot sockets close; no more than eight MCP requests are unanswered.
  for (let id = 5; id <= 8; id++) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
    name: "godot_get_node", arguments: { path: NODE.path, properties: ["huge"] },
  } }) + "\n");
  assert.equal(await within(exit, 8000), 1);
  assert.match(stderr, /MCP output (timed out|exceeds the session limits)/);
  assert.ok(f.requests.length >= 4 && f.requests.length <= 8);
});

async function startup(args, token) {
  const env = { ...process.env };
  if (token === undefined) delete env.GODOT_CLI_TOKEN;
  else env.GODOT_CLI_TOKEN = token;
  const child = spawn(process.execPath, [CLI, ...args, "mcp", "serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end();
  try {
    const code = await within(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }));
    return { code, stdout, stderr };
  } finally { if (child.exitCode === null) child.kill(); }
}

test("MCP startup rejects missing tokens, remote hosts and malformed ports without protocol stdout", { timeout: 10000 }, async () => {
  for (const [args, token] of [[[], undefined], [[], "short"], [[], "x".repeat(4097)], [["--host", "192.0.2.10"], TOKEN], [["--port", "9900junk"], TOKEN], [["--port", "0"], TOKEN]]) {
    const result = await startup(args, token);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error:/);
    if (token?.length >= 32) assert.ok(!result.stderr.includes(token));
  }
});

test("an already cancelled client request does not resolve DNS or connect", async () => {
  const controller = new AbortController();
  controller.abort();
  let resolved = false;
  const client = new GodotClient({ token: TOKEN, host: "localhost", hostResolver: async () => { resolved = true; return [{ address: "127.0.0.1" }]; } });
  await assert.rejects(client.send("ping", {}, 1000, controller.signal), /cancelled/);
  assert.equal(resolved, false);
});

test("client cancellation during hostname resolution rejects before opening a socket", async () => {
  const controller = new AbortController(), lookup = deferred();
  const client = new GodotClient({ token: TOKEN, host: "localhost", hostResolver: () => lookup.promise });
  const pending = client.send("ping", {}, 1000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  lookup.resolve([{ address: "127.0.0.1" }]);
});

test("cancelled DNS work remains bounded until the underlying lookups settle", { timeout: 10000 }, async (t) => {
  const f = await fixture(t), lookup = deferred();
  let lookups = 0;
  const client = new GodotClient({
    token: TOKEN, host: "localhost", port: f.server.address().port,
    hostResolver: () => ++lookups <= 4 ? lookup.promise : Promise.resolve([{ address: "127.0.0.1" }]),
  });
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController();
    const pending = client.send("ping", {}, 1000, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  }
  await assert.rejects(client.send("ping"), /hostname lookup budget/);
  assert.equal(lookups, 4);
  assert.equal(f.requests.length, 0);
  lookup.resolve([{ address: "127.0.0.1" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await client.send("ping")).status, "ok");
  assert.equal(lookups, 5);
  assert.equal(f.requests.length, 1);
});
