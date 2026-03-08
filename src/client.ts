import * as net from "node:net";
import { randomUUID } from "node:crypto";

export interface GodotResponse {
  id: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
}

export class GodotClient {
  private host: string;
  private port: number;

  constructor(options: { host?: string; port?: string | number }) {
    this.host = options.host || "localhost";
    this.port =
      typeof options.port === "string"
        ? parseInt(options.port, 10)
        : options.port || 9900;
  }

  async send(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000
  ): Promise<GodotResponse> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let buffer = "";
      const id = randomUUID();

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Connection timed out"));
      }, timeoutMs);

      socket.connect(this.port, this.host, () => {
        const message = JSON.stringify({ id, command, params }) + "\n";
        socket.write(message);
      });

      socket.on("data", (data) => {
        buffer += data.toString();
        const idx = buffer.indexOf("\n");
        if (idx !== -1) {
          clearTimeout(timeout);
          const line = buffer.substring(0, idx);
          socket.destroy();
          try {
            resolve(JSON.parse(line) as GodotResponse);
          } catch {
            reject(new Error("Invalid JSON response from Godot"));
          }
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Cannot connect to Godot on ${this.host}:${this.port} - ${err.message}\n` +
              `Make sure your Godot project is running with the GodotCLI addon enabled.`
          )
        );
      });
    });
  }
}
