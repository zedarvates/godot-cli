# Asset Validation Design

**Status:** Approved architecture; written design pending user review.

## Purpose

Add a bounded, local, read-only `uo-godot-cli asset validate` capability for
Godot 4 projects. The command verifies whether one glTF asset and its local
dependency closure are structurally usable by the development pipeline. It
does not generate, optimize, modify, sign, or publish assets, and it does not
claim visual quality or OpenXR readiness.

This keeps the repository's established responsibility intact: the CLI is an
authenticated development control plane and validation/orchestration layer,
not the Ultimate Odycer VR client.

## Scope

The first version accepts one project-local `res://` path ending in `.gltf` or
`.glb` and produces one deterministic JSON report. It has two proof layers:

1. `static`: bounded parsing, dependency closure, integrity fingerprints, and
   portable glTF metrics;
2. `godot_import`: an optional isolated Godot 4 import probe in a disposable
   project containing only the validated source closure.

Static validation is always executed. The Godot import layer is executed only
when explicitly requested and a compatible `GODOT_BIN` or `--godot` executable
is available. If the caller requests the layer and it cannot complete, the
command fails closed. An unrequested layer is reported as `not_requested`, not
as passed or failed.

## Non-goals

- Blender automation, asset conversion, LOD generation, texture atlasing, or
  collision generation.
- Editing `project.godot`, source assets, import metadata, or canonical scenes.
- Starting the Ultimate Odycer client or connecting to Zig2.
- Measuring rendered frame time, VRAM residency, GPU behavior, foveation,
  stereo correctness, visual quality, collision quality, or OpenXR behavior.
- Signing assets, packaging mods, publishing npm packages, or deploying CI.
- Validating arbitrary Godot resource formats in the first version.

## Command Contract

```text
uo-godot-cli asset validate <res://path/to/model.gltf|model.glb>
  [--project <path>]
  [--godot-import]
  [--godot <path>]
  [--timeout <seconds>]
  [--policy <path>]
```

The command writes only its JSON report to standard output. Diagnostics go in
the report rather than being mixed with human prose. Exit code `0` means every
requested proof layer completed and every enforced rule passed. Exit code `1`
means invalid input, an incomplete requested proof, or at least one error-level
finding. Warnings alone do not change the exit code.

`--policy` points to a regular JSON file inside the project. Without a policy,
the command enforces only format, safety, closure, and completeness rules; it
reports performance-related metrics without inventing headset-specific limits.

## Security and Resource Boundaries

The validator reuses the repository's fail-closed conventions:

- input must begin with `res://` and resolve inside the nearest Godot project;
- the root and every dependency must be a regular file, never a symlink;
- absolute paths, traversal, network URLs, protocol-relative URLs, and file
  URLs are rejected;
- data URIs are rejected in v1 to keep decoded-memory and provenance bounded;
- percent-decoded dependency paths are revalidated before filesystem access;
- at most 256 dependency files and 512 MiB total source bytes are accepted;
- no individual source file may exceed 256 MiB;
- JSON nesting, array counts, string sizes, report findings, and subprocess
  output are bounded by exported constants and tested at their limits;
- filesystem traversal stops at the parsed dependency closure; the command
  never scans the entire project;
- the import probe receives a reduced child environment without CLI tokens or
  mutation/unsafe gates;
- the disposable project is created with owner-only permissions where the
  platform supports them and is removed after the probe;
- cleanup failure is reported and makes the requested import proof incomplete.

The static layer performs no network access and launches no child process.

## Static glTF Validation

### `.gltf`

The validator parses UTF-8 JSON and requires a root object with
`asset.version == "2.0"`. It validates that indexed references stay within
their corresponding arrays and that declared buffer and image dependencies
resolve through the bounded local closure.

External buffer and image URIs are normalized relative to the `.gltf` file.
Duplicate normalized paths are fingerprinted once. Missing, divergent,
out-of-project, symlinked, or non-regular dependencies are errors.

### `.glb`

The validator requires the glTF binary magic, version `2`, exact declared file
length, one leading JSON chunk, at most one BIN chunk, valid four-byte chunk
alignment, and no trailing or duplicate chunks. The JSON chunk receives the
same object and reference validation as `.gltf`. External image URIs, when
present, follow the same local closure rules.

### Portable metrics

The report includes bounded counts for scenes, nodes, meshes, primitives,
materials, textures, images, samplers, skins, animations, accessors, and buffer
bytes. It reports primitive modes and available accessor counts. It does not
derive a triangle count when the source topology or indices make the result
ambiguous; such a metric is marked `unknown` with a reason.

The report also records:

- SHA-256 and byte size for the root and every dependency;
- image MIME declarations and dimensions only when safely available from
  bounded PNG/JPEG headers;
- whether explicit LOD evidence is present through a future, versioned policy
  rule; v1 never guesses LODs from node names;
- collision evidence as `unknown` in the static layer, because glTF validity
  alone cannot prove Godot collision nodes or collision quality.

## Optional Policy

The first policy schema is versioned as `uo-godot-asset-policy/1`. Unknown
fields and unsupported versions are errors. It may enforce only metrics the
validator can measure deterministically:

```json
{
  "schema": "uo-godot-asset-policy/1",
  "max_total_bytes": 536870912,
  "max_meshes": 256,
  "max_primitives": 1024,
  "max_materials": 256,
  "max_textures": 256,
  "max_image_dimension": 8192,
  "require_godot_import": false,
  "require_collision_nodes": false
}
```

Policy limits may only tighten built-in safety limits. `require_collision_nodes`
also requires `require_godot_import`; otherwise the policy is rejected as
internally inconsistent. Policy success means only that measured values met
that policy, not that the asset is performant on a headset.

