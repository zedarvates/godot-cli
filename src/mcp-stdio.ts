import { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";

export const MAX_MCP_INPUT_BYTES = 64 * 1024;
export const MAX_MCP_MESSAGE_BYTES = 256 * 1024;
export const MAX_MCP_PENDING_REQUESTS = 8;
export const MAX_MCP_PENDING_OUTPUT_BYTES = 512 * 1024;
export const MCP_OUTPUT_TIMEOUT_MS = 5000;

/** Bound JSON traversal before SDK dispatch or result serialization. */
export function assertMcpJsonBudget(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++visited > 16_384 || item.depth > 24) {
      throw new Error("MCP JSON exceeds the depth or value budget.");
    }
    if (typeof item.value !== "object" || item.value === null) continue;
    const values = Object.values(item.value);
    if (values.length + pending.length + visited > 16_384) {
      throw new Error("MCP JSON exceeds the value budget.");
    }
    for (const child of values) pending.push({ value: child, depth: item.depth + 1 });
  }
}

export function redactMcpText(text: string, token: string): string {
  // JSON escaping matters for tokens containing quotes, backslashes or controls.
  const escaped = JSON.stringify(token).slice(1, -1);
  return text.replaceAll(escaped, "[redacted]").replaceAll(token, "[redacted]");
}

/** Keep the SDK's stdio framing and protocol implementation; bound its use. */
export class BoundedMcpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly closed: Promise<void>;
  failure?: Error;
  private finish!: () => void;
  private stopped = false;
  private started = false;
  private pending = new Set<RequestId>();
  private pendingOutputBytes = 0;
  private writes = new Set<(error: Error) => void>();
  private inner: StdioServerTransport;

  constructor(
    private token: string,
    private input: Readable = process.stdin,
    private output: Writable = process.stdout,
  ) {
    if (token.length < 32 || Buffer.byteLength(token, "utf8") > 4096) {
      throw new Error("MCP transport requires a bounded runtime token.");
    }
    this.closed = new Promise((resolve) => { this.finish = resolve; });
    this.inner = new StdioServerTransport(input, output, {
      maxBufferSize: MAX_MCP_INPUT_BYTES,
    });
    this.inner.onmessage = (message) => this.receive(message);
    this.inner.onerror = () => this.fail("Invalid or oversized MCP input.");
    this.inner.onclose = () => { void this.close(); };
  }

  private onEnd = (): void => { void this.close(); };
  private onOutputError = (): void => this.fail("MCP output stream failed.");

  private fail(message: string): void {
    if (this.stopped) return;
    this.failure = new Error(message);
    this.onerror?.(this.failure);
    void this.close();
  }

  private receive(message: JSONRPCMessage): void {
    if (this.stopped) return;
    try {
      assertMcpJsonBudget(message);
      const encoded = JSON.stringify(message);
      if (redactMcpText(encoded, this.token) !== encoded) {
        throw new Error("Runtime token must stay outside MCP messages.");
      }
      if ("id" in message && "method" in message) {
        if (
          (typeof message.id === "string" && Buffer.byteLength(message.id, "utf8") > 128) ||
          (typeof message.id === "number" && !Number.isSafeInteger(message.id)) ||
          this.pending.has(message.id) ||
          this.pending.size >= MAX_MCP_PENDING_REQUESTS
        ) {
          throw new Error("MCP request ID or pending-request budget exceeded.");
        }
        this.pending.add(message.id);
      }
      this.onmessage?.(message);
    } catch {
      this.fail("MCP input violates the session limits.");
    }
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) throw new Error("MCP transport cannot be restarted.");
    this.started = true;
    this.input.once("end", this.onEnd);
    this.output.on("error", this.onOutputError);
    this.output.once("close", () => this.output.off("error", this.onOutputError));
    await this.inner.start();
    if (this.input.readableEnded) await this.close();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.stopped) throw new Error("MCP session is closed.");
    let encoded: string;
    try {
      assertMcpJsonBudget(message);
      encoded = redactMcpText(JSON.stringify(message), this.token);
    } catch {
      this.fail("Invalid or excessive MCP output structure.");
      throw this.failure;
    }
    const bytes = Buffer.byteLength(encoded, "utf8") + 1;
    if (
      bytes > MAX_MCP_MESSAGE_BYTES ||
      this.pendingOutputBytes + bytes > MAX_MCP_PENDING_OUTPUT_BYTES
    ) {
      this.fail("MCP output exceeds the session limits.");
      throw this.failure;
    }
    this.pendingOutputBytes += bytes;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.writes.delete(cancel);
        this.pendingOutputBytes -= bytes;
        if (error) reject(new Error("MCP output failed or the session closed."));
        else {
          if ("id" in message && message.id !== undefined && !("method" in message)) this.pending.delete(message.id);
          resolve();
        }
      };
      const cancel = (error: Error): void => finish(error);
      const timer = setTimeout(() => this.fail("MCP output timed out."), MCP_OUTPUT_TIMEOUT_MS);
      this.writes.add(cancel);
      try {
        // Wait for the write callback; do not retain one closed-Promise reaction
        // per successful request or accumulate SDK drain listeners.
        this.output.write(serializeMessage(JSON.parse(encoded) as JSONRPCMessage), finish);
      } catch {
        this.fail("MCP output stream failed.");
      }
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.input.off("end", this.onEnd);
    this.pending.clear();
    for (const cancel of this.writes) cancel(new Error("MCP session is closed."));
    this.writes.clear();
    await this.inner.close();
    this.onclose?.();
    this.finish();
  }
}
