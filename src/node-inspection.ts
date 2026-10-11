import type { GodotResponse } from "./client.js";

export const MAX_SELECTED_NODE_PROPERTIES = 32;
export const MAX_NODE_PROPERTY_NAME_BYTES = 128;

export function validatePropertySelection(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SELECTED_NODE_PROPERTIES
  ) {
    throw new Error(
      `--properties must select between 1 and ${MAX_SELECTED_NODE_PROPERTIES} exact property names.`
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      Buffer.byteLength(name, "utf8") > MAX_NODE_PROPERTY_NAME_BYTES
    ) {
      throw new Error(
        `Each selected property must be a non-empty name without control characters, at most ${MAX_NODE_PROPERTY_NAME_BYTES} UTF-8 bytes.`
      );
    }
    if (seen.has(name)) {
      throw new Error("--properties must not contain duplicate property names.");
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Project a bounded runtime response without returning unrelated node context. */
export function selectNodeProperties(
  response: GodotResponse,
  selection: readonly string[]
): GodotResponse {
  const names = validatePropertySelection(selection);
  if (response.status !== "ok") return response;

  const data = response.data;
  if (!isRecord(data) || !isRecord(data.properties)) {
    throw new Error("Godot returned an invalid node inspection result.");
  }
  const properties = data.properties;
  for (const field of ["name", "type", "path"]) {
    if (
      typeof data[field] !== "string" ||
      data[field].length === 0 ||
      Buffer.byteLength(data[field], "utf8") > 4096
    ) {
      throw new Error("Godot returned invalid node identity metadata.");
    }
  }
  for (const name of names) {
    if (!Object.hasOwn(properties, name)) {
      // Do not return a partial selection or dump the full node as a fallback.
      throw new Error("Godot did not return every requested property.");
    }
  }

  return {
    id: response.id,
    status: "ok",
    data: {
      name: data.name,
      type: data.type,
      path: data.path,
      properties: Object.fromEntries(names.map((name) => [name, properties[name]])),
      _cli: {
        selected_properties: names,
        available_property_count: Object.keys(properties).length,
      },
    },
  };
}
