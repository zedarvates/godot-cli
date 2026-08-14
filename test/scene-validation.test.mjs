import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_SCENE_VALIDATION_BYTES,
  analyzeGodotLog,
  validateSceneFile,
} from "../dist/scene-validation.js";

async function createProject(context) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "uo-scene-unit-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(project, "project.godot"),
    'config_version=5\n\n[application]\nconfig/name="Scene Unit"\n',
    "utf8"
  );
  return project;
}

test("Godot log analysis classifies hard errors and reports truncation", () => {
  const report = analyzeGodotLog(
    [
      "Godot Engine v4.7.dev5",
      "\u001b[31mSCRIPT ERROR: Parse Error: Expected closing parenthesis\u001b[0m",
      "ERROR: Failed to load script res://broken.gd",
      "WARNING: Camera is not current",
      "ordinary text containing the word error without Godot formatting",
    ],
    {
      logPath: "runtime.log",
      totalBytes: 4096,
      bytesRead: 1024,
      truncatedByBytes: true,
    }
  );

  assert.equal(report.available, true);
  assert.equal(report.complete, false);
  assert.equal(report.errorCount, 2);
  assert.deepEqual(
    report.diagnostics.map((entry) => entry.category),
    ["script_error", "resource_error"]
  );
  assert.equal(report.warningCount, 1);
  assert.equal(report.truncatedByBytes, true);
});

test("scene validation rejects paths outside the project before launching Godot", async (t) => {
  const project = await createProject(t);

  await assert.rejects(
    () => validateSceneFile({
      project,
      scene: "res://../outside.tscn",
      env: {},
    }),
    /must stay inside/
  );
  await assert.rejects(
    () => validateSceneFile({
      project,
      scene: "res://notes.txt",
      env: {},
    }),
    /only \.tscn or \.scn/
  );
});

test("scene validation refuses oversized scene files without reading them", async (t) => {
  const project = await createProject(t);
  const scene = path.join(project, "Huge.tscn");
  await fs.writeFile(scene, "[gd_scene format=3]\n", "utf8");
  await fs.truncate(scene, MAX_SCENE_VALIDATION_BYTES + 1);

  await assert.rejects(
    () => validateSceneFile({
      project,
      scene: "res://Huge.tscn",
      env: {},
    }),
    /exceeds the .* validation limit/
  );
});
