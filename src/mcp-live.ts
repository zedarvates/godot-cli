const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";

export const DEFAULT_GODOT_AI_MCP_PORT = 8000;
export const DEFAULT_LIVE_TIMEOUT_MS = 3000;
export const MIN_LIVE_TIMEOUT_MS = 100;
export const MAX_LIVE_TIMEOUT_MS = 10_000;
export const MAX_MCP_IDENTITY_BYTES = 64 * 1024;
export const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_MCP_TOOL_PAGES = 8;
export const MAX_MCP_TOOLS = 512;

interface HttpPayload {
  status: number;
  headers: Headers;
  contentType: string;
  text: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
}

interface McpListResult {
  tools: Array<{ name: string }>;
  nextCursor?: string;
}

export interface LocalEndpoint {
  host: string;
  port: number;
  path: string;
}

export interface GodotAiIdentity {
  name: "godot-ai";
  version?: string;
  wsPort?: number;
}

export interface GodotAiMcpProbe {
  endpoint: LocalEndpoint;
  identityEndpoint: LocalEndpoint;
  identity: GodotAiIdentity;
  protocol: {
    mode: "modern_stateless" | "legacy_session";
    version: string;
  };
  toolNames: string[];
  pageCount: number;
}

export interface GodotAiMcpProbeOptions {
  port?: string | number;
  timeoutMs?: number;
}

class ModernProtocolUnsupportedError extends Error {}

