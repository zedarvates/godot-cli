export const CLI_VERSION = "0.1.0-uo.4";
export const EXPECTED_PROTOCOL_VERSION = 1;
export const EXPECTED_GODOT_MAJOR = 4;
export const EXPECTED_GODOT_MINOR = 7;
export const MAX_SCENE_TREE_DEPTH = 64;
export const MAX_ASSERT_CHECKS = 256;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
}

export interface DoctorReport {
  status: "ok" | "error";
  compatible: boolean;
  safeMode: boolean;
  allowElevated: boolean;
  checks: DoctorCheck[];
  server: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function check(
  name: string,
  expected: unknown,
  actual: unknown,
  ok: boolean
): DoctorCheck {
  return { name, ok, expected, actual };
}

export function buildDoctorReport(
  value: unknown,
  options: { allowElevated?: boolean } = {}
): DoctorReport {
  const allowElevated = options.allowElevated === true;
  const server = asRecord(value);
  const engine = asRecord(server?.engine);
  const endpoint = asRecord(server?.endpoint);
  const gates = asRecord(server?.gates);
  const limits = asRecord(server?.limits);

  const compatibilityChecks = [
    check("server_info_envelope", "object", server === null ? typeof value : "object", server !== null),
    check(
      "protocol_version",
      EXPECTED_PROTOCOL_VERSION,
      server?.protocol_version,
      server?.protocol_version === EXPECTED_PROTOCOL_VERSION
    ),
    check(
      "addon_version",
      CLI_VERSION,
      server?.addon_version,
      server?.addon_version === CLI_VERSION
    ),
    check(
      "godot_version",
      `${EXPECTED_GODOT_MAJOR}.${EXPECTED_GODOT_MINOR}`,
      engine === null ? null : `${String(engine.major)}.${String(engine.minor)}`,
      engine?.major === EXPECTED_GODOT_MAJOR &&
        engine?.minor === EXPECTED_GODOT_MINOR
    ),
    check("debug_build", true, server?.debug_build, server?.debug_build === true),
    check(
      "loopback_bind",
      "127.0.0.1",
      endpoint?.bind_address,
      endpoint?.bind_address === "127.0.0.1"
    ),
    check(
      "bounded_scene_queries",
      {
        max_scene_tree_depth: MAX_SCENE_TREE_DEPTH,
        max_assert_checks: MAX_ASSERT_CHECKS,
      },
      limits,
      limits?.max_scene_tree_depth === MAX_SCENE_TREE_DEPTH &&
        limits?.max_assert_checks === MAX_ASSERT_CHECKS &&
        typeof limits?.max_scene_nodes === "number" &&
        typeof limits?.max_visible_nodes === "number"
    ),
  ];

  const mutationsEnabled = gates?.mutations_enabled === true;
  const unsafeEnabled = gates?.unsafe_enabled === true;
  const safetyChecks = [
    check(
      "mutations_disabled",
      allowElevated ? "allowed" : false,
      mutationsEnabled,
      allowElevated || !mutationsEnabled
    ),
    check(
      "unsafe_disabled",
      allowElevated ? "allowed" : false,
      unsafeEnabled,
      allowElevated || !unsafeEnabled
    ),
  ];
  const compatible = compatibilityChecks.every((entry) => entry.ok);
  const safeMode = !mutationsEnabled && !unsafeEnabled;
  const checks = [...compatibilityChecks, ...safetyChecks];

  return {
    status: compatible && safetyChecks.every((entry) => entry.ok) ? "ok" : "error",
    compatible,
    safeMode,
    allowElevated,
    checks,
    server,
  };
}
