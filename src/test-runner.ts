import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { discoverProject, type ProjectDiscovery } from "./project.js";
import { resolveGodotExecutable } from "./runtime.js";

export const TEST_MANIFEST_FILE = ".uo-godot-tests.json";
export const TEST_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_TEST_MANIFEST_BYTES = 256 * 1024;
export const MAX_TEST_PROFILES = 128;
export const MAX_TEST_ARGUMENTS = 32;
export const MAX_TEST_ARGUMENT_BYTES = 1024;
export const MAX_TEST_ARGUMENT_TOTAL_BYTES = 8 * 1024;
export const MAX_TEST_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_TEST_TIMEOUT_SECONDS = 900;
export const MAX_TEST_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TEST_REPORTED_OUTPUT_BYTES = 64 * 1024;
export const MAX_TEST_DIAGNOSTIC_SAMPLES = 64;

const DEFAULT_TEST_TIMEOUT_SECONDS = 120;
const PROCESS_STOP_GRACE_MS = 2_000;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ALLOWED_PLACEHOLDERS = new Set(["projectRoot", "godotBin"]);
const RUNNER_EXTENSIONS: Record<TestRunner, Set<string>> = {
  godot_scene: new Set([".tscn", ".scn"]),
  godot_script: new Set([".gd"]),
  python: new Set([".py"]),
  dotnet_test: new Set([".csproj"]),
};
const TEST_RUNNERS = new Set<TestRunner>([
  "godot_scene",
  "godot_script",
  "python",
  "dotnet_test",
]);
const SAFE_ENVIRONMENT_KEYS = [
  "APPDATA",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "VIRTUAL_ENV",
  "WINDIR",
] as const;

export type TestRunner =
  | "godot_scene"
  | "godot_script"
  | "python"
  | "dotnet_test";

export interface TestProfile {
  id: string;
  description: string | null;
  runner: TestRunner;
  entry: string;
  args: string[];
  timeoutSeconds: number;
  tags: string[];
}

export interface TestProfileAvailability {
  available: boolean;
  entryPath: string | null;
  executable: string | null;
  godotExecutable: string | null;
  godotVersion: string | null;
  reasons: string[];
}

export interface ListedTestProfile extends TestProfile {
  availability: TestProfileAvailability;
}

export interface TestCatalogReport {
  status: "ok";
  configured: boolean;
  project: ProjectDiscovery;
  manifestPath: string;
  manifestSha256: string | null;
  schemaVersion: number | null;
  profiles: ListedTestProfile[];
  warnings: string[];
  limits: {
    maxProfiles: number;
    maxArguments: number;
    maxTimeoutSeconds: number;
    maxOutputBytes: number;
  };
}

export interface TestRunReport {
  status: "ok" | "error";
  passed: boolean;
  complete: boolean;
  project: ProjectDiscovery;
  manifestPath: string;
  profile: TestProfile;
  command: {
    executable: string;
    args: string[];
    cwd: string;
    shell: false;
  };
  process: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    outputLimitExceeded: boolean;
    durationMs: number;
  };
  diagnostics: {
    errorCount: number;
    warningCount: number;
    errors: string[];
    warnings: string[];
    samplesTruncated: boolean;
  };
  output: {
    stdoutTail: string;
    stderrTail: string;
    capturedBytes: number;
    reportedOutputTruncated: boolean;
  };
  evidence: {
    manifestSha256Before: string;
    manifestSha256After: string | null;
    manifestUnchanged: boolean;
    entrySha256Before: string;
    entrySha256After: string | null;
    entryUnchanged: boolean;
    projectMutationAudit: "not_performed";
  };
  notes: string[];
}

