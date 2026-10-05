import { Ajv, type ValidateFunction } from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GodotClient, type GodotResponse } from "./client.js";
import { buildDoctorReport, CLI_VERSION } from "./doctor.js";
import { selectNodeProperties, validatePropertySelection } from "./node-inspection.js";
import {
  assertMcpJsonBudget,
  BoundedMcpStdioTransport,
  redactMcpText,
} from "./mcp-stdio.js";

export const MAX_MCP_TOOL_CALLS = 4;
export const MAX_MCP_TOOL_RESULT_BYTES = 64 * 1024;
export const MAX_MCP_GODOT_RESPONSE_BYTES = 1024 * 1024;
export const MCP_TOOL_TIMEOUT_MS = 10_000;
export const MAX_MCP_SCENE_DEPTH = 8;

const pathSchema = {
  type: "string", minLength: 1, maxLength: 4096,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
};
const noArguments = { type: "object" as const, properties: {}, additionalProperties: false };
const annotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};

// Stable ordering and a small catalog keep discovery context predictable.
const tools: Tool[] = [
  {
    name: "godot_doctor",
    description: "Check the local Godot addon version, debug build, limits and safety gates. Run first before inspecting a scene.",
    inputSchema: noArguments, annotations,
  },
  {
    name: "godot_get_node",
    description: "Read 1–32 exact node properties with identity metadata. Missing properties fail; unrelated node context is omitted. Selection is client-side.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["path", "properties"],
      properties: {
        path: pathSchema,
        properties: {
          type: "array", minItems: 1, maxItems: 32, uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
    annotations,
  },
  {
    name: "godot_ping",
    description: "Check that the authenticated local Godot runtime responds.",
    inputSchema: noArguments, annotations,
  },
  {
    name: "godot_scene_tree",
    description: "Inspect a small live hierarchy. Depth defaults to 2, maximum 8. Use a root path to narrow context. Traversal truncation fails.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        root: pathSchema,
        depth: { type: "integer", minimum: 0, maximum: MAX_MCP_SCENE_DEPTH },
      },
    },
    annotations,
  },
  {
    name: "godot_validate_scene",
    description: "Read structural scene diagnostics. Invalid or incomplete validation returns a tool error with no mutation.",
    inputSchema: noArguments, annotations,
  },
  {
    name: "godot_viewport_info",
    description: "Read live viewport and engine performance metrics without captures or file writes.",
    inputSchema: noArguments, annotations,
  },
];

