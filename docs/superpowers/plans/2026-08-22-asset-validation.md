# Asset Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, bounded `uo-godot-cli asset validate` command for project-local `.gltf` and `.glb` assets, with optional policy enforcement and isolated Godot import proof.

**Architecture:** Keep all static parsing and report assembly in `asset-validation.ts`; isolate child-process and disposable-project behavior in `asset-import.ts`. The CLI remains a read-only orchestration surface and never loads the asset into the canonical project. Static, policy, Godot-import, integrity, and cleanup evidence remain separate in the JSON report.

**Tech Stack:** TypeScript ES2022, Node.js built-ins, Commander 13, Node test runner, Godot 4.7.x for the optional real import gate.

**Spec:** `docs/superpowers/specs/2026-08-22-asset-validation-design.md`

## Global Constraints

- Default operation is local, read-only, loopback-independent, and performs no network access.
- Accept only one regular project-local `res://` `.gltf` or `.glb` file; reject symlinks and traversal.
- Built-in limits are 256 closure files, 512 MiB total source bytes, and 256 MiB per file.
- Reject absolute, network, protocol-relative, file, data, traversal, and symlinked dependency URIs.
- Static validation always runs; requested Godot import failure or incomplete cleanup fails closed.
- Godot import runs only in a disposable project with XR disabled and without CLI tokens or mutation gates.
- No default headset-performance budget is invented; performance limits require `uo-godot-asset-policy/1`.
- Never claim GPU, VRAM, rendered quality, collision quality, foveation, stereo, or OpenXR proof.
- Add success and rejection tests before every production behavior.
- Preserve all unrelated dirty files and never stage them.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/asset-validation.ts` | Resolve input, parse glTF/GLB, close dependencies, compute fingerprints/metrics, enforce policy, assemble deterministic report. |
| `src/asset-import.ts` | Copy an already validated closure into a disposable Godot project, execute bounded import/probe processes, parse logs, clean up. |
| `src/cli.ts` | Register `asset validate`, validate numeric CLI options, print JSON, map report status to exit code. |
| `test/asset-validation.test.mjs` | Static parser, closure, policy, limits, determinism, and integrity behavior. |
| `test/asset-import-godot.test.mjs` | Real Godot isolated import, collision evidence, source preservation, and cleanup. |
| `test/package-consumer.test.mjs` | Verify packaged CLI exposes and executes the static command. |
| `README.md` | User contract, examples, proof boundaries, validation evidence. |
| `SECURITY.md` | URI, resource, child-environment, temporary-project, and cleanup boundaries. |
| `CHANGELOG.md` | Unreleased feature entry without runtime/VR overclaim. |

---

### Task 1: Static `.gltf` root validation and stable report

**Files:**
- Create: `src/asset-validation.ts`
- Create: `test/asset-validation.test.mjs`

**Interfaces:**
- Produces: `validateAsset(options: AssetValidationOptions): Promise<AssetValidationReport>`
- Produces: `MAX_ASSET_FILE_BYTES`, `MAX_ASSET_TOTAL_BYTES`, `MAX_ASSET_CLOSURE_FILES`
- Produces: `AssetClosureFile`, `AssetFinding`, `AssetMetrics`, `AssetValidationReport`
- Consumes: `discoverProject()` from `src/project.ts`

- [ ] **Step 1: Write the failing minimal `.gltf` test**

Create `test/asset-validation.test.mjs` with a temporary Godot project, one
minimal glTF document, and exact report assertions:

```js
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAsset } from "../dist/asset-validation.js";

async function createProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-asset-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "project.godot"), "config_version=5\n", "utf8");
  return root;
}

