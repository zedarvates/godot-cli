import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCompatibilityReport,
  MAX_COMPATIBILITY_CATALOG_BYTES,
} from "../dist/compatibility.js";

const MCP_CATALOG = `@tool
class_name McpToolCatalog
extends RefCounted

const CORE_TOOLS := [
  "editor_state",
  "node_get_properties",
  "scene_get_hierarchy",
  "session_activate",
]

const ALWAYS_ON_TOOLS := [
  "session_manage",
]

const DOMAINS := [
  {"id": "animation", "label": "animation", "count": 2, "tools": ["animation_create", "animation_manage"]},
  {"id": "api", "label": "api", "count": 1, "tools": ["api_manage"]},
  {"id": "audio", "label": "audio", "count": 1, "tools": ["audio_manage"]},
  {"id": "autoload", "label": "autoload", "count": 1, "tools": ["autoload_manage"]},
  {"id": "batch", "label": "batch", "count": 1, "tools": ["batch_execute"]},
  {"id": "camera", "label": "camera", "count": 1, "tools": ["camera_manage"]},
  {"id": "client", "label": "client", "count": 1, "tools": ["client_manage"]},
  {"id": "editor", "label": "editor", "count": 4, "tools": ["editor_manage", "editor_reload_plugin", "editor_screenshot", "logs_read"]},
  {"id": "filesystem", "label": "filesystem", "count": 1, "tools": ["filesystem_manage"]},
  {"id": "game", "label": "game", "count": 1, "tools": ["game_manage"]},
  {"id": "input_map", "label": "input_map", "count": 1, "tools": ["input_map_manage"]},
  {"id": "material", "label": "material", "count": 1, "tools": ["material_manage"]},
  {"id": "node", "label": "node", "count": 4, "tools": ["node_create", "node_find", "node_manage", "node_set_property"]},
  {"id": "particle", "label": "particle", "count": 1, "tools": ["particle_manage"]},
  {"id": "project", "label": "project", "count": 2, "tools": ["project_manage", "project_run"]},
  {"id": "resource", "label": "resource", "count": 1, "tools": ["resource_manage"]},
  {"id": "scene", "label": "scene", "count": 3, "tools": ["scene_manage", "scene_open", "scene_save"]},
  {"id": "script", "label": "script", "count": 4, "tools": ["script_attach", "script_create", "script_manage", "script_patch"]},
  {"id": "signal", "label": "signal", "count": 1, "tools": ["signal_manage"]},
  {"id": "testing", "label": "testing", "count": 2, "tools": ["test_manage", "test_run"]},
  {"id": "theme", "label": "theme", "count": 1, "tools": ["theme_manage"]},
  {"id": "tilemap", "label": "tilemap", "count": 1, "tools": ["tilemap_manage"]},
  {"id": "tileset", "label": "tileset", "count": 1, "tools": ["tileset_manage"]},
  {"id": "ui", "label": "ui", "count": 1, "tools": ["ui_manage"]},
]
`;

const TOKEN = "live-compatibility-test-token".padEnd(64, "x");

