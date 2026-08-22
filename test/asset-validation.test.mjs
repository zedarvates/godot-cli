import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

function buildGlb(document) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const chunk = Buffer.alloc(paddedLength, 0x20);
  json.copy(chunk);
  const glb = Buffer.alloc(12 + 8 + chunk.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(chunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(glb, 20);
  return glb;
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

test("static validation fingerprints the bounded local dependency closure", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(path.join(project, "mesh.bin"), Buffer.alloc(12, 7));
  await fs.writeFile(
    path.join(project, "texture.png"),
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ])
  );
  await fs.writeFile(
    path.join(project, "model.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "mesh.bin", byteLength: 12 }],
      images: [{ uri: "texture.png", mimeType: "image/png" }],
    }),
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://model.gltf",
    env: {},
  });

  assert.equal(report.status, "ok");
  assert.deepEqual(
    report.closure.files.map((file) => [file.resourcePath, file.kind]),
    [
      ["res://model.gltf", "root"],
      ["res://mesh.bin", "buffer"],
      ["res://texture.png", "image"],
    ]
  );
  assert.equal(report.closure.fileCount, 3);
  assert.equal(report.metrics.declaredBufferBytes, 12);
});

test("static validation rejects non-local and escaping dependency URIs", async (t) => {
  const project = await createProject(t);
  const uris = [
    "https://host/a.bin",
    "//host/a.bin",
    "file:///a.bin",
    "data:application/octet-stream;base64,AA==",
    "/absolute.bin",
    "C:\\absolute.bin",
    "../outside.bin",
    "%2e%2e/outside.bin",
  ];

  for (const [index, uri] of uris.entries()) {
    const name = `forbidden-${index}.gltf`;
    await fs.writeFile(
      path.join(project, name),
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri, byteLength: 1 }],
      }),
      "utf8"
    );
    const report = await validateAsset({
      project,
      asset: `res://${name}`,
      env: {},
    });
    assert.equal(report.status, "error", uri);
    assert.ok(
      report.findings.some((finding) => finding.code === "ASSET_URI_FORBIDDEN"),
      uri
    );
    assert.equal(report.closure.fileCount, 1, uri);
  }
});

test("static validation rejects out-of-range glTF indices at stable locations", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "indices.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 1,
      scenes: [{ nodes: [1] }],
      nodes: [{ mesh: 1 }],
      meshes: [{ primitives: [{ indices: 1, material: 1 }] }],
      accessors: [{}],
      materials: [{}],
      textures: [{ source: 1, sampler: 1 }],
      images: [{}],
      samplers: [{}],
    }),
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://indices.gltf",
    env: {},
  });

  assert.equal(report.status, "error");
  assert.deepEqual(
    report.findings
      .filter((finding) => finding.code === "ASSET_REFERENCE_OUT_OF_RANGE")
      .map((finding) => finding.location),
    [
      "/meshes/0/primitives/0/indices",
      "/meshes/0/primitives/0/material",
      "/nodes/0/mesh",
      "/scene",
      "/scenes/0/nodes/0",
      "/textures/0/sampler",
      "/textures/0/source",
    ]
  );
});

test("static validation reads bounded PNG and JPEG dimensions without decoding pixels", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "two-by-three.png"),
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ])
  );
  await fs.writeFile(
    path.join(project, "four-by-five.jpg"),
    Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05,
      0x00, 0x04, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ])
  );
  await fs.writeFile(
    path.join(project, "images.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      images: [
        { uri: "two-by-three.png", mimeType: "image/png" },
        { uri: "four-by-five.jpg", mimeType: "image/jpeg" },
      ],
    }),
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://images.gltf",
    env: {},
  });

  assert.equal(report.status, "ok");
  assert.deepEqual(report.images, [
    {
      resourcePath: "res://two-by-three.png",
      mimeType: "image/png",
      width: 2,
      height: 3,
    },
    {
      resourcePath: "res://four-by-five.jpg",
      mimeType: "image/jpeg",
      width: 4,
      height: 5,
    },
  ]);
});

test("static validation derives triangle-list metrics from accessor counts", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "triangles.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      accessors: [{ count: 4 }, { count: 6 }],
      meshes: [
        {
          primitives: [
            { mode: 4, attributes: { POSITION: 0 }, indices: 1 },
          ],
        },
      ],
    }),
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://triangles.gltf",
    env: {},
  });

  assert.equal(report.status, "ok");
  assert.deepEqual(report.metrics.primitiveModes, { "4": 1 });
  assert.deepEqual(report.metrics.triangles, { value: 2, reason: null });
});

