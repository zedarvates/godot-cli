import { promises as fs } from "node:fs";
import * as path from "node:path";

import { inspectAddon, type AddonStatus } from "./addon.js";

export const PROJECT_ENVIRONMENT_VARIABLE = "UO_GODOT_PROJECT";
export const MAX_PROJECT_DEFINITION_BYTES = 1024 * 1024;
export const MAX_PROJECT_SCAN_FILES = 20_000;
export const MAX_PROJECT_SCAN_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PROJECT_SCAN_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_REPORTED_PROJECT_ISSUES = 256;

const PROJECT_FILE_NAME = "project.godot";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".godot",
  ".mono",
  "bin",
  "node_modules",
  "obj",
]);
const HARD_REFERENCE_EXTENSIONS = new Set([
  ".cfg",
  ".godot",
  ".gdextension",
  ".tres",
  ".tscn",
]);
const SOFT_REFERENCE_EXTENSIONS = new Set([
  ".cs",
  ".gd",
  ".gdshader",
  ".json",
  ".shader",
]);

export type ProjectDiscoverySource = "argument" | "environment" | "cwd";
export type ProjectCheckSeverity = "error" | "warning";
export type ProjectReferenceKind = "hard" | "soft";

export interface ProjectDiscovery {
  status: "ok";
  source: ProjectDiscoverySource;
  startPath: string;
  projectRoot: string;
  projectFile: string;
  searchedDirectories: string[];
}

export interface ProjectAutoload {
  name: string;
  resource: string;
  singleton: boolean;
}

export interface ProjectInfo {
  status: "ok";
  discovery: ProjectDiscovery;
  configVersion: number | null;
  name: string | null;
  mainScene: string | null;
  features: string[];
  godotFeature: string | null;
  renderer: "forward_plus" | "mobile" | "gl_compatibility" | "unknown";
  rendererSource: "setting" | "feature" | "default" | "unknown";
  csharp: boolean;
  csharpProjects: string[];
  editorPlugins: string[];
  autoloads: ProjectAutoload[];
}

export interface ProjectReferenceIssue {
  reference: string;
  kind: ProjectReferenceKind;
  source: string;
  line: number;
  reason: "missing" | "outside_project" | "uid_without_path";
}

export interface ProjectLargeFile {
  source: string;
  bytes: number;
  limit: number;
}

export interface ProjectScanLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxReportedIssues: number;
}

export interface ProjectResourceScan {
  complete: boolean;
  filesScanned: number;
  bytesScanned: number;
  directoriesScanned: number;
  skippedDirectories: number;
  skippedNestedProjects: number;
  nestedProjects: string[];
  skippedSymlinks: number;
  skippedLargeFiles: number;
  largeFiles: ProjectLargeFile[];
  truncated: boolean;
  uniqueReferences: number;
  uidReferences: number;
  runtimeUidValidationRequired: boolean;
  missingHardReferences: number;
  missingSoftReferences: number;
  unresolvedUidReferences: number;
  issuesTruncated: boolean;
  issues: ProjectReferenceIssue[];
  scanErrors: string[];
  limits: ProjectScanLimits;
}

export interface ProjectPreflightCheck {
  name: string;
  severity: ProjectCheckSeverity;
  ok: boolean;
  expected: unknown;
  actual: unknown;
  note?: string;
}

export interface ProjectPreflightReport {
  status: "ok" | "error";
  ready: boolean;
  project: ProjectInfo;
  addon: AddonStatus;
  resources: ProjectResourceScan;
  checks: ProjectPreflightCheck[];
  warnings: string[];
}

export interface ProjectDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxReportedIssues?: number;
}

interface ParsedProjectDefinition {
  root: Map<string, string>;
  sections: Map<string, Map<string, string>>;
}

