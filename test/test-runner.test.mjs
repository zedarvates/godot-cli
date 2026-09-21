import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_TEST_OUTPUT_BYTES,
  listTestProfiles,
  runTestProfile,
} from "../dist/test-runner.js";

async function createProject(context, profiles = []) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-test-catalog-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(project, "project.godot"),
    'config_version=5\n\n[application]\nconfig/name="Test Catalog"\nconfig/features=PackedStringArray("4.7")\n',
    "utf8"
  );
  await fs.mkdir(path.join(project, "Tests"));
  if (profiles !== null) {
    await fs.writeFile(
      path.join(project, ".uo-godot-tests.json"),
      JSON.stringify({ schemaVersion: 1, profiles }, null, 2) + "\n",
      "utf8"
    );
  }
  return project;
}

async function writeNodeFixture(project, name, source) {
  const target = path.join(project, "Tests", name);
  await fs.writeFile(target, source, "utf8");
  return `res://Tests/${name}`;
}

function pythonProfile(entry, overrides = {}) {
  return {
    id: "unit-pass",
    description: "Bounded local fixture",
    runner: "python",
    entry,
    args: [],
    timeoutSeconds: 10,
    tags: ["unit"],
    ...overrides,
  };
}

function testEnvironment(extra = {}) {
  return {
    ...process.env,
    PYTHON_BIN: process.execPath,
    ...extra,
  };
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

test("test list reports an absent manifest without executing anything", async (t) => {
  const project = await createProject(t, null);

  const report = await listTestProfiles({
    project,
    env: testEnvironment(),
  });

  assert.equal(report.status, "ok");
  assert.equal(report.configured, false);
  assert.deepEqual(report.profiles, []);
  assert.match(report.warnings[0], /absent/);
});

test("test list validates and reports an available project profile", async (t) => {
  const project = await createProject(t);
  const entry = await writeNodeFixture(project, "pass.py", 'console.log("PASS_MARKER");\n');
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      { schemaVersion: 1, profiles: [pythonProfile(entry)] },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const report = await listTestProfiles({ project, env: testEnvironment() });

  assert.equal(report.configured, true);
  assert.equal(report.profiles.length, 1);
  assert.equal(report.profiles[0].availability.available, true);
  assert.equal(report.profiles[0].availability.executable, await fs.realpath(process.execPath));
  assert.match(report.manifestSha256, /^[a-f0-9]{64}$/);
});

test("test run executes only the declared entry with a sanitized environment", async (t) => {
  const project = await createProject(t);
  const entry = await writeNodeFixture(
    project,
    "pass.py",
    `if (process.env.GODOT_CLI_TOKEN) process.exit(19);
if (process.env.UO_GODOT_CLI_ALLOW_UNSAFE) process.exit(20);
console.log("PASS_MARKER=" + process.env.CI);
`
  );
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      { schemaVersion: 1, profiles: [pythonProfile(entry)] },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const report = await runTestProfile({
    profile: "unit-pass",
    project,
    env: testEnvironment({
      GODOT_CLI_TOKEN: "must-not-cross-process-boundary",
      UO_GODOT_CLI_ALLOW_UNSAFE: "1",
    }),
  });

  assert.equal(report.status, "ok");
  assert.equal(report.passed, true);
  assert.equal(report.complete, true);
  assert.equal(report.command.shell, false);
  assert.match(report.output.stdoutTail, /PASS_MARKER=1/);
  assert.equal(report.evidence.manifestUnchanged, true);
  assert.equal(report.evidence.entryUnchanged, true);
  assert.equal(report.evidence.projectMutationAudit, "not_performed");
});

test("test run preserves the profile failure exit code", async (t) => {
  const project = await createProject(t);
  const entry = await writeNodeFixture(
    project,
    "fail.py",
    'console.log("[ERREUR] broken contract");\nconsole.log("[AVERT ] review fixture");\nprocess.exit(7);\n'
  );
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        profiles: [pythonProfile(entry, { id: "unit-fail" })],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const report = await runTestProfile({
    profile: "unit-fail",
    project,
    env: testEnvironment(),
  });

  assert.equal(report.status, "error");
  assert.equal(report.passed, false);
  assert.equal(report.complete, true);
  assert.equal(report.process.exitCode, 7);
  assert.equal(report.diagnostics.errorCount, 1);
  assert.equal(report.diagnostics.warningCount, 1);
});

test("test run stops an owned child when its output exceeds the fixed cap", async (t) => {
  const project = await createProject(t);
  const entry = await writeNodeFixture(
    project,
    "noisy.py",
    `process.stdout.write("x".repeat(${MAX_TEST_OUTPUT_BYTES + 4096}));
setInterval(() => {}, 1000);
`
  );
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        profiles: [pythonProfile(entry, { id: "unit-noisy" })],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const report = await runTestProfile({
    profile: "unit-noisy",
    project,
    env: testEnvironment(),
  });

  assert.equal(report.status, "error");
  assert.equal(report.complete, false);
  assert.equal(report.process.outputLimitExceeded, true);
  assert.equal(report.output.capturedBytes, MAX_TEST_OUTPUT_BYTES);
  assert.equal(report.output.reportedOutputTruncated, true);
});

test("test manifests fail closed on traversal, unknown fields, and unknown profiles", async (t) => {
  const traversalProject = await createProject(t, [
    pythonProfile("res://../escape.py"),
  ]);
  await assert.rejects(
    () => listTestProfiles({ project: traversalProject, env: testEnvironment() }),
    /must stay inside/
  );

  const unknownFieldProject = await createProject(t, [
    { ...pythonProfile("res://Tests/pass.py"), command: "arbitrary" },
  ]);
  await assert.rejects(
    () => listTestProfiles({ project: unknownFieldProject, env: testEnvironment() }),
    /unsupported field 'command'/
  );

  const project = await createProject(t, []);
  await assert.rejects(
    () => runTestProfile({ profile: "missing", project, env: testEnvironment() }),
    /Unknown test profile/
  );
});

test("test run rejects timeout expansion beyond the manifest contract", async (t) => {
  const project = await createProject(t);
  const entry = await writeNodeFixture(project, "pass.py", "process.exit(0);\n");
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      { schemaVersion: 1, profiles: [pythonProfile(entry)] },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await assert.rejects(
    () =>
      runTestProfile({
        profile: "unit-pass",
        project,
        env: testEnvironment(),
        timeoutSeconds: 11,
      }),
    /cannot exceed the profile limit of 10 seconds/
  );
});

test("test list and test run expose machine-readable CLI results", async (t) => {
  const project = await createProject(t);
  const entry = await writeNodeFixture(project, "pass.py", 'console.log("CLI_PASS");\n');
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      { schemaVersion: 1, profiles: [pythonProfile(entry)] },
      null,
      2
    ) + "\n",
    "utf8"
  );
  const env = testEnvironment();

  const listed = await runCli(["test", "list", project], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).profiles[0].id, "unit-pass");

  const executed = await runCli(["test", "run", "unit-pass", project], env);
  assert.equal(executed.code, 0, executed.stderr);
  const report = JSON.parse(executed.stdout);
  assert.equal(report.passed, true);
  assert.match(report.output.stdoutTail, /CLI_PASS/);
});
