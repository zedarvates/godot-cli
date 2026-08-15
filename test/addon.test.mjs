import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectAddon, installAddon } from "../dist/addon.js";

const PROJECT_DEFINITION = `config_version=5

[application]
config/name="Addon Test"

[editor_plugins]
enabled=PackedStringArray("res://addons/godot_ai/plugin.cfg")

[autoload]
_mcp_game_helper="*res://addons/godot_ai/runtime/game_helper.gd"
`;

async function createProject(context, definition = PROJECT_DEFINITION) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-godot-cli-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, "project.godot"), definition, "utf8");
  await fs.mkdir(path.join(project, "addons", "godot_ai"), {
    recursive: true,
  });
  return project;
}

function runCli(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("status detects godot_ai without claiming GodotCLI is installed", async (t) => {
  const project = await createProject(t);
  const status = await inspectAddon(project);

  assert.equal(status.installed, false);
  assert.equal(status.matchesBundled, false);
  assert.equal(status.godotAiDetected, true);
  assert.equal(status.godotAiEnabled, true);
  assert.match(status.warnings.join("\n"), /overlapping control planes/);
});

test("dry-run reports installation without writing the project", async (t) => {
  const project = await createProject(t);
  const projectFile = path.join(project, "project.godot");
  const before = await fs.readFile(projectFile, "utf8");

  const result = await installAddon({ project, dryRun: true });

  assert.equal(result.action, "would_install");
  assert.equal(result.installed, false);
  await assert.rejects(() => fs.access(result.targetAddon), /ENOENT/);
  assert.equal(await fs.readFile(projectFile, "utf8"), before);
});

test("install copies verified files without enabling the plugin", async (t) => {
  const project = await createProject(t);
  const projectFile = path.join(project, "project.godot");
  const before = await fs.readFile(projectFile, "utf8");

  const result = await installAddon({ project });

  assert.equal(result.action, "installed");
  assert.equal(result.matchesBundled, true);
  assert.equal(result.pluginEnabled, false);
  assert.equal(result.autoloadEnabled, false);
  assert.equal(await fs.readFile(projectFile, "utf8"), before);
  assert.match(
    await fs.readFile(path.join(result.targetAddon, "plugin.cfg"), "utf8"),
    /Ultimate Odycer Godot Runtime CLI/
  );

  await fs.writeFile(path.join(result.targetAddon, "plugin.gd.uid"), "uid://test");
  assert.equal((await inspectAddon(project)).matchesBundled, true);
  assert.equal((await installAddon({ project })).action, "unchanged");
});

test("modified addon requires force and is replaced atomically", async (t) => {
  const project = await createProject(t);
  const installed = await installAddon({ project });
  const serverFile = path.join(installed.targetAddon, "cli_server.gd");
  await fs.writeFile(serverFile, "modified", "utf8");

  const changed = await inspectAddon(project);
  assert.deepEqual(changed.modifiedFiles, ["cli_server.gd"]);
  await assert.rejects(
    () => installAddon({ project }),
    /pass --force to replace it/
  );

  const dryRun = await installAddon({ project, dryRun: true, force: true });
  assert.equal(dryRun.action, "would_replace");
  assert.equal(await fs.readFile(serverFile, "utf8"), "modified");

  const replaced = await installAddon({ project, force: true });
  assert.equal(replaced.action, "replaced");
  assert.equal(replaced.matchesBundled, true);
  const addonsEntries = await fs.readdir(path.join(project, "addons"));
  assert.equal(
    addonsEntries.some((entry) => entry.startsWith(".godot_cli.")),
    false
  );
});

test("status command works without a runtime token", async (t) => {
  const project = await createProject(t);
  const env = { ...process.env };
  delete env.GODOT_CLI_TOKEN;

  const result = await runCli(["addon", "status", project], env);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).godotAiEnabled, true);
});

test("installer rejects directories without project.godot", async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-godot-cli-empty-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  await assert.rejects(() => inspectAddon(project), /project\.godot not found/);
});

test("installer rejects a non-directory addon target", async (t) => {
  const project = await createProject(t);
  const target = path.join(project, "addons", "godot_cli");
  await fs.writeFile(target, "not-a-directory", "utf8");

  await assert.rejects(
    () => inspectAddon(project),
    /addon target is not a regular directory/
  );
});
