import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { GodotClient } from "./client.js";
import {
  DEFAULT_LIVE_TIMEOUT_MS,
  MAX_LIVE_TIMEOUT_MS,
  MIN_LIVE_TIMEOUT_MS,
  probeGodotAiMcp,
  type GodotAiIdentity,
  type LocalEndpoint,
} from "./mcp-live.js";
import {
  discoverProject,
  type ProjectDiscovery,
  type ProjectDiscoveryOptions,
} from "./project.js";

export const COMPATIBILITY_REPORT_VERSION = 3;
export const MAX_COMPATIBILITY_CATALOG_BYTES = 1024 * 1024;

const BUNDLED_CLI_CATALOG = fileURLToPath(
  new URL(
    "../godot-addon/addons/godot_cli/cli_server.gd",
    import.meta.url
  )
);
const GODOT_AI_CATALOG_SEGMENTS = ["addons", "godot_ai", "tool_catalog.gd"];

type CompatibilityClassification = "shared" | "cli_only" | "mcp_only";

interface CatalogSource {
  path: string;
  bytes: number;
  sha256: string;
  text: string;
}

interface CliCatalog {
  names: string[];
  security: {
    readOnly: string[];
    mutating: string[];
    unsafe: string[];
  };
}

export interface McpDomainCatalog {
  id: string;
  tools: string[];
}

interface McpCatalog {
  names: string[];
  core: string[];
  alwaysOn: string[];
  domains: McpDomainCatalog[];
}

interface CapabilityFamilyDefinition {
  id: string;
  label: string;
  cliCommands: readonly string[];
  mcpTools: readonly string[];
  note: string;
}

export interface CompatibilityFamily {
  id: string;
  label: string;
  classification: CompatibilityClassification;
  cliCommands: string[];
  mcpTools: string[];
  missingCliCommands: string[];
  missingMcpTools: string[];
  note: string;
}

export interface LiveCliCommand {
  name: string;
  security: "read_only" | "mutating" | "unsafe";
  enabled: boolean;
  requiredGate: string;
  conditionallyUnsafe: boolean;
}

export interface LiveCliObservation {
  endpoint: LocalEndpoint;
  protocol: "godot_cli_tcp_ndjson";
  catalogVersion: number;
  commandCount: number;
  gates: {
    mutationsEnabled: boolean;
    unsafeEnabled: boolean;
  };
  commands: LiveCliCommand[];
  enabledCommands: string[];
  blockedCommands: Array<{ name: string; requiredGate: string }>;
  unknownCommands: string[];
  missingCatalogCommands: string[];
}

export interface LiveMcpDomainObservation {
  id: string;
  state: "active" | "excluded" | "partial";
  expectedTools: string[];
  liveTools: string[];
  missingTools: string[];
}

export interface LiveMcpObservation {
  endpoint: LocalEndpoint;
  identityEndpoint: LocalEndpoint;
  identity: GodotAiIdentity;
  protocol: {
    mode: "modern_stateless" | "legacy_session";
    version: string;
  };
  pageCount: number;
  toolCount: number;
  unknownTools: string[];
  missingCoreTools: string[];
  missingAlwaysOnTools: string[];
  activeDomains: string[];
  excludedDomains: string[];
  partialDomains: string[];
  domains: LiveMcpDomainObservation[];
}

export interface CompatibilityLiveObservation {
  status: "ok" | "review_required";
  complete: boolean;
  observedAt: string;
  readOnly: true;
  cli: LiveCliObservation;
  mcp: LiveMcpObservation;
  warnings: string[];
}

export interface CompatibilityLiveOptions {
  cliHost?: string;
  cliPort?: string | number;
  mcpPort?: string | number;
  timeoutMs?: number;
  token?: string;
}

export type CompatibilityRouteDecision =
  | "cli_runtime"
  | "mcp_editor"
  | "choose_by_context"
  | "unavailable"
  | "review_required";