interface PendingReference {
  kind: ProjectReferenceKind;
  source: string;
  line: number;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parsePositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

async function requireRegularProjectFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`project.godot must not be a symbolic link: ${candidate}`);
    }
    if (!stat.isFile()) {
      throw new Error(`project.godot is not a regular file: ${candidate}`);
    }
    if (stat.size > MAX_PROJECT_DEFINITION_BYTES) {
      throw new Error(
        `project.godot exceeds the ${MAX_PROJECT_DEFINITION_BYTES}-byte limit: ${candidate}`
      );
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function discoverProject(
  requested?: string,
  options: ProjectDiscoveryOptions = {}
): Promise<ProjectDiscovery> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const environmentValue = (options.env ?? process.env)[
    PROJECT_ENVIRONMENT_VARIABLE
  ]?.trim();
  const argumentValue = requested?.trim();
  const source: ProjectDiscoverySource = argumentValue
    ? "argument"
    : environmentValue
      ? "environment"
      : "cwd";
  const rawStart = argumentValue || environmentValue || cwd;
  const absoluteStart = path.resolve(cwd, rawStart);

  let startStat;
  try {
    startStat = await fs.stat(absoluteStart);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`Project discovery start path not found: ${absoluteStart}`);
    }
    throw error;
  }

  let current: string;
  if (startStat.isDirectory()) current = await fs.realpath(absoluteStart);
  else if (startStat.isFile()) current = await fs.realpath(path.dirname(absoluteStart));
  else throw new Error(`Unsupported project discovery start path: ${absoluteStart}`);

  const searchedDirectories: string[] = [];
  while (true) {
    searchedDirectories.push(current);
    const projectFile = path.join(current, PROJECT_FILE_NAME);
    if (await requireRegularProjectFile(projectFile)) {
      return {
        status: "ok",
        source,
        startPath: absoluteStart,
        projectRoot: current,
        projectFile,
        searchedDirectories,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `project.godot not found from ${absoluteStart} or any parent directory`
  );
}

function parseProjectDefinition(definition: string): ParsedProjectDefinition {
  const root = new Map<string, string>();
  const sections = new Map<string, Map<string, string>>();
  let section = "";

  for (const rawLine of definition.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (section) sections.get(section)?.set(key, value);
    else root.set(key, value);
  }

  return { root, sections };
}

function parseGodotString(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parsePackedStrings(raw: string | undefined): string[] {
  if (!raw) return [];
  const values: string[] = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    try {
      values.push(JSON.parse(match[0]) as string);
    } catch {
      values.push(match[0].slice(1, -1));
    }
  }
  return values;
}

function inferRenderer(
  definition: ParsedProjectDefinition,
  features: string[]
): Pick<ProjectInfo, "renderer" | "rendererSource"> {
  const configured = parseGodotString(
    definition.sections.get("rendering")?.get("renderer/rendering_method")
  );
  if (
    configured === "forward_plus" ||
    configured === "mobile" ||
    configured === "gl_compatibility"
  ) {
    return { renderer: configured, rendererSource: "setting" };
  }

  const normalizedFeatures = features.map((feature) => feature.toLowerCase());
  if (normalizedFeatures.includes("forward plus")) {
    return { renderer: "forward_plus", rendererSource: "feature" };
  }
  if (normalizedFeatures.includes("mobile")) {
    return { renderer: "mobile", rendererSource: "feature" };
  }
  if (normalizedFeatures.includes("gl compatibility")) {
    return { renderer: "gl_compatibility", rendererSource: "feature" };
  }
  if (features.length > 0) {
    return { renderer: "forward_plus", rendererSource: "default" };
  }
  return { renderer: "unknown", rendererSource: "unknown" };
}

async function listCsharpProjects(projectRoot: string): Promise<string[]> {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csproj"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function inspectProject(
  requested?: string,
  options: ProjectDiscoveryOptions = {}
): Promise<ProjectInfo> {
  const discovery = await discoverProject(requested, options);
  const definition = await fs.readFile(discovery.projectFile, "utf8");
  const parsed = parseProjectDefinition(definition);
  const features = parsePackedStrings(
    parsed.sections.get("application")?.get("config/features")
  );
  const renderer = inferRenderer(parsed, features);
  const autoloads = [...(parsed.sections.get("autoload")?.entries() ?? [])]
    .map(([name, rawResource]) => {
      const decoded = parseGodotString(rawResource) ?? "";
      return {
        name,
        resource: decoded.startsWith("*") ? decoded.slice(1) : decoded,
        singleton: decoded.startsWith("*"),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const configVersion = Number(parsed.root.get("config_version"));

  return {
    status: "ok",
    discovery,
    configVersion: Number.isSafeInteger(configVersion) ? configVersion : null,
    name: parseGodotString(
      parsed.sections.get("application")?.get("config/name")
    ),
    mainScene: parseGodotString(
      parsed.sections.get("application")?.get("run/main_scene")
    ),
    features,
    godotFeature: features.find((feature) => /^\d+\.\d+/.test(feature)) ?? null,
    ...renderer,
    csharp: features.includes("C#"),
    csharpProjects: await listCsharpProjects(discovery.projectRoot),
    editorPlugins: parsePackedStrings(
      parsed.sections.get("editor_plugins")?.get("enabled")
    ).sort((left, right) => left.localeCompare(right)),
    autoloads,
  };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= index) low = middle;
    else high = middle;
  }
  return low + 1;
}

function decodeDoubleQuotedReference(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function collectReferences(
  text: string,
  relativeSource: string,
  defaultKind: ProjectReferenceKind,
  externalResourceLinesOnly: boolean,
  references: Map<string, PendingReference[]>
): number {
  const starts = lineStarts(text);
  const lines = externalResourceLinesOnly ? text.split(/\r?\n/) : [];
  const matches: Array<{ index: number; value: string }> = [];
  for (const match of text.matchAll(/"(\*?res:\/\/(?:\\.|[^"\\])*)"/g)) {
    matches.push({
      index: match.index,
      value: decodeDoubleQuotedReference(match[1]),
    });
  }
  for (const match of text.matchAll(/'(\*?res:\/\/[^'\r\n]*)'/g)) {
    matches.push({ index: match.index, value: match[1] });
  }
  matches.sort((left, right) => left.index - right.index);

  const seen = new Set<string>();
  for (const match of matches) {
    const reference = match.value.startsWith("*")
      ? match.value.slice(1)
      : match.value;
    const line = lineAt(starts, match.index);
    const kind =
      externalResourceLinesOnly &&
      !lines[line - 1]?.trimStart().startsWith("[ext_resource")
        ? "soft"
        : defaultKind;
    const occurrenceKey = `${reference}\0${line}`;
    if (seen.has(occurrenceKey)) continue;
    seen.add(occurrenceKey);
    const pending = references.get(reference) ?? [];
    pending.push({ kind, source: relativeSource, line });
    references.set(reference, pending);
  }

  return [...text.matchAll(/uid:\/\/[a-z0-9]+/gi)].length;
}

