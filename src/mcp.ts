import { GodotClient } from "./client.js";
import * as readline from "node:readline";

export async function runMcpServer(options: { host?: string; port?: string | number } = {}): Promise<void> {
  const client = new GodotClient(options);

  const tools = [
    {
      name: "godot_ping",
      description: "Ping the running Godot game engine to check connection readiness.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_scene_tree",
      description: "Get the running Godot scene tree hierarchy.",
      inputSchema: {
        type: "object",
        properties: {
          depth: { type: "number", description: "Maximum depth to traverse (default: 10)" },
          root: { type: "string", description: "Root node path (default: scene root)" },
        },
      },
    },
    {
      name: "godot_get_node",
      description: "Get all properties of a node in the scene tree.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path (e.g. /root/Main/Player)" },
        },
        required: ["path"],
      },
    },
    {
      name: "godot_set_property",
      description: "Set a property on a node.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path" },
          property: { type: "string", description: "Property name" },
          value: { description: "Value (primitive, GDScript expression string like Vector2(1,2), or JSON object)" },
        },
        required: ["path", "property", "value"],
      },
    },
    {
      name: "godot_eval",
      description: "Evaluate GDScript code in the live game context.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "GDScript code or single expression" },
        },
        required: ["code"],
      },
    },
    {
      name: "godot_call_method",
      description: "Call a method on a node in the scene tree.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path" },
          method: { type: "string", description: "Method name" },
          args: { type: "array", description: "Arguments for the method call" },
        },
        required: ["path", "method"],
      },
    },
    {
      name: "godot_screenshot",
      description: "Capture game viewport screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          output: { type: "string", description: "Output PNG file path" },
        },
      },
    },
    {
      name: "godot_batch_execute",
      description: "Execute multiple godot-cli commands atomically in a single request.",
      inputSchema: {
        type: "object",
        properties: {
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                command: { type: "string" },
                params: { type: "object" },
              },
              required: ["command"],
            },
          },
        },
        required: ["commands"],
      },
    },
    {
      name: "godot_viewport_info",
      description: "Get engine viewport performance info (FPS, draw calls, memory, node count).",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line: string) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      const { id, method, params } = request;

      if (method === "initialize") {
        sendResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "godot-cli-mcp", version: "0.2.0" },
        });
      } else if (method === "tools/list") {
        sendResponse(id, { tools });
      } else if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};

        let commandName = "";
        let commandParams: Record<string, unknown> = { ...toolArgs };

        switch (toolName) {
          case "godot_ping": commandName = "ping"; break;
          case "godot_scene_tree": commandName = "scene_tree"; break;
          case "godot_get_node": commandName = "get_node"; break;
          case "godot_set_property": commandName = "set_property"; break;
          case "godot_eval": commandName = "eval"; break;
          case "godot_call_method": commandName = "call_method"; break;
          case "godot_screenshot": commandName = "screenshot"; break;
          case "godot_batch_execute": commandName = "batch_execute"; break;
          case "godot_viewport_info": commandName = "viewport_info"; break;
          default:
            sendError(id, -32601, `Unknown tool: ${toolName}`);
            return;
        }

        try {
          const res = await client.send(commandName, commandParams);
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(res, null, 2),
              },
            ],
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `Error: ${msg}`,
              },
            ],
            isError: true,
          });
        }
      } else {
        if (id !== undefined) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
      }
    } catch {
      // JSON parse error
    }
  });
}

function sendResponse(id: unknown, result: unknown): void {
  const message = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendError(id: unknown, code: number, message: string): void {
  const errorObj = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(errorObj) + "\n");
}
