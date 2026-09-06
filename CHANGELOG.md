# Changelog

All notable changes to this fork are documented here. The project uses
pre-release versions until the public API and operational boundary are stable.

## Unreleased

### Fixed

- Charge rejected registry files against the aggregate read budget and stop
  before a file would exceed it. Report consumption in `readBudget` and allow
  a lower ceiling with `template registry inspect --max-read-bytes`.

- Reject duplicate decoded JSON keys in registry catalogs and referenced files;
  share detection with strict template validation, including escaped aliases.

- Decode registry JSON and compute its checksum from the same bounded bytes,
  detecting read-time growth/drift and rejecting malformed UTF-8 instead of
  silently replacing bytes. Short-read and concurrent-replacement regressions
  cover the inspection path.

- Resolve every schema reference, including unused definitions, and reject
  missing fragments, non-schema targets and malformed JSON Pointer escapes.

- Check schema keywords and formats in unused definitions before compilation;
  keep annotation and constant data outside schema-vocabulary traversal.
- Count boolean schemas toward the 4,096-node schema traversal limit.

- Reject unsupported numeric tokens in loaded template schemas before Ajv
  evaluation, preventing rounded bounds from silently changing the verdict.
  This applies to every loaded schema, including annotations and constants.

### Added

- `template validate --registry-max-read-bytes` lowers the registry inspection
  phase's read ceiling and reports `registryReadBudget`, including rejected bytes.

- Extend `--expected-catalog-sha256` to `template validate`, checking the pin
  before referenced files and reporting `catalogPinVerified` separately from validity.

- `template registry inspect --expected-catalog-sha256` rejects an unexpected
  catalog snapshot before opening referenced files and reports `catalog.pinVerified`.

- Include `catalog.sha256` and `catalog.bytes` in registry inspection reports,
  identifying the exact catalog snapshot independently of readiness.

- Exact safe-integer `spec_checksum` support in `template validate`, with
  original-token checks and Python/registry serializer parity vectors. Decimal,
  exponent and out-of-range integer tokens remain unsupported and fail closed.

- `template validate <resource> --registry <root>` evaluates catalogued strict
  templates against their common and family Draft 2020-12 schemas locally.
  Includes bounded worker execution, strict reference/format handling, checksum
  verification, source fingerprints and explicit non-Godot readiness reporting.
  Decimal/exponent spec checksums remain unsupported pending serializer parity.

- `mod manifest inspect <manifest.json>` for bounded local structural checks of
  the Zig2 addon-manifest schema v1, including byte-integrity evidence and
  deterministic findings.
- Optional test-only parity gates for the authoritative Zig manifest and trust
  store suites when `UO_ZIG_SERVER_ROOT` is explicitly configured.
- Bounded `asset validate` support for project-local glTF 2.0 `.gltf` and
  `.glb` files, including local dependency closure, fingerprints, indexed
  reference checks, portable metrics, PNG/JPEG header dimensions, and the
  closed `uo-godot-asset-policy/1` schema.
- Optional disposable Godot 4.7 import evidence with XR disabled, a scrubbed
  child environment, bounded logs, source-integrity checks, collision-node
  presence reporting, and fail-closed cleanup.
- Read-only `template registry inspect <root>` for bounded catalog v2, profile,
  contract, schema-link, exact SHA-256, strict-content, and `godot-vr`
  compatibility-evidence inspection.
- `network replication inspect <frame.bin>` for bounded local decoding of one
  complete Zig2 `entity_update=80` frame, including exact envelope/delta/field
  validation, precision-safe entity IDs, and source-integrity evidence.
- `network vr-request inspect <frame.bin>` for exact local decoding of
  client-to-server VR grab `128` and release `129` frames with finite
  big-endian velocity checks and immutable server-validation requirements.

### Security

- Mod inspection always reports trust and package integrity as `not_checked`,
  activation as ineligible, and Zig2 authority as required. It does not read
  packages or trust stores, verify signatures, execute mods, or mutate their
  lifecycle.

### Changed

- Template registry inspection now recognizes family schemas composed from the
  exact verified common-contract `$id` and validates reciprocal strict-to-legacy
  supersession links. Arbitrary remote schema references remain rejected.

### Known boundaries

- Static and isolated-import evidence is not GPU, VRAM, visual-quality,
  collision-quality, performance, or OpenXR proof. The command does not
  generate LODs, collisions, atlases, conversions, signatures, or packages.
- Inspection does not execute JSON Schema, recompute canonical
  `spec_checksum`, detect duplicate JSON keys, validate, instantiate, migrate,
  run registry Python, start Godot, access the network, or prove runtime
  compatibility.
- Replication inspection does not connect, capture, replay, authenticate,
  interpolate, reconcile, apply state to Godot, or prove live networking,
  delivery, latency, rendering, VR, or production behavior.
- VR request inspection excludes server broadcasts, pose, voice, locomotion,
  object ownership/state decisions, velocity clamps, anti-cheat acceptance,
  sockets, replay, and Godot mutation.

## 0.1.0-uo.7 — 2026-08-14

### Added

- Provider-neutral FoveaCore commands for bridge status, unsaved splat
  insertion, and scene validation.
- Project discovery, bounded static preflight, addon inspection/installation,
  runtime readiness, and managed runtime lifecycle commands.
- One-shot safe-mode scene validation with structural checks, categorized log
  diagnostics, bounded evidence, and source-file fingerprints.
- Versioned project test profiles with tokenless discovery plus bounded,
  shell-free Godot, Python, and .NET execution.
- Real Godot security, process-ownership, package-consumer, and optional
  cross-repository Fovea integration tests.
- Public CI for Node.js 18/22 and the verified official Godot 4.7.1 Linux
  archive.
- MIT license, npm public metadata, and a first-release checklist.

### Security

- Require a fresh token of at least 32 characters and bind only to loopback in
  debug builds.
- Keep mutation and unsafe capabilities behind separate explicit gates.
- Bound protocol payloads, clients, waits, scene scans, assertions, files, and
  managed logs; verify process ownership before stopping a runtime.

### Changed

- Use `uo-godot-cli` to avoid colliding with unrelated Godot CLI packages.
- Route npm pre-releases through the `next` distribution tag.

### Known boundaries

- The Fovea bridge test covers GDScript loading and one unsaved splat, not
  native acceleration, GPU output, visual quality, collisions, or OpenXR.
- Canonical Ultimate Odycer client activation remains a separate integration
  gate while another runtime control plane is enabled.
