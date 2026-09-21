import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9900;
const DEFAULT_MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

export interface GodotResponse {
  id: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
}

export interface GodotClientOptions {
  host?: string;
  port?: string | number;
  token?: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  hostResolver?: HostResolver;
}

export interface ResolvedHost {
  address: string;
}

export type HostResolver = (host: string) => Promise<readonly ResolvedHost[]>;

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (net.isIP(normalized) === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  if (net.isIP(normalized) !== 6) return false;
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("::ffff:127.")
  );
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || isLoopbackAddress(normalized);
}

const defaultHostResolver: HostResolver = async (host) =>
  dnsLookup(host, { all: true, verbatim: true });

function parseResponse(line: string, requestId: string): GodotResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Invalid JSON response from Godot");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid response envelope from Godot");
  }

  const response = value as Record<string, unknown>;
  if (response.id !== requestId) {
    throw new Error("Godot response ID does not match the request ID");
  }
  if (response.status !== "ok" && response.status !== "error") {
    throw new Error("Invalid response status from Godot");
  }
  if (response.status === "error" && typeof response.error !== "string") {
    throw new Error("Invalid error response from Godot");
  }

  return value as GodotResponse;
}

export class GodotClient {
  private host: string;
  private port: number;
  private token: string;
  private maxRequestBytes: number;
  private maxResponseBytes: number;
  private hostResolver: HostResolver;

  constructor(options: GodotClientOptions = {}) {
    this.host = options.host?.trim() || DEFAULT_HOST;
    if (!isLoopbackHost(this.host)) {
      throw new Error(
        `Remote Godot hosts are disabled; use a loopback host instead of '${this.host}'.`
      );
    }

    const parsedPort =
      typeof options.port === "string"
        ? Number.parseInt(options.port, 10)
        : options.port ?? DEFAULT_PORT;
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`Invalid Godot server port: ${String(options.port)}`);
    }
    this.port = parsedPort;

    this.token = (options.token ?? process.env.GODOT_CLI_TOKEN ?? "").trim();
    if (this.token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `GODOT_CLI_TOKEN must contain at least ${MIN_TOKEN_LENGTH} characters.`
      );
    }

    this.maxRequestBytes =
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) {
      throw new Error("maxRequestBytes must be a positive integer.");
    }

    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (
      !Number.isInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1
    ) {
      throw new Error("maxResponseBytes must be a positive integer.");
    }

    this.hostResolver = options.hostResolver ?? defaultHostResolver;
  }

  private async resolveConnectHost(): Promise<string> {
    if (this.host.toLowerCase() !== "localhost") return this.host;

    let results: readonly ResolvedHost[];
    try {
      results = await this.hostResolver(this.host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot resolve loopback host '${this.host}': ${message}`);
    }

    if (results.length === 0 || results.some(({ address }) => !isLoopbackAddress(address))) {
      throw new Error(
        `Host '${this.host}' resolved outside the loopback interface.`
      );
    }
    const ipv4Loopback = results.find(({ address }) => net.isIP(address) === 4);
    return (ipv4Loopback ?? results[0]).address;
  }

  async send(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000
  ): Promise<GodotResponse> {
    const id = randomUUID();
    const message =
      JSON.stringify({ id, token: this.token, command, params }) + "\n";
    const requestBytes = Buffer.byteLength(message, "utf8");
    if (requestBytes > this.maxRequestBytes) {
      throw new Error(
        `Godot request exceeded ${this.maxRequestBytes} bytes.`
      );
    }

    const connectHost = await this.resolveConnectHost();

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let responseBytes = 0;
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        reject(error);
      };

      const timeout = setTimeout(() => {
        fail(new Error("Connection timed out"));
      }, timeoutMs);

      socket.connect(this.port, connectHost, () => {
        socket.setNoDelay(true);
        socket.write(message);
      });

      socket.on("data", (data) => {
        responseBytes += data.byteLength;
        if (responseBytes > this.maxResponseBytes) {
          fail(
            new Error(
              `Godot response exceeded ${this.maxResponseBytes} bytes.`
            )
          );
          return;
        }
        buffer += decoder.write(data);
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          if (settled) return;
          const line = buffer.substring(0, idx);
          try {
            const response = parseResponse(line, id);
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            resolve(response);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });

      socket.on("error", (err) => {
        fail(
          new Error(
            `Cannot connect to Godot on ${this.host}:${this.port} - ${err.message}\n` +
              `Make sure your Godot project is running with the GodotCLI addon enabled.`
          )
        );
      });

      socket.on("close", (hadError) => {
        if (!settled && !hadError) {
          fail(new Error("Connection closed before Godot returned a response."));
        }
      });
    });
  }
}
