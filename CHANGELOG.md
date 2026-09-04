# Changelog

All notable changes to this fork are documented here. The project uses
pre-release versions until the public API and operational boundary are stable.

## Unreleased

### Added

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