function parseBoundedInteger(
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

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error("Live MCP observation timed out.");
  return remaining;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error(`MCP response exceeded ${maxBytes} bytes.`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`MCP response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString(
    "utf8"
  );
}

async function requestBounded(
  url: string,
  init: RequestInit,
  deadline: number,
  maxBytes: number
): Promise<HttpPayload> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingTime(deadline));
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readBoundedBody(response, maxBytes);
    return {
      status: response.status,
      headers: response.headers,
      contentType: (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase(),
      text,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Live MCP observation timed out.");
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reach the local Godot AI MCP server: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (payload === "" || payload === "[DONE]") continue;
    messages.push(parseJson(payload, "MCP SSE event"));
  }
  if (messages.length === 0) {
    throw new Error("MCP SSE response contained no JSON data event.");
  }
  return messages;
}

function parseRpcResponse(
  payload: HttpPayload,
  requestId: string
): JsonRpcResponse {
  let candidates: unknown[];
  if (payload.contentType === "application/json") {
    candidates = [parseJson(payload.text, "MCP endpoint")];
  } else if (payload.contentType === "text/event-stream") {
    candidates = parseSseMessages(payload.text);
  } else {
    throw new Error(
      `MCP endpoint returned unsupported content type '${payload.contentType || "missing"}'.`
    );
  }

  const value = candidates.find(
    (candidate) => isRecord(candidate) && candidate.id === requestId
  );
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new Error("MCP response did not match the JSON-RPC request ID.");
  }
  if (value.error !== undefined && !isRecord(value.error)) {
    throw new Error("MCP response contained a malformed JSON-RPC error.");
  }
  return value as unknown as JsonRpcResponse;
}

function rpcErrorMessage(response: JsonRpcResponse): string {
  if (!response.error) return "Unknown MCP protocol error.";
  return typeof response.error.message === "string"
    ? response.error.message
    : "Unknown MCP protocol error.";
}

function parseListResult(response: JsonRpcResponse): McpListResult {
  if (response.error) throw new Error(`MCP tools/list failed: ${rpcErrorMessage(response)}`);
  if (!isRecord(response.result) || !Array.isArray(response.result.tools)) {
    throw new Error("MCP tools/list returned a malformed result.");
  }
  const tools: Array<{ name: string }> = [];
  for (const tool of response.result.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || tool.name === "") {
      throw new Error("MCP tools/list returned a tool without a valid name.");
    }
    tools.push({ name: tool.name });
  }
  const nextCursor = response.result.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string") {
    throw new Error("MCP tools/list returned an invalid nextCursor.");
  }
  return { tools, nextCursor };
}

function clientMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/clientInfo": {
      name: "uo-godot-cli",
      version: "0.1",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

function rpcHeaders(
  protocolVersion: string,
  method: string,
  sessionId?: string
): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": protocolVersion,
    "Mcp-Method": method,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
}

async function postRpc(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  deadline: number
): Promise<HttpPayload> {
  return requestBounded(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    deadline,
    MAX_MCP_RESPONSE_BYTES
  );
}

function canFallbackToLegacy(payload: HttpPayload, rpc?: JsonRpcResponse): boolean {
  if (payload.status !== 400) return false;
  const message = `${rpc ? rpcErrorMessage(rpc) : ""} ${payload.text}`.toLowerCase();
  return /protocol|version|initialize|session|unsupported/.test(message);
}

async function listModern(
  url: string,
  deadline: number
): Promise<{ names: string[]; pages: number }> {
  const names: string[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 1; page <= MAX_MCP_TOOL_PAGES; page += 1) {
    const requestId = `uo-live-modern-${page}`;
    const payload = await postRpc(
      url,
      {
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/list",
        params: { ...(cursor ? { cursor } : {}), _meta: clientMeta() },
      },
      rpcHeaders(MODERN_PROTOCOL_VERSION, "tools/list"),
      deadline
    );
    let rpc: JsonRpcResponse | undefined;
    try {
      rpc = parseRpcResponse(payload, requestId);
    } catch (error) {
      if (page === 1 && canFallbackToLegacy(payload)) {
        throw new ModernProtocolUnsupportedError();
      }
      throw error;
    }
    if (page === 1 && canFallbackToLegacy(payload, rpc)) {
      throw new ModernProtocolUnsupportedError();
    }
    if (payload.status < 200 || payload.status >= 300) {
      throw new Error(`MCP tools/list returned HTTP ${payload.status}: ${rpcErrorMessage(rpc)}`);
    }
    const result = parseListResult(rpc);
    for (const tool of result.tools) {
      if (seenNames.has(tool.name)) {
        throw new Error(`MCP tools/list repeated tool '${tool.name}'.`);
      }
      seenNames.add(tool.name);
      names.push(tool.name);
      if (names.length > MAX_MCP_TOOLS) {
        throw new Error(`MCP tools/list exceeded ${MAX_MCP_TOOLS} tools.`);
      }
    }
    if (!result.nextCursor) return { names, pages: page };
    if (seenCursors.has(result.nextCursor)) {
      throw new Error("MCP tools/list repeated a pagination cursor.");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`MCP tools/list exceeded ${MAX_MCP_TOOL_PAGES} pages.`);
}

async function listLegacy(
  url: string,
  deadline: number
): Promise<{ names: string[]; pages: number; version: string }> {
  const initializeId = "uo-live-legacy-initialize";
  const initializePayload = await postRpc(
    url,
    {
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "uo-godot-cli", version: "0.1" },
      },
    },
    rpcHeaders(LEGACY_PROTOCOL_VERSION, "initialize"),
    deadline
  );
  if (initializePayload.status < 200 || initializePayload.status >= 300) {
    throw new Error(`MCP initialize returned HTTP ${initializePayload.status}.`);
  }
  const initializeResponse = parseRpcResponse(initializePayload, initializeId);
  if (initializeResponse.error) {
    throw new Error(`MCP initialize failed: ${rpcErrorMessage(initializeResponse)}`);
  }
  if (!isRecord(initializeResponse.result)) {
    throw new Error("MCP initialize returned a malformed result.");
  }
  const negotiated = initializeResponse.result.protocolVersion;
  if (typeof negotiated !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(negotiated)) {
    throw new Error("MCP initialize returned an invalid protocol version.");
  }
  const sessionId = initializePayload.headers.get("mcp-session-id") ?? undefined;

  const initializedPayload = await postRpc(
    url,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    rpcHeaders(negotiated, "notifications/initialized", sessionId),
    deadline
  );
  if (initializedPayload.status < 200 || initializedPayload.status >= 300) {
    throw new Error(
      `MCP notifications/initialized returned HTTP ${initializedPayload.status}.`
    );
  }

  const names: string[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 1; page <= MAX_MCP_TOOL_PAGES; page += 1) {
      const requestId = `uo-live-legacy-${page}`;
      const payload = await postRpc(
        url,
        {
          jsonrpc: "2.0",
          id: requestId,
          method: "tools/list",
          params: cursor ? { cursor } : {},
        },
        rpcHeaders(negotiated, "tools/list", sessionId),
        deadline
      );
      if (payload.status < 200 || payload.status >= 300) {
        throw new Error(`MCP tools/list returned HTTP ${payload.status}.`);
      }
      const result = parseListResult(parseRpcResponse(payload, requestId));
      for (const tool of result.tools) {
        if (seenNames.has(tool.name)) {
          throw new Error(`MCP tools/list repeated tool '${tool.name}'.`);
        }
        seenNames.add(tool.name);
        names.push(tool.name);
        if (names.length > MAX_MCP_TOOLS) {
          throw new Error(`MCP tools/list exceeded ${MAX_MCP_TOOLS} tools.`);
        }
      }
      if (!result.nextCursor) return { names, pages: page, version: negotiated };
      if (seenCursors.has(result.nextCursor)) {
        throw new Error("MCP tools/list repeated a pagination cursor.");
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error(`MCP tools/list exceeded ${MAX_MCP_TOOL_PAGES} pages.`);
  } finally {
    if (sessionId && Date.now() < deadline) {
      try {
        await requestBounded(
          url,
          {
            method: "DELETE",
            headers: {
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": negotiated,
              "Mcp-Session-Id": sessionId,
            },
          },
          deadline,
          MAX_MCP_IDENTITY_BYTES
        );
      } catch {
        // Best-effort cleanup must not hide the catalog result or its error.
      }
    }
  }
}

async function readIdentity(
  endpoint: LocalEndpoint,
  deadline: number
): Promise<GodotAiIdentity> {
  const url = `http://${endpoint.host}:${endpoint.port}${endpoint.path}`;
  const payload = await requestBounded(
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    deadline,
    MAX_MCP_IDENTITY_BYTES
  );
  if (payload.status !== 200) {
    throw new Error(`Godot AI identity endpoint returned HTTP ${payload.status}.`);
  }
  if (payload.contentType !== "application/json") {
    throw new Error("Godot AI identity endpoint did not return application/json.");
  }
  const value = parseJson(payload.text, "Godot AI identity endpoint");
  if (!isRecord(value) || value.name !== "godot-ai") {
    throw new Error("Local port does not identify a Godot AI MCP server.");
  }
  const versionCandidate = value.server_version ?? value.version;
  if (versionCandidate !== undefined && typeof versionCandidate !== "string") {
    throw new Error("Godot AI identity endpoint returned an invalid version.");
  }
  const wsPortCandidate = value.ws_port;
  if (
    wsPortCandidate !== undefined &&
    (!Number.isInteger(wsPortCandidate) ||
      (wsPortCandidate as number) < 1 ||
      (wsPortCandidate as number) > 65535)
  ) {
    throw new Error("Godot AI identity endpoint returned an invalid WebSocket port.");
  }
  return {
    name: "godot-ai",
    ...(versionCandidate ? { version: versionCandidate } : {}),
    ...(typeof wsPortCandidate === "number" ? { wsPort: wsPortCandidate } : {}),
  };
}

export async function probeGodotAiMcp(
  options: GodotAiMcpProbeOptions = {}
): Promise<GodotAiMcpProbe> {
  const port = parseBoundedInteger(
    options.port,
    DEFAULT_GODOT_AI_MCP_PORT,
    "MCP port",
    1,
    65535
  );
  const timeoutMs = parseBoundedInteger(
    options.timeoutMs,
    DEFAULT_LIVE_TIMEOUT_MS,
    "Live timeout",
    MIN_LIVE_TIMEOUT_MS,
    MAX_LIVE_TIMEOUT_MS
  );
  const deadline = Date.now() + timeoutMs;
  const identityEndpoint: LocalEndpoint = {
    host: "127.0.0.1",
    port,
    path: "/godot-ai/status",
  };
  const endpoint: LocalEndpoint = {
    host: "127.0.0.1",
    port,
    path: "/mcp",
  };
  const identity = await readIdentity(identityEndpoint, deadline);
  const url = `http://${endpoint.host}:${endpoint.port}${endpoint.path}`;

  try {
    const modern = await listModern(url, deadline);
    return {
      endpoint,
      identityEndpoint,
      identity,
      protocol: { mode: "modern_stateless", version: MODERN_PROTOCOL_VERSION },
      toolNames: modern.names.sort(),
      pageCount: modern.pages,
    };
  } catch (error) {
    if (!(error instanceof ModernProtocolUnsupportedError)) throw error;
  }

  const legacy = await listLegacy(url, deadline);
  return {
    endpoint,
    identityEndpoint,
    identity,
    protocol: { mode: "legacy_session", version: legacy.version },
    toolNames: legacy.names.sort(),
    pageCount: legacy.pages,
  };
}