function extractConstantNames(source, constantName, opener, closer) {
  const open = opener === "[" ? "\\[" : "\\{";
  const close = closer === "]" ? "\\]" : "\\}";
  const match = new RegExp(
    `^const\\s+${constantName}\\s*:=\\s*${open}\\s*\\r?\\n([\\s\\S]*?)^${close}\\s*$`,
    "m"
  ).exec(source);
  assert.ok(match, `missing ${constantName}`);
  return [...match[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map(
    (entry) => entry[1]
  );
}

function mcpToolNames(source) {
  const names = [
    ...extractConstantNames(source, "CORE_TOOLS", "[", "]"),
    ...extractConstantNames(source, "ALWAYS_ON_TOOLS", "[", "]"),
  ];
  const domains = extractConstantNames(source, "DOMAINS", "[", "]");
  for (const line of domains) {
    if (!names.includes(line) && line.includes("_manage")) names.push(line);
  }
  const domainBody = new RegExp(
    "^const\\s+DOMAINS\\s*:=\\s*\\[\\s*\\r?\\n([\\s\\S]*?)^\\]\\s*$",
    "m"
  ).exec(source)?.[1];
  assert.ok(domainBody);
  for (const match of domainBody.matchAll(/"tools":\s*\[([^\]]*)\]/g)) {
    for (const tool of match[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) {
      if (!names.includes(tool[1])) names.push(tool[1]);
    }
  }
  return names;
}

async function listenServer(context, server) {
  const sockets = new Set();
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

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function createProject(context, catalog = MCP_CATALOG) {
  const project = await fs.mkdtemp(
    path.join(os.tmpdir(), "uo-godot-compatibility-")
  );
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, "project.godot"), "config_version=5\n");
  if (catalog !== null) {
    const addon = path.join(project, "addons", "godot_ai");
    await fs.mkdir(addon, { recursive: true });
    await fs.writeFile(path.join(addon, "tool_catalog.gd"), catalog, "utf8");
  }
  return project;
}

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("compatibility report classifies complete CLI and MCP catalogs", async (t) => {
  const project = await createProject(t);

  const report = await buildCompatibilityReport(project, { env: {} });

  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.reportVersion, 3);
  assert.equal(report.basis, "bundled_cli_and_installed_mcp_catalogs");
  assert.equal(report.equivalence, "semantic_families_only");
  assert.equal(report.catalogs.cli.count, 34);
  assert.deepEqual(report.catalogs.cli.securityCounts, {
    readOnly: 17,
    mutating: 10,
    unsafe: 7,
  });
  assert.equal(report.catalogs.mcp.count, 43);
  assert.equal(report.catalogs.mcp.coreCount, 4);
  assert.equal(report.catalogs.mcp.alwaysOnCount, 1);
  assert.equal(report.catalogs.mcp.domains.length, 24);
  assert.deepEqual(report.summary, {
    familyCount: 7,
    sharedFamilies: 5,
    cliOnlyFamilies: 1,
    mcpOnlyFamilies: 1,
    unmappedCliCommands: [],
    unmappedMcpTools: [],
    missingExpectedCliCommands: [],
    missingExpectedMcpTools: [],
  });
  assert.equal(
    report.families.find((family) => family.id === "fovea_cli_extension")
      ?.classification,
    "cli_only"
  );
  assert.equal(report.routing.status, "ok");
  assert.equal(report.routing.mode, "static_catalog");
  assert.equal(report.routing.advisoryOnly, true);
  assert.equal(report.routing.authorizationSource, false);
  assert.equal(report.routing.routes.length, 7);
  assert.deepEqual(report.routing.reviewRequiredFamilies, []);
  assert.equal(
    report.routing.routes.find(
      (route) => route.familyId === "scene_node_operations"
    )?.decision,
    "choose_by_context"
  );
  assert.equal(
    report.routing.routes.find(
      (route) => route.familyId === "fovea_cli_extension"
    )?.decision,
    "cli_runtime"
  );
  assert.equal(
    report.routing.routes.find(
      (route) => route.familyId === "mcp_authoring_domains"
    )?.decision,
    "mcp_editor"
  );
  assert.equal(report.routing.routes[0].cli.enabledCommands, null);
  assert.equal(report.routing.routes[0].mcp.listedTools, null);
  assert.equal(report.warnings.length, 2);
  assert.match(report.catalogs.cli.sha256, /^[a-f0-9]{64}$/);
  assert.match(report.catalogs.mcp.sha256, /^[a-f0-9]{64}$/);
});

test("compatibility report fails when godot_ai catalog is missing", async (t) => {
  const project = await createProject(t, null);

  await assert.rejects(
    () => buildCompatibilityReport(project, { env: {} }),
    /Godot AI tool catalog not found.*Install the expected addon/
  );
});

test("compatibility report requires review for an unclassified MCP tool", async (t) => {
  const project = await createProject(
    t,
    MCP_CATALOG.replace('"session_activate",', '"session_activate",\n  "future_tool",')
  );

  const report = await buildCompatibilityReport(project, { env: {} });

  assert.equal(report.status, "review_required");
  assert.equal(report.complete, false);
  assert.deepEqual(report.summary.unmappedMcpTools, ["future_tool"]);
  assert.equal(report.routing.status, "review_required");
  assert.deepEqual(report.routing.unmappedCatalogEntries.mcpTools, [
    "future_tool",
  ]);
});

test("compatibility report rejects inconsistent MCP domain counts", async (t) => {
  const project = await createProject(
    t,
    MCP_CATALOG.replace(
      '"count": 2, "tools": ["animation_create", "animation_manage"]',
      '"count": 3, "tools": ["animation_create", "animation_manage"]'
    )
  );

  await assert.rejects(
    () => buildCompatibilityReport(project, { env: {} }),
    /animation declares 3 tools but lists 2/
  );
});

test("compatibility report rejects oversized MCP catalogs", async (t) => {
  const project = await createProject(
    t,
    MCP_CATALOG + "#".repeat(MAX_COMPATIBILITY_CATALOG_BYTES)
  );

  await assert.rejects(
    () => buildCompatibilityReport(project, { env: {} }),
    /exceeds the 1048576-byte limit/
  );
});

test("project compatibility CLI is local, tokenless, and fail-closed", async (t) => {
  const completeProject = await createProject(t);
  const driftProject = await createProject(
    t,
    MCP_CATALOG.replace('"session_activate",', '"session_activate",\n  "future_tool",')
  );
  const env = { ...process.env };
  delete env.GODOT_CLI_TOKEN;
  delete env.UO_GODOT_PROJECT;

  const complete = await runCli(
    ["project", "compatibility", completeProject],
    env
  );
  assert.equal(complete.code, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).status, "ok");

  const drift = await runCli(
    ["project", "compatibility", driftProject],
    env
  );
  assert.equal(drift.code, 1, drift.stderr);
  assert.equal(JSON.parse(drift.stdout).status, "review_required");
});