export interface TestCatalogOptions {
  project?: string;
  godot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TestRunOptions extends TestCatalogOptions {
  profile: string;
  timeoutSeconds?: number;
}

interface ParsedManifest {
  schemaVersion: number;
  profiles: TestProfile[];
  manifestPath: string;
  manifestSha256: string;
}

interface EntryInspection {
  path: string | null;
  reason: string | null;
}

interface DependencyInspection {
  executable: string | null;
  godotExecutable: string | null;
  godotVersion: string | null;
  reasons: string[];
}

interface DependencyCache {
  godot?: Promise<{ executable: string; version: string }>;
  python?: Promise<string>;
  dotnetTest?: Promise<string>;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: Buffer;
  stderr: Buffer;
  capturedBytes: number;
  durationMs: number;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  name: string,
  maximumLength: number
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (value.length > maximumLength) {
    throw new Error(`${name} exceeds the ${maximumLength}-character limit`);
  }
  if (/\0|[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain NUL or newline characters`);
  }
  return value;
}

function parseProfile(value: unknown, index: number): TestProfile {
  const raw = asObject(value, `profiles[${index}]`);
  const allowedKeys = new Set([
    "id",
    "description",
    "runner",
    "entry",
    "args",
    "timeoutSeconds",
    "tags",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`profiles[${index}] contains unsupported field '${key}'`);
    }
  }

  const id = requireString(raw.id, `profiles[${index}].id`, 64);
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new Error(
      `profiles[${index}].id must match ${PROFILE_ID_PATTERN.source}`
    );
  }
  const runner = raw.runner;
  if (typeof runner !== "string" || !TEST_RUNNERS.has(runner as TestRunner)) {
    throw new Error(
      `profiles[${index}].runner must be godot_scene, godot_script, python, or dotnet_test`
    );
  }
  const typedRunner = runner as TestRunner;
  const entry = requireString(raw.entry, `profiles[${index}].entry`, 1024);
  if (!entry.startsWith("res://")) {
    throw new Error(`profiles[${index}].entry must use a res:// project path`);
  }
  const extension = path.posix.extname(entry).toLowerCase();
  if (!RUNNER_EXTENSIONS[typedRunner].has(extension)) {
    throw new Error(
      `profiles[${index}].entry extension '${extension || "none"}' is not valid for ${typedRunner}`
    );
  }

  const description =
    raw.description === undefined
      ? null
      : requireString(raw.description, `profiles[${index}].description`, 512);
  const rawArgs = raw.args ?? [];
  if (!Array.isArray(rawArgs)) {
    throw new Error(`profiles[${index}].args must be an array`);
  }
  if (rawArgs.length > MAX_TEST_ARGUMENTS) {
    throw new Error(
      `profiles[${index}].args exceeds the ${MAX_TEST_ARGUMENTS}-argument limit`
    );
  }
  let argumentBytes = 0;
  const args = rawArgs.map((argument, argumentIndex) => {
    const parsed = requireString(
      argument,
      `profiles[${index}].args[${argumentIndex}]`,
      MAX_TEST_ARGUMENT_BYTES
    );
    argumentBytes += Buffer.byteLength(parsed, "utf8");
    for (const placeholder of parsed.matchAll(/\$\{([^}]+)\}/g)) {
      if (!ALLOWED_PLACEHOLDERS.has(placeholder[1])) {
        throw new Error(
          `profiles[${index}].args[${argumentIndex}] uses unsupported placeholder '${placeholder[0]}'`
        );
      }
    }
    return parsed;
  });
  if (argumentBytes > MAX_TEST_ARGUMENT_TOTAL_BYTES) {
    throw new Error(
      `profiles[${index}].args exceeds the ${MAX_TEST_ARGUMENT_TOTAL_BYTES}-byte total limit`
    );
  }

  const timeoutSeconds = raw.timeoutSeconds ?? DEFAULT_TEST_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    (timeoutSeconds as number) < 1 ||
    (timeoutSeconds as number) > MAX_TEST_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `profiles[${index}].timeoutSeconds must be an integer between 1 and ${MAX_TEST_TIMEOUT_SECONDS}`
    );
  }

  const rawTags = raw.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > 16) {
    throw new Error(`profiles[${index}].tags must contain at most 16 entries`);
  }
  const tags = rawTags.map((tag, tagIndex) => {
    const parsed = requireString(tag, `profiles[${index}].tags[${tagIndex}]`, 32);
    if (!TAG_PATTERN.test(parsed)) {
      throw new Error(
        `profiles[${index}].tags[${tagIndex}] must match ${TAG_PATTERN.source}`
      );
    }
    return parsed;
  });
  if (new Set(tags).size !== tags.length) {
    throw new Error(`profiles[${index}].tags must not contain duplicates`);
  }

  return {
    id,
    description,
    runner: typedRunner,
    entry,
    args,
    timeoutSeconds: timeoutSeconds as number,
    tags,
  };
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function hashFileIfRegular(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return hashFile(filePath);
  } catch {
    return null;
  }
}