const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = new Map<string, ValidateFunction>(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateArguments(name: string, value: unknown): Record<string, unknown> {
  const validate = validators.get(name);
  if (!validate || !validate(value) || !isRecord(value)) {
    throw new McpError(ErrorCode.InvalidParams, "Unknown tool or invalid tool arguments.");
  }
  for (const field of ["path", "root"]) {
    if (value[field] !== undefined && (
      typeof value[field] !== "string" ||
      value[field].trim().length === 0 ||
      Buffer.byteLength(value[field], "utf8") > 4096
    )) throw new McpError(ErrorCode.InvalidParams, "Invalid node path.");
  }
  if (name === "godot_get_node") validatePropertySelection(value.properties);
  return value;
}

function toolResult(value: unknown, token: string, isError = false): CallToolResult {
  assertMcpJsonBudget(value);
  const text = redactMcpText(JSON.stringify(value), token);
  if (Buffer.byteLength(text, "utf8") > MAX_MCP_TOOL_RESULT_BYTES) {
    throw new Error("Godot result exceeds 64 KiB; narrow the root, depth or property selection.");
  }
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function projectResult(name: string, response: GodotResponse, args: Record<string, unknown>): GodotResponse {
  if (response.status === "error") return response;
  if (name === "godot_get_node") {
    return selectNodeProperties(response, args.properties as string[]);
  }
  if (!isRecord(response.data)) throw new Error("Godot returned an invalid tool result.");
  if (name === "godot_doctor") {
    const report = buildDoctorReport(response.data);
    return { id: response.id, status: report.status, data: report };
  }
  if (name === "godot_scene_tree") {
    const metadata = response.data._cli;
    if (!isRecord(metadata) || typeof metadata.truncated !== "boolean") {
      throw new Error("Godot returned invalid scene traversal metadata.");
    }
    if (metadata.truncated) throw new Error("Scene traversal was incomplete; choose a smaller root or depth.");
  }
  if (name === "godot_validate_scene") {
    if (response.data.complete !== true) throw new Error("Godot scene validation was incomplete.");
    if (typeof response.data.valid !== "boolean") throw new Error("Godot returned invalid validation metadata.");
  }
  return response;
}

export interface GodotMcpOptions {
  host?: string;
  port?: string | number;
}

/** Serve MCP over stdio only; reuse the existing authenticated loopback client. */
export async function serveGodotMcp(options: GodotMcpOptions = {}): Promise<void> {
  const token = (process.env.GODOT_CLI_TOKEN ?? "").trim();
  if (token.length < 32 || Buffer.byteLength(token, "utf8") > 4096) {
    throw new Error("GODOT_CLI_TOKEN must contain at least 32 characters and at most 4096 UTF-8 bytes.");
  }
  const port = options.port === undefined ? 9900 : Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP Godot server port.");
  let client: GodotClient;
  try {
    client = new GodotClient({
      host: options.host, port, token,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: MAX_MCP_GODOT_RESPONSE_BYTES,
    });
  } catch (error) {
    throw new Error(redactMcpText(error instanceof Error ? error.message : String(error), token));
  }
  const transport = new BoundedMcpStdioTransport(token);
  const server = new Server({ name: "ultimate-odycer-godot", version: CLI_VERSION }, {
    capabilities: { tools: {} },
    instructions: "Local read-only Godot inspection. Start with godot_doctor. Select only necessary properties and scene roots. No mutations, code execution, model calls or automatic retries.",
  });
  const active = new Set<AbortController>();
  let initialized = false;
  server.oninitialized = () => { initialized = true; };
  server.onclose = () => { for (const controller of active) controller.abort(); };
  server.onerror = () => { /* Never log SDK errors containing request data. */ };
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (!initialized) throw new McpError(ErrorCode.InvalidRequest, "Initialize the MCP session first.");
    if (request.params?.cursor !== undefined) throw new McpError(ErrorCode.InvalidParams, "This bounded catalog has no pagination.");
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!initialized) throw new McpError(ErrorCode.InvalidRequest, "Initialize the MCP session first.");
    if (request.params.task) throw new McpError(ErrorCode.InvalidParams, "Task creation is not supported.");
    let controller: AbortController | undefined;
    let timer: NodeJS.Timeout | undefined;
    const cancel = (): void => { controller?.abort(); };
    try {
      const name = request.params.name;
      const args = validateArguments(name, request.params.arguments ?? {});
      if (active.size >= MAX_MCP_TOOL_CALLS) throw new Error("Godot MCP is busy: at most four reads may run concurrently; retry explicitly after a read finishes.");
      controller = new AbortController();
      active.add(controller);
      extra.signal.addEventListener("abort", cancel, { once: true });
      if (extra.signal.aborted) controller.abort();
      timer = setTimeout(cancel, MCP_TOOL_TIMEOUT_MS);
      let command: string;
      let params: Record<string, unknown> = {};
      switch (name) {
        case "godot_doctor": command = "server_info"; break;
        case "godot_get_node": command = "get_node"; params = { path: args.path }; break;
        case "godot_ping": command = "ping"; break;
        case "godot_scene_tree":
          command = "scene_tree";
          params = { depth: args.depth ?? 2, ...(args.root === undefined ? {} : { root: args.root }) };
          break;
        case "godot_validate_scene": command = "validate_scene"; break;
        case "godot_viewport_info": command = "viewport_info"; break;
        default: throw new Error("Unknown Godot MCP tool.");
      }
      const response = projectResult(name, await client.send(command, params, MCP_TOOL_TIMEOUT_MS, controller.signal), args);
      const invalidScene = name === "godot_validate_scene" && isRecord(response.data) && response.data.valid === false;
      return toolResult(response, token, response.status === "error" || invalidScene);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Godot MCP read failed.";
      // Error detail is bounded too; never dump the failed response as a fallback.
      const safe = redactMcpText(message, token);
      return toolResult({ status: "error", error: Buffer.byteLength(safe, "utf8") <= 1024 ? safe : "Godot MCP read failed." }, token, true);
    } finally {
      clearTimeout(timer);
      extra.signal.removeEventListener("abort", cancel);
      if (controller) active.delete(controller);
    }
  });
  const stop = (): void => { void transport.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.connect(transport);
    await transport.closed;
    if (transport.failure) throw transport.failure;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await transport.close();
  }
}
