import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveGodotExecutable } from "../dist/runtime.js";
import { listTestProfiles, runTestProfile } from "../dist/test-runner.js";

const execFileAsync = promisify(execFile);

async function findGodot47(context) {
  let executable;
  try {
    executable = await resolveGodotExecutable();
  } catch (error) {
    context.skip(error instanceof Error ? error.message : String(error));
    return null;
  }
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 5000,
      windowsHide: true,
    });
    const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/)[0] ?? "";
    if (!/^4\.7(?:\.|\s|$)/.test(version)) {
      context.skip(`Godot 4.7 required; found '${version || "unknown"}'`);
      return null;
    }
  } catch (error) {
    context.skip(`Cannot query Godot: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return executable;
}

test("test run executes a real Godot 4.7 script profile headlessly", async (t) => {
  const godot = await findGodot47(t);
  if (!godot) return;

  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-test-godot-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, "Tests"));
  await fs.writeFile(
    path.join(project, "project.godot"),
    'config_version=5\n\n[application]\nconfig/name="Godot Test Profile"\nconfig/features=PackedStringArray("4.7", "Forward Plus")\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(project, "Tests", "profile_smoke.gd"),
    `extends SceneTree

func _initialize() -> void:
    print("UO_TEST_PROFILE_GODOT_47_OK")
    quit(0)
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(project, ".uo-godot-tests.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        profiles: [
          {
            id: "godot-smoke",
            description: "Real Godot 4.7 headless script smoke test",
            runner: "godot_script",
            entry: "res://Tests/profile_smoke.gd",
            args: [],
            timeoutSeconds: 30,
            tags: ["godot", "smoke"],
          },
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const catalog = await listTestProfiles({ project, godot });
  assert.equal(catalog.profiles[0].availability.available, true);
  assert.match(catalog.profiles[0].availability.godotVersion, /^4\.7/);

  const report = await runTestProfile({
    profile: "godot-smoke",
    project,
    godot,
  });
  assert.equal(report.status, "ok", report.output.stderrTail);
  assert.equal(report.passed, true);
  assert.equal(report.process.exitCode, 0);
  assert.equal(report.diagnostics.errorCount, 0);
  assert.match(report.output.stdoutTail, /UO_TEST_PROFILE_GODOT_47_OK/);
  assert.deepEqual(report.command.args.slice(0, 6), [
    "--headless",
    "--xr-mode",
    "off",
    "--audio-driver",
    "Dummy",
    "--path",
  ]);
});