async function loadManifest(projectRoot: string): Promise<ParsedManifest | null> {
  const manifestPath = path.join(projectRoot, TEST_MANIFEST_FILE);
  let stat;
  try {
    stat = await fs.lstat(manifestPath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${TEST_MANIFEST_FILE} must be a regular non-symbolic file`);
  }
  if (stat.size > MAX_TEST_MANIFEST_BYTES) {
    throw new Error(
      `${TEST_MANIFEST_FILE} exceeds the ${MAX_TEST_MANIFEST_BYTES}-byte limit`
    );
  }
  const bytes = await fs.readFile(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${TEST_MANIFEST_FILE} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const raw = asObject(parsed, TEST_MANIFEST_FILE);
  const rootKeys = Object.keys(raw);
  if (rootKeys.some((key) => key !== "schemaVersion" && key !== "profiles")) {
    throw new Error(`${TEST_MANIFEST_FILE} contains unsupported root fields`);
  }
  if (raw.schemaVersion !== TEST_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${TEST_MANIFEST_FILE}.schemaVersion must equal ${TEST_MANIFEST_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(raw.profiles)) {
    throw new Error(`${TEST_MANIFEST_FILE}.profiles must be an array`);
  }
  if (raw.profiles.length > MAX_TEST_PROFILES) {
    throw new Error(
      `${TEST_MANIFEST_FILE}.profiles exceeds the ${MAX_TEST_PROFILES}-profile limit`
    );
  }
  const profiles = raw.profiles.map(parseProfile);
  const identifiers = new Set<string>();
  for (const profile of profiles) {
    if (identifiers.has(profile.id)) {
      throw new Error(`${TEST_MANIFEST_FILE} contains duplicate profile '${profile.id}'`);
    }
    identifiers.add(profile.id);
  }
  profiles.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: TEST_MANIFEST_SCHEMA_VERSION,
    profiles,
    manifestPath,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function lexicalEntryPath(projectRoot: string, reference: string): string {
  const relativeResource = reference
    .slice("res://".length)
    .replaceAll("/", path.sep);
  const absolute = path.resolve(projectRoot, relativeResource);
  const relative = path.relative(projectRoot, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Test entry must stay inside the Godot project: ${reference}`);
  }
  return absolute;
}

async function inspectEntry(
  projectRoot: string,
  reference: string
): Promise<EntryInspection> {
  const absolute = lexicalEntryPath(projectRoot, reference);
  const relative = path.relative(projectRoot, absolute);
  let current = projectRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isNotFound(error)) {
        return { path: null, reason: `Entry not found: ${reference}` };
      }
      return {
        path: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (stat.isSymbolicLink()) {
      return {
        path: null,
        reason: `Entry path contains a symbolic link: ${reference}`,
      };
    }
    if (current === absolute) {
      if (!stat.isFile()) {
        return { path: null, reason: `Entry is not a regular file: ${reference}` };
      }
      if (stat.size > MAX_TEST_ENTRY_BYTES) {
        return {
          path: null,
          reason: `Entry exceeds the ${MAX_TEST_ENTRY_BYTES}-byte limit: ${reference}`,
        };
      }
    } else if (!stat.isDirectory()) {
      return { path: null, reason: `Entry parent is not a directory: ${reference}` };
    }
  }
  return { path: absolute, reason: null };
}

async function canonicalExecutable(candidate: string): Promise<string> {
  const real = await fs.realpath(candidate);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`Executable is not a regular file: ${candidate}`);
  return real;
}

async function findOnPath(
  commands: string[],
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  const entries = (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of entries) {
    for (const command of commands) {
      const names =
        process.platform === "win32" && !command.toLowerCase().endsWith(".exe")
          ? [`${command}.exe`, command]
          : [command];
      for (const name of names) {
        try {
          return await canonicalExecutable(path.join(directory, name));
        } catch {
          // Continue through deterministic PATH entries.
        }
      }
    }
  }
  return null;
}

async function resolveToolExecutable(
  runner: "python" | "dotnet_test",
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  const variable = runner === "python" ? "PYTHON_BIN" : "DOTNET_BIN";
  const configured = env[variable]?.trim();
  if (configured) {
    if (path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
      return canonicalExecutable(path.resolve(cwd, configured));
    }
    const found = await findOnPath([configured], env);
    if (found) return found;
    throw new Error(`${variable} executable not found on PATH: ${configured}`);
  }
  const commands = runner === "python" ? ["python", "python3"] : ["dotnet"];
  const found = await findOnPath(commands, env);
  if (found) return found;
  throw new Error(
    `${runner === "python" ? "Python" : ".NET"} executable not found; set ${variable}`
  );
}