## Isolated Godot Import Proof

When requested, the CLI creates a disposable minimal Godot 4 project and
copies the already validated source closure while preserving its relative
layout. It runs the configured Godot executable headlessly with XR disabled and
a bounded timeout. The probe must finish with a complete log and a successful
import for the requested asset.

After import, a small validation scene loads the imported resource and emits a
bounded machine-readable summary containing the root type and counts of loaded
nodes, meshes, surfaces, materials, animations, skeletons, bodies, and
`CollisionShape3D` nodes. The summary is evidence from a disposable import; it
does not modify or prove the canonical project.

The CLI fingerprints the canonical source closure before and after the probe.
Any source change is an error. Generated files inside the disposable project's
`.godot` directory are not source mutations and are deleted during cleanup.

## Report Model

```json
{
  "status": "ok",
  "valid": true,
  "complete": true,
  "asset": "res://assets/model.gltf",
  "project_root": "<absolute path>",
  "format": "gltf",
  "proof": {
    "static": { "status": "ok", "complete": true },
    "godot_import": { "status": "not_requested", "complete": false }
  },
  "closure": {
    "file_count": 3,
    "total_bytes": 1024,
    "files": []
  },
  "metrics": {},
  "policy": null,
  "findings": [],
  "integrity": { "unchanged": true },
  "boundaries": [
    "Static or isolated import evidence is not GPU, VRAM, visual-quality, collision-quality, or OpenXR proof."
  ]
}
```

`complete` is true only when static validation completed, every requested layer
completed, source integrity was rechecked, and cleanup completed. Findings use
stable codes, `error` or `warning` severity, a JSON-pointer-like location when
applicable, and a bounded message. Reports are sorted deterministically by
normalized path, code, and location.

## Architecture and Files

- `src/asset-validation.ts`: path resolution, bounded glTF/GLB parsing,
  dependency closure, metrics, policy evaluation, fingerprinting, and report
  assembly.
- `src/asset-import.ts`: disposable project lifecycle and bounded Godot import
  probe. It receives an already validated closure and cannot expand it.
- `src/cli.ts`: `asset validate` command registration and exit-code mapping.
- `test/asset-validation.test.mjs`: static success and rejection tests.
- `test/asset-import-godot.test.mjs`: real Godot import proof, skipped only when
  Godot is genuinely unavailable.
- `test/package-consumer.test.mjs`: packaged command and help visibility.
- `README.md`, `SECURITY.md`, and `CHANGELOG.md`: command contract, boundaries,
  security model, and validation evidence.

No change is required in the runtime addon for this increment. Keeping the
import probe outside the authenticated runtime protocol avoids adding a broad
asset-loading command to a live project.

## Error Handling

Every parse, closure, policy, import, log, integrity, and cleanup failure is
represented in the report. The implementation never suppresses a failed
requested layer, substitutes a fixture, retries with a less strict mode, or
falls back to a similarly named file. Truncated logs or findings make the
relevant proof incomplete.

Unknown extensions, unsupported glTF versions or features required for safe
parsing, malformed indices, non-finite JSON numbers, and conflicting resource
declarations fail closed.

## Test Strategy

Implementation follows red-green-refactor. Tests must first demonstrate the
expected failure before production code is added.

Static tests cover:

- minimal valid `.gltf` and `.glb` fixtures;
- malformed JSON, GLB headers, chunks, alignment, and lengths;
- missing, traversal, URL, data URI, symlink, duplicate, and oversized
  dependencies;
- invalid array references and unsupported glTF versions;
- deterministic closure ordering, hashes, metrics, and finding ordering;
- built-in resource limits and tighter policy limits;
- inconsistent or unknown policy fields and versions;
- unchanged source fingerprints and bounded reports.

The real-Godot test creates a disposable source project and validates one clean
asset, one import failure, and a collision-policy rejection. It verifies that
the canonical fixture bytes remain unchanged and that no owned Godot process or
temporary directory remains. This test is import/runtime evidence only.

Final gates are:

```text
npm run build
node --test test/asset-validation.test.mjs
node --test test/asset-import-godot.test.mjs
npm test
npm audit --omit=dev --audit-level=moderate
npm publish --dry-run
git diff --check
PYTHONPATH=C:\Users\redga\botte-secrete python -m skills.checkup.cli .
```

The final report must separate a skipped external Godot probe from passing
static tests and must not turn a skip into import proof.

## Rollout

1. Implement static `.gltf` validation and report contracts.
2. Add `.glb`, policy, and resource-limit coverage.
3. Add the isolated real-Godot import proof.
4. Document and run the full local gates.
5. Only after this increment is reviewed, design the registry v1 adapter as a
   separate subsystem.

## Acceptance Criteria

1. A valid project-local `.gltf` or `.glb` produces a deterministic complete
   static report without modifying source files.
2. Every dependency escape, URL, symlink, missing file, malformed reference,
   unsupported version, and resource-limit breach fails closed.
3. Requested Godot import proof runs only in a disposable project, disables XR,
   scrubs sensitive gates, observes bounded logs, cleans up, and preserves all
   canonical source bytes.
4. Collision presence is enforced only from imported Godot node evidence;
   collision quality is never claimed.
5. Performance limits are enforced only from an explicit versioned policy;
   default output reports metrics without inventing a headset budget.
6. Static, import, policy, integrity, cleanup, and unsupported proof levels are
   distinguishable in JSON and documentation.
7. The full component test suite and security/package gates pass or their exact
   pre-existing failures are reported without false completion.
