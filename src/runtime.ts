import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { inspectAddon } from "./addon.js";
import { GodotClient } from "./client.js";
import { discoverProject } from "./project.js";
import {
  MAX_READY_TIMEOUT_MS,
  MIN_READY_INTERVAL_MS,
  waitForReady,
  type ReadinessReport,
} from "./readiness.js";

export const RUNTIME_STATE_SCHEMA_VERSION = 1;
export const MIN_RUNTIME_TOKEN_LENGTH = 32;
export const MAX_RUNTIME_STATE_BYTES = 64 * 1024;
export const MAX_RUNTIME_ARGUMENTS = 128;
export const MAX_RUNTIME_ARGUMENT_BYTES = 4096;
export const MAX_RUNTIME_LOG_BYTES = 1024 * 1024;
export const MAX_RUNTIME_LOG_LINES = 2000;
export const MAX_RUNTIME_STOP_TIMEOUT_MS = 30_000;
export const MAX_RUNTIME_LOG_FILES = 5;
export const STARTING_STATE_MAX_AGE_MS = 5 * 60_000;
export const RUNTIME_STATE_DIRECTORY_VARIABLE = "UO_GODOT_CLI_STATE_DIR";

const DEFAULT_LOG_BYTES = 64 * 1024;
const DEFAULT_LOG_LINES = 200;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const PROCESS_START_TIMEOUT_MS = 5_000;
const INSTANCE_ARGUMENT_PREFIX = "--uo-godot-cli-instance=";
const STATE_FILE_PREFIX = "runtime-";

export type RuntimeMode = "headless" | "editor" | "game";
export type RuntimePhase = "starting" | "running" | "stopped";

interface RuntimeState {
  schemaVersion: 1;
  phase: RuntimePhase;
  instanceId: string;
  tokenHash: string;
  pid: number;
  projectRoot: string;
  executable: string;
  arguments: string[];
  port: number;
  mode: RuntimeMode;
  logFile: string;
  startedAt: string;
  mutationsEnabled: boolean;
  unsafeEnabled: boolean;
  stoppedAt?: string;
  stopReason?: string;
}

export interface RuntimePublicState {
  schemaVersion: 1;
  phase: RuntimePhase;
  instanceId: string;
  pid: number;
  projectRoot: string;
  executable: string;
  arguments: string[];
  port: number;
  mode: RuntimeMode;
  logFile: string;
  startedAt: string;
  mutationsEnabled: boolean;
  unsafeEnabled: boolean;
  stoppedAt?: string;
  stopReason?: string;
}

export interface RuntimeStatusReport {
  status: "ok" | "error";
  running: boolean;
  owned: boolean;
  stale: boolean;
  reason: string;
  runtime: RuntimePublicState | null;
}

export interface RuntimeStartReport {
  status: "ok" | "error";
  started: boolean;
  ready: boolean | "not_checked";
  runtime: RuntimePublicState;
  readiness?: ReadinessReport;
  cleanup?: RuntimeStopReport;
}

export interface RuntimeStopReport {
  status: "ok" | "error";
  stopped: boolean;
  reason: string;
  runtime: RuntimePublicState | null;
}

export interface RuntimeLogsReport {
  status: "ok";
  running: boolean;
  owned: boolean;
  runtime: RuntimePublicState;
  logPath: string;
  bytesRead: number;
  totalBytes: number;
  truncatedByBytes: boolean;
  truncatedByLines: boolean;
  lines: string[];
}

export interface ManagedRuntimeStartOptions {
  projectRoot: string;
  executable: string;
  arguments: string[];
  port: number;
  mode: RuntimeMode;
  token: string;
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
  allowMutations?: boolean;
  allowUnsafe?: boolean;
}

export interface RuntimeAccessOptions {
  token?: string;
  stateRoot?: string;
}

export interface RuntimeStopOptions extends RuntimeAccessOptions {
  timeoutMs?: number;
}

export interface RuntimeLogsOptions extends RuntimeAccessOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface GodotRuntimeStartOptions {
  project?: string;
  godot?: string;
  host?: string;
  port?: string | number;
  mode?: RuntimeMode;
  scene?: string;
  wait?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
  allowMutations?: boolean;
  allowUnsafe?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stateRoot?: string;
}

interface RuntimePaths {
  stateRoot: string;
  stateFile: string;
  logsDirectory: string;
  projectKey: string;
}

