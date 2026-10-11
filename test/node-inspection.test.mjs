import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import {
  selectNodeProperties,
  validatePropertySelection,
} from "../dist/node-inspection.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "node-inspection-fixture-".padEnd(64, "x");
const DATA = {
  name: "Player",
  type: "CharacterBody3D",
  path: "/root/Main/Player",
  properties: {
    position: { _type: "Vector3", x: 0, y: 2, z: 3 },
    velocity: { _type: "Vector3", x: 0, y: 0, z: 0 },
    visible: false,
    nullable: null,
    health: 0,
    unrelated: "unrequested-node-value",
  },
  children: ["unrequested-child"],
  groups: ["unrequested-group"],
  script_methods: ["unrequested-method"],
};

function response(data = DATA) {
  return { id: "fixture-id", status: "ok", data };
}

test("selected properties retain identity and exact values without unrelated context", () => {
  const output = selectNodeProperties(response(), ["position", "health", "visible", "nullable"]);
  assert.deepEqual(output, {
    id: "fixture-id", status: "ok",
    data: {
      name: "Player", type: "CharacterBody3D", path: "/root/Main/Player",
      properties: { position: DATA.properties.position, health: 0, visible: false, nullable: null },
      _cli: { selected_properties: ["position", "health", "visible", "nullable"], available_property_count: 6 },
    },
  });
  assert.ok(!JSON.stringify(output).includes("unrequested"));
  assert.equal(DATA.properties.unrelated, "unrequested-node-value");
});

test("a missing selected property fails instead of returning a partial or full node", () => {
  assert.throws(() => selectNodeProperties(response(), ["position", "missing"]), /every requested property/);
  assert.throws(() => selectNodeProperties(response(), ["toString"]), /every requested property/);
});

test("selected special keys are own data properties and cannot pollute prototypes", () => {
  const properties = JSON.parse('{"__proto__":{"polluted":true},"constructor":0}');
  const output = selectNodeProperties(response({ ...DATA, properties }), ["__proto__", "constructor"]);
  assert.equal(Object.hasOwn(output.data.properties, "__proto__"), true);
  assert.deepEqual(output.data.properties.__proto__, { polluted: true });
  assert.equal(output.data.properties.constructor, 0);
  assert.equal({}.polluted, undefined);
});

test("malformed node results and incomplete identities are rejected", () => {
  for (const data of [null, [], {}, { ...DATA, properties: [] }, { ...DATA, path: "" }, { ...DATA, type: 1 }, { ...DATA, name: "x".repeat(4097) }]) {
    assert.throws(() => selectNodeProperties(response(data), ["position"]), /invalid node/);
  }
});

test("property selection bounds counts, UTF-8 bytes, duplicates and control characters", () => {
  assert.equal(validatePropertySelection(Array.from({ length: 32 }, (_, i) => `property_${i}`)).length, 32);
  assert.deepEqual(validatePropertySelection(["shader_parameter/tint", "é".repeat(64)]), ["shader_parameter/tint", "é".repeat(64)]);
  for (const input of [undefined, {}, [], Array.from({ length: 33 }, (_, i) => `p${i}`), ["x", "x"], [null], [""], [" "], ["x\n"], ["x\0"], ["x\u007f"], ["é".repeat(65)]]) {
    assert.throws(() => validatePropertySelection(input));
  }
});

test("runtime errors remain errors rather than being projected as a successful node", () => {
  const error = { id: "error-id", status: "error", error: "Node not found" };
  assert.deepEqual(selectNodeProperties(error, ["position"]), error);
});

async function runCli(args, runtimeResponse = response()) {
  const requests = [];
  const server = net.createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      socket.end(JSON.stringify({ ...runtimeResponse, id: request.id }) + "\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const child = spawn(process.execPath, [CLI, "--port", String(server.address().port), "get-node", DATA.path, ...args], {
      env: { ...process.env, GODOT_CLI_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr, requests };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("CLI selects properties with one existing authenticated get_node request", async () => {
  const result = await runCli(["--properties", "position", "velocity"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].command, "get_node");
  assert.equal(result.requests[0].token, TOKEN);
  assert.deepEqual(result.requests[0].params, { path: DATA.path });
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output.data.properties), ["position", "velocity"]);
  assert.ok(!result.stdout.includes("unrequested"));
  assert.ok(!result.stdout.includes(TOKEN));
  assert.ok(!result.stderr.includes(TOKEN));
});

test("CLI without --properties preserves the complete existing response", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.data, DATA);
});

test("CLI rejects invalid selection before opening a runtime connection", async () => {
  const result = await runCli(["--properties", "position", "position"]);
  assert.equal(result.code, 1);
  assert.deepEqual(result.requests, []);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /duplicate/);
});

test("CLI fails closed on a missing property without leaking full node data", async () => {
  const result = await runCli(["--properties", "position", "missing"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /every requested property/);
  assert.ok(!result.stderr.includes("unrequested"));
});

test("CLI preserves a runtime error and its nonzero exit status", async () => {
  const result = await runCli(["--properties", "position"], { status: "error", error: "Node not found" });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).status, "error");
});
