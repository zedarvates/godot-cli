import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { GodotClient } from "../dist/client.js";

const GODOT_BIN = process.env.GODOT_BIN;
const ADDON_PROJECT_DIR = "godot-addon";

let godotProcess = null;
let client = null;
let launchToken = null;
let launchPort = null;

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

before(async (t) => {
  if (!GODOT_BIN) {
    return;
  }

  launchPort = await findFreePort();
  launchToken = crypto.randomBytes(32).toString("hex");

  const env = {
    ...process.env,
    GODOT_CLI_PORT: String(launchPort),
    GODOT_CLI_TOKEN: launchToken,
    GODOT_CLI_ALLOW_MUTATIONS: "1",
    GODOT_CLI_ALLOW_UNSAFE: "1",
  };

  let godotOutput = "";
  godotProcess = spawn(
    GODOT_BIN,
    ["--path", ADDON_PROJECT_DIR, "--headless", `--godot-cli-port=${launchPort}`],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
  godotProcess.stdout.on("data", (d) => (godotOutput += d.toString()));
  godotProcess.stderr.on("data", (d) => (godotOutput += d.toString()));

  client = new GodotClient({
    port: launchPort,
    token: launchToken,
  });

  let connected = false;
  let lastError = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await client.send("server_info");
      if (res && res.status === "ok") {
        connected = true;
        break;
      }
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!connected) {
    if (godotProcess) godotProcess.kill();
    throw new Error(`Failed to connect to Godot CLI server within 15 seconds. Last error: ${lastError?.message || lastError}\nLogs:\n${godotOutput}`);
  }
});

after(() => {
  if (godotProcess) {
    godotProcess.kill();
    godotProcess = null;
  }
});

test("smoke test: server_info returns runtime contract", async (t) => {
  if (!GODOT_BIN) {
    t.skip("GODOT_BIN not set");
    return;
  }
  const res = await client.send("server_info");
  assert.equal(res.status, "ok");
  assert.equal(typeof res.data.protocol_version, "number");
  assert.equal(typeof res.data.addon_version, "string");
  assert.equal(res.data.gates.mutations_enabled, true);
  assert.equal(res.data.gates.unsafe_enabled, true);
});

test("smoke test: ping and command discovery report live gates", async (t) => {
  if (!GODOT_BIN) {
    t.skip("GODOT_BIN not set");
    return;
  }

  const ping = await client.send("ping");
  assert.equal(ping.status, "ok");
  assert.equal(ping.data.ready, true);
  assert.equal(ping.data.addon_version, "0.1.0-uo.7");
  assert.equal(ping.data.gates.mutations_enabled, true);
  assert.equal(ping.data.gates.unsafe_enabled, true);

  const catalog = await client.send("commands");
  assert.equal(catalog.status, "ok");
  assert.equal(catalog.data.catalog_version, 1);
  assert.equal(catalog.data.protocol, "godot_cli_tcp_ndjson");
  assert.equal(catalog.data.mcp_server, false);
  assert.equal(catalog.data.annotations_are_security_controls, false);
  assert.equal(catalog.data.count, 34);
  assert.equal(catalog.data.commands.length, 34);
  const sceneTree = catalog.data.commands.find((entry) => entry.name === "scene_tree");
  assert.equal(sceneTree.security, "read_only");
  assert.match(sceneTree.description, /hierarchy/);
  assert.deepEqual(sceneTree.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

  const setProperty = catalog.data.commands.find((entry) => entry.name === "set_property");
  assert.equal(setProperty.enabled, true);
  assert.deepEqual(setProperty.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

  const evaluated = catalog.data.commands.find((entry) => entry.name === "eval");
  assert.equal(evaluated.required_gate, "GODOT_CLI_ALLOW_UNSAFE");
  assert.deepEqual(evaluated.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });

  const asserted = catalog.data.commands.find((entry) => entry.name === "assert");
  assert.equal(asserted.conditionally_unsafe, true);
  assert.equal(asserted.annotations.readOnlyHint, false);
  assert.equal(asserted.annotations.destructiveHint, true);
  assert.equal(
    catalog.data.commands.find((entry) => entry.name === "fovea_status").security,
    "read_only"
  );
  assert.equal(
    catalog.data.commands.find((entry) => entry.name === "fovea_add_splat").security,
    "mutating"
  );
});

test("smoke test: optional FoveaCore bridge adds and validates a splat", async (t) => {
  if (!GODOT_BIN) {
    t.skip("GODOT_BIN not set");
    return;
  }

  const status = await client.send("fovea_status");
  assert.equal(status.status, "ok");
  assert.equal(status.data.available, true);
  assert.equal(status.data.compatible, true);
  assert.equal(status.data.contract.version, 1);
  assert.equal(status.data.splat_count, 0);

  const escaped = await client.send("fovea_add_splat", {
    parent: "/root/SecurityFixture",
    source_path: "res://../outside.ply",
  });
  assert.equal(escaped.status, "error");
  assert.match(escaped.error, /inside res:\/\//);

  const added = await client.send("fovea_add_splat", {
    parent: "/root/SecurityFixture",
    source_path: "res://fixture.ply",
    name: "CliBonsaiSplat",
    quality: "balanced",
    opacity: 0.75,
    generate_collisions: false,
    is_static: true,
  });
  assert.equal(added.status, "ok");
  assert.equal(added.data.type, "FoveaSplat3D");
  assert.equal(added.data.persisted, false);

  const validation = await client.send("fovea_validate");
  assert.equal(validation.status, "ok");
  assert.equal(validation.data.valid, true);
  assert.equal(validation.data.complete, true);
  assert.equal(validation.data.splat_count, 1);
});

test("smoke test: scene_tree returns node hierarchy", async (t) => {
  if (!GODOT_BIN) {
    t.skip("GODOT_BIN not set");
    return;
  }
  const res = await client.send("scene_tree");
  assert.equal(res.status, "ok");
  assert.equal(res.data.name, "root");
  assert.equal(Array.isArray(res.data.children), true);
  const fixture = res.data.children.find((c) => c.name === "SecurityFixture");
  assert.notEqual(fixture, undefined);
});

test("smoke test: validate_scene passes on standard scene", async (t) => {
  if (!GODOT_BIN) {
    t.skip("GODOT_BIN not set");
    return;
  }
  const res = await client.send("validate_scene");
  assert.equal(res.status, "ok");
  assert.equal(res.data.valid, true);
  assert.equal(res.data.complete, true);
  assert.equal(typeof res.data.visited_nodes, "number");
});

test("smoke test: validate_scene fails closed when exceeding 4096 node budget", async (t) => {
  if (!GODOT_BIN) {
    t.skip("GODOT_BIN not set");
    return;
  }
  
  // Add 4200 nodes to the scene
  const evalRes = await client.send("eval", {
    expression:
      "for i in range(4200): var n = Node.new(); n.name = 'StressNode' + str(i); get_tree().current_scene.add_child(n)",
  });
  assert.equal(evalRes.status, "ok");

  const res = await client.send("validate_scene");
  assert.equal(res.status, "ok");
  assert.equal(res.data.complete, false);
  assert.equal(res.data.valid, false);
  assert.equal(res.data.visited_nodes, 4096);
  assert.equal(res.data.max_nodes, 4096);

  const budgetErr = res.data.errors.find(
    (e) => e.rule === "validation_budget_exceeded"
  );
  assert.notEqual(budgetErr, undefined);
  assert.match(budgetErr.message, /stopped after 4096 nodes/);
});