function collectUnresolvedUidReferences(
  text: string,
  relativeSource: string
): ProjectReferenceIssue[] {
  const issues: ProjectReferenceIssue[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (
      line.startsWith("[ext_resource") &&
      /uid="uid:\/\/[a-z0-9]+"/i.test(line) &&
      !/path="res:\/\//.test(line)
    ) {
      const uid = /uid="(uid:\/\/[a-z0-9]+)"/i.exec(line)?.[1] ?? "uid://unknown";
      issues.push({
        reference: uid,
        kind: "hard",
        source: relativeSource,
        line: index + 1,
        reason: "uid_without_path",
      });
    }
  }
  return issues;
}

function resourcePathWithinProject(
  projectRoot: string,
  reference: string
): string | null {
  const relativeResource = reference.slice("res://".length).replaceAll("/", path.sep);
  const absolute = path.resolve(projectRoot, relativeResource);
  const relative = path.relative(projectRoot, absolute);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return absolute;
  }
  return null;
}

export async function scanProjectResources(
  project: ProjectInfo,
  options: ProjectScanOptions = {}
): Promise<ProjectResourceScan> {
  const limits: ProjectScanLimits = {
    maxFiles: parsePositiveInteger(options.maxFiles, MAX_PROJECT_SCAN_FILES, "maxFiles"),
    maxFileBytes: parsePositiveInteger(
      options.maxFileBytes,
      MAX_PROJECT_SCAN_FILE_BYTES,
      "maxFileBytes"
    ),
    maxTotalBytes: parsePositiveInteger(
      options.maxTotalBytes,
      MAX_PROJECT_SCAN_TOTAL_BYTES,
      "maxTotalBytes"
    ),
    maxReportedIssues: parsePositiveInteger(
      options.maxReportedIssues,
      MAX_REPORTED_PROJECT_ISSUES,
      "maxReportedIssues"
    ),
  };
  const queue = [project.discovery.projectRoot];
  const references = new Map<string, PendingReference[]>();
  const uidIssues: ProjectReferenceIssue[] = [];
  const missingIssues: ProjectReferenceIssue[] = [];
  const scanErrors: string[] = [];
  const nestedProjects: string[] = [];
  const largeFiles: ProjectLargeFile[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let directoriesScanned = 0;
  let skippedDirectories = 0;
  let skippedNestedProjects = 0;
  let skippedSymlinks = 0;
  let skippedLargeFiles = 0;
  let uidReferences = 0;
  let unresolvedUidReferences = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const directory = queue.shift() as string;
    directoriesScanned += 1;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (scanErrors.length < limits.maxReportedIssues) {
        scanErrors.push(
          `${path.relative(project.discovery.projectRoot, directory) || "."}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    if (
      directory !== project.discovery.projectRoot &&
      entries.some(
        (entry) => entry.isFile() && entry.name.toLowerCase() === PROJECT_FILE_NAME
      )
    ) {
      skippedNestedProjects += 1;
      if (nestedProjects.length < limits.maxReportedIssues) {
        nestedProjects.push(
          path
            .relative(project.discovery.projectRoot, directory)
            .split(path.sep)
            .join("/")
        );
      }
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
          skippedDirectories += 1;
        } else {
          queue.push(absolute);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      const kind = HARD_REFERENCE_EXTENSIONS.has(extension)
        ? "hard"
        : SOFT_REFERENCE_EXTENSIONS.has(extension)
          ? "soft"
          : null;
      if (kind === null) continue;
      if (filesScanned >= limits.maxFiles) {
        truncated = true;
        break;
      }

      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch (error) {
        if (scanErrors.length < limits.maxReportedIssues) {
          scanErrors.push(
            `${path.relative(project.discovery.projectRoot, absolute)}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        skippedLargeFiles += 1;
        if (largeFiles.length < limits.maxReportedIssues) {
          largeFiles.push({
            source: path
              .relative(project.discovery.projectRoot, absolute)
              .split(path.sep)
              .join("/"),
            bytes: stat.size,
            limit: limits.maxFileBytes,
          });
        }
        continue;
      }
      if (bytesScanned + stat.size > limits.maxTotalBytes) {
        truncated = true;
        break;
      }

      let text;
      try {
        text = await fs.readFile(absolute, "utf8");
      } catch (error) {
        if (scanErrors.length < limits.maxReportedIssues) {
          scanErrors.push(
            `${path.relative(project.discovery.projectRoot, absolute)}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        continue;
      }
      filesScanned += 1;
      bytesScanned += stat.size;
      const relativeSource = path
        .relative(project.discovery.projectRoot, absolute)
        .split(path.sep)
        .join("/");
      uidReferences += collectReferences(
        text,
        relativeSource,
        kind,
        extension === ".tscn" || extension === ".tres",
        references
      );
      if (extension === ".tscn" || extension === ".tres") {
        const unresolved = collectUnresolvedUidReferences(text, relativeSource);
        unresolvedUidReferences += unresolved.length;
        for (const issue of unresolved) {
          uidIssues.push(issue);
        }
      }
    }
  }

  let missingHardReferences = 0;
  let missingSoftReferences = 0;
  for (const [reference, occurrences] of [...references.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const absolute = resourcePathWithinProject(project.discovery.projectRoot, reference);
    const hardOccurrence = occurrences.find((entry) => entry.kind === "hard");
    const evidence = hardOccurrence ?? occurrences[0];
    if (absolute === null) {
      if (evidence.kind === "hard") missingHardReferences += 1;
      else missingSoftReferences += 1;
      missingIssues.push({
        reference,
        kind: evidence.kind,
        source: evidence.source,
        line: evidence.line,
        reason: "outside_project",
      });
      continue;
    }
    try {
      await fs.access(absolute);
    } catch (error) {
      if (!isNotFound(error)) {
        if (scanErrors.length < limits.maxReportedIssues) {
          scanErrors.push(
            `${reference}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        continue;
      }
      if (evidence.kind === "hard") missingHardReferences += 1;
      else missingSoftReferences += 1;
      missingIssues.push({
        reference,
        kind: evidence.kind,
        source: evidence.source,
        line: evidence.line,
        reason: "missing",
      });
    }
  }

  const allIssues = [...uidIssues, ...missingIssues].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "hard" ? -1 : 1;
    const sourceOrder = left.source.localeCompare(right.source);
    if (sourceOrder !== 0) return sourceOrder;
    if (left.line !== right.line) return left.line - right.line;
    return left.reference.localeCompare(right.reference);
  });
  const issues = allIssues.slice(0, limits.maxReportedIssues);
  const complete =
    !truncated &&
    skippedSymlinks === 0 &&
    skippedLargeFiles === 0 &&
    scanErrors.length === 0;
  return {
    complete,
    filesScanned,
    bytesScanned,
    directoriesScanned,
    skippedDirectories,
    skippedNestedProjects,
    nestedProjects,
    skippedSymlinks,
    skippedLargeFiles,
    largeFiles,
    truncated,
    uniqueReferences: references.size,
    uidReferences,
    runtimeUidValidationRequired: uidReferences > 0,
    missingHardReferences,
    missingSoftReferences,
    unresolvedUidReferences,
    issuesTruncated: allIssues.length > issues.length,
    issues,
    scanErrors,
    limits,
  };
}

