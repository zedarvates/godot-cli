import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const NPM_CLI = process.env.npm_execpath;

function runProcess(executable, args, cwd, env = process.env) {
  try {
    return execFileSync(executable, args, {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const stdout = error?.stdout?.toString().trim() ?? "";
    const stderr = error?.stderr?.toString().trim() ?? "";
    const details = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      `${path.basename(executable)} ${args.join(" ")} failed${
        details ? `:\n${details}` : ""
      }`,
      { cause: error }
    );
  }
}

function runNpm(args, cwd) {
  assert.ok(NPM_CLI, "npm_execpath is required for the package consumer test");
  return runProcess(process.execPath, [NPM_CLI, ...args], cwd, {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });
}

function packPackage(packageDirectory, destination) {
  const output = runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    packageDirectory
  );
  const records = JSON.parse(output);
  assert.equal(records.length, 1, "npm pack must produce exactly one archive");
  return path.join(destination, records[0].filename);
}

function runInstalledCli(cliPath, args, cwd) {
  const env = { ...process.env };
  delete env.GODOT_CLI_TOKEN;
  return runProcess(process.execPath, [cliPath, ...args], cwd, env);
}

test("packed CLI installs and manages its addon outside the source tree", async (t) => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "uo-godot-cli-consumer-")
  );
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));

  const sourceManifest = JSON.parse(
    await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")
  );
  assert.equal(typeof sourceManifest.dependencies?.commander, "string");

  const cliArchive = packPackage(PACKAGE_ROOT, temporaryRoot);
  const commanderArchive = packPackage(
    path.join(PACKAGE_ROOT, "node_modules", "commander"),
    temporaryRoot
  );

  const consumer = path.join(temporaryRoot, "consumer");
  const project = path.join(temporaryRoot, "godot-project");
  await fs.mkdir(consumer);
  await fs.mkdir(project);

  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "--package-lock=false",
      commanderArchive,
      cliArchive,
    ],
    consumer
  );

  const installedPackage = path.join(
    consumer,
    "node_modules",
    "@ultimate-odycer",
    "godot-runtime-cli"
  );
  const installedManifest = JSON.parse(
    await fs.readFile(path.join(installedPackage, "package.json"), "utf8")
  );
  assert.equal(installedManifest.name, sourceManifest.name);
  assert.equal(installedManifest.version, sourceManifest.version);
  assert.deepEqual(installedManifest.dependencies, sourceManifest.dependencies);
  assert.equal(installedManifest.bin?.["uo-godot-cli"], "dist/cli.js");
  assert.match(
    await fs.readFile(path.join(installedPackage, "LICENSE"), "utf8"),
    /^MIT License\r?\n/
  );

  const cliPath = path.join(installedPackage, "dist", "cli.js");
  assert.equal(
    runInstalledCli(cliPath, ["--version"], consumer),
    sourceManifest.version
  );

  const projectDefinition = `config_version=5

[application]
config/name="Package Consumer Test"
`;
  const projectFile = path.join(project, "project.godot");
  await fs.writeFile(projectFile, projectDefinition, "utf8");

  const registry = path.join(temporaryRoot, "template-registry");
  const schemaResource =
    "templates/schemas/template-contract/v1.0.0/schema.json";
  const schema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ultimateodycer.com/schemas/template-contract/1.0.0",
    type: "object",
    required: [
      "$schema", "contract_version", "id", "slug", "family", "version",
      "authority", "intended_consumers", "compatibility", "dependencies",
      "spec_checksum", "spec",
    ],
    properties: {},
    additionalProperties: false,
  });
  const schemaFile = path.join(registry, ...schemaResource.split("/"));
  await fs.mkdir(path.dirname(schemaFile), { recursive: true });
  await fs.writeFile(schemaFile, schema, "utf8");
  const catalogFile = path.join(registry, "templates", "catalog.json");
  await fs.mkdir(path.dirname(catalogFile), { recursive: true });
  await fs.writeFile(
    catalogFile,
    JSON.stringify({
      registry_version: "2.0.0",
      generated_at: "2026-08-23",
      source_set: "package-consumer",
      entries: [
        {
          name: "template-contract",
          kind: "json-schema",
          version: "1.0.0",
          status: "experimental",
          file: schemaResource,
          sha256: createHash("sha256").update(schema).digest("hex"),
          compatibility: [],
          validation_profile: "strict-schema-v1",
          contract_version: "1.0.0",
        },
      ],
      aliases: [],
    }),
    "utf8"
  );
  const registryReport = JSON.parse(
    runInstalledCli(
      cliPath,
      ["template", "registry", "inspect", registry],
      consumer
    )
  );
  assert.equal(registryReport.status, "ok");
  assert.equal(registryReport.complete, true);
  assert.equal(registryReport.consumerReady, false);

  const before = JSON.parse(
    runInstalledCli(cliPath, ["addon", "status", project], consumer)
  );
  assert.equal(before.installed, false);
  assert.equal(before.matchesBundled, false);

  const dryRun = JSON.parse(
    runInstalledCli(
      cliPath,
      ["addon", "install", project, "--dry-run"],
      consumer
    )
  );
  assert.equal(dryRun.action, "would_install");
  await assert.rejects(() => fs.access(dryRun.targetAddon), /ENOENT/);

  const installed = JSON.parse(
    runInstalledCli(cliPath, ["addon", "install", project], consumer)
  );
  assert.equal(installed.action, "installed");
  assert.equal(installed.matchesBundled, true);
  assert.equal(installed.pluginEnabled, false);
  assert.equal(installed.autoloadEnabled, false);
  assert.equal(await fs.readFile(projectFile, "utf8"), projectDefinition);

  const after = JSON.parse(
    runInstalledCli(cliPath, ["addon", "status", project], consumer)
  );
  assert.equal(after.installed, true);
  assert.equal(after.matchesBundled, true);
  assert.deepEqual(after.modifiedFiles, []);
  assert.deepEqual(after.missingFiles, []);

  const unchanged = JSON.parse(
    runInstalledCli(cliPath, ["addon", "install", project], consumer)
  );
  assert.equal(unchanged.action, "unchanged");
});
