import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";

import { GodotClient, type GodotResponse } from "./client.js";
import { buildDoctorReport, type DoctorReport } from "./doctor.js";
import { discoverProject } from "./project.js";
import {
  MAX_RUNTIME_LOG_BYTES,
  MAX_RUNTIME_LOG_LINES,
  RUNTIME_STATE_DIRECTORY_VARIABLE,
  readRuntimeLogs,
  startGodotRuntime,
  stopManagedRuntime,
  type RuntimeLogsReport,
  type RuntimeStartReport,
  type RuntimeStopReport,
} from "./runtime.js";

export const MAX_SCENE_VALIDATION_BYTES = 64 * 1024 * 1024;
export const MAX_SCENE_LOG_DIAGNOSTICS = 256;
export const MAX_SCENE_WARNING_SAMPLES = 64;

export interface SceneValidationOptions {
  scene: string;
  project?: string;
  godot?: string;
  host?: string;
  port?: string | number;
  timeoutMs?: number;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stateRoot?: string;
}

export interface SceneFileFingerprint {
  path: string;
  bytes: number | null;
  beforeSha256: string;
  afterSha256: string | null;
  unchanged: boolean;
}

export interface SceneLogDiagnostic {
  category:
    | "script_error"
    | "parse_error"
    | "resource_error"
    | "shader_error"
    | "engine_error";
  line: number;
  message: string;
}

export interface SceneLogAnalysis {
  available: boolean;
  complete: boolean;
  logPath: string | null;
  totalBytes: number;
  bytesRead: number;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
  errorCount: number;
  diagnosticsTruncated: boolean;
  diagnostics: SceneLogDiagnostic[];
  warningCount: number;
  warningSamples: string[];
}

export interface SceneStructuralReport {
  response: GodotResponse | null;
  valid: boolean;
  complete: boolean;
  visitedNodes: number | null;
  errorCount: number | null;
  warningCount: number | null;
}

export interface SceneValidationReport {
  status: "ok" | "error";
  valid: boolean;
  complete: boolean;
  scene: string;
  projectRoot: string;
  generatedCacheBoundary: string;
  runtime: {
    start: RuntimeStartReport;
    stop: RuntimeStopReport | null;
  };
  doctor: DoctorReport | null;
  structural: SceneStructuralReport;
  logs: SceneLogAnalysis;
  integrity: {
    scene: SceneFileFingerprint;
    project: SceneFileFingerprint;
  };
  orchestrationErrors: string[];
}

interface ResolvedScene {
  resourcePath: string;
  absolutePath: string;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function analyzeGodotLog(
  lines: string[],
  options: {
    available?: boolean;
    logPath?: string | null;
    totalBytes?: number;
    bytesRead?: number;
    truncatedByBytes?: boolean;
    truncatedByLines?: boolean;
  } = {}
): SceneLogAnalysis {
  const diagnostics: SceneLogDiagnostic[] = [];
  const warningSamples: string[] = [];
  let errorCount = 0;
  let warningCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const message = stripAnsi(lines[index]).trim();
    if (!message) continue;
    let category: SceneLogDiagnostic["category"] | null = null;
    if (/\bSCRIPT ERROR\b/i.test(message)) category = "script_error";
    else if (/\bParse Error\b/i.test(message)) category = "parse_error";
    else if (
      /\b(?:Failed to load|Failed loading resource|Resource file not found|Cannot open file)\b/i.test(
        message
      )
    ) {
      category = "resource_error";
    } else if (/\bshader\b.*\b(?:error|failed|failure)\b/i.test(message)) {
      category = "shader_error";
    } else if (/(?:^|\s)ERROR:\s/i.test(message)) {
      category = "engine_error";
    }

    if (category !== null) {
      errorCount += 1;
      if (diagnostics.length < MAX_SCENE_LOG_DIAGNOSTICS) {
        diagnostics.push({ category, line: index + 1, message });
      }
    }
    if (/(?:^|\s)WARNING:\s/i.test(message)) {
      warningCount += 1;
      if (warningSamples.length < MAX_SCENE_WARNING_SAMPLES) {
        warningSamples.push(message);
      }
    }
  }

  const available = options.available !== false;
  const truncatedByBytes = options.truncatedByBytes === true;
  const truncatedByLines = options.truncatedByLines === true;
  return {
    available,
    complete: available && !truncatedByBytes && !truncatedByLines,
    logPath: options.logPath ?? null,
    totalBytes: options.totalBytes ?? 0,
    bytesRead: options.bytesRead ?? 0,
    truncatedByBytes,
    truncatedByLines,
    errorCount,
    diagnosticsTruncated: errorCount > diagnostics.length,
    diagnostics,
    warningCount,
    warningSamples,
  };
}

async function resolveScene(
  projectRoot: string,
  scene: string
): Promise<ResolvedScene> {
  if (!scene.startsWith("res://")) {
    throw new Error("Scene validation requires a res:// path");
  }
  const extension = path.posix.extname(scene).toLowerCase();
  if (extension !== ".tscn" && extension !== ".scn") {
    throw new Error("Scene validation accepts only .tscn or .scn files");
  }
  const relative = scene.slice("res://".length).replaceAll("/", path.sep);
  const absolutePath = path.resolve(projectRoot, relative);
  const within = path.relative(projectRoot, absolutePath);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  ) {
    throw new Error("Scene validation path must stay inside the Godot project");
  }
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if (isNotFound(error)) throw new Error(`Scene not found: ${scene}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Scene must be a regular project file: ${scene}`);
  }
  if (stat.size > MAX_SCENE_VALIDATION_BYTES) {
    throw new Error(
      `Scene exceeds the ${MAX_SCENE_VALIDATION_BYTES}-byte validation limit: ${scene}`
    );
  }
  return { resourcePath: scene, absolutePath };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