async function runProcessQuery(
  executable: string,
  args: string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_QUERY_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function inspectGodot(
  requested: string | undefined,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<{ executable: string; version: string }> {
  const executable = await resolveGodotExecutable(requested, env, cwd);
  const result = await runProcessQuery(executable, ["--version"]);
  const version = `${result.stdout}\n${result.stderr}`
    .trim()
    .split(/\r?\n/)[0] ?? "";
  if (result.exitCode !== 0) {
    throw new Error(`Cannot query Godot version (exit ${result.exitCode})`);
  }
  if (!/^4\.7(?:\.|\s|$)/.test(version)) {
    throw new Error(`Godot 4.7 is required; executable reported '${version || "unknown"}'`);
  }
  return { executable, version };
}

function profileRequiresGodot(profile: TestProfile): boolean {
  return (
    profile.runner === "godot_scene" ||
    profile.runner === "godot_script" ||
    profile.args.some((argument) => argument.includes("${godotBin}"))
  );
}

async function inspectDependencies(
  profile: TestProfile,
  options: TestCatalogOptions,
  projectRoot: string,
  cache: DependencyCache
): Promise<DependencyInspection> {
  const env = options.env ?? process.env;
  const reasons: string[] = [];
  let executable: string | null = null;
  let godotExecutable: string | null = null;
  let godotVersion: string | null = null;

  if (profileRequiresGodot(profile)) {
    try {
      cache.godot ??= inspectGodot(options.godot, env, projectRoot);
      const godot = await cache.godot;
      godotExecutable = godot.executable;
      godotVersion = godot.version;
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (profile.runner === "godot_scene" || profile.runner === "godot_script") {
    executable = godotExecutable;
  } else {
    try {
      const key = profile.runner === "python" ? "python" : "dotnetTest";
      cache[key] ??= resolveToolExecutable(profile.runner, env, projectRoot);
      executable = await cache[key];
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { executable, godotExecutable, godotVersion, reasons };
}

async function inspectProfileAvailability(
  profile: TestProfile,
  options: TestCatalogOptions,
  projectRoot: string,
  cache: DependencyCache = {}
): Promise<TestProfileAvailability> {
  const [entry, dependencies] = await Promise.all([
    inspectEntry(projectRoot, profile.entry),
    inspectDependencies(profile, options, projectRoot, cache),
  ]);
  const reasons = [...dependencies.reasons];
  if (entry.reason) reasons.unshift(entry.reason);
  return {
    available: reasons.length === 0,
    entryPath: entry.path,
    executable: dependencies.executable,
    godotExecutable: dependencies.godotExecutable,
    godotVersion: dependencies.godotVersion,
    reasons,
  };
}

export async function listTestProfiles(
  options: TestCatalogOptions = {}
): Promise<TestCatalogReport> {
  const env = options.env ?? process.env;
  const project = await discoverProject(options.project, {
    cwd: options.cwd,
    env,
  });
  const manifest = await loadManifest(project.projectRoot);
  const manifestPath = path.join(project.projectRoot, TEST_MANIFEST_FILE);
  if (manifest === null) {
    return {
      status: "ok",
      configured: false,
      project,
      manifestPath,
      manifestSha256: null,
      schemaVersion: null,
      profiles: [],
      warnings: [
        `${TEST_MANIFEST_FILE} is absent; no project-defined test profile is available.`,
      ],
      limits: {
        maxProfiles: MAX_TEST_PROFILES,
        maxArguments: MAX_TEST_ARGUMENTS,
        maxTimeoutSeconds: MAX_TEST_TIMEOUT_SECONDS,
        maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
      },
    };
  }

  const profiles: ListedTestProfile[] = [];
  const dependencyCache: DependencyCache = {};
  for (const profile of manifest.profiles) {
    profiles.push({
      ...profile,
      availability: await inspectProfileAvailability(
        profile,
        options,
        project.projectRoot,
        dependencyCache
      ),
    });
  }
  return {
    status: "ok",
    configured: true,
    project,
    manifestPath,
    manifestSha256: manifest.manifestSha256,
    schemaVersion: manifest.schemaVersion,
    profiles,
    warnings: profiles.some((profile) => !profile.availability.available)
      ? ["One or more declared profiles are currently unavailable."]
      : [],
    limits: {
      maxProfiles: MAX_TEST_PROFILES,
      maxArguments: MAX_TEST_ARGUMENTS,
      maxTimeoutSeconds: MAX_TEST_TIMEOUT_SECONDS,
      maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
    },
  };
}

function expandArguments(
  args: string[],
  projectRoot: string,
  godotExecutable: string | null
): string[] {
  return args.map((argument) => {
    let expanded = argument.replaceAll("${projectRoot}", projectRoot);
    if (expanded.includes("${godotBin}")) {
      if (!godotExecutable) {
        throw new Error("Profile requires ${godotBin}, but Godot 4.7 is unavailable");
      }
      expanded = expanded.replaceAll("${godotBin}", godotExecutable);
    }
    return expanded;
  });
}

function buildCommand(
  profile: TestProfile,
  availability: TestProfileAvailability,
  projectRoot: string
): { executable: string; args: string[] } {
  if (!availability.executable || !availability.entryPath) {
    throw new Error(`Profile '${profile.id}' is unavailable`);
  }
  const expanded = expandArguments(
    profile.args,
    projectRoot,
    availability.godotExecutable
  );
  switch (profile.runner) {
    case "godot_scene":
      return {
        executable: availability.executable,
        args: [
          "--headless",
          "--xr-mode",
          "off",
          "--audio-driver",
          "Dummy",
          "--path",
          projectRoot,
          profile.entry,
          "--",
          ...expanded,
        ],
      };
    case "godot_script":
      return {
        executable: availability.executable,
        args: [
          "--headless",
          "--xr-mode",
          "off",
          "--audio-driver",
          "Dummy",
          "--path",
          projectRoot,
          "--script",
          profile.entry,
          "--",
          ...expanded,
        ],
      };
    case "python":
      return {
        executable: availability.executable,
        args: [availability.entryPath, ...expanded],
      };
    case "dotnet_test":
      return {
        executable: availability.executable,
        args: ["test", availability.entryPath, "--nologo", ...expanded],
      };
  }
}

function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  projectRoot: string,
  godotExecutable: string | null
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  result.CI = "1";
  result.UO_GODOT_PROJECT = projectRoot;
  if (godotExecutable) result.GODOT_BIN = godotExecutable;
  if (source.FOVEA_PROJECT_ROOT) {
    result.FOVEA_PROJECT_ROOT = source.FOVEA_PROJECT_ROOT;
  }
  return result;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  remaining: number
): number {
  if (remaining <= 0) return 0;
  const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(Buffer.from(accepted));
  return accepted.length;
}

async function runBoundedProcess(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let stopping = false;
    let forceTimer: NodeJS.Timeout | null = null;

    const stopOwnedChild = (): void => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, PROCESS_STOP_GRACE_MS);
      forceTimer.unref();
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      const accepted = appendBounded(
        target,
        chunk,
        MAX_TEST_OUTPUT_BYTES - capturedBytes
      );
      capturedBytes += accepted;
      if (accepted < chunk.length) {
        outputLimitExceeded = true;
        stopOwnedChild();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      stopOwnedChild();
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        capturedBytes,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function tailUtf8(buffer: Buffer, maximumBytes: number): string {
  const slice =
    buffer.length <= maximumBytes
      ? buffer
      : buffer.subarray(buffer.length - maximumBytes);
  return slice.toString("utf8").replace(/^\uFFFD/, "");
}

function analyzeOutput(stdout: Buffer, stderr: Buffer): TestRunReport["diagnostics"] {
  const errors: string[] = [];
  const warnings: string[] = [];
  let errorCount = 0;
  let warningCount = 0;
  const lines = `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const isError =
      /(?:^|\s)(?:SHADER ERROR:|SCRIPT ERROR:|Parse Error:|ERROR:|FATAL:|FAIL:|\[FAIL\]|\[ERREUR\]|Unhandled exception|error [A-Z]{2}\d{4})/i.test(
        line
      );
    const isWarning =
      !isError &&
      /(?:^|\s)(?:WARNING:|WARN:|\[WARN\]|\[AVERT\s*\]|warning [A-Z]{2}\d{4})/i.test(
        line
      );
    if (isError) {
      errorCount += 1;
      if (errors.length < MAX_TEST_DIAGNOSTIC_SAMPLES) errors.push(line);
    } else if (isWarning) {
      warningCount += 1;
      if (warnings.length < MAX_TEST_DIAGNOSTIC_SAMPLES) warnings.push(line);
    }
  }
  return {
    errorCount,
    warningCount,
    errors,
    warnings,
    samplesTruncated:
      errorCount > errors.length || warningCount > warnings.length,
  };
}

function validateTimeoutOverride(
  requested: number | undefined,
  profileLimit: number
): number {
  if (requested === undefined) return profileLimit;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error("--timeout must be a positive integer number of seconds");
  }
  if (requested > profileLimit) {
    throw new Error(
      `--timeout cannot exceed the profile limit of ${profileLimit} seconds`
    );
  }
  return requested;
}

export async function runTestProfile(
  options: TestRunOptions
): Promise<TestRunReport> {
  if (!PROFILE_ID_PATTERN.test(options.profile)) {
    throw new Error(`Profile id must match ${PROFILE_ID_PATTERN.source}`);
  }
  const env = options.env ?? process.env;
  const project = await discoverProject(options.project, {
    cwd: options.cwd,
    env,
  });
  const manifest = await loadManifest(project.projectRoot);
  if (manifest === null) {
    throw new Error(`${TEST_MANIFEST_FILE} not found in ${project.projectRoot}`);
  }
  const profile = manifest.profiles.find((candidate) => candidate.id === options.profile);
  if (!profile) {
    throw new Error(`Unknown test profile '${options.profile}'`);
  }
  const availability = await inspectProfileAvailability(
    profile,
    options,
    project.projectRoot
  );
  if (!availability.available) {
    throw new Error(
      `Test profile '${profile.id}' is unavailable: ${availability.reasons.join("; ")}`
    );
  }
  const timeoutSeconds = validateTimeoutOverride(
    options.timeoutSeconds,
    profile.timeoutSeconds
  );
  const command = buildCommand(profile, availability, project.projectRoot);
  const entryPath = availability.entryPath as string;
  const entrySha256Before = await hashFile(entryPath);
  const processResult = await runBoundedProcess(
    command.executable,
    command.args,
    project.projectRoot,
    buildChildEnvironment(env, project.projectRoot, availability.godotExecutable),
    timeoutSeconds * 1000
  );
  const [manifestSha256After, entrySha256After] = await Promise.all([
    hashFileIfRegular(manifest.manifestPath),
    hashFileIfRegular(entryPath),
  ]);
  const diagnostics = analyzeOutput(processResult.stdout, processResult.stderr);
  const complete =
    !processResult.timedOut && !processResult.outputLimitExceeded;
  const godotLogClean =
    profile.runner !== "godot_scene" && profile.runner !== "godot_script"
      ? true
      : diagnostics.errorCount === 0;
  const passed =
    complete && processResult.exitCode === 0 && godotLogClean;
  const reportedOutputTruncated =
    processResult.stdout.length > MAX_TEST_REPORTED_OUTPUT_BYTES ||
    processResult.stderr.length > MAX_TEST_REPORTED_OUTPUT_BYTES;
  const notes = [
    "Only the declared profile entry was executed; no shell was used.",
    "The child received a minimal environment without GODOT_CLI_TOKEN or runtime mutation gates.",
    "Project-wide file mutation was not audited.",
  ];
  if (
    (profile.runner === "godot_scene" || profile.runner === "godot_script") &&
    diagnostics.errorCount > 0
  ) {
    notes.push("Godot error diagnostics fail the profile even when the process exits with code 0.");
  }
  return {
    status: passed ? "ok" : "error",
    passed,
    complete,
    project,
    manifestPath: manifest.manifestPath,
    profile,
    command: {
      executable: command.executable,
      args: command.args,
      cwd: project.projectRoot,
      shell: false,
    },
    process: {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
      outputLimitExceeded: processResult.outputLimitExceeded,
      durationMs: processResult.durationMs,
    },
    diagnostics,
    output: {
      stdoutTail: tailUtf8(
        processResult.stdout,
        MAX_TEST_REPORTED_OUTPUT_BYTES
      ),
      stderrTail: tailUtf8(
        processResult.stderr,
        MAX_TEST_REPORTED_OUTPUT_BYTES
      ),
      capturedBytes: processResult.capturedBytes,
      reportedOutputTruncated,
    },
    evidence: {
      manifestSha256Before: manifest.manifestSha256,
      manifestSha256After,
      manifestUnchanged: manifestSha256After === manifest.manifestSha256,
      entrySha256Before,
      entrySha256After,
      entryUnchanged: entrySha256After === entrySha256Before,
      projectMutationAudit: "not_performed",
    },
    notes,
  };
}
