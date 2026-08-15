import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installAddon } from "../dist/addon.js";
import {
  buildProjectPreflight,
  discoverProject,
  inspectProject,
  scanProjectResources,
} from "../dist/project.js";

const PROJECT_DEFINITION = `config_version=5

[application]
config/name="Project Preflight Test"
run/main_scene="res://Scenes/Main.tscn"
config/features=PackedStringArray("4.7", "C#", "Forward Plus")

[autoload]
Config="*res://Scripts/Config.cs"

[editor_plugins]
enabled=PackedStringArray("res://addons/example/plugin.cfg")
`;

async function createProject(context, options = {}) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-godot-project-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(project, "project.godot"),
    options.definition ?? PROJECT_DEFINITION,
    "utf8"
  );
  await fs.writeFile(
    path.join(project, "ProjectPreflightTest.csproj"),
    '<Project Sdk="Godot.NET.Sdk/4.7.0"></Project>',
    "utf8"
  );
  await fs.mkdir(path.join(project, "Scenes"), { recursive: true });
  if (!options.omitMainScene) {
    await fs.writeFile(
      path.join(project, "Scenes", "Main.tscn"),
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
      "utf8"
    );
  }
  await fs.mkdir(path.join(project, "Scripts"), { recursive: true });
  await fs.writeFile(path.join(project, "Scripts", "Config.cs"), "public class Config {}\n");
  await fs.mkdir(path.join(project, "addons", "example"), { recursive: true });
  await fs.writeFile(
    path.join(project, "addons", "example", "plugin.cfg"),
    '[plugin]\nname="Example"\n',
    "utf8"
  );
  return project;
}

function runCli(args, cwd, env = process.env) {
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
    child.once("exit", (code) => resolve({ code, stdout, stderr, cwd }));
  });
}

test("project discovery walks upward from a nested file", async (t) => {
  const project = await createProject(t);
  const nested = path.join(project, "Scripts", "Nested");
  await fs.mkdir(nested);
  const sourceFile = path.join(nested, "Probe.gd");
  await fs.writeFile(sourceFile, "extends Node\n", "utf8");

  const discovery = await discoverProject(sourceFile, {
    cwd: path.dirname(project),
    env: {},
  });

  assert.equal(discovery.source, "argument");
  assert.equal(discovery.projectRoot, await fs.realpath(project));
  assert.equal(discovery.searchedDirectories.length, 3);
});

test("UO_GODOT_PROJECT is used when no argument is provided", async (t) => {
  const project = await createProject(t);
  const discovery = await discoverProject(undefined, {
    cwd: os.tmpdir(),
    env: { UO_GODOT_PROJECT: project },
  });

  assert.equal(discovery.source, "environment");
  assert.equal(discovery.projectRoot, await fs.realpath(project));
});

test("project info reports the Godot 4.7 Forward+ C# contract", async (t) => {
  const project = await createProject(t);
  const info = await inspectProject(project, { env: {} });

  assert.equal(info.name, "Project Preflight Test");
  assert.equal(info.mainScene, "res://Scenes/Main.tscn");
  assert.equal(info.godotFeature, "4.7");
  assert.equal(info.renderer, "forward_plus");
  assert.equal(info.rendererSource, "feature");
  assert.equal(info.csharp, true);
  assert.deepEqual(info.csharpProjects, ["ProjectPreflightTest.csproj"]);
  assert.deepEqual(info.editorPlugins, ["res://addons/example/plugin.cfg"]);
  assert.deepEqual(info.autoloads, [
    { name: "Config", resource: "res://Scripts/Config.cs", singleton: true },
  ]);
});

test("preflight accepts a complete project with an exact inactive addon", async (t) => {
  const project = await createProject(t);
  await installAddon({ project });

  const report = await buildProjectPreflight(project, { env: {} });

  assert.equal(report.status, "ok");
  assert.equal(report.ready, true);
  assert.equal(report.addon.matchesBundled, true);
  assert.equal(report.resources.complete, true);
  assert.equal(report.resources.missingHardReferences, 0);
  assert.equal(
    report.checks.find((entry) => entry.name === "addon_activation")?.severity,
    "warning"
  );
});

test("preflight fails closed when the main scene is missing", async (t) => {
  const project = await createProject(t, { omitMainScene: true });
  await installAddon({ project });

  const report = await buildProjectPreflight(project, { env: {} });

  assert.equal(report.status, "error");
  assert.equal(report.ready, false);
  assert.equal(
    report.checks.find((entry) => entry.name === "main_scene")?.ok,
    false
  );
  assert.ok(report.resources.missingHardReferences >= 1);
  assert.ok(
    report.resources.issues.some(
      (entry) => entry.reference === "res://Scenes/Main.tscn" && entry.reason === "missing"
    )
  );
});

test("resource scan reports an incomplete result when its file budget is exhausted", async (t) => {
  const project = await createProject(t);
  const info = await inspectProject(project, { env: {} });

  const scan = await scanProjectResources(info, { maxFiles: 1 });

  assert.equal(scan.complete, false);
  assert.equal(scan.truncated, true);
  assert.equal(scan.filesScanned, 1);
});

test("resource scan isolates nested projects and treats scene path strings as soft", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "Scenes", "Metadata.tscn"),
    '[gd_scene format=3]\n\n[node name="Metadata" type="Node"]\nsource_path = "res://generated/later.glb"\n',
    "utf8"
  );
  const nested = path.join(project, "Tests", "Standalone");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(
    path.join(nested, "project.godot"),
    'config_version=5\n\n[application]\nrun/main_scene="res://missing.tscn"\n',
    "utf8"
  );

  const info = await inspectProject(project, { env: {} });
  const scan = await scanProjectResources(info);

  assert.equal(scan.skippedNestedProjects, 1);
  assert.deepEqual(scan.nestedProjects, ["Tests/Standalone"]);
  assert.equal(scan.missingHardReferences, 0);
  assert.equal(scan.missingSoftReferences, 1);
  assert.equal(scan.issues[0].reference, "res://generated/later.glb");
  assert.equal(scan.issues[0].kind, "soft");
});

test("project CLI commands require no runtime token and preserve failure exit codes", async (t) => {
  const project = await createProject(t, { omitMainScene: true });
  await installAddon({ project });
  const env = { ...process.env };
  delete env.GODOT_CLI_TOKEN;
  delete env.UO_GODOT_PROJECT;

  const discovery = await runCli(["project", "discover", project], project, env);
  assert.equal(discovery.code, 0, discovery.stderr);
  assert.equal(JSON.parse(discovery.stdout).projectRoot, await fs.realpath(project));

  const preflight = await runCli(["project", "preflight", project], project, env);
  assert.equal(preflight.code, 1, preflight.stderr);
  assert.equal(JSON.parse(preflight.stdout).status, "error");
});
