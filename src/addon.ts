import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ADDON_RELATIVE_PATH = path.join("addons", "godot_cli");
const GODOT_AI_RELATIVE_PATH = path.join("addons", "godot_ai");
const GENERATED_FILE_SUFFIXES = [".uid"];

export interface AddonStatus {
  projectRoot: string;
  projectFile: string;
  sourceAddon: string;
  targetAddon: string;
  installed: boolean;
  matchesBundled: boolean;
  missingFiles: string[];
  modifiedFiles: string[];
  extraFiles: string[];
  pluginEnabled: boolean;
  autoloadEnabled: boolean;
  godotAiDetected: boolean;
  godotAiEnabled: boolean;
  warnings: string[];
}

export interface AddonInstallOptions {
  project: string;
  dryRun?: boolean;
  force?: boolean;
  sourceAddon?: string;
}

export interface AddonInstallResult extends AddonStatus {
  action:
    | "installed"
    | "replaced"
    | "unchanged"
    | "would_install"
    | "would_replace";
}

type Fingerprint = Map<string, string>;

function bundledAddonPath(): string {
  return fileURLToPath(
    new URL("../godot-addon/addons/godot_cli/", import.meta.url)
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function lstatIfExists(candidate: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function requireProject(project: string): Promise<{
  projectRoot: string;
  projectFile: string;
  definition: string;
}> {
  const requestedRoot = path.resolve(project);
  let requestedStat;
  try {
    requestedStat = await fs.stat(requestedRoot);
  } catch {
    throw new Error(`Godot project directory not found: ${requestedRoot}`);
  }
  if (!requestedStat.isDirectory()) {
    throw new Error(`Godot project path is not a directory: ${requestedRoot}`);
  }

  const projectRoot = await fs.realpath(requestedRoot);
  const projectFile = path.join(projectRoot, "project.godot");

  let projectStat;
  try {
    projectStat = await fs.lstat(projectFile);
  } catch {
    throw new Error(`project.godot not found in: ${projectRoot}`);
  }
  if (projectStat.isSymbolicLink() || !projectStat.isFile()) {
    throw new Error(`project.godot is not a regular file: ${projectFile}`);
  }

  return {
    projectRoot,
    projectFile,
    definition: await fs.readFile(projectFile, "utf8"),
  };
}

async function fingerprintDirectory(root: string): Promise<Fingerprint> {
  const fingerprint: Fingerprint = new Map();

  async function walk(current: string, relativeRoot: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path
        .join(relativeRoot, entry.name)
        .split(path.sep)
        .join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in addon files: ${absolute}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported addon filesystem entry: ${absolute}`);
      }
      const digest = createHash("sha256")
        .update(await fs.readFile(absolute))
        .digest("hex");
      fingerprint.set(relative, digest);
    }
  }

  await walk(root, "");
  return fingerprint;
}

function isGeneratedFile(relative: string): boolean {
  return GENERATED_FILE_SUFFIXES.some((suffix) => relative.endsWith(suffix));
}

export async function inspectAddon(
  project: string,
  sourceAddon = bundledAddonPath()
): Promise<AddonStatus> {
  const { projectRoot, projectFile, definition } = await requireProject(project);
  const resolvedSource = path.resolve(sourceAddon);
  const targetAddon = path.join(projectRoot, ADDON_RELATIVE_PATH);
  const addonsRoot = path.dirname(targetAddon);

  let sourceStat;
  try {
    sourceStat = await fs.lstat(resolvedSource);
  } catch {
    throw new Error(`Bundled GodotCLI addon not found: ${resolvedSource}`);
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`Bundled GodotCLI addon is not a directory: ${resolvedSource}`);
  }

  const addonsRootStat = await lstatIfExists(addonsRoot);
  if (
    addonsRootStat &&
    (addonsRootStat.isSymbolicLink() || !addonsRootStat.isDirectory())
  ) {
    throw new Error(`Godot addons path is not a regular directory: ${addonsRoot}`);
  }
  const targetStat = await lstatIfExists(targetAddon);
  if (
    targetStat &&
    (targetStat.isSymbolicLink() || !targetStat.isDirectory())
  ) {
    throw new Error(`GodotCLI addon target is not a regular directory: ${targetAddon}`);
  }

  const sourceFingerprint = await fingerprintDirectory(resolvedSource);
  if (sourceFingerprint.size === 0) {
    throw new Error(`Bundled GodotCLI addon is empty: ${resolvedSource}`);
  }

  const installed = targetStat !== undefined;
  const targetFingerprint = installed
    ? await fingerprintDirectory(targetAddon)
    : new Map<string, string>();
  const missingFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const extraFiles: string[] = [];

  for (const [relative, digest] of sourceFingerprint) {
    const installedDigest = targetFingerprint.get(relative);
    if (installedDigest === undefined) missingFiles.push(relative);
    else if (installedDigest !== digest) modifiedFiles.push(relative);
  }
  for (const relative of targetFingerprint.keys()) {
    if (!sourceFingerprint.has(relative) && !isGeneratedFile(relative)) {
      extraFiles.push(relative);
    }
  }

  const pluginEnabled = definition.includes(
    '"res://addons/godot_cli/plugin.cfg"'
  );
  const autoloadEnabled = /GodotCLI\s*=\s*"\*?res:\/\/addons\/godot_cli\/cli_server\.gd"/.test(
    definition
  );
  const godotAiDetected = await pathExists(
    path.join(projectRoot, GODOT_AI_RELATIVE_PATH)
  );
  const godotAiEnabled =
    definition.includes('"res://addons/godot_ai/plugin.cfg"') ||
    /_mcp_game_helper\s*=/.test(definition);
  const warnings: string[] = [];
  if (godotAiEnabled) {
    warnings.push(
      "godot_ai is enabled; keep GodotCLI opt-in and use a distinct port/token to avoid overlapping control planes."
    );
  }
  if (installed && !pluginEnabled && !autoloadEnabled) {
    warnings.push(
      "GodotCLI files are installed but the plugin/autoload is not enabled."
    );
  }

  return {
    projectRoot,
    projectFile,
    sourceAddon: resolvedSource,
    targetAddon,
    installed,
    matchesBundled:
      installed &&
      missingFiles.length === 0 &&
      modifiedFiles.length === 0 &&
      extraFiles.length === 0,
    missingFiles,
    modifiedFiles,
    extraFiles,
    pluginEnabled,
    autoloadEnabled,
    godotAiDetected,
    godotAiEnabled,
    warnings,
  };
}

export async function installAddon(
  options: AddonInstallOptions
): Promise<AddonInstallResult> {
  const before = await inspectAddon(options.project, options.sourceAddon);
  if (before.matchesBundled) return { ...before, action: "unchanged" };

  if (before.installed && !options.force) {
    throw new Error(
      `GodotCLI addon already exists and differs from the bundled version: ${before.targetAddon}. ` +
        "Inspect it first, then pass --force to replace it."
    );
  }

  const replacing = before.installed;
  if (options.dryRun) {
    return {
      ...before,
      action: replacing ? "would_replace" : "would_install",
    };
  }

  const addonsRoot = path.dirname(before.targetAddon);
  const nonce = `${process.pid}-${randomUUID()}`;
  const temporary = path.join(addonsRoot, `.godot_cli.install-${nonce}`);
  const backup = path.join(addonsRoot, `.godot_cli.backup-${nonce}`);
  await fs.mkdir(addonsRoot, { recursive: true });
  try {
    await fs.cp(before.sourceAddon, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }

  let backupCreated = false;
  try {
    if (replacing) {
      await fs.rename(before.targetAddon, backup);
      backupCreated = true;
    }
    await fs.rename(temporary, before.targetAddon);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    if (backupCreated && !(await pathExists(before.targetAddon))) {
      await fs.rename(backup, before.targetAddon);
      backupCreated = false;
    }
    throw error;
  }

  if (backupCreated) {
    await fs.rm(backup, { recursive: true, force: true });
  }

  const after = await inspectAddon(options.project, options.sourceAddon);
  if (!after.matchesBundled) {
    throw new Error(
      `GodotCLI addon verification failed after installation: ${after.targetAddon}`
    );
  }
  return { ...after, action: replacing ? "replaced" : "installed" };
}
