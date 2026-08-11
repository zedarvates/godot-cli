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
    {
      name: "godot_get_logs",
      description: "Retrieve GDScript runtime logs, errors, and warnings.",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", description: "Filter by level: info, warning, error" },
          clear: { type: "boolean", description: "Clear log buffer after fetching" },
        },
      },
    },
    {
      name: "godot_list_signals",
      description: "List all signals of a node, their parameters, and connected target callables.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path (e.g. /root/Main/Player)" },
        },
        required: ["path"],
      },
    },
    {
      name: "godot_emit_signal",
      description: "Emit a GDScript signal on a node programmatically.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path" },
          signal: { type: "string", description: "Signal name" },
          args: { type: "array", description: "Arguments for the signal" },
        },
        required: ["path", "signal"],
      },
    },
    {
      name: "godot_query_ray",
      description: "Perform 3D or 2D physics raycast query in the world space state.",
      inputSchema: {
        type: "object",
        properties: {
          is_3d: { type: "boolean", description: "True for 3D physics raycast, false for 2D" },
          from: { description: "Ray start position string expression or Vector dict (e.g. Vector3(0,10,0))" },
          to: { description: "Ray end position string expression or Vector dict (e.g. Vector3(0,0,0))" },
          collision_mask: { type: "number", description: "Physics collision layer mask" },
        },
      },
    },
    {
      name: "godot_query_point",
      description: "Query physics colliders at a specific 3D or 2D point.",
      inputSchema: {
        type: "object",
        properties: {
          is_3d: { type: "boolean", description: "True for 3D point query, false for 2D" },
          point: { description: "Point position" },
        },
      },
    },
    {
      name: "godot_action_press",
      description: "Simulate pressing an InputMap action (e.g. ui_accept, move_forward).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "InputMap action name" },
          strength: { type: "number", description: "Action strength (0.0 to 1.0, default 1.0)" },
        },
        required: ["action"],
      },
    },
    {
      name: "godot_action_release",
      description: "Simulate releasing an InputMap action.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "InputMap action name" },
        },
        required: ["action"],
      },
    },
    {
      name: "godot_metrics",
      description: "Get detailed engine performance monitors (FPS, process/physics ms, draw calls, video memory, active 3D/2D objects).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_highlight_node",
      description: "Temporarily highlight a node in the viewport for visual inspection and screenshots.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path" },
          duration: { type: "number", description: "Duration in seconds (default 2.0)" },
        },
        required: ["path"],
      },
    },
    {
      name: "godot_find_nodes",
      description: "Find nodes matching wildcard pattern, class type, or node group.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Name wildcard pattern (e.g. *Player* or Enemy*)" },
          type: { type: "string", description: "Node class name (e.g. CharacterBody3D, Sprite2D)" },
          group: { type: "string", description: "Node group name" },
          root: { type: "string", description: "Root node path to start search from" },
        },
      },
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
          serverInfo: { name: "godot-cli-mcp", version: "0.3.0" },
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
          case "godot_get_logs": commandName = "get_logs"; break;
          case "godot_list_signals": commandName = "list_signals"; break;
          case "godot_emit_signal": commandName = "emit_signal"; break;
          case "godot_query_ray": commandName = "query_ray"; break;
          case "godot_query_point": commandName = "query_point"; break;
          case "godot_action_press": commandName = "action_press"; break;
          case "godot_action_release": commandName = "action_release"; break;
          case "godot_metrics": commandName = "metrics"; break;
          case "godot_highlight_node": commandName = "highlight_node"; break;
          case "godot_find_nodes": commandName = "find_nodes"; break;
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
