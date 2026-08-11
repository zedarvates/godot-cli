import * as http from "node:http";
import { GodotClient } from "./client.js";

export function startSseMcpServer(options: { host?: string; port?: string | number; ssePort?: number } = {}): void {
  const client = new GodotClient(options);
  const ssePort = options.ssePort || 3001;

  let sseResponse: http.ServerResponse | null = null;

  const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseResponse = res;
      res.write("event: endpoint\ndata: /message\n\n");
      req.on("close", () => {
        sseResponse = null;
      });
      return;
    }

    if (req.method === "POST" && req.url === "/message") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const request = JSON.parse(body);
          const { id, method, params } = request;

          let responsePayload: any;

          if (method === "initialize") {
            responsePayload = {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "godot-cli-mcp-sse", version: "0.4.0" },
              },
            };
          } else if (method === "tools/call") {
            const toolName = params?.name;
            const toolArgs = params?.arguments || {};
            let cmdName = toolName.replace("godot_", "");
            try {
              const godotRes = await client.send(cmdName, toolArgs);
              responsePayload = {
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: JSON.stringify(godotRes, null, 2) }],
                },
              };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              responsePayload = {
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `Error: ${msg}` }],
                  isError: true,
                },
              };
            }
          } else {
            responsePayload = { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
          }

          if (sseResponse) {
            sseResponse.write(`event: message\ndata: ${JSON.stringify(responsePayload)}\n\n`);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted" }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  server.listen(ssePort, () => {
    process.stdout.write(`GodotCLI HTTP/SSE MCP Server listening on http://localhost:${ssePort}/sse\n`);
  });
}
