import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import * as path from "node:path";

import type { AssetClosureFile, AssetFinding } from "./asset-validation.js";

const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const REPORT_PREFIX = "UO_ASSET_IMPORT_REPORT=";
const SAFE_ENVIRONMENT_KEYS = [
  "APPDATA", "ComSpec", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT",
  "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "SystemRoot", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "WINDIR",
] as const;

const PROJECT = `config_version=5

[application]
config/name="UO Asset Import Probe"

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`;

const PROBE = `extends SceneTree

func _initialize() -> void:
    var args := OS.get_cmdline_user_args()
    if args.size() != 1:
        quit(2)
        return
    var resource := load(args[0])
    if not resource is PackedScene:
        quit(3)
        return
    var root := (resource as PackedScene).instantiate()
    var summary := {
        "rootType": root.get_class(), "nodes": 0, "meshes": 0,
        "surfaces": 0, "materials": 0, "animations": 0,
        "skeletons": 0, "bodies": 0, "collisionShapes": 0
    }
    var pending: Array[Node] = [root]
    while not pending.is_empty():
        if int(summary.nodes) >= 100000:
            root.free()
            quit(4)
            return
        var node: Node = pending.pop_back()
        summary.nodes = int(summary.nodes) + 1
        if node is MeshInstance3D:
            summary.meshes = int(summary.meshes) + 1
            var mesh := (node as MeshInstance3D).mesh
            if mesh != null:
                summary.surfaces = int(summary.surfaces) + mesh.get_surface_count()
                for surface in range(mesh.get_surface_count()):
                    if mesh.surface_get_material(surface) != null:
                        summary.materials = int(summary.materials) + 1
        if node is AnimationPlayer:
            summary.animations = int(summary.animations) + 1
        if node is Skeleton3D:
            summary.skeletons = int(summary.skeletons) + 1
        if node is PhysicsBody3D:
            summary.bodies = int(summary.bodies) + 1
        if node is CollisionShape3D:
            summary.collisionShapes = int(summary.collisionShapes) + 1
        for child in node.get_children():
            pending.push_back(child)
    print("${REPORT_PREFIX}" + JSON.stringify(summary))
    root.free()
    quit(0)
`;

export interface AssetImportSummary {
  rootType: string;
  nodes: number;
  meshes: number;
  surfaces: number;
  materials: number;
  animations: number;
  skeletons: number;
  bodies: number;
  collisionShapes: number;
}

export interface AssetImportReport {
  status: "ok" | "error";
  complete: boolean;
  summary: AssetImportSummary | null;
  exitCodes: { import: number | null; probe: number | null };
  logs: { complete: boolean; truncated: boolean; lines: string[] };
  cleanup: { complete: boolean };
  findings: AssetFinding[];
}

interface AssetImportOptions {
  projectRoot: string;
  asset: string;
  closure: AssetClosureFile[];
  godot?: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

interface ProcessResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
}

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

async function requireGodot(candidate: string | undefined): Promise<string> {
  const configured = candidate?.trim();
  if (!configured) throw new Error("Godot import requires --godot or GODOT_BIN");
  const canonical = await fs.realpath(configured);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error("Godot executable must be a regular file");
  return canonical;
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    const accept = (chunk: Buffer) => {
      const remaining = MAX_CHILD_OUTPUT_BYTES - size;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        size += kept.length;
      }
      if (chunk.length > remaining) {
        truncated = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        output: Buffer.concat(chunks).toString("utf8"),
        truncated,
        timedOut,
      });
    });
  });
}

function parseSummary(output: string): AssetImportSummary | null {
  const reports = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(REPORT_PREFIX));
  if (reports.length !== 1) return null;
  const parsed: unknown = JSON.parse(reports[0].slice(REPORT_PREFIX.length));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as AssetImportSummary;
}

export async function runIsolatedGodotImport(
  options: AssetImportOptions
): Promise<AssetImportReport> {
  const findings: AssetFinding[] = [];
  const logs: string[] = [];
  let temporaryRoot: string | null = null;
  let importExit: number | null = null;
  let probeExit: number | null = null;
  let summary: AssetImportSummary | null = null;
  let truncated = false;
  let cleanupComplete = false;
  try {
    const executable = await requireGodot(options.godot ?? options.env.GODOT_BIN);
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uo-asset-import-"));
    await fs.writeFile(path.join(temporaryRoot, "project.godot"), PROJECT, "utf8");
    await fs.writeFile(path.join(temporaryRoot, "probe.gd"), PROBE, "utf8");
    for (const file of options.closure) {
      const relative = file.resourcePath.slice("res://".length).replaceAll("/", path.sep);
      const source = path.resolve(options.projectRoot, relative);
      const target = path.resolve(temporaryRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    const env = childEnvironment(options.env);
    const imported = await runProcess(
      executable,
      ["--headless", "--xr-mode", "off", "--audio-driver", "Dummy", "--path", temporaryRoot, "--import"],
      temporaryRoot,
      env,
      options.timeoutMs
    );
    importExit = imported.exitCode;
    truncated ||= imported.truncated;
    logs.push(...imported.output.split(/\r?\n/).filter(Boolean));
    if (imported.exitCode !== 0 || imported.timedOut || imported.truncated) {
      throw new Error("Godot import process failed, timed out, or exceeded output limits");
    }
    const probed = await runProcess(
      executable,
      ["--headless", "--xr-mode", "off", "--audio-driver", "Dummy", "--path", temporaryRoot, "--script", "res://probe.gd", "--", options.asset],
      temporaryRoot,
      env,
      options.timeoutMs
    );
    probeExit = probed.exitCode;
    truncated ||= probed.truncated;
    logs.push(...probed.output.split(/\r?\n/).filter(Boolean));
    if (probed.exitCode !== 0 || probed.timedOut || probed.truncated) {
      throw new Error("Godot asset probe failed, timed out, or exceeded output limits");
    }
    summary = parseSummary(probed.output);
    if (summary === null) throw new Error("Godot asset probe returned no unique report");
  } catch (error) {
    findings.push({
      severity: "error",
      code: "ASSET_IMPORT_FAILED",
      location: options.asset,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (temporaryRoot !== null) {
      try {
        await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        cleanupComplete = true;
      } catch (error) {
        findings.push({
          severity: "error",
          code: "ASSET_IMPORT_CLEANUP_FAILED",
          location: temporaryRoot,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const complete = summary !== null && !truncated && cleanupComplete && findings.length === 0;
  return {
    status: complete ? "ok" : "error",
    complete,
    summary,
    exitCodes: { import: importExit, probe: probeExit },
    logs: { complete: !truncated, truncated, lines: logs.slice(-4096) },
    cleanup: { complete: cleanupComplete },
    findings,
  };
}
