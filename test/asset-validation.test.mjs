import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_ASSET_FILE_BYTES,
  validateAsset,
} from "../dist/asset-validation.js";

async function createProject(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-asset-unit-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, "project.godot"),
    'config_version=5\n\n[application]\nconfig/name="Asset Unit"\n',
    "utf8"
  );
  return root;
}

test("static validation accepts a minimal project-local glTF 2.0 asset", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "model.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0] }],
      nodes: [{}],
      scene: 0,
    }),
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://model.gltf",
    env: {},
  });

  assert.equal(report.status, "ok");
  assert.equal(report.valid, true);
  assert.equal(report.complete, true);
  assert.equal(report.format, "gltf");
  assert.equal(report.proof.static.status, "ok");
  assert.equal(report.proof.godotImport.status, "not_requested");
  assert.deepEqual(report.metrics, {
    scenes: 1,
    nodes: 1,
    meshes: 0,
    primitives: 0,
    materials: 0,
    textures: 0,
    images: 0,
    samplers: 0,
    skins: 0,
    animations: 0,
    accessors: 0,
    declaredBufferBytes: 0,
    primitiveModes: {},
    triangles: { value: 0, reason: null },
  });
  assert.equal(report.closure.fileCount, 1);
  assert.equal(report.images.length, 0);
  assert.equal(report.evidence.lod.status, "unknown");
  assert.equal(report.evidence.collision.status, "unknown");
  assert.equal(report.integrity.unchanged, true);
});

test("asset root resolution rejects traversal and unsupported extensions before parsing", async (t) => {
  const project = await createProject(t);

  await assert.rejects(
    () =>
      validateAsset({
        project,
        asset: "res://../outside.gltf",
        env: {},
      }),
    /must stay inside/
  );
  await assert.rejects(
    () =>
      validateAsset({
        project,
        asset: "res://model.obj",
        env: {},
      }),
    /only \.gltf or \.glb/
  );
});

test("asset root resolution rejects oversized files before reading them", async (t) => {
  const project = await createProject(t);
  const asset = path.join(project, "huge.gltf");
  await fs.writeFile(asset, "{}", "utf8");
  await fs.truncate(asset, MAX_ASSET_FILE_BYTES + 1);

  await assert.rejects(
    () => validateAsset({ project, asset: "res://huge.gltf", env: {} }),
    /exceeds the .* validation limit/
  );
});

test("static validation reports malformed and unsupported glTF JSON", async (t) => {
  const project = await createProject(t);
  const cases = [
    ["malformed.gltf", "{", /JSON/],
    ["legacy.gltf", JSON.stringify({ asset: { version: "1.0" } }), /version "2\.0"/],
    ["bom.gltf", `\ufeff${JSON.stringify({ asset: { version: "2.0" } })}`, /UTF-8 BOM/],
    [
      "dangerous.gltf",
      '{"asset":{"version":"2.0"},"__proto__":{"polluted":true}}',
      /forbidden key/,
    ],
  ];

  for (const [name, contents, expected] of cases) {
    await fs.writeFile(path.join(project, name), contents, "utf8");
    const report = await validateAsset({
      project,
      asset: `res://${name}`,
      env: {},
    });
    assert.equal(report.status, "error", name);
    assert.equal(report.valid, false, name);
    assert.equal(report.complete, true, name);
    assert.equal(report.proof.static.status, "error", name);
    assert.equal(report.findings[0].code, "ASSET_GLTF_INVALID", name);
    assert.match(report.findings[0].message, expected, name);
    assert.equal(report.integrity.unchanged, true, name);
  }
});

test("static validation bounds JSON nesting", async (t) => {
  const project = await createProject(t);
  let nested = "0";
  for (let depth = 0; depth < 70; depth += 1) nested = `[${nested}]`;
  await fs.writeFile(
    path.join(project, "deep.gltf"),
    `{"asset":{"version":"2.0"},"extras":${nested}}`,
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://deep.gltf",
    env: {},
  });
  assert.equal(report.status, "error");
  assert.match(report.findings[0].message, /depth limit/);
  assert.equal(report.integrity.unchanged, true);
});