export type CompatibilityRouteReason =
  | "catalog_drift"
  | "partial_mcp_domain"
  | "static_shared_context"
  | "static_cli_only"
  | "static_mcp_only"
  | "static_unavailable"
  | "live_both"
  | "live_cli_only"
  | "live_mcp_only"
  | "live_unavailable";

export interface CompatibilityRoute {
  familyId: string;
  decision: CompatibilityRouteDecision;
  reasonCode: CompatibilityRouteReason;
  rationale: string;
  evidence: "static_catalog" | "live_catalog";
  cli: {
    catalogCommands: string[];
    enabledCommands: string[] | null;
    blockedCommands: Array<{ name: string; requiredGate: string }> | null;
  };
  mcp: {
    catalogTools: string[];
    listedTools: string[] | null;
    missingLiveTools: string[] | null;
  };
}

export interface CompatibilityRoutingAdvice {
  status: "ok" | "review_required";
  complete: boolean;
  mode: "static_catalog" | "live_catalog";
  advisoryOnly: true;
  authorizationSource: false;
  routes: CompatibilityRoute[];
  reviewRequiredFamilies: string[];
  unmappedCatalogEntries: {
    cliCommands: string[];
    mcpTools: string[];
  };
  warnings: string[];
}

export interface CompatibilityReport {
  status: "ok" | "review_required";
  complete: boolean;
  reportVersion: number;
  basis: "bundled_cli_and_installed_mcp_catalogs";
  equivalence: "semantic_families_only";
  project: ProjectDiscovery;
  catalogs: {
    cli: {
      path: string;
      bytes: number;
      sha256: string;
      count: number;
      securityCounts: {
        readOnly: number;
        mutating: number;
        unsafe: number;
      };
    };
    mcp: {
      path: string;
      bytes: number;
      sha256: string;
      count: number;
      coreCount: number;
      alwaysOnCount: number;
      domains: McpDomainCatalog[];
    };
  };
  summary: {
    familyCount: number;
    sharedFamilies: number;
    cliOnlyFamilies: number;
    mcpOnlyFamilies: number;
    unmappedCliCommands: string[];
    unmappedMcpTools: string[];
    missingExpectedCliCommands: string[];
    missingExpectedMcpTools: string[];
  };
  families: CompatibilityFamily[];
  routing: CompatibilityRoutingAdvice;
  live?: CompatibilityLiveObservation;
  warnings: string[];
}