test("live compatibility reports CLI gates and conservative MCP domain state", async (t) => {
  const project = await createProject(t);
  const cliSource = await fs.readFile(
    new URL("../godot-addon/addons/godot_cli/cli_server.gd", import.meta.url),
    "utf8"
  );
  const categories = {
    read_only: extractConstantNames(cliSource, "READ_ONLY_COMMANDS", "{", "}"),
    mutating: extractConstantNames(cliSource, "MUTATING_COMMANDS", "{", "}"),
    unsafe: extractConstantNames(cliSource, "UNSAFE_COMMANDS", "{", "}"),
  };
  const cliCommands = Object.entries(categories).flatMap(([security, names]) =>
    names.map((name) => ({
      name,
      security,
      enabled: security === "read_only",
      required_gate:
        security === "read_only"
          ? "none"
          : security === "mutating"
            ? "GODOT_CLI_ALLOW_MUTATIONS"
            : "GODOT_CLI_ALLOW_UNSAFE",
      conditionally_unsafe: name === "wait_for" || name === "assert",
    }))
  );
  let cliRequests = 0;
  const cliServer = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim());
      cliRequests += 1;
      assert.equal(request.token, TOKEN);
      assert.equal(request.command, "commands");
      socket.end(
        JSON.stringify({
          id: request.id,
          status: "ok",
          data: {
            catalog_version: 1,
            protocol: "godot_cli_tcp_ndjson",
            mcp_server: false,
            annotations_are_security_controls: false,
            count: cliCommands.length,
            commands: cliCommands,
            gates: { mutations_enabled: false, unsafe_enabled: false },
          },
        }) + "\n"
      );
    });
  });
  const cliPort = await listenServer(t, cliServer);

  const completeTools = mcpToolNames(MCP_CATALOG);
  assert.equal(completeTools.length, 43);
  let liveTools = completeTools.filter(
    (name) => name !== "animation_create" && name !== "animation_manage"
  );
  const mcpMethods = [];
  const mcpServer = http.createServer(async (request, response) => {
    if (request.url === "/godot-ai/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ name: "godot-ai", server_version: "3.0.7", ws_port: 9500 })
      );
      return;
    }
    const body = await readRequestJson(request);
    mcpMethods.push(body.method);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: liveTools.map((name) => ({ name })) },
      })
    );
  });
  const mcpPort = await listenServer(t, mcpServer);

  const liveOptions = { cliPort, mcpPort, timeoutMs: 2000, token: TOKEN };
  const excluded = await buildCompatibilityReport(
    project,
    { env: {} },
    liveOptions
  );

  assert.equal(excluded.status, "ok");
  assert.equal(excluded.live.status, "ok");
  assert.deepEqual(excluded.live.cli.gates, {
    mutationsEnabled: false,
    unsafeEnabled: false,
  });
  assert.equal(excluded.live.cli.enabledCommands.length, 17);
  assert.equal(excluded.live.cli.blockedCommands.length, 17);
  assert.deepEqual(excluded.live.mcp.excludedDomains, ["animation"]);
  assert.deepEqual(excluded.live.mcp.partialDomains, []);
  assert.equal(excluded.routing.status, "ok");
  assert.equal(excluded.routing.mode, "live_catalog");
  const foveaRoute = excluded.routing.routes.find(
    (route) => route.familyId === "fovea_cli_extension"
  );
  assert.equal(foveaRoute.decision, "cli_runtime");
  assert.deepEqual(foveaRoute.cli.blockedCommands, [
    {
      name: "fovea_add_splat",
      requiredGate: "GODOT_CLI_ALLOW_MUTATIONS",
    },
  ]);
  const authoringRoute = excluded.routing.routes.find(
    (route) => route.familyId === "mcp_authoring_domains"
  );
  assert.equal(authoringRoute.decision, "mcp_editor");
  assert.deepEqual(authoringRoute.mcp.missingLiveTools, [
    "animation_create",
    "animation_manage",
  ]);
  assert.deepEqual(mcpMethods, ["tools/list"]);
  assert.equal(cliRequests, 1);

  liveTools = completeTools.filter((name) => name !== "animation_create");
  const partial = await buildCompatibilityReport(
    project,
    { env: {} },
    liveOptions
  );
  assert.equal(partial.status, "review_required");
  assert.deepEqual(partial.live.mcp.partialDomains, ["animation"]);
  assert.equal(partial.routing.status, "review_required");
  assert.equal(
    partial.routing.routes.find(
      (route) => route.familyId === "mcp_authoring_domains"
    )?.reasonCode,
    "partial_mcp_domain"
  );

  await assert.rejects(
    () =>
      buildCompatibilityReport(project, { env: {} }, { ...liveOptions, token: "" }),
    /GODOT_CLI_TOKEN must contain at least 32 characters/
  );

  liveTools = completeTools;
  const cliResult = await runCli(
    [
      "--port",
      String(cliPort),
      "project",
      "compatibility",
      project,
      "--live",
      "--mcp-port",
      String(mcpPort),
      "--live-timeout",
      "2000",
    ],
    { ...process.env, GODOT_CLI_TOKEN: TOKEN }
  );
  assert.equal(cliResult.code, 0, cliResult.stderr);
  const cliReport = JSON.parse(cliResult.stdout);
  assert.equal(cliReport.live.readOnly, true);
  assert.equal(cliReport.routing.authorizationSource, false);
});