async function fingerprintBefore(
  file: string,
  displayPath: string
): Promise<SceneFileFingerprint> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Integrity target must be a regular file: ${displayPath}`);
  }
  return {
    path: displayPath,
    bytes: stat.size,
    beforeSha256: await sha256File(file),
    afterSha256: null,
    unchanged: false,
  };
}

async function fingerprintAfter(
  before: SceneFileFingerprint,
  file: string
): Promise<SceneFileFingerprint> {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return before;
    const afterSha256 = await sha256File(file);
    return {
      ...before,
      bytes: stat.size,
      afterSha256,
      unchanged:
        afterSha256 === before.beforeSha256 && stat.size === before.bytes,
    };
  } catch {
    return before;
  }
}

function structuralReport(response: GodotResponse | null): SceneStructuralReport {
  const data = asRecord(response?.data);
  return {
    response,
    valid: response?.status === "ok" && data?.valid === true,
    complete: response?.status === "ok" && data?.complete === true,
    visitedNodes: typeof data?.visited_nodes === "number" ? data.visited_nodes : null,
    errorCount: typeof data?.error_count === "number" ? data.error_count : null,
    warningCount: typeof data?.warning_count === "number" ? data.warning_count : null,
  };
}

function unavailableLogAnalysis(): SceneLogAnalysis {
  return analyzeGodotLog([], { available: false });
}

export async function validateSceneFile(
  options: SceneValidationOptions
): Promise<SceneValidationReport> {
  const env = options.env ?? process.env;
  const token = (env.GODOT_CLI_TOKEN ?? "").trim();
  const configuredStateRoot = env[RUNTIME_STATE_DIRECTORY_VARIABLE]?.trim();
  const stateRoot = options.stateRoot ?? (configuredStateRoot || undefined);
  const discovery = await discoverProject(options.project, {
    cwd: options.cwd,
    env,
  });
  const resolvedScene = await resolveScene(discovery.projectRoot, options.scene);
  const sceneBefore = await fingerprintBefore(
    resolvedScene.absolutePath,
    resolvedScene.resourcePath
  );
  const projectBefore = await fingerprintBefore(
    discovery.projectFile,
    "project.godot"
  );

  const start = await startGodotRuntime({
    project: discovery.projectRoot,
    godot: options.godot,
    host: options.host,
    port: options.port,
    mode: "headless",
    scene: resolvedScene.resourcePath,
    wait: true,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
    allowMutations: false,
    allowUnsafe: false,
    env,
    cwd: options.cwd,
    stateRoot,
  });

  const orchestrationErrors: string[] = [];
  let doctor: DoctorReport | null = null;
  let structuralResponse: GodotResponse | null = null;
  let stop: RuntimeStopReport | null = start.cleanup ?? null;
  if (start.status !== "ok") {
    orchestrationErrors.push(
      start.readiness?.error ?? "Managed Godot runtime did not become ready"
    );
  } else {
    try {
      const client = new GodotClient({
        host: options.host,
        port: start.runtime.port,
        token,
      });
      const serverInfo = await client.send("server_info", {}, 10_000);
      if (serverInfo.status === "ok") {
        doctor = buildDoctorReport(serverInfo.data);
      } else {
        orchestrationErrors.push(serverInfo.error ?? "server_info failed");
      }
      structuralResponse = await client.send("validate_scene", {}, 30_000);
      if (structuralResponse.status === "error") {
        orchestrationErrors.push(
          structuralResponse.error ?? "validate_scene failed"
        );
      }
    } catch (error) {
      orchestrationErrors.push(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (stop === null) {
        try {
          stop = await stopManagedRuntime(discovery.projectRoot, {
            token,
            stateRoot,
            timeoutMs: 10_000,
          });
        } catch (error) {
          orchestrationErrors.push(
            `Runtime stop failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  let logReport: RuntimeLogsReport | null = null;
  let logs = unavailableLogAnalysis();
  try {
    logReport = await readRuntimeLogs(discovery.projectRoot, {
      token,
      stateRoot,
      maxBytes: MAX_RUNTIME_LOG_BYTES,
      maxLines: MAX_RUNTIME_LOG_LINES,
    });
    logs = analyzeGodotLog(logReport.lines, {
      logPath: logReport.logPath,
      totalBytes: logReport.totalBytes,
      bytesRead: logReport.bytesRead,
      truncatedByBytes: logReport.truncatedByBytes,
      truncatedByLines: logReport.truncatedByLines,
    });
  } catch (error) {
    orchestrationErrors.push(
      `Runtime log unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const [sceneAfter, projectAfter] = await Promise.all([
    fingerprintAfter(sceneBefore, resolvedScene.absolutePath),
    fingerprintAfter(projectBefore, discovery.projectFile),
  ]);
  const structural = structuralReport(structuralResponse);
  const runtimeStopped =
    stop !== null && stop.status === "ok" && stop.runtime?.phase === "stopped";
  const complete =
    start.status === "ok" &&
    start.ready === true &&
    doctor?.status === "ok" &&
    structural.complete &&
    logs.complete &&
    runtimeStopped &&
    sceneAfter.unchanged &&
    projectAfter.unchanged &&
    orchestrationErrors.length === 0;
  const valid = complete && structural.valid && logs.errorCount === 0;

  return {
    status: valid ? "ok" : "error",
    valid,
    complete,
    scene: resolvedScene.resourcePath,
    projectRoot: discovery.projectRoot,
    generatedCacheBoundary:
      "Source scene and project.godot are fingerprinted; Godot may update generated .godot import/cache data.",
    runtime: { start, stop },
    doctor,
    structural,
    logs,
    integrity: { scene: sceneAfter, project: projectAfter },
    orchestrationErrors,
  };
}