test("static validation accepts a strictly framed GLB 2.0 JSON chunk", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "model.glb"),
    buildGlb({ asset: { version: "2.0" }, scenes: [{}] })
  );

  const report = await validateAsset({
    project,
    asset: "res://model.glb",
    env: {},
  });

  assert.equal(report.status, "ok");
  assert.equal(report.format, "glb");
  assert.equal(report.metrics.scenes, 1);
  assert.equal(report.closure.fileCount, 1);
  assert.equal(report.integrity.unchanged, true);
});

test("versioned asset policy enforces measured limits without default VR claims", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "model.gltf"),
    JSON.stringify({
      asset: { version: "2.0" },
      meshes: [{ primitives: [] }],
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(project, "asset-policy.json"),
    JSON.stringify({
      schema: "uo-godot-asset-policy/1",
      max_meshes: 0,
    }),
    "utf8"
  );

  const report = await validateAsset({
    project,
    asset: "res://model.gltf",
    policy: "res://asset-policy.json",
    env: {},
  });

  assert.equal(report.status, "error");
  assert.deepEqual(report.policy, {
    resourcePath: "res://asset-policy.json",
    schema: "uo-godot-asset-policy/1",
    passed: false,
  });
  assert.ok(
    report.findings.some((finding) => finding.code === "ASSET_POLICY_LIMIT")
  );
});

test("GLB validation rejects ambiguous framing with a stable error code", async (t) => {
  const project = await createProject(t);
  const wrongMagic = buildGlb({ asset: { version: "2.0" } });
  wrongMagic.writeUInt32LE(0, 0);
  const wrongLength = buildGlb({ asset: { version: "2.0" } });
  wrongLength.writeUInt32LE(wrongLength.length + 4, 8);
  const unknownChunk = buildGlb({ asset: { version: "2.0" } });
  unknownChunk.writeUInt32LE(0x12345678, 16);

  for (const [name, bytes] of [
    ["wrong-magic.glb", wrongMagic],
    ["wrong-length.glb", wrongLength],
    ["unknown-chunk.glb", unknownChunk],
  ]) {
    await fs.writeFile(path.join(project, name), bytes);
    const report = await validateAsset({ project, asset: `res://${name}`, env: {} });
    assert.equal(report.status, "error", name);
    assert.equal(report.findings[0].code, "ASSET_GLB_INVALID", name);
    assert.equal(report.integrity.unchanged, true, name);
  }
});

test("asset policy rejects unknown fields and inconsistent collision requirements", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "model.gltf"),
    JSON.stringify({ asset: { version: "2.0" } }),
    "utf8"
  );
  const policies = [
    { schema: "uo-godot-asset-policy/1", surprise: true },
    {
      schema: "uo-godot-asset-policy/1",
      require_collision_nodes: true,
      require_godot_import: false,
    },
  ];

  for (const [index, policy] of policies.entries()) {
    const name = `invalid-policy-${index}.json`;
    await fs.writeFile(path.join(project, name), JSON.stringify(policy), "utf8");
    const report = await validateAsset({
      project,
      asset: "res://model.gltf",
      policy: `res://${name}`,
      env: {},
    });
    assert.equal(report.status, "error", name);
    assert.ok(
      report.findings.some((finding) => finding.code === "ASSET_POLICY_INVALID"),
      name
    );
  }
});

test("asset validate CLI emits JSON and preserves validation exit status", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "good.gltf"),
    JSON.stringify({ asset: { version: "2.0" } }),
    "utf8"
  );
  await fs.writeFile(path.join(project, "bad.gltf"), "{", "utf8");

  const good = await runCli([
    "asset",
    "validate",
    "res://good.gltf",
    "--project",
    project,
  ]);
  assert.equal(good.code, 0, `${good.stdout}\n${good.stderr}`);
  assert.equal(good.stderr, "");
  assert.equal(JSON.parse(good.stdout).status, "ok");

  const bad = await runCli([
    "asset",
    "validate",
    "res://bad.gltf",
    "--project",
    project,
  ]);
  assert.equal(bad.code, 1, `${bad.stdout}\n${bad.stderr}`);
  assert.equal(bad.stderr, "");
  assert.equal(JSON.parse(bad.stdout).status, "error");
});
