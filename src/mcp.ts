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
    {
      name: "godot_spawn_3d_object",
      description: "Spawn a 3D object in the scene (MeshInstance3D, Light3D, Camera3D, GReFormerNode3D, etc.).",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Node type (default: MeshInstance3D or GReFormerNode3D)" },
          name: { type: "string", description: "Node name" },
          parent_path: { type: "string", description: "Parent node path (default: scene root)" },
          position: { description: "Vector3 dict, array [x,y,z], or 'x,y,z' string" },
          rotation: { description: "Vector3 dict, array [x,y,z], or 'x,y,z' string" },
          scale: { description: "Vector3 dict, array [x,y,z], or 'x,y,z' string" },
        },
      },
    },
    {
      name: "godot_transform_3d_node",
      description: "Translate, rotate, or scale any 3D node in the scene.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "Target node path" },
          position: { description: "New position" },
          rotation: { description: "New rotation in radians" },
          scale: { description: "New scale" },
          relative: { type: "boolean", description: "If true, add relative delta instead of absolute position" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_inspect_level_layout",
      description: "Query surrounding 3D level layout, objects, and distances near a center point.",
      inputSchema: {
        type: "object",
        properties: {
          center_position: { description: "Center position [x,y,z]" },
          radius: { type: "number", description: "Search radius (default 20.0)" },
          node_path: { type: "string", description: "Root node to inspect from" },
        },
      },
    },
    {
      name: "godot_duplicate_3d_node",
      description: "Clone a 3D level object or block with transform offset.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "Source node path" },
          new_name: { type: "string", description: "Optional name for clone" },
          offset_position: { description: "Position offset for clone" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_create",
      description: "Spawn a GReFormer 3D editable primitive (Box, Stairs, Cylinder) in the editor scene.",
      inputSchema: {
        type: "object",
        properties: {
          primitive_type: { type: "string", description: "Primitive type: Box, Stairs, Cylinder (default Box)" },
          name: { type: "string", description: "Object name" },
          position: { description: "Spawn position [x,y,z]" },
        },
      },
    },
    {
      name: "godot_greformer_push_pull",
      description: "Extrude a GReFormer mesh face along its normal (SketchUp push/pull).",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path" },
          face_index: { type: "number", description: "Index of face to extrude (default 0)" },
          distance: { type: "number", description: "Extrusion distance along normal" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_apply_hotspot",
      description: "Apply a hotspot UV texture region (Wood_Plank, Metal_Trim, Stone_Wall, Bricks) to a face.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path" },
          face_index: { type: "number", description: "Face index" },
          region_name: { type: "string", description: "Hotspot region: Wood_Plank, Metal_Trim, Stone_Wall, Bricks" },
        },
        required: ["node_path", "region_name"],
      },
    },
    {
      name: "godot_greformer_bake",
      description: "Bake a GReFormer editable node into a standard static MeshInstance3D with collision.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path to bake" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_set_shading",
      description: "Recalculate flat vs smooth normals for a GReFormer node.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path" },
          mode: { type: "string", description: "Shading mode ('flat' or 'smooth')" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_paint_color",
      description: "Paint vertex color on face or entire GReFormer mesh.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path" },
          color: { type: "array", description: "RGB color tuple [r, g, b]" },
          face_index: { type: "number", description: "Face index (-1 for entire mesh)" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_export_gltf",
      description: "Export GReFormer node directly to GLTF/GLB binary file.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path" },
          output_path: { type: "string", description: "Target file path (res://model.glb)" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_bevel_edges",
      description: "Bevel / chamfer hard edges of a GReFormer node.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "GReFormer node path" },
          offset: { type: "number", description: "Bevel offset distance (default 0.1)" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_generate_stairs",
      description: "Generate parametric staircase with custom step count and side railings.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Parent node path (default /root)" },
          step_count: { type: "number", description: "Number of steps (default 8)" },
          step_width: { type: "number", description: "Step width (default 2.0)" },
          step_height: { type: "number", description: "Step height (default 0.25)" },
          step_depth: { type: "number", description: "Step depth (default 0.4)" },
          has_railings: { type: "boolean", description: "Add side railings (default true)" },
        },
      },
    },
    {
      name: "godot_greformer_generate_archway",
      description: "Generate parametric archway portal or curved tunnel entrance.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Parent node path (default /root)" },
          width: { type: "number", description: "Archway width (default 3.0)" },
          height: { type: "number", description: "Archway height (default 4.0)" },
          depth: { type: "number", description: "Archway depth (default 1.0)" },
        },
      },
    },
    {
      name: "godot_greformer_array_duplicate",
      description: "Duplicate GReFormer node in linear or radial array.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "Path to GReFormer node" },
          mode: { type: "string", description: "Array mode ('linear' or 'radial')" },
          count: { type: "number", description: "Number of copies (default 5)" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_generate_collision",
      description: "Generate convex or trimesh collision shape for GReFormer node.",
      inputSchema: {
        type: "object",
        properties: {
          node_path: { type: "string", description: "Path to GReFormer node" },
          mode: { type: "string", description: "Collision mode ('convex' or 'trimesh')" },
        },
        required: ["node_path"],
      },
    },
    {
      name: "godot_greformer_generate_terrain",
      description: "Generate low-poly heightmap terrain grid mesh.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Parent node path (default /root)" },
          grid_width: { type: "number", description: "Grid width (default 16)" },
          grid_depth: { type: "number", description: "Grid depth (default 16)" },
          max_height: { type: "number", description: "Maximum height elevation (default 3.0)" },
        },
      },
    },
    {
      name: "godot_greformer_generate_tunnel",
      description: "Generate modular dungeon tunnel or catacomb corridor section.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Parent node path (default /root)" },
          length: { type: "number", description: "Tunnel length (default 6.0)" },
          width: { type: "number", description: "Tunnel width (default 3.0)" },
          height: { type: "number", description: "Tunnel height (default 3.0)" },
        },
      },
    },
    {
      name: "godot_capture_sequence",
      description: "Capture a multi-frame sequence of viewport screenshots as base64 images.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of frames to capture (default 5, max 30)" },
        },
      },
    },
    {
      name: "godot_export_project_api",
      description: "Scan loaded project GDScript scripts and export custom classes, properties, methods, and signals.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_undo",
      description: "Undo last editor / scene modification.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_redo",
      description: "Redo previously undone editor / scene modification.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_fuzzy_find_node",
      description: "Fuzzy search scene tree nodes matching partial query string.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Partial node name query string" },
        },
        required: ["query"],
      },
    },
    {
      name: "godot_profile_performance",
      description: "Deep performance profiler: FPS, frametime, draw calls, VRAM, and orphan node memory leaks.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_inspect_node_resources",
      description: "Inspect all attached resources (textures, shaders, audio, collision shapes) on a node.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Node path to inspect" },
        },
        required: ["path"],
      },
    },
    {
      name: "godot_record_metrics",
      description: "Record time-series performance metrics (FPS, process/physics time, VRAM, draw calls).",
      inputSchema: {
        type: "object",
        properties: {
          duration: { type: "number", description: "Sample duration in seconds (default 1.0)" },
        },
      },
    },
    {
      name: "godot_version",
      description: "Get detailed engine version, build details, OS, and locale information.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_clear_logs",
      description: "Clear runtime print/warning/error log buffer.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "godot_inspect_node_children",
      description: "Inspect direct or nested child nodes under a target path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target node path" },
          depth: { type: "number", description: "Inspection depth (default 1)" },
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
          case "godot_spawn_3d_object": commandName = "spawn_3d_object"; break;
          case "godot_transform_3d_node": commandName = "transform_3d_node"; break;
          case "godot_inspect_level_layout": commandName = "inspect_level_layout"; break;
          case "godot_duplicate_3d_node": commandName = "duplicate_3d_node"; break;
          case "godot_greformer_create": commandName = "greformer_create"; break;
          case "godot_greformer_push_pull": commandName = "greformer_push_pull"; break;
          case "godot_greformer_apply_hotspot": commandName = "greformer_apply_hotspot"; break;
          case "godot_greformer_bake": commandName = "greformer_bake"; break;
          case "godot_greformer_export_obj": commandName = "greformer_export_obj"; break;
          case "godot_greformer_create_preset": commandName = "greformer_create_preset"; break;
          case "godot_greformer_snap_grid": commandName = "greformer_snap_grid"; break;
          case "godot_greformer_carve_hole": commandName = "greformer_carve_hole"; break;
          case "godot_greformer_set_shading": commandName = "greformer_set_shading"; break;
          case "godot_greformer_paint_color": commandName = "greformer_paint_color"; break;
          case "godot_greformer_export_gltf": commandName = "greformer_export_gltf"; break;
          case "godot_greformer_bevel_edges": commandName = "greformer_bevel_edges"; break;
          case "godot_greformer_generate_stairs": commandName = "greformer_generate_stairs"; break;
          case "godot_greformer_generate_archway": commandName = "greformer_generate_archway"; break;
          case "godot_greformer_array_duplicate": commandName = "greformer_array_duplicate"; break;
          case "godot_greformer_generate_collision": commandName = "greformer_generate_collision"; break;
          case "godot_greformer_generate_terrain": commandName = "greformer_generate_terrain"; break;
          case "godot_greformer_generate_tunnel": commandName = "greformer_generate_tunnel"; break;
          case "godot_capture_sequence": commandName = "capture_sequence"; break;
          case "godot_export_project_api": commandName = "export_project_api"; break;
          case "godot_undo": commandName = "undo"; break;
          case "godot_redo": commandName = "redo"; break;
          case "godot_fuzzy_find_node": commandName = "fuzzy_find_node"; break;
          case "godot_profile_performance": commandName = "profile_performance"; break;
          case "godot_inspect_node_resources": commandName = "inspect_resources"; break;
          case "godot_record_metrics": commandName = "record_metrics"; break;
          case "godot_version": commandName = "version"; break;
          case "godot_clear_logs": commandName = "clear_logs"; break;
          case "godot_inspect_node_children": commandName = "inspect_children"; break;
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
