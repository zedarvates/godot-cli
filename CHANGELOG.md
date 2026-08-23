# Changelog

All notable changes to this fork are documented here. The project uses
pre-release versions until the public API and operational boundary are stable.

## Unreleased

### Added

- Read-only `template registry inspect <root>` for bounded catalog v2, profile,
  contract, schema-link, exact SHA-256, strict-content, and `godot-vr`
  compatibility-evidence inspection.

### Known boundaries

- Inspection does not execute JSON Schema, recompute canonical
  `spec_checksum`, detect duplicate JSON keys, validate, instantiate, migrate,
  run registry Python, start Godot, access the network, or prove runtime
  compatibility.

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