interface ProcessDetails {
  alive: boolean;
  commandLine: string | null;
  executablePath: string | null;
  queryError?: string;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseBoundedInteger(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function requireRuntimeToken(token?: string): string {
  const resolved = (token ?? process.env.GODOT_CLI_TOKEN ?? "").trim();
  if (resolved.length < MIN_RUNTIME_TOKEN_LENGTH) {
    throw new Error(
      `GODOT_CLI_TOKEN must contain at least ${MIN_RUNTIME_TOKEN_LENGTH} characters.`
    );
  }
  return resolved;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(state: RuntimeState, token: string): boolean {
  const expected = Buffer.from(state.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicState(state: RuntimeState): RuntimePublicState {
  const {
    tokenHash: _tokenHash,
    ...visible
  } = state;
  return visible;
}

async function requireRegularProjectRoot(projectRoot: string): Promise<string> {
  const discovery = await discoverProject(projectRoot, { env: {} });
  if (
    normalizePathForComparison(discovery.projectRoot) !==
    normalizePathForComparison(path.resolve(projectRoot))
  ) {
    throw new Error(
      `Runtime project must be the discovered project root: ${discovery.projectRoot}`
    );
  }
  return discovery.projectRoot;
}

function defaultStateRoot(): string {
  const configured = process.env[RUNTIME_STATE_DIRECTORY_VARIABLE]?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.tmpdir(), "uo-godot-cli", "runtime");
}

async function requireRuntimeDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Runtime state path must be a regular directory: ${resolved}`);
  }
  return resolved;
}

async function runtimePaths(
  projectRoot: string,
  requestedStateRoot?: string
): Promise<RuntimePaths> {
  const canonicalProject = await requireRegularProjectRoot(projectRoot);
  const stateRoot = await requireRuntimeDirectory(
    requestedStateRoot ?? defaultStateRoot()
  );
  const logsDirectory = await requireRuntimeDirectory(path.join(stateRoot, "logs"));
  const keySource =
    process.platform === "win32"
      ? canonicalProject.toLowerCase()
      : canonicalProject;
  const projectKey = createHash("sha256")
    .update(keySource, "utf8")
    .digest("hex")
    .slice(0, 32);
  return {
    stateRoot,
    logsDirectory,
    projectKey,
    stateFile: path.join(stateRoot, `${STATE_FILE_PREFIX}${projectKey}.json`),
  };
}

function validateState(value: unknown, projectRoot: string): RuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Runtime state must be a JSON object");
  }
  const state = value as Record<string, unknown>;
  const phase = state.phase;
  if (
    state.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION ||
    (phase !== "starting" && phase !== "running" && phase !== "stopped") ||
    typeof state.instanceId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(state.instanceId) ||
    typeof state.tokenHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(state.tokenHash) ||
    !Number.isSafeInteger(state.pid) ||
    Number(state.pid) < 0 ||
    typeof state.projectRoot !== "string" ||
    typeof state.executable !== "string" ||
    !Array.isArray(state.arguments) ||
    state.arguments.some((entry) => typeof entry !== "string") ||
    !Number.isInteger(state.port) ||
    Number(state.port) < 1 ||
    Number(state.port) > 65535 ||
    (state.mode !== "headless" && state.mode !== "editor" && state.mode !== "game") ||
    typeof state.logFile !== "string" ||
    path.basename(state.logFile) !== state.logFile ||
    typeof state.startedAt !== "string" ||
    Number.isNaN(Date.parse(state.startedAt)) ||
    typeof state.mutationsEnabled !== "boolean" ||
    typeof state.unsafeEnabled !== "boolean"
  ) {
    throw new Error("Runtime state contains invalid or unsupported fields");
  }
  if (
    normalizePathForComparison(state.projectRoot) !==
    normalizePathForComparison(projectRoot)
  ) {
    throw new Error("Runtime state belongs to a different project root");
  }
  if (state.arguments.length > MAX_RUNTIME_ARGUMENTS) {
    throw new Error("Runtime state contains too many process arguments");
  }
  if (
    state.arguments.some(
      (entry) => Buffer.byteLength(entry, "utf8") > MAX_RUNTIME_ARGUMENT_BYTES
    )
  ) {
    throw new Error("Runtime state contains an oversized process argument");
  }
  if (state.stoppedAt !== undefined && typeof state.stoppedAt !== "string") {
    throw new Error("Runtime state stoppedAt field is invalid");
  }
  if (state.stopReason !== undefined && typeof state.stopReason !== "string") {
    throw new Error("Runtime state stopReason field is invalid");
  }
  return state as unknown as RuntimeState;
}

async function readState(
  projectRoot: string,
  paths: RuntimePaths
): Promise<RuntimeState | null> {
  let stat;
  try {
    stat = await fs.lstat(paths.stateFile);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Runtime state is not a regular file: ${paths.stateFile}`);
  }
  if (stat.size > MAX_RUNTIME_STATE_BYTES) {
    throw new Error(`Runtime state exceeds ${MAX_RUNTIME_STATE_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(paths.stateFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse runtime state: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return validateState(value, projectRoot);
}

async function writeStateExclusive(
  paths: RuntimePaths,
  state: RuntimeState
): Promise<void> {
  try {
    await fs.writeFile(paths.stateFile, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new Error("A runtime state reservation already exists for this project");
    }
    throw error;
  }
}

async function replaceState(paths: RuntimePaths, state: RuntimeState): Promise<void> {
  const current = await readState(state.projectRoot, paths);
  if (current?.instanceId !== state.instanceId) {
    throw new Error("Runtime state ownership changed during the operation");
  }
  const temporary = path.join(
    paths.stateRoot,
    `.${path.basename(paths.stateFile)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, paths.stateFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeStateIfOwned(
  projectRoot: string,
  paths: RuntimePaths,
  instanceId: string
): Promise<void> {
  const current = await readState(projectRoot, paths);
  if (current === null) return;
  if (current.instanceId !== instanceId) {
    throw new Error("Refusing to remove runtime state owned by another instance");
  }
  await fs.rm(paths.stateFile, { force: true });
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

function runExecutable(
  executable: string,
  arguments_: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function queryProcessOnce(pid: number): Promise<ProcessDetails> {
  if (!processIsAlive(pid)) {
    return { alive: false, commandLine: null, executablePath: null };
  }

  try {
    if (process.platform === "win32") {
      const powershell = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const script =
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" ` +
        "-ErrorAction SilentlyContinue; " +
        "if ($null -eq $p) { exit 3 }; " +
        "[pscustomobject]@{ executablePath = $p.ExecutablePath; commandLine = $p.CommandLine } " +
        "| ConvertTo-Json -Compress";
      const { stdout } = await runExecutable(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        PROCESS_QUERY_TIMEOUT_MS
      );
      const value = JSON.parse(stdout) as Record<string, unknown>;
      return {
        alive: true,
        executablePath:
          typeof value.executablePath === "string" ? value.executablePath : null,
        commandLine: typeof value.commandLine === "string" ? value.commandLine : null,
      };
    }

    if (process.platform === "linux") {
      const commandLine = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8"))
        .split("\0")
        .filter(Boolean)
        .join(" ");
      const executablePath = await fs.readlink(`/proc/${pid}/exe`);
      return { alive: true, commandLine, executablePath };
    }

    const { stdout } = await runExecutable(
      "ps",
      ["-p", String(pid), "-o", "command="],
      PROCESS_QUERY_TIMEOUT_MS
    );
    return { alive: true, commandLine: stdout.trim(), executablePath: null };
  } catch (error) {
    if (!processIsAlive(pid)) {
      return { alive: false, commandLine: null, executablePath: null };
    }
    return {
      alive: true,
      commandLine: null,
      executablePath: null,
      queryError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function queryProcess(pid: number): Promise<ProcessDetails> {
  let last: ProcessDetails = {
    alive: processIsAlive(pid),
    commandLine: null,
    executablePath: null,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await queryProcessOnce(pid);
    if (!last.alive || last.queryError === undefined) return last;
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return last;
}

async function inspectStateProcess(state: RuntimeState): Promise<RuntimeStatusReport> {
  if (state.phase === "starting") {
    return {
      status: "ok",
      running: false,
      owned: false,
      stale: Date.now() - Date.parse(state.startedAt) > STARTING_STATE_MAX_AGE_MS,
      reason: "startup_in_progress",
      runtime: publicState(state),
    };
  }
  if (state.phase === "stopped") {
    return {
      status: "ok",
      running: false,
      owned: true,
      stale: false,
      reason: state.stopReason ?? "stopped",
      runtime: publicState(state),
    };
  }

  const details = await queryProcess(state.pid);
  if (!details.alive) {
    return {
      status: "ok",
      running: false,
      owned: false,
      stale: true,
      reason: "process_not_found",
      runtime: publicState(state),
    };
  }

  const marker = `${INSTANCE_ARGUMENT_PREFIX}${state.instanceId}`;
  const markerMatches = details.commandLine?.includes(marker) === true;
  const executableMatches =
    details.executablePath !== null
      ? normalizePathForComparison(details.executablePath) ===
        normalizePathForComparison(state.executable)
      : process.platform === "darwin" &&
        details.commandLine?.includes(path.basename(state.executable)) === true;
  const owned = markerMatches && executableMatches;
  return {
    status: owned ? "ok" : "error",
    running: true,
    owned,
    stale: false,
    reason: owned
      ? "owned_process_running"
      : details.queryError
        ? "process_identity_unavailable"
        : "process_identity_mismatch",
    runtime: publicState(state),
  };
}

async function canonicalExecutable(executable: string): Promise<string> {
  const resolved = path.resolve(executable);
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch (error) {
    if (isNotFound(error)) throw new Error(`Executable not found: ${resolved}`);
    throw error;
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`Executable is not a regular file: ${real}`);
  if (process.platform !== "win32") {
    await fs.access(real, fsConstants.X_OK);
  }
  return real;
}

async function findOnPath(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const names = process.platform === "win32"
    ? command.toLowerCase().endsWith(".exe")
      ? [command]
      : [`${command}.exe`]
    : [command];
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        return await canonicalExecutable(candidate);
      } catch {
        // Continue searching deterministic PATH entries.
      }
    }
  }
  return null;
}

export async function resolveGodotExecutable(
  requested?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<string> {
  const configured = requested?.trim() || env.GODOT_BIN?.trim();
  if (configured) {
    if (path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
      return canonicalExecutable(path.resolve(cwd, configured));
    }
    const found = await findOnPath(configured, env);
    if (found) return found;
    throw new Error(`Godot executable not found on PATH: ${configured}`);
  }

  for (const command of ["godot4", "godot"]) {
    const found = await findOnPath(command, env);
    if (found) return found;
  }
  throw new Error("Godot executable not found; pass --godot or set GODOT_BIN");
}

async function requireGodot47(executable: string): Promise<string> {
  let result;
  try {
    result = await runExecutable(executable, ["--version"], PROCESS_QUERY_TIMEOUT_MS);
  } catch (error) {
    throw new Error(
      `Cannot query Godot version: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
  if (!/^4\.7(?:\.|\s|$)/.test(version)) {
    throw new Error(`Godot 4.7 is required; executable reported '${version || "unknown"}'`);
  }
  return version;
}

async function ensurePortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => reject(error));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }).catch((error) => {
    throw new Error(
      `Loopback port ${port} is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

async function validateScenePath(projectRoot: string, scene?: string): Promise<string | undefined> {
  if (!scene) return undefined;
  if (!scene.startsWith("res://")) {
    throw new Error("--scene must use a res:// project path");
  }
  const relative = scene.slice("res://".length).replaceAll("/", path.sep);
  const absolute = path.resolve(projectRoot, relative);
  const within = path.relative(projectRoot, absolute);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error("--scene must stay inside the Godot project");
  }
  const stat = await fs.lstat(absolute).catch((error) => {
    if (isNotFound(error)) throw new Error(`Scene not found: ${scene}`);
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Scene must resolve to a regular project file: ${scene}`);
  }
  return scene;
}

async function pruneLogs(paths: RuntimePaths): Promise<void> {
  const prefix = `${STATE_FILE_PREFIX}${paths.projectKey}-`;
  const entries = await fs.readdir(paths.logsDirectory, { withFileTypes: true });
  const candidates: Array<{ name: string; modified: number }> = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(".log") ||
      path.basename(entry.name) !== entry.name
    ) {
      continue;
    }
    const stat = await fs.lstat(path.join(paths.logsDirectory, entry.name));
    if (!stat.isSymbolicLink()) candidates.push({ name: entry.name, modified: stat.mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  for (const candidate of candidates.slice(MAX_RUNTIME_LOG_FILES - 1)) {
    await fs.rm(path.join(paths.logsDirectory, candidate.name), { force: true });
  }
}

async function prepareStart(paths: RuntimePaths, projectRoot: string): Promise<void> {
  const existing = await readState(projectRoot, paths);
  if (existing === null) return;
  const inspection = await inspectStateProcess(existing);
  if (existing.phase === "starting" && !inspection.stale) {
    throw new Error("A runtime start operation is already in progress for this project");
  }
  if (inspection.running) {
    throw new Error(
      inspection.owned
        ? `An owned runtime is already running with PID ${existing.pid}`
        : `Refusing to replace state for an unverified live PID ${existing.pid}`
    );
  }
  await removeStateIfOwned(projectRoot, paths, existing.instanceId);
}

function validateProcessArguments(arguments_: string[]): void {
  if (arguments_.length > MAX_RUNTIME_ARGUMENTS) {
    throw new Error(`Runtime accepts at most ${MAX_RUNTIME_ARGUMENTS} process arguments`);
  }
  for (const argument of arguments_) {
    if (Buffer.byteLength(argument, "utf8") > MAX_RUNTIME_ARGUMENT_BYTES) {
      throw new Error(
        `Runtime process arguments are limited to ${MAX_RUNTIME_ARGUMENT_BYTES} bytes each`
      );
    }
    if (argument.startsWith(INSTANCE_ARGUMENT_PREFIX)) {
      throw new Error("Runtime instance markers are managed internally");
    }
  }
}

export async function startManagedRuntime(
  options: ManagedRuntimeStartOptions
): Promise<RuntimePublicState> {
  const token = requireRuntimeToken(options.token);
  const projectRoot = await requireRegularProjectRoot(options.projectRoot);
  const executable = await canonicalExecutable(options.executable);
  const port = parseBoundedInteger(options.port, 9900, 1, 65535, "port");
  validateProcessArguments(options.arguments);
  const paths = await runtimePaths(projectRoot, options.stateRoot);
  await prepareStart(paths, projectRoot);
  await pruneLogs(paths);

  const instanceId = randomUUID();
  const marker = `${INSTANCE_ARGUMENT_PREFIX}${instanceId}`;
  const arguments_ = [...options.arguments, marker];
  const startedAt = new Date().toISOString();
  const logFile = `${STATE_FILE_PREFIX}${paths.projectKey}-${Date.now()}-${instanceId.slice(0, 8)}.log`;
  const reservation: RuntimeState = {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    phase: "starting",
    instanceId,
    tokenHash: hashToken(token),
    pid: 0,
    projectRoot,
    executable,
    arguments: arguments_,
    port,
    mode: options.mode,
    logFile,
    startedAt,
    mutationsEnabled: options.allowMutations === true || options.allowUnsafe === true,
    unsafeEnabled: options.allowUnsafe === true,
  };
  await writeStateExclusive(paths, reservation);

  const logPath = path.join(paths.logsDirectory, logFile);
  let logHandle;
  let child: ChildProcess | undefined;
  try {
    logHandle = await fs.open(logPath, "wx", 0o600);
    await logHandle.writeFile(
      `[uo-godot-cli] starting ${startedAt} project=${projectRoot} mode=${options.mode} port=${port}\n`,
      "utf8"
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      GODOT_CLI_TOKEN: token,
      GODOT_CLI_PORT: String(port),
      UO_GODOT_CLI_INSTANCE_ID: instanceId,
    };
    delete childEnv.GODOT_CLI_ALLOW_MUTATIONS;
    delete childEnv.GODOT_CLI_ALLOW_UNSAFE;
    if (reservation.mutationsEnabled) childEnv.GODOT_CLI_ALLOW_MUTATIONS = "1";
    if (reservation.unsafeEnabled) childEnv.GODOT_CLI_ALLOW_UNSAFE = "1";

    child = spawn(executable, arguments_, {
      cwd: projectRoot,
      env: childEnv,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Process did not start within ${PROCESS_START_TIMEOUT_MS} ms`));
      }, PROCESS_START_TIMEOUT_MS);
      child?.once("spawn", () => {
        clearTimeout(timeout);
        resolve();
      });
      child?.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) {
      throw new Error("Started process did not provide a valid PID");
    }

    const running: RuntimeState = {
      ...reservation,
      phase: "running",
      pid: Number(child.pid),
    };
    await replaceState(paths, running);
    child.unref();
    return publicState(running);
  } catch (error) {
    if (child?.pid && processIsAlive(child.pid)) child.kill("SIGTERM");
    await removeStateIfOwned(projectRoot, paths, instanceId).catch(() => undefined);
    await fs.rm(logPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await logHandle?.close().catch(() => undefined);
  }
}

export async function getRuntimeStatus(
  projectRoot: string,
  options: RuntimeAccessOptions = {}
): Promise<RuntimeStatusReport> {
  const token = requireRuntimeToken(options.token);
  const canonicalProject = await requireRegularProjectRoot(projectRoot);
  const paths = await runtimePaths(canonicalProject, options.stateRoot);
  const state = await readState(canonicalProject, paths);
  if (state === null) {
    return {
      status: "ok",
      running: false,
      owned: false,
      stale: false,
      reason: "not_started",
      runtime: null,
    };
  }
  if (!tokenMatches(state, token)) {
    throw new Error("GODOT_CLI_TOKEN does not match the managed runtime state");
  }
  return inspectStateProcess(state);
}

async function markStopped(
  paths: RuntimePaths,
  state: RuntimeState,
  reason: string
): Promise<RuntimeState> {
  const stopped: RuntimeState = {
    ...state,
    phase: "stopped",
    stoppedAt: new Date().toISOString(),
    stopReason: reason,
  };
  await replaceState(paths, stopped);
  return stopped;
}

export async function stopManagedRuntime(
  projectRoot: string,
  options: RuntimeStopOptions = {}
): Promise<RuntimeStopReport> {
  const token = requireRuntimeToken(options.token);
  const timeoutMs = parseBoundedInteger(
    options.timeoutMs,
    DEFAULT_STOP_TIMEOUT_MS,
    100,
    MAX_RUNTIME_STOP_TIMEOUT_MS,
    "timeoutMs"
  );
  const canonicalProject = await requireRegularProjectRoot(projectRoot);
  const paths = await runtimePaths(canonicalProject, options.stateRoot);
  const state = await readState(canonicalProject, paths);
  if (state === null) {
    return { status: "ok", stopped: false, reason: "not_started", runtime: null };
  }
  if (!tokenMatches(state, token)) {
    throw new Error("GODOT_CLI_TOKEN does not match the managed runtime state");
  }
  if (state.phase === "starting") {
    throw new Error("Refusing to stop while runtime ownership is still being established");
  }
  if (state.phase === "stopped") {
    return {
      status: "ok",
      stopped: false,
      reason: state.stopReason ?? "already_stopped",
      runtime: publicState(state),
    };
  }

  const inspection = await inspectStateProcess(state);
  if (!inspection.running) {
    const stopped = await markStopped(paths, state, "process_exited");
    return {
      status: "ok",
      stopped: false,
      reason: "process_exited",
      runtime: publicState(stopped),
    };
  }
  if (!inspection.owned) {
    throw new Error(
      `Refusing to stop PID ${state.pid}: ${inspection.reason}`
    );
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (processIsAlive(state.pid)) throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (processIsAlive(state.pid)) {
    return {
      status: "error",
      stopped: false,
      reason: "graceful_stop_timeout",
      runtime: publicState(state),
    };
  }

  const stopped = await markStopped(paths, state, "stopped_by_cli");
  return {
    status: "ok",
    stopped: true,
    reason: "stopped_by_cli",
    runtime: publicState(stopped),
  };
}

export async function readRuntimeLogs(
  projectRoot: string,
  options: RuntimeLogsOptions = {}
): Promise<RuntimeLogsReport> {
  const token = requireRuntimeToken(options.token);
  const maxBytes = parseBoundedInteger(
    options.maxBytes,
    DEFAULT_LOG_BYTES,
    1,
    MAX_RUNTIME_LOG_BYTES,
    "maxBytes"
  );
  const maxLines = parseBoundedInteger(
    options.maxLines,
    DEFAULT_LOG_LINES,
    1,
    MAX_RUNTIME_LOG_LINES,
    "maxLines"
  );
  const canonicalProject = await requireRegularProjectRoot(projectRoot);
  const paths = await runtimePaths(canonicalProject, options.stateRoot);
  const state = await readState(canonicalProject, paths);
  if (state === null) throw new Error("No managed runtime state exists for this project");
  if (!tokenMatches(state, token)) {
    throw new Error("GODOT_CLI_TOKEN does not match the managed runtime state");
  }
  if (path.basename(state.logFile) !== state.logFile) {
    throw new Error("Runtime log state contains an invalid filename");
  }
  const logPath = path.join(paths.logsDirectory, state.logFile);
  const relativeLog = path.relative(paths.logsDirectory, logPath);
  if (
    relativeLog === ".." ||
    relativeLog.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeLog)
  ) {
    throw new Error("Runtime log path escaped the managed log directory");
  }
  const stat = await fs.lstat(logPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Runtime log is not a regular file: ${logPath}`);
  }
  const bytesRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytesRead);
  const handle = await fs.open(logPath, "r");
  try {
    if (bytesRead > 0) {
      await handle.read(buffer, 0, bytesRead, Math.max(0, stat.size - bytesRead));
    }
  } finally {
    await handle.close();
  }
  let lines = buffer.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  const truncatedByLines = lines.length > maxLines;
  if (truncatedByLines) lines = lines.slice(-maxLines);
  const status = await inspectStateProcess(state);
  return {
    status: "ok",
    running: status.running,
    owned: status.owned,
    runtime: publicState(state),
    logPath,
    bytesRead,
    totalBytes: stat.size,
    truncatedByBytes: stat.size > bytesRead,
    truncatedByLines,
    lines,
  };
}

export async function startGodotRuntime(
  options: GodotRuntimeStartOptions
): Promise<RuntimeStartReport> {
  const env = options.env ?? process.env;
  const configuredStateRoot = env[RUNTIME_STATE_DIRECTORY_VARIABLE]?.trim();
  const stateRoot = options.stateRoot ?? (configuredStateRoot || undefined);
  const token = requireRuntimeToken(env.GODOT_CLI_TOKEN);
  const discovery = await discoverProject(options.project, {
    cwd: options.cwd,
    env,
  });
  const addon = await inspectAddon(discovery.projectRoot);
  if (!addon.installed || !addon.matchesBundled) {
    throw new Error(
      `Runtime start requires the exact bundled addon; inspect ${addon.targetAddon}`
    );
  }
  if (!addon.autoloadEnabled) {
    throw new Error(
      "Runtime start requires the GodotCLI autoload to be explicitly enabled"
    );
  }

  const executable = await resolveGodotExecutable(options.godot, env, options.cwd);
  await requireGodot47(executable);
  const port = parseBoundedInteger(options.port, 9900, 1, 65535, "port");
  await ensurePortAvailable(port);
  const mode = options.mode ?? "headless";
  if (mode !== "headless" && mode !== "editor" && mode !== "game") {
    throw new Error("--mode must be headless, editor, or game");
  }
  const scene = await validateScenePath(discovery.projectRoot, options.scene);
  const shouldWait = options.wait !== false;
  const timeoutMs = shouldWait
    ? parseBoundedInteger(
        options.timeoutMs,
        30_000,
        1,
        MAX_READY_TIMEOUT_MS,
        "timeoutMs"
      )
    : 30_000;
  const intervalMs = shouldWait
    ? parseBoundedInteger(
        options.intervalMs,
        250,
        MIN_READY_INTERVAL_MS,
        5_000,
        "intervalMs"
      )
    : 250;
  const arguments_ = ["--path", discovery.projectRoot];
  if (mode === "headless") {
    arguments_.push("--headless", "--xr-mode", "off", "--audio-driver", "Dummy");
  } else if (mode === "editor") {
    arguments_.push("--editor");
  }
  if (scene) arguments_.push(scene);
  arguments_.push("--");

  const runtime = await startManagedRuntime({
    projectRoot: discovery.projectRoot,
    executable,
    arguments: arguments_,
    port,
    mode,
    token,
    env,
    stateRoot,
    allowMutations: options.allowMutations,
    allowUnsafe: options.allowUnsafe,
  });
  if (!shouldWait) {
    return {
      status: "ok",
      started: true,
      ready: "not_checked",
      runtime,
    };
  }

  const readiness = await waitForReady(
    new GodotClient({ host: options.host, port, token }),
    { timeoutMs, intervalMs }
  );
  if (readiness.status === "ok") {
    return {
      status: "ok",
      started: true,
      ready: true,
      runtime,
      readiness,
    };
  }

  const cleanup = await stopManagedRuntime(discovery.projectRoot, {
    token,
    stateRoot,
    timeoutMs: DEFAULT_STOP_TIMEOUT_MS,
  });
  return {
    status: "error",
    started: true,
    ready: false,
    runtime,
    readiness,
    cleanup,
  };
}