test("static validation accepts a minimal project-local glTF 2.0 asset", async (t) => {
  const project = await createProject(t);
  await fs.writeFile(
    path.join(project, "model.gltf"),
    JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [0] }], nodes: [{}], scene: 0 }),
    "utf8"
  );

  const report = await validateAsset({ project, asset: "res://model.gltf", env: {} });

  assert.equal(report.status, "ok");
  assert.equal(report.valid, true);
  assert.equal(report.complete, true);
  assert.equal(report.format, "gltf");
  assert.equal(report.proof.static.status, "ok");
  assert.equal(report.proof.godotImport.status, "not_requested");
  assert.deepEqual(report.metrics, {
    scenes: 1, nodes: 1, meshes: 0, primitives: 0, materials: 0,
    textures: 0, images: 0, samplers: 0, skins: 0, animations: 0,
    accessors: 0, declaredBufferBytes: 0, primitiveModes: {},
    triangles: { value: 0, reason: null }
  });
  assert.equal(report.closure.fileCount, 1);
  assert.equal(report.integrity.unchanged, true);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
```

Expected: the test fails because `dist/asset-validation.js` does not exist.

- [ ] **Step 3: Implement the public report types and safe root resolver**

Create `src/asset-validation.ts` with these exact public contracts:

```ts
export const MAX_ASSET_CLOSURE_FILES = 256;
export const MAX_ASSET_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_ASSET_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_ASSET_FINDINGS = 256;
export const MAX_ASSET_JSON_DEPTH = 64;
export const MAX_ASSET_JSON_STRING_BYTES = 1024 * 1024;
export const MAX_ASSET_JSON_ARRAY_ITEMS = 1_000_000;

