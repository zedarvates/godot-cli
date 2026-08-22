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
  private token: string;

  constructor(options: {
    host?: string;
    port?: string | number;
    /** Overrides GODOT_CLI_TOKEN. Lets a caller drive more than one engine. */
    token?: string;
  }) {
    this.host = options.host || "localhost";
    this.port =
      typeof options.port === "string"
        ? parseInt(options.port, 10)
        : options.port || 9900;
    this.token = (options.token ?? process.env.GODOT_CLI_TOKEN ?? "").trim();
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
        // The hardened addon (cli_server.gd:_handle_message) rejects any request
        // without a matching `token`, and disconnects. The uo7 client already does
        // this; this branch shipped the hardened server with the older client.
        const message =
          JSON.stringify({ id, token: this.token, command, params }) + "\n";
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