const CAPABILITY_FAMILIES: readonly CapabilityFamilyDefinition[] = [
  {
    id: "control_plane_state",
    label: "Control plane and state",
    cliCommands: ["ping", "commands", "server_info", "viewport_info"],
    mcpTools: [
      "editor_state",
      "session_activate",
      "session_manage",
      "client_manage",
      "editor_manage",
      "editor_reload_plugin",
      "logs_read",
      "project_manage",
    ],
    note:
      "Readiness, lifecycle, diagnostics, and editor state overlap only at workflow level.",
  },
  {
    id: "scene_node_operations",
    label: "Scene hierarchy and nodes",
    cliCommands: [
      "scene_tree",
      "get_node",
      "visible_nodes",
      "set_property",
      "add_node",
      "remove_node",
      "reparent_node",
      "rename_node",
    ],
    mcpTools: [
      "scene_get_hierarchy",
      "node_get_properties",
      "node_create",
      "node_find",
      "node_manage",
      "node_set_property",
    ],
    note:
      "Both surfaces inspect and edit nodes, but operate in different editor/runtime contexts.",
  },
  {
    id: "scene_capture_operations",
    label: "Scenes and captures",
    cliCommands: ["screenshot", "load_scene", "save_scene"],
    mcpTools: [
      "editor_screenshot",
      "camera_manage",
      "scene_manage",
      "scene_open",
      "scene_save",
    ],
    note:
      "Capture and scene lifecycle intent overlaps; persistence and viewport behavior may differ.",
  },
  {
    id: "project_asset_script_operations",
    label: "Project files, assets, and scripts",
    cliCommands: [
      "read_file",
      "list_files",
      "list_classes",
      "class_info",
      "create_file",
      "delete_file",
      "attach_script",
      "detach_script",
    ],
    mcpTools: [
      "api_manage",
      "filesystem_manage",
      "resource_manage",
      "script_attach",
      "script_create",
      "script_manage",
      "script_patch",
    ],
    note:
      "Both surfaces cover project data and scripts; this does not imply identical path or write policies.",
  },
  {
    id: "runtime_validation_operations",
    label: "Runtime automation and validation",
    cliCommands: [
      "wait_for",
      "assert",
      "validate_scene",
      "click",
      "press_key",
      "mouse_move",
      "call_method",
      "eval",
    ],
    mcpTools: [
      "batch_execute",
      "game_manage",
      "input_map_manage",
      "project_run",
      "test_manage",
      "test_run",
    ],
    note:
      "These tools support automation workflows, but input maps, live input, tests, and evaluation are distinct operations.",
  },
  {
    id: "fovea_cli_extension",
    label: "FoveaCore CLI extension",
    cliCommands: ["fovea_status", "fovea_validate", "fovea_add_splat"],
    mcpTools: [],
    note:
      "The versioned FoveaCore bridge is CLI-specific in the inspected MCP catalog.",
  },
  {
    id: "mcp_authoring_domains",
    label: "MCP authoring domains",
    cliCommands: [],
    mcpTools: [
      "animation_create",
      "animation_manage",
      "audio_manage",
      "autoload_manage",
      "material_manage",
      "particle_manage",
      "signal_manage",
      "theme_manage",
      "tilemap_manage",
      "tileset_manage",
      "ui_manage",
    ],
    note:
      "These editor authoring domains have no direct command in the inspected runtime CLI manifest.",
  },
];

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function readCatalog(
  catalogPath: string,
  label: string,
  containmentRoot?: string
): Promise<CatalogSource> {
  let stat;
  try {
    stat = await fs.lstat(catalogPath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `${label} not found at ${catalogPath}. Install the expected addon before running the compatibility report.`
      );
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${catalogPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file: ${catalogPath}`);
  }
  if (stat.size > MAX_COMPATIBILITY_CATALOG_BYTES) {
    throw new Error(
      `${label} exceeds the ${MAX_COMPATIBILITY_CATALOG_BYTES}-byte limit: ${catalogPath}`
    );
  }

  const realPath = await fs.realpath(catalogPath);
  if (containmentRoot && !isWithin(containmentRoot, realPath)) {
    throw new Error(`${label} resolves outside the Godot project: ${catalogPath}`);
  }
  const text = await fs.readFile(realPath, "utf8");
  return {
    path: realPath,
    bytes: stat.size,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    text,
  };
}

function extractConstantBody(
  source: string,
  constantName: string,
  opener: "[" | "{",
  closer: "]" | "}"
): string {
  const escapedOpen = opener === "[" ? "\\[" : "\\{";
  const escapedClose = closer === "]" ? "\\]" : "\\}";
  const expression = new RegExp(
    `^const\\s+${constantName}\\s*:=\\s*${escapedOpen}\\s*\\r?\\n([\\s\\S]*?)^${escapedClose}\\s*$`,
    "m"
  );
  const match = expression.exec(source);
  if (!match) {
    throw new Error(`Catalog constant ${constantName} is missing or malformed.`);
  }
  return match[1];
}

function parseQuotedNames(body: string, label: string): string[] {
  const names = [...body.matchAll(/"([a-z][a-z0-9_]*)"/g)].map(
    (match) => match[1]
  );
  if (names.length === 0) {
    throw new Error(`${label} contains no tool names.`);
  }
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error(`${label} contains duplicate tool names.`);
  }
  return names;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry) => right.includes(entry))
  );
}

function parseCliCatalog(source: string): CliCatalog {
  const names = parseQuotedNames(
    extractConstantBody(source, "COMMAND_DESCRIPTIONS", "{", "}"),
    "COMMAND_DESCRIPTIONS"
  );
  const readOnly = parseQuotedNames(
    extractConstantBody(source, "READ_ONLY_COMMANDS", "{", "}"),
    "READ_ONLY_COMMANDS"
  );
  const mutating = parseQuotedNames(
    extractConstantBody(source, "MUTATING_COMMANDS", "{", "}"),
    "MUTATING_COMMANDS"
  );
  const unsafe = parseQuotedNames(
    extractConstantBody(source, "UNSAFE_COMMANDS", "{", "}"),
    "UNSAFE_COMMANDS"
  );
  const categorized = [...readOnly, ...mutating, ...unsafe];
  if (new Set(categorized).size !== categorized.length) {
    throw new Error("CLI command security categories overlap.");
  }
  if (!sameMembers(names, categorized)) {
    throw new Error(
      "CLI command descriptions and security categories are out of sync."
    );
  }
  return {
    names,
    security: { readOnly, mutating, unsafe },
  };
}

function parseMcpCatalog(source: string): McpCatalog {
  const core = parseQuotedNames(
    extractConstantBody(source, "CORE_TOOLS", "[", "]"),
    "CORE_TOOLS"
  );
  const alwaysOn = parseQuotedNames(
    extractConstantBody(source, "ALWAYS_ON_TOOLS", "[", "]"),
    "ALWAYS_ON_TOOLS"
  );
  const domainsBody = extractConstantBody(source, "DOMAINS", "[", "]");
  const candidateLines = domainsBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"id"'));
  const domains: McpDomainCatalog[] = [];
  const domainPattern =
    /^\{"id":\s*"([a-z][a-z0-9_]*)",\s*"label":\s*"[^"]+",\s*"count":\s*(\d+),\s*"tools":\s*\[([^\]]*)\]\},?$/;
  for (const line of candidateLines) {
    const match = domainPattern.exec(line);
    if (!match) {
      throw new Error(`Malformed MCP domain catalog entry: ${line}`);
    }
    const tools = parseQuotedNames(match[3], `MCP domain ${match[1]}`);
    const declaredCount = Number(match[2]);
    if (declaredCount !== tools.length) {
      throw new Error(
        `MCP domain ${match[1]} declares ${declaredCount} tools but lists ${tools.length}.`
      );
    }
    domains.push({ id: match[1], tools });
  }
  if (domains.length === 0 || domains.length !== candidateLines.length) {
    throw new Error("MCP DOMAINS contains no complete domain entries.");
  }
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) {
    throw new Error("MCP DOMAINS contains duplicate domain ids.");
  }

  const names = [
    ...core,
    ...alwaysOn,
    ...domains.flatMap((domain) => domain.tools),
  ];
  if (new Set(names).size !== names.length) {
    throw new Error("MCP tool catalog contains duplicate tool names.");
  }
  return { names, core, alwaysOn, domains };
}

function classificationFor(
  cliCommands: readonly string[],
  mcpTools: readonly string[]
): CompatibilityClassification {
  if (cliCommands.length > 0 && mcpTools.length > 0) return "shared";
  if (cliCommands.length > 0) return "cli_only";
  return "mcp_only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInteger(
  value: string | number | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  const parsed =
    value === undefined
      ? fallback
      : typeof value === "number"
        ? value
        : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}.`
    );
  }
  return parsed;
}