function preflightCheck(
  name: string,
  severity: ProjectCheckSeverity,
  expected: unknown,
  actual: unknown,
  ok: boolean,
  note?: string
): ProjectPreflightCheck {
  return { name, severity, expected, actual, ok, ...(note ? { note } : {}) };
}

async function projectResourceExists(
  projectRoot: string,
  reference: string | null
): Promise<boolean> {
  if (!reference?.startsWith("res://")) return false;
  const absolute = resourcePathWithinProject(projectRoot, reference);
  if (absolute === null) return false;
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function buildProjectPreflight(
  requested?: string,
  discoveryOptions: ProjectDiscoveryOptions = {},
  scanOptions: ProjectScanOptions = {}
): Promise<ProjectPreflightReport> {
  const project = await inspectProject(requested, discoveryOptions);
  const [addon, resources, mainSceneExists] = await Promise.all([
    inspectAddon(project.discovery.projectRoot),
    scanProjectResources(project, scanOptions),
    projectResourceExists(project.discovery.projectRoot, project.mainScene),
  ]);
  const checks: ProjectPreflightCheck[] = [
    preflightCheck("config_version", "error", 5, project.configVersion, project.configVersion === 5),
    preflightCheck("godot_feature", "error", "4.7", project.godotFeature, project.godotFeature === "4.7"),
    preflightCheck("renderer", "error", "forward_plus", project.renderer, project.renderer === "forward_plus"),
    preflightCheck(
      "csharp_project",
      "error",
      { feature: true, project_files: ">=1" },
      { feature: project.csharp, project_files: project.csharpProjects },
      project.csharp && project.csharpProjects.length > 0
    ),
    preflightCheck(
      "main_scene",
      "error",
      "existing res:// file",
      project.mainScene,
      mainSceneExists
    ),
    preflightCheck(
      "addon_integrity",
      "error",
      "installed and byte-identical to bundled addon",
      { installed: addon.installed, matchesBundled: addon.matchesBundled },
      addon.installed && addon.matchesBundled
    ),
    preflightCheck(
      "addon_activation",
      "warning",
      "explicit opt-in when runtime control is needed",
      { pluginEnabled: addon.pluginEnabled, autoloadEnabled: addon.autoloadEnabled },
      addon.pluginEnabled || addon.autoloadEnabled,
      "An inactive addon is valid for static checks but cannot accept runtime commands."
    ),
    preflightCheck(
      "control_plane_coexistence",
      "warning",
      "at most one active control plane unless ports and tokens are isolated",
      {
        godotAiEnabled: addon.godotAiEnabled,
        godotCliEnabled: addon.pluginEnabled || addon.autoloadEnabled,
      },
      !addon.godotAiEnabled || !(addon.pluginEnabled || addon.autoloadEnabled)
    ),
    preflightCheck(
      "resource_scan_complete",
      "error",
      true,
      resources.complete,
      resources.complete,
      "A truncated or partially unreadable scan cannot prove project readiness."
    ),
    preflightCheck(
      "oversized_project_files",
      "error",
      0,
      resources.largeFiles,
      resources.skippedLargeFiles === 0,
      "Oversized text resources are reported but never loaded into CLI memory."
    ),
    preflightCheck(
      "hard_resource_references",
      "error",
      0,
      resources.missingHardReferences,
      resources.missingHardReferences === 0
    ),
    preflightCheck(
      "soft_resource_references",
      "warning",
      0,
      resources.missingSoftReferences,
      resources.missingSoftReferences === 0,
      "Code strings can be examples or dynamically generated paths; review before treating them as load failures."
    ),
    preflightCheck(
      "uid_paths",
      "error",
      0,
      resources.unresolvedUidReferences,
      resources.unresolvedUidReferences === 0
    ),
    preflightCheck(
      "uid_runtime_validation",
      "warning",
      "Godot runtime load required",
      resources.runtimeUidValidationRequired ? "not_checked" : "not_required",
      !resources.runtimeUidValidationRequired,
      "Static scanning cannot validate Godot's binary UID cache; use a later scene-load gate."
    ),
  ];
  const ready = checks
    .filter((entry) => entry.severity === "error")
    .every((entry) => entry.ok);

  return {
    status: ready ? "ok" : "error",
    ready,
    project,
    addon,
    resources,
    checks,
    warnings: addon.warnings,
  };
}
