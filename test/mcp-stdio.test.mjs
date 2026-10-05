import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  BoundedMcpStdioTransport,
  MAX_MCP_INPUT_BYTES,
  MAX_MCP_MESSAGE_BYTES,
  MAX_MCP_PENDING_REQUESTS,
  MCP_OUTPUT_TIMEOUT_MS,
} from "../dist/mcp-stdio.js";

const TOKEN = "stdio-test-token-".padEnd(64, "x");

async function setup(t, output = new PassThrough()) {
  const input = new PassThrough();
  const transport = new BoundedMcpStdioTransport(TOKEN, input, output);
  const messages = [], errors = [];
  let stdout = "";
  if (output instanceof PassThrough) output.on("data", (chunk) => { stdout += chunk.toString(); });
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  t.after(async () => { await transport.close(); input.destroy(); output.destroy(); });
  await transport.start();
  return { input, output, transport, messages, errors, get stdout() { return stdout; } };
}

function request(id) { return { jsonrpc: "2.0", id, method: "ping" }; }

test("bounded transport preserves official stdio framing across split UTF-8 chunks", async (t) => {
  const f = await setup(t);
  const message = { jsonrpc: "2.0", id: "é", method: "ping" };
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  f.input.write(bytes.subarray(0, split));
  assert.equal(f.messages.length, 0);
  f.input.write(bytes.subarray(split));
  assert.deepEqual(f.messages, [message]);
  await f.transport.send({ jsonrpc: "2.0", id: "é", result: { pong: true } });
  assert.deepEqual(JSON.parse(f.stdout), { jsonrpc: "2.0", id: "é", result: { pong: true } });
  assert.deepEqual(f.errors, []);
});

test("oversized unterminated stdin and malformed JSON close the session without dispatch or secret echo", async (t) => {
  for (const input of ["x".repeat(MAX_MCP_INPUT_BYTES + 1), `{not-json-${TOKEN}}\n`]) {
    const f = await setup(t);
    f.input.write(input);
    await f.transport.closed;
    assert.equal(f.messages.length, 0);
    assert.equal(f.stdout, "");
    assert.equal(f.errors.length, 1);
    assert.ok(!f.errors[0].message.includes(TOKEN));
  }
});

test("deep MCP parameters are rejected before SDK dispatch", async (t) => {
  const f = await setup(t);
  let value = {};
  for (let i = 0; i < 30; i++) value = { value };
  f.input.write(JSON.stringify({ ...request(1), params: value }) + "\n");
  await f.transport.closed;
  assert.equal(f.messages.length, 0);
  assert.match(f.transport.failure.message, /session limits/);
});

test("tokens in request IDs or arguments close without exposing them in a response", async (t) => {
  for (const message of [{ ...request(TOKEN) }, { ...request(1), params: { value: TOKEN } }]) {
    const f = await setup(t);
    f.input.write(JSON.stringify(message) + "\n");
    await f.transport.closed;
    assert.equal(f.messages.length, 0);
    assert.equal(f.stdout, "");
    assert.ok(!f.transport.failure.message.includes(TOKEN));
  }
});

test("duplicate IDs and unsafe or excessive request IDs close before further dispatch", async (t) => {
  for (const ids of [[1, 1], Array.from({ length: MAX_MCP_PENDING_REQUESTS + 1 }, (_, i) => i), ["x".repeat(129)], [Number.MAX_SAFE_INTEGER + 1]]) {
    const f = await setup(t);
    for (const id of ids) f.input.write(JSON.stringify(request(id)) + "\n");
    await f.transport.closed;
    assert.ok(f.messages.length <= MAX_MCP_PENDING_REQUESTS);
    assert.equal(f.stdout, "");
    assert.equal(f.errors.length, 1);
  }
});

test("completed writes release request capacity without accumulating drain listeners", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 100; i++) {
    f.input.write(JSON.stringify(request(i)) + "\n");
    await f.transport.send({ jsonrpc: "2.0", id: i, result: {} });
  }
  assert.equal(f.messages.length, 100);
  assert.equal(f.stdout.trim().split("\n").length, 100);
  assert.equal(f.output.listenerCount("drain"), 0);
  assert.deepEqual(f.errors, []);
});

test("oversized protocol output closes instead of emitting a clipped successful result", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: 1, result: { value: "x".repeat(MAX_MCP_MESSAGE_BYTES) } }), /session limits/);
  await f.transport.closed;
  assert.equal(f.stdout, "");
});

test("excessively deep output closes without leaving a pending request", async (t) => {
  const f = await setup(t);
  let value = {};
  for (let i = 0; i < 30; i++) value = { value };
  await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: 1, result: value }), /output structure/);
  await f.transport.closed;
  assert.equal(f.stdout, "");
});

test("broken stdout closes without propagating sensitive stream error detail", async (t) => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error(`pipe-${TOKEN}`)); } });
  const f = await setup(t, output);
  await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: 1, result: {} }), /MCP output failed/);
  await f.transport.closed;
  assert.ok(!f.transport.failure.message.includes(TOKEN));
});

test("blocked stdout cannot accumulate more than the bounded pending-output budget", async (t) => {
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} });
  const f = await setup(t, output);
  const writes = Array.from({ length: 5 }, (_, id) => f.transport.send({ jsonrpc: "2.0", id, result: { value: "x".repeat(130 * 1024) } }));
  const results = await Promise.allSettled(writes);
  await f.transport.closed;
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.ok(output.writableLength <= 512 * 1024);
  assert.match(f.transport.failure.message, /session limits/);
});

test("one blocked stdout write has a finite deadline", { timeout: MCP_OUTPUT_TIMEOUT_MS + 3000 }, async (t) => {
  const f = await setup(t, new Writable({ write(_chunk, _encoding, _callback) {} }));
  await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: 1, result: {} }), /session closed/);
  await f.transport.closed;
  assert.match(f.transport.failure.message, /timed out/);
});

test("stdin EOF closes the bounded transport and releases stream listeners", async (t) => {
  const f = await setup(t);
  f.input.end();
  await f.transport.closed;
  assert.equal(f.input.listenerCount("data"), 0);
  assert.equal(f.input.listenerCount("error"), 0);
  await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: 1, result: {} }), /closed/);
});