function parseLiveCliCommand(value: unknown): LiveCliCommand {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
    throw new Error("Live CLI catalog returned a command without a valid name.");
  }
  if (
    value.security !== "read_only" &&
    value.security !== "mutating" &&
    value.security !== "unsafe"
  ) {
    throw new Error(`Live CLI command '${value.name}' has invalid security metadata.`);
  }
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.required_gate !== "string" ||
    typeof value.conditionally_unsafe !== "boolean"
  ) {
    throw new Error(`Live CLI command '${value.name}' has malformed gate metadata.`);
  }
  return {
    name: value.name,
    security: value.security,
    enabled: value.enabled,
    requiredGate: value.required_gate,
    conditionallyUnsafe: value.conditionally_unsafe,
  };
}

async function observeLiveCli(
  catalog: CliCatalog,
  options: Required<
    Pick<CompatibilityLiveOptions, "cliHost" | "cliPort" | "timeoutMs">
  > & { token?: string }
): Promise<LiveCliObservation> {
  const port = normalizeInteger(options.cliPort, 9900, "CLI port", 1, 65535);
  const client = new GodotClient({
    host: options.cliHost,
    port,
    token: options.token,
  });
  const response = await client.send("commands", {}, options.timeoutMs);
  if (response.status === "error") {
    throw new Error(`Live CLI commands probe failed: ${response.error}`);
  }
  if (!isRecord(response.data)) {
    throw new Error("Live CLI commands probe returned malformed data.");
  }
  const data = response.data;
  if (
    !Number.isInteger(data.catalog_version) ||
    data.protocol !== "godot_cli_tcp_ndjson" ||
    data.mcp_server !== false ||
    data.annotations_are_security_controls !== false ||
    !Number.isInteger(data.count) ||
    !Array.isArray(data.commands) ||
    !isRecord(data.gates) ||
    typeof data.gates.mutations_enabled !== "boolean" ||
    typeof data.gates.unsafe_enabled !== "boolean"
  ) {
    throw new Error("Live CLI commands probe returned an incompatible catalog envelope.");
  }

  const commands = data.commands.map(parseLiveCliCommand);
  if (data.count !== commands.length) {
    throw new Error(
      `Live CLI catalog declares ${String(data.count)} commands but returned ${commands.length}.`
    );
  }
  const names = commands.map((command) => command.name);
  if (new Set(names).size !== names.length) {
    throw new Error("Live CLI catalog returned duplicate command names.");
  }
  const expected = new Set(catalog.names);
  const live = new Set(names);
  return {
    endpoint: { host: options.cliHost, port, path: "tcp/ndjson" },
    protocol: "godot_cli_tcp_ndjson",
    catalogVersion: data.catalog_version as number,
    commandCount: commands.length,
    gates: {
      mutationsEnabled: data.gates.mutations_enabled as boolean,
      unsafeEnabled: data.gates.unsafe_enabled as boolean,
    },
    commands: commands.sort((left, right) => left.name.localeCompare(right.name)),
    enabledCommands: commands
      .filter((command) => command.enabled)
      .map((command) => command.name)
      .sort(),
    blockedCommands: commands
      .filter((command) => !command.enabled)
      .map((command) => ({
        name: command.name,
        requiredGate: command.requiredGate,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    unknownCommands: names.filter((name) => !expected.has(name)).sort(),
    missingCatalogCommands: catalog.names
      .filter((name) => !live.has(name))
      .sort(),
  };
}

function analyzeLiveMcp(
  catalog: McpCatalog,
  probe: Awaited<ReturnType<typeof probeGodotAiMcp>>
): LiveMcpObservation {
  const expected = new Set(catalog.names);
  const live = new Set(probe.toolNames);
  const domains = catalog.domains.map((domain) => {
    const liveTools = domain.tools.filter((tool) => live.has(tool));
    const missingTools = domain.tools.filter((tool) => !live.has(tool));
    const state =
      liveTools.length === 0
        ? "excluded"
        : missingTools.length === 0
          ? "active"
          : "partial";
    return {
      id: domain.id,
      state,
      expectedTools: domain.tools,
      liveTools,
      missingTools,
    } satisfies LiveMcpDomainObservation;
  });
  return {
    endpoint: probe.endpoint,
    identityEndpoint: probe.identityEndpoint,
    identity: probe.identity,
    protocol: probe.protocol,
    pageCount: probe.pageCount,
    toolCount: probe.toolNames.length,
    unknownTools: probe.toolNames.filter((name) => !expected.has(name)).sort(),
    missingCoreTools: catalog.core.filter((name) => !live.has(name)).sort(),
    missingAlwaysOnTools: catalog.alwaysOn
      .filter((name) => !live.has(name))
      .sort(),
    activeDomains: domains
      .filter((domain) => domain.state === "active")
      .map((domain) => domain.id),
    excludedDomains: domains
      .filter((domain) => domain.state === "excluded")
      .map((domain) => domain.id),
    partialDomains: domains
      .filter((domain) => domain.state === "partial")
      .map((domain) => domain.id),
    domains,
  };
}

async function observeLiveCompatibility(
  cliCatalog: CliCatalog,
  mcpCatalog: McpCatalog,
  options: CompatibilityLiveOptions
): Promise<CompatibilityLiveObservation> {
  const timeoutMs = normalizeInteger(
    options.timeoutMs,
    DEFAULT_LIVE_TIMEOUT_MS,
    "Live timeout",
    MIN_LIVE_TIMEOUT_MS,
    MAX_LIVE_TIMEOUT_MS
  );
  const probe = await probeGodotAiMcp({
    port: options.mcpPort,
    timeoutMs,
  });
  const mcp = analyzeLiveMcp(mcpCatalog, probe);
  const cli = await observeLiveCli(cliCatalog, {
    cliHost: options.cliHost ?? "127.0.0.1",
    cliPort: options.cliPort ?? 9900,
    timeoutMs,
    token: options.token,
  });
  const complete =
    cli.unknownCommands.length === 0 &&
    cli.missingCatalogCommands.length === 0 &&
    mcp.unknownTools.length === 0 &&
    mcp.missingCoreTools.length === 0 &&
    mcp.missingAlwaysOnTools.length === 0 &&
    mcp.partialDomains.length === 0;
  return {
    status: complete ? "ok" : "review_required",
    complete,
    observedAt: new Date().toISOString(),
    readOnly: true,
    cli,
    mcp,
    warnings: [
      "Live state is a point-in-time observation and does not prove editor readiness or tool behavior.",
      "The probe performs only catalog discovery (plus the required legacy MCP session handshake and cleanup); it never enables gates, invokes tools, starts servers, or changes configuration.",
    ],
  };
}

const ROUTE_RATIONALES: Record<CompatibilityRouteReason, string> = {
  catalog_drift:
    "Expected catalog entries are missing or inconsistent; review before routing.",
  partial_mcp_domain:
    "Only part of an MCP domain is listed live; treat its routing as indeterminate.",
  static_shared_context:
    "Both catalogs cover this family; choose editor or runtime context before acting.",
  static_cli_only:
    "Only the runtime CLI catalog covers this capability family.",
  static_mcp_only:
    "Only the editor MCP catalog covers this capability family.",
  static_unavailable:
    "Neither static catalog covers this capability family.",
  live_both:
    "Both live catalogs expose capabilities; choose editor or runtime context before acting.",
  live_cli_only:
    "Only the live runtime CLI exposes an enabled capability in this family.",
  live_mcp_only:
    "Only the live editor MCP lists a capability in this family.",
  live_unavailable:
    "Neither live catalog exposes an enabled capability in this family.",
};

function buildRoutingAdvice(
  families: CompatibilityFamily[],
  live: CompatibilityLiveObservation | undefined,
  unmappedCliCommands: string[],
  unmappedMcpTools: string[]
): CompatibilityRoutingAdvice {
  const enabledCli = new Set(live?.cli.enabledCommands ?? []);
  const blockedCli = new Map(
    (live?.cli.blockedCommands ?? []).map((command) => [command.name, command])
  );
  const missingMcp = new Set([
    ...(live?.mcp.missingCoreTools ?? []),
    ...(live?.mcp.missingAlwaysOnTools ?? []),
    ...(live?.mcp.domains.flatMap((domain) => domain.missingTools) ?? []),
  ]);
  const partialMcpTools = new Set(
    live?.mcp.domains
      .filter((domain) => domain.state === "partial")
      .flatMap((domain) => domain.expectedTools) ?? []
  );

  const routes = families.map((family) => {
    const enabledCommands = live
      ? family.cliCommands.filter((name) => enabledCli.has(name))
      : null;
    const blockedCommands = live
      ? family.cliCommands
          .map((name) => blockedCli.get(name))
          .filter(
            (command): command is { name: string; requiredGate: string } =>
              command !== undefined
          )
      : null;
    const listedTools = live
      ? family.mcpTools.filter((name) => !missingMcp.has(name))
      : null;
    const missingLiveTools = live
      ? family.mcpTools.filter((name) => missingMcp.has(name))
      : null;
    const catalogDrift =
      family.missingCliCommands.length > 0 || family.missingMcpTools.length > 0;
    const partialDomain =
      live !== undefined &&
      family.mcpTools.some((name) => partialMcpTools.has(name));

    let decision: CompatibilityRouteDecision;
    let reasonCode: CompatibilityRouteReason;
    if (catalogDrift) {
      decision = "review_required";
      reasonCode = "catalog_drift";
    } else if (partialDomain) {
      decision = "review_required";
      reasonCode = "partial_mcp_domain";
    } else if (!live) {
      if (family.cliCommands.length > 0 && family.mcpTools.length > 0) {
        decision = "choose_by_context";
        reasonCode = "static_shared_context";
      } else if (family.cliCommands.length > 0) {
        decision = "cli_runtime";
        reasonCode = "static_cli_only";
      } else if (family.mcpTools.length > 0) {
        decision = "mcp_editor";
        reasonCode = "static_mcp_only";
      } else {
        decision = "unavailable";
        reasonCode = "static_unavailable";
      }
    } else {
      const hasCli = (enabledCommands?.length ?? 0) > 0;
      const hasMcp = (listedTools?.length ?? 0) > 0;
      if (hasCli && hasMcp) {
        decision = "choose_by_context";
        reasonCode = "live_both";
      } else if (hasCli) {
        decision = "cli_runtime";
        reasonCode = "live_cli_only";
      } else if (hasMcp) {
        decision = "mcp_editor";
        reasonCode = "live_mcp_only";
      } else {
        decision = "unavailable";
        reasonCode = "live_unavailable";
      }
    }

    return {
      familyId: family.id,
      decision,
      reasonCode,
      rationale: ROUTE_RATIONALES[reasonCode],
      evidence: live ? "live_catalog" : "static_catalog",
      cli: {
        catalogCommands: family.cliCommands,
        enabledCommands,
        blockedCommands,
      },
      mcp: {
        catalogTools: family.mcpTools,
        listedTools,
        missingLiveTools,
      },
    } satisfies CompatibilityRoute;
  });

  const reviewRequiredFamilies = routes
    .filter((route) => route.decision === "review_required")
    .map((route) => route.familyId);
  const complete =
    reviewRequiredFamilies.length === 0 &&
    unmappedCliCommands.length === 0 &&
    unmappedMcpTools.length === 0 &&
    (live?.status ?? "ok") === "ok";
  return {
    status: complete ? "ok" : "review_required",
    complete,
    mode: live ? "live_catalog" : "static_catalog",
    advisoryOnly: true,
    authorizationSource: false,
    routes,
    reviewRequiredFamilies,
    unmappedCatalogEntries: {
      cliCommands: unmappedCliCommands,
      mcpTools: unmappedMcpTools,
    },
    warnings: [
      "Routing advice distinguishes the runtime CLI from the editor MCP but does not claim behavioral equivalence.",
      "Never enable a capability gate or invoke a mutating operation based on routing advice or annotations alone.",
    ],
  };
}

export async function buildCompatibilityReport(
  requested?: string,
  discoveryOptions: ProjectDiscoveryOptions = {},
  liveOptions?: CompatibilityLiveOptions
): Promise<CompatibilityReport> {
  const project = await discoverProject(requested, discoveryOptions);
  const mcpCatalogPath = path.join(
    project.projectRoot,
    ...GODOT_AI_CATALOG_SEGMENTS
  );
  const [cliSource, mcpSource] = await Promise.all([
    readCatalog(BUNDLED_CLI_CATALOG, "Bundled Godot CLI command catalog"),
    readCatalog(
      mcpCatalogPath,
      "Godot AI tool catalog",
      project.projectRoot
    ),
  ]);
  const cli = parseCliCatalog(cliSource.text);
  const mcp = parseMcpCatalog(mcpSource.text);
  const cliSet = new Set(cli.names);
  const mcpSet = new Set(mcp.names);

  const families = CAPABILITY_FAMILIES.map((definition) => {
    const cliCommands = definition.cliCommands.filter((name) => cliSet.has(name));
    const mcpTools = definition.mcpTools.filter((name) => mcpSet.has(name));
    return {
      id: definition.id,
      label: definition.label,
      classification: classificationFor(cliCommands, mcpTools),
      cliCommands,
      mcpTools,
      missingCliCommands: definition.cliCommands.filter(
        (name) => !cliSet.has(name)
      ),
      missingMcpTools: definition.mcpTools.filter((name) => !mcpSet.has(name)),
      note: definition.note,
    } satisfies CompatibilityFamily;
  });

  const expectedCli = new Set(
    CAPABILITY_FAMILIES.flatMap((family) => family.cliCommands)
  );
  const expectedMcp = new Set(
    CAPABILITY_FAMILIES.flatMap((family) => family.mcpTools)
  );
  const unmappedCliCommands = cli.names
    .filter((name) => !expectedCli.has(name))
    .sort();
  const unmappedMcpTools = mcp.names
    .filter((name) => !expectedMcp.has(name))
    .sort();
  const missingExpectedCliCommands = [...expectedCli]
    .filter((name) => !cliSet.has(name))
    .sort();
  const missingExpectedMcpTools = [...expectedMcp]
    .filter((name) => !mcpSet.has(name))
    .sort();
  const staticComplete =
    unmappedCliCommands.length === 0 &&
    unmappedMcpTools.length === 0 &&
    missingExpectedCliCommands.length === 0 &&
    missingExpectedMcpTools.length === 0;

  const live = liveOptions
    ? await observeLiveCompatibility(cli, mcp, liveOptions)
    : undefined;
  const routing = buildRoutingAdvice(
    families,
    live,
    unmappedCliCommands,
    unmappedMcpTools
  );
  const complete = staticComplete && (live?.complete ?? true);

  return {
    status: complete ? "ok" : "review_required",
    complete,
    reportVersion: COMPATIBILITY_REPORT_VERSION,
    basis: "bundled_cli_and_installed_mcp_catalogs",
    equivalence: "semantic_families_only",
    project,
    catalogs: {
      cli: {
        path: cliSource.path,
        bytes: cliSource.bytes,
        sha256: cliSource.sha256,
        count: cli.names.length,
        securityCounts: {
          readOnly: cli.security.readOnly.length,
          mutating: cli.security.mutating.length,
          unsafe: cli.security.unsafe.length,
        },
      },
      mcp: {
        path: mcpSource.path,
        bytes: mcpSource.bytes,
        sha256: mcpSource.sha256,
        count: mcp.names.length,
        coreCount: mcp.core.length,
        alwaysOnCount: mcp.alwaysOn.length,
        domains: mcp.domains,
      },
    },
    summary: {
      familyCount: families.length,
      sharedFamilies: families.filter(
        (family) => family.classification === "shared"
      ).length,
      cliOnlyFamilies: families.filter(
        (family) => family.classification === "cli_only"
      ).length,
      mcpOnlyFamilies: families.filter(
        (family) => family.classification === "mcp_only"
      ).length,
      unmappedCliCommands,
      unmappedMcpTools,
      missingExpectedCliCommands,
      missingExpectedMcpTools,
    },
    families,
    routing,
    ...(live ? { live } : {}),
    warnings: [
      "Semantic family overlap does not prove parameter, transport, authorization, side-effect, or runtime equivalence.",
      live
        ? "Live observations are bounded snapshots layered over the static catalogs; they do not prove editor readiness or command behavior."
        : "The report parses static catalogs; it does not observe live CLI gates, MCP domain exclusions, editor readiness, or server wiring.",
    ],
  };
}