export interface AssetValidationOptions {
  asset: string;
  project?: string;
  policy?: string;
  godotImport?: boolean;
  godot?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface AssetFinding {
  severity: "error" | "warning";
  code: string;
  location: string;
  message: string;
}

export interface AssetClosureFile {
  resourcePath: string;
  bytes: number;
  sha256: string;
  kind: "root" | "buffer" | "image";
}

export interface AssetMetrics {
  scenes: number;
  nodes: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  images: number;
  samplers: number;
  skins: number;
  animations: number;
  accessors: number;
  declaredBufferBytes: number;
  primitiveModes: Record<string, number>;
  triangles: { value: number | null; reason: string | null };
}

export interface AssetImageMetadata {
  resourcePath: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
}

export interface AssetValidationReport {
  status: "ok" | "error";
  valid: boolean;
  complete: boolean;
  asset: string;
  projectRoot: string;
  format: "gltf" | "glb";
  proof: {
    static: { status: "ok" | "error"; complete: boolean };
    godotImport: { status: "ok" | "error" | "not_requested"; complete: boolean };
  };
  closure: { fileCount: number; totalBytes: number; files: AssetClosureFile[] };
  metrics: AssetMetrics;
  images: AssetImageMetadata[];
  evidence: {
    lod: { status: "unknown"; reason: string };
    collision: {
      status: "unknown" | "observed";
      collisionShapes: number | null;
      reason: string;
    };
  };
  policy: null | { resourcePath: string; schema: "uo-godot-asset-policy/1"; passed: boolean };
  findings: AssetFinding[];
  integrity: { unchanged: boolean };
  boundaries: string[];
}
```

Implement `resolveProjectFile()` so it requires `res://`, accepts only `.gltf`
or `.glb`, resolves through `path.relative`, calls `lstat` and `realpath`, rejects
symlinks/non-files, and enforces `MAX_ASSET_FILE_BYTES` before reading. Reuse
`discoverProject()` for nearest-project behavior.

- [ ] **Step 4: Implement bounded JSON parsing and minimal metrics**

Use `fs.open()` plus a size-checked read, reject a UTF-8 BOM, parse JSON, require
a non-array object, `asset.version === "2.0"`, and finite JSON numbers. Walk the
parsed value iteratively before semantic parsing: reject depth above
`MAX_ASSET_JSON_DEPTH`, any UTF-8 string above
`MAX_ASSET_JSON_STRING_BYTES`, any array above
`MAX_ASSET_JSON_ARRAY_ITEMS`, dangerous keys `__proto__`, `prototype`, and
`constructor`, and more than 1,000,000 total visited values. Count only arrays
present on the root; compute primitive count by summing each
`meshes[*].primitives.length`. Sort findings by `code`, then `location`, then
`message`. Fingerprint the root before and after report assembly with SHA-256.

The minimal return must set `godotImport.status` to `not_requested`, initialize
`images` to an empty array, report LOD and collision evidence as `unknown` with
reasons, include the spec boundary sentence, and make `valid/complete/status`
depend on zero errors and unchanged source bytes.

- [ ] **Step 5: Add rejection tests for path, extension, size, and version**

Add separate tests asserting `assert.rejects()` for:

```js
await assert.rejects(
  () => validateAsset({ project, asset: "res://../outside.gltf", env: {} }),
  /must stay inside/
);
await assert.rejects(
  () => validateAsset({ project, asset: "res://model.obj", env: {} }),
  /only \.gltf or \.glb/
);
```

Also test a root symlink when the platform permits it, a file truncated to
`MAX_ASSET_FILE_BYTES + 1`, malformed JSON, `asset.version: "1.0"`, excessive
nesting, excessive string/array size, dangerous keys, non-finite numeric input
through a focused unit helper, and the total visited-value bound.

- [ ] **Step 6: Run Task 1 tests and verify GREEN**

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
```

Expected: all Task 1 tests pass with no warnings or leaked temporary files.

- [ ] **Step 7: Commit Task 1 only**

```powershell
rtk git add -- src/asset-validation.ts test/asset-validation.test.mjs
rtk git commit -m "feat: add bounded static gltf validation" -- src/asset-validation.ts test/asset-validation.test.mjs
```

---

### Task 2: Dependency closure, reference validation, and deterministic metrics

**Files:**
- Modify: `src/asset-validation.ts`
- Modify: `test/asset-validation.test.mjs`

**Interfaces:**
- Consumes: `validateAsset`, report types, and safety constants from Task 1
- Produces: complete local buffer/image closure, topology/image metadata, and stable finding codes
- Produces finding codes: `ASSET_URI_FORBIDDEN`, `ASSET_DEPENDENCY_MISSING`, `ASSET_DEPENDENCY_SYMLINK`, `ASSET_REFERENCE_OUT_OF_RANGE`, `ASSET_LIMIT_EXCEEDED`

- [ ] **Step 1: Write failing closure success and URL/traversal rejection tests**

Add a fixture with `mesh.bin` and `texture.png`, then assert:

```js
assert.deepEqual(
  report.closure.files.map((file) => file.resourcePath),
  ["res://model.gltf", "res://mesh.bin", "res://texture.png"]
);
assert.equal(report.closure.fileCount, 3);
assert.equal(report.metrics.declaredBufferBytes, 12);
```

Add table-driven invalid URIs for `https://host/a.bin`, `//host/a.bin`,
`file:///a.bin`, `data:application/octet-stream;base64,AA==`, `/absolute.bin`,
`C:\\absolute.bin`, and `../outside.bin`. Each must produce status `error` and
finding code `ASSET_URI_FORBIDDEN` without reading outside the project.

- [ ] **Step 2: Run the focused tests and verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="closure|URI" test/asset-validation.test.mjs
```

Expected: closure stays at one file or forbidden URIs are not reported with the
stable code.

- [ ] **Step 3: Implement normalized dependency closure**

Add internal functions with these signatures:

```ts
function decodeAndValidateUri(uri: string, owner: string): string;
async function resolveDependency(
  projectRoot: string,
  ownerAbsolutePath: string,
  uri: string,
  kind: "buffer" | "image"
): Promise<{ absolutePath: string; resourcePath: string; kind: "buffer" | "image" }>;
async function fingerprintClosure(
  root: ResolvedAsset,
  gltf: Record<string, unknown>
): Promise<AssetClosureFile[]>;
```

Reject forbidden schemes before percent-decoding, decode exactly once, reject
NUL and malformed escapes, normalize separators, resolve relative to the owner,
and repeat the project-containment, `lstat`, `realpath`, symlink, file-size, file
count, and total-size checks. Deduplicate by canonical absolute path but preserve
the most restrictive kind ordering `root`, `buffer`, `image`. Sort output by
`resourcePath`, with the root forced first.

- [ ] **Step 4: Write failing indexed-reference tests**

Create one test per relation: default scene to scenes, scene nodes to nodes,
node children/mesh/skin, primitive attributes/indices/material, texture source
and sampler, material texture indices, animation sampler/channel targets, skin
joints/skeleton/inverse bind matrices, accessor bufferView, and bufferView
buffer. A value equal to the target-array length must emit
`ASSET_REFERENCE_OUT_OF_RANGE` at the exact JSON pointer.

- [ ] **Step 5: Implement reference checks and portable metrics**

Add a typed `checkIndex(reference, targetLength, location, findings)` helper
that accepts only non-negative integers. Walk only the explicit relations listed
in Step 4. Reject non-array containers where glTF requires arrays. Count array
members and primitive modes. Sum finite non-negative `buffers[*].byteLength`
values with safe-integer overflow checks. Compute triangle counts only for
supported triangle-list/strip/fan primitives whose accessor counts and indexed
topology make the result deterministic; otherwise set `value: null` and a stable
reason. Never infer LOD from names.

- [ ] **Step 6: Write failing bounded image-metadata tests**

Add minimal PNG and JPEG dependencies with known dimensions. Assert exact MIME,
width, height, and normalized resource path. Add truncated, oversized-header,
embedded-buffer-view, and MIME/dependency mismatch cases; unsupported or unsafe
dimension parsing must return null dimensions plus a warning, never decode full
image pixels.

- [ ] **Step 7: Implement bounded PNG/JPEG header inspection**

Read at most 64 KiB per external image. For PNG, require signature and IHDR and
read unsigned big-endian width/height. For JPEG, scan bounded marker segments to
the first supported SOF marker while validating each segment length. Populate
`AssetImageMetadata[]` in glTF image order. Reject dimensions outside safe
integers; preserve unknown dimensions for buffer-view images in static mode.

- [ ] **Step 8: Verify dependency limits and deterministic output**

Add tests for 257 unique dependencies, an individual file above 256 MiB, total
closure above 512 MiB using sparse files, duplicate normalized paths, and two
consecutive reports whose closure, metrics, image metadata, evidence, findings,
and hashes deep-equal.

Run:

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
```

Expected: every static test passes.

- [ ] **Step 9: Commit Task 2 only**

```powershell
rtk git add -- src/asset-validation.ts test/asset-validation.test.mjs
rtk git commit -m "feat: validate gltf dependency closure" -- src/asset-validation.ts test/asset-validation.test.mjs
```

---

### Task 3: Strict `.glb` parsing and versioned policy enforcement

**Files:**
- Modify: `src/asset-validation.ts`
- Modify: `test/asset-validation.test.mjs`

**Interfaces:**
- Consumes: static report and finding infrastructure from Tasks 1-2
- Produces: `AssetPolicyV1` and strict GLB parsing
- Produces finding codes: `ASSET_GLB_INVALID`, `ASSET_POLICY_INVALID`, `ASSET_POLICY_LIMIT`, `ASSET_POLICY_REQUIRES_IMPORT`

- [ ] **Step 1: Write a failing valid-GLB test**

Add a test helper that pads JSON with spaces to four-byte alignment, writes the
12-byte GLB header plus one JSON chunk, and asserts the same metrics as the
equivalent `.gltf` report with `format === "glb"`.

- [ ] **Step 2: Run the GLB test and verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="GLB" test/asset-validation.test.mjs
```

Expected: parsing fails because Task 1 treated the file as JSON or rejected it.

- [ ] **Step 3: Implement exact GLB framing checks**

Add:

```ts
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

function parseGlb(bytes: Buffer): { json: Record<string, unknown>; binBytes: number };
```

Require magic, version `2`, declared length equal to actual length, four-byte
alignment, JSON as the first and unique JSON chunk, no more than one BIN chunk,
no unknown/trailing chunk, and valid UTF-8 JSON after removing only legal JSON
chunk padding. Check that buffer declarations without URI are compatible with
the single BIN chunk length.

- [ ] **Step 4: Add malformed-GLB rejection tests**

Cover wrong magic/version/length, truncated header, JSON not first, duplicate
JSON/BIN, unaligned chunk, unknown chunk, trailing bytes, invalid JSON, and a
declared internal buffer larger than the BIN chunk. Each returns an error report
with `ASSET_GLB_INVALID`; it must not throw after root path resolution succeeds.

- [ ] **Step 5: Write failing policy success and rejection tests**

Create `res://asset-policy.json` and call:

```js
const report = await validateAsset({
  project,
  asset: "res://model.gltf",
  policy: "res://asset-policy.json",
  env: {}
});
assert.equal(report.policy.schema, "uo-godot-asset-policy/1");
assert.equal(report.policy.passed, false);
assert.ok(report.findings.some((finding) => finding.code === "ASSET_POLICY_LIMIT"));
```

Test unknown keys, unsupported schema, negative/non-integer limits, a policy
outside the project, a symlinked policy, limits above built-in safety limits,
and `require_collision_nodes: true` without `require_godot_import: true`.

- [ ] **Step 6: Implement the closed policy schema**

Use this exact internal type:

```ts
interface AssetPolicyV1 {
  schema: "uo-godot-asset-policy/1";
  max_total_bytes?: number;
  max_meshes?: number;
  max_primitives?: number;
  max_materials?: number;
  max_textures?: number;
  max_image_dimension?: number;
  require_godot_import?: boolean;
  require_collision_nodes?: boolean;
}
```

Reject unknown fields. Require non-negative safe integers. Policies may tighten
but never raise built-in byte limits. Set `ASSET_POLICY_REQUIRES_IMPORT` when
the policy requires import but `godotImport` is false. Do not add default
performance thresholds.

- [ ] **Step 7: Run the entire static suite and verify GREEN**

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
```

Expected: all `.gltf`, closure, GLB, and policy tests pass.

- [ ] **Step 8: Commit Task 3 only**

```powershell
rtk git add -- src/asset-validation.ts test/asset-validation.test.mjs
rtk git commit -m "feat: add glb and asset policy validation" -- src/asset-validation.ts test/asset-validation.test.mjs
```

---

### Task 4: CLI command and packaged-consumer contract

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/package-consumer.test.mjs`
- Modify: `test/asset-validation.test.mjs`

**Interfaces:**
- Consumes: `validateAsset()` from Tasks 1-3
- Produces: `uo-godot-cli asset validate <asset>` command

- [ ] **Step 1: Write a failing CLI integration test**

Add a `runCli()` helper to `test/asset-validation.test.mjs` using
`spawn(process.execPath, ["dist/cli.js", ...args])`. Assert that:

```js
const result = await runCli([
  "asset", "validate", "res://model.gltf", "--project", project
]);
assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
assert.equal(JSON.parse(result.stdout).status, "ok");
assert.equal(result.stderr, "");
```

Also assert exit `1` and JSON status `error` for a structurally invalid but
readable glTF. Path/option usage errors may remain Commander errors on stderr.

- [ ] **Step 2: Run the CLI test and verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="CLI" test/asset-validation.test.mjs
```

Expected: Commander reports unknown command `asset`.

- [ ] **Step 3: Register the command in `src/cli.ts`**

Import `validateAsset`, then add next to scene validation:

```ts
const assetCommands = program
  .command("asset")
  .description("Validate bounded project-local Godot assets");

assetCommands
  .command("validate")
  .description("Validate one project-local .gltf or .glb without modifying it")
  .argument("<asset>", "Project-local res:// .gltf or .glb path")
  .option("--project <path>", "Godot project path; otherwise discover it")
  .option("--policy <path>", "Project-local res:// uo-godot-asset-policy/1 JSON")
  .option("--godot-import", "Run an isolated disposable Godot import proof")
  .option("--godot <path>", "Godot executable for the requested import proof")
  .option("--timeout <seconds>", "Maximum time for each Godot child", "30")
  .action(async (asset, options) => {
    try {
      const timeout = Number(options.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) {
        throw new Error("--timeout must be a finite number between 0 and 300 seconds");
      }
      const report = await validateAsset({
        asset,
        project: options.project,
        policy: options.policy,
        godotImport: options.godotImport === true,
        godot: options.godot,
        timeoutMs: timeout * 1000
      });
      printLocalResult(report);
      if (report.status !== "ok") process.exitCode = 1;
    } catch (error) {
      reportLocalError(error);
    }
  });
```

Do not add this command to the runtime addon's authenticated command manifest;
it is a local filesystem command, not a live-runtime capability.

- [ ] **Step 4: Add packaged-consumer proof**

In `test/package-consumer.test.mjs`, after creating `project.godot`, write a
minimal `model.gltf` and execute the installed archive's CLI. Assert exit
success, JSON `status: "ok"`, one closure file, and unchanged source bytes.
Also assert `asset validate --help` mentions `.gltf` and `.glb`.

- [ ] **Step 5: Run CLI and consumer tests**

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
rtk proxy node --test test/package-consumer.test.mjs
```

Expected: both test files pass and package installation remains offline.

- [ ] **Step 6: Commit Task 4 only**

```powershell
rtk git add -- src/cli.ts test/asset-validation.test.mjs test/package-consumer.test.mjs
rtk git commit -m "feat: expose asset validation command" -- src/cli.ts test/asset-validation.test.mjs test/package-consumer.test.mjs
```

---

### Task 5: Isolated real-Godot import proof

**Files:**
- Create: `src/asset-import.ts`
- Modify: `src/asset-validation.ts`
- Create: `test/asset-import-godot.test.mjs`

**Interfaces:**
- Consumes: a fully validated and fingerprinted `AssetClosureFile[]`
- Produces: `runIsolatedGodotImport(options: AssetImportOptions): Promise<AssetImportReport>`
- Produces: node/mesh/surface/material/animation/skeleton/body/collision counts
- Produces finding codes: `ASSET_IMPORT_UNAVAILABLE`, `ASSET_IMPORT_FAILED`, `ASSET_IMPORT_LOG_TRUNCATED`, `ASSET_IMPORT_CLEANUP_FAILED`, `ASSET_COLLISION_REQUIRED`

- [ ] **Step 1: Read TDD test-quality rules before adding the real test**

Read `C:/Users/redga/.codex/plugins/cache/claude-plugins-official/superpowers/6.3.0/skills/test-driven-development/writing-good-tests.md` completely. Name the production behavior that each real test would catch: canonical-project mutation, child-environment leakage, incomplete import, missing collision evidence, and leaked owned resources.

- [ ] **Step 2: Write the failing real-Godot clean import test**

Create `test/asset-import-godot.test.mjs`, skip only when `GODOT_BIN` is absent,
and use a tiny inline glTF triangle with a local buffer. Record every source
file's bytes. Run the CLI with `--godot-import --godot <GODOT_BIN> --timeout 30`
and assert:

```js
assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
const report = JSON.parse(result.stdout);
assert.equal(report.proof.godotImport.status, "ok");
assert.equal(report.proof.godotImport.complete, true);
assert.equal(report.integrity.unchanged, true);
assert.ok(report.proof.godotImport.summary.meshes >= 1);
for (const [name, bytes] of originals) {
  assert.deepEqual(await fs.readFile(path.join(project, name)), bytes);
}
```

The test's `t.after()` may stop only its own child PID and remove only its own
temporary root. It must fail if the report exposes a token or canonical path in
captured child environment data.

- [ ] **Step 3: Run the real test and verify RED**

```powershell
rtk npm run build
rtk proxy node --test test/asset-import-godot.test.mjs
```

Expected with Godot configured: fail because `--godot-import` remains
`not_requested` or has no import implementation. If Godot is absent, record the
skip and do not treat it as RED evidence; configure the pinned executable before
implementation.

- [ ] **Step 4: Implement disposable-project preparation**

Create `src/asset-import.ts` with:

```ts
export interface AssetImportOptions {
  projectRoot: string;
  asset: string;
  closure: AssetClosureFile[];
  godot?: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export interface AssetImportSummary {
  rootType: string;
  nodes: number;
  meshes: number;
  surfaces: number;
  materials: number;
  animations: number;
  skeletons: number;
  bodies: number;
  collisionShapes: number;
}

export interface AssetImportReport {
  status: "ok" | "error";
  complete: boolean;
  summary: AssetImportSummary | null;
  exitCodes: { import: number | null; probe: number | null };
  logs: { complete: boolean; truncated: boolean; lines: string[] };
  cleanup: { complete: boolean };
  findings: AssetFinding[];
}

export async function runIsolatedGodotImport(
  options: AssetImportOptions
): Promise<AssetImportReport>;
```

Create the temporary root with `mkdtemp`, write a minimal `project.godot`, copy
only closure files after rechecking source hashes, and preserve their relative
layout. Write a fixed `probe.gd` owned by the package. Never copy canonical
`.godot`, `.import`, addon, scene, or script files.

- [ ] **Step 5: Implement bounded Godot child execution**

Resolve the executable by the same canonical-file/PATH principles used by
`test-runner.ts`. Build a child environment only from the existing safe OS keys
(`PATH`, `SystemRoot`, temp/home/locale/program directories), set `CI=1`, and
explicitly omit `GODOT_CLI_TOKEN`, `GODOT_CLI_ALLOW_MUTATIONS`,
`GODOT_CLI_ALLOW_UNSAFE`, and project integration variables.

Run without a shell or detached mode:

```text
godot --headless --xr-mode off --audio-driver Dummy --path <temp> --editor --import
godot --headless --xr-mode off --audio-driver Dummy --path <temp> --script res://probe.gd -- <asset>
```

Bound each process by `timeoutMs`, captured stdout/stderr by 1 MiB, and retained
log lines by 4096. A timeout kills only that child and is an error. Parse exactly
one line prefixed `UO_ASSET_IMPORT_REPORT=` as JSON. Missing, duplicate,
truncated, malformed, or nonzero output fails closed.

- [ ] **Step 6: Implement the fixed GDScript probe**

The script must load the passed `res://` resource, require `PackedScene`,
instantiate it, traverse a bounded maximum of 100,000 nodes without modifying
the scene, count `MeshInstance3D` surfaces/materials, `AnimationPlayer`,
`Skeleton3D`, `PhysicsBody3D`, and `CollisionShape3D`, print the prefixed JSON,
free the instance, and quit `0`. It quits nonzero for missing args, load error,
wrong type, node limit, or traversal error.

- [ ] **Step 7: Wire import evidence and collision policy**

In `validateAsset()`, call `runIsolatedGodotImport()` only after static success
and only when `godotImport` is true or policy requires it. Merge import findings,
re-fingerprint the canonical closure, and set overall completeness only when
import and cleanup complete. If `require_collision_nodes` is true and the
summary reports zero, add `ASSET_COLLISION_REQUIRED` and fail policy/overall
status. When collision nodes are present, set collision evidence to `observed`
with the exact count and retain the reason that presence is not quality proof.
LOD evidence remains `unknown` in v1. Never describe a positive collision count
as collision-quality proof.

- [ ] **Step 8: Add real rejection and cleanup tests**

Test a malformed/import-failing asset, collision-required policy with zero
`CollisionShape3D`, bounded timeout via a test-only fake executable fixture, and
cleanup after both success and failure. Assert no owned process remains and the
temporary directory is absent. Read full captured logs before diagnosing any
failure.

- [ ] **Step 9: Run focused static and real suites**

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
rtk proxy node --test test/asset-import-godot.test.mjs
```

Expected: static tests pass; real tests pass with the pinned Godot executable.
Any skip remains explicit and cannot satisfy import acceptance criteria.

- [ ] **Step 10: Commit Task 5 only**

```powershell
rtk git add -- src/asset-import.ts src/asset-validation.ts test/asset-import-godot.test.mjs
rtk git commit -m "feat: prove assets in isolated Godot imports" -- src/asset-import.ts src/asset-validation.ts test/asset-import-godot.test.mjs
```

---

### Task 6: Documentation, security contract, and full verification

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: final command/report contracts from Tasks 1-5
- Produces: user-facing instructions and evidence with exact proof boundaries

- [ ] **Step 1: Write documentation assertions before documentation changes**

Add assertions to `test/package-consumer.test.mjs` that the packaged README and
SECURITY files mention `asset validate`, `uo-godot-asset-policy/1`, and the exact
boundary phrase `not GPU, VRAM, visual-quality, collision-quality, or OpenXR proof`.

- [ ] **Step 2: Run the consumer test and verify RED**

```powershell
rtk npm run build
rtk proxy node --test test/package-consumer.test.mjs
```

Expected: documentation assertions fail.

- [ ] **Step 3: Update README, SECURITY, and CHANGELOG**

Document one static example, one policy example, and one isolated import example.
Explain exit codes and `not_requested`. Add security bullets for URI rejection,
closure limits, scrubbed child environment, disposable cache, bounded logs, and
cleanup failure. Add an Unreleased changelog item labeled as validation tooling,
not client/runtime completion.

- [ ] **Step 4: Run the complete fresh verification matrix**

Use the pinned Godot environment where available and capture full logs:

```powershell
rtk npm run build
rtk proxy node --test test/asset-validation.test.mjs
rtk proxy node --test test/asset-import-godot.test.mjs
rtk npm test
rtk npm audit --omit=dev --audit-level=moderate
rtk npm publish --dry-run
rtk git diff --check
rtk proxy powershell -NoProfile -Command "$env:PYTHONPATH='C:/Users/redga/botte-secrete'; python -m skills.checkup.cli ."
```

Read full untruncated logs for every failure before changing code. Record exact
pass/fail/skip counts. A missing Godot executable means the real import gate is
unverified, not passed.

- [ ] **Step 5: Review requirements against the specification**

Verify one by one: source immutability, forbidden URI rejection, closure limits,
GLB framing, policy closure, no default VR budget, isolated import, collision
evidence boundary, deterministic JSON, explicit skip semantics, child cleanup,
package visibility, and no addon manifest change. Inspect `git diff --stat` and
`git status --short` to confirm no unrelated file entered the task.

- [ ] **Step 6: Commit documentation only after fresh gates**

```powershell
rtk git add -- README.md SECURITY.md CHANGELOG.md test/package-consumer.test.mjs
rtk git commit -m "docs: document asset validation proof levels" -- README.md SECURITY.md CHANGELOG.md test/package-consumer.test.mjs
```

- [ ] **Step 7: Request final code review**

Use `superpowers:requesting-code-review`. The reviewer must compare the diff to
the specification, inspect security boundaries, and reject any claim that static
or isolated import evidence proves production VR behavior.
