# Ultimate Odycer client integration roadmap

This document maps the ten original audit areas to the development CLI and
the systems that must supply the remaining runtime behavior. It describes
the current CLI, including local strict template validation. Proposed gates below are not
implemented commands or evidence of a working VR MMO client.

## Responsibilities

The CLI owns bounded local inspection, development runtime control, test
orchestration, and evidence reporting. The Godot client owns rendering, XR
input, interactions, interpolation, and world streaming. The authoritative
server owns gameplay validation, authentication, replication, and player
handoff. The template registry owns versioned content contracts and catalog
integrity. These responsibilities do not require bundling server or client
implementations into this public tooling repository.

## Audit coverage and next proof

| Audit area | Implemented in this CLI | Remaining work and acceptance gate |
|---|---|---|
| Zig2 networking | Local `network replication inspect` for `entity_update=80`; `network vr-request inspect` for client grab/release frames; optional authoritative Zig parity tests | A client adapter must prove authenticated delivery, bounded decoding, ordering and disconnect handling. Captured bytes alone do not establish StateSync, EntitySync, MapSync, PlayerSync or ClusterSync. |
| Godot XR client | General runtime, scene and declared test-profile tools | Client-owned XR origin, head/hand input, locomotion and interactions need a real headset test with tracking-loss handling and measured frame time. Headless success does not prove XR. |
| Assets | Bounded glTF/GLB checks, dependency fingerprints, versioned policy and optional disposable Godot import | Authoring pipeline must provide provenance, LOD, textures and collisions. Target-device measurements must establish VRAM, frame time and visual/collision quality before VR readiness. |
| Template registry | `template registry inspect` checks catalog integrity; `template validate` evaluates one strict template against its common/family schemas | Godot consumer readiness still requires explicit compatibility evidence. Numeric spec canonicalization, instantiation and migration remain separate gates. |
| Maps and streaming | Generic scene inspection and test-profile execution | Client-owned zone/tile loading needs bounded residency, cancellation, unloading, collision/navigation continuity and cross-zone tests. Roofing and map creation need their own content contracts. |
| Cluster integration | No dedicated cluster command | Server-owned heartbeat, failover and handoff contracts must exist before a CLI adapter. First prove one bounded recorded diagnostic against an authoritative fixture; operational actions require a separate design. |
| Mods | Local addon-manifest v1 structural inspection, with authoritative parity available in tests | Server/package tooling must establish signature trust, package integrity, dependency compatibility, lifecycle and rollback. Manifest inspection never permits activation. |
| Security | Local authenticated debug runtime, separate mutation/unsafe gates, bounded files/messages and source-integrity checks | Gameplay authentication and content signature trust belong to their authoritative systems. Add adversarial integration tests at each new cross-system boundary. A checksum is not a signature. |
| CI/CD | Portable Node jobs, Godot runtime CI, package-consumer tests; optional local cross-repository parity gates | Reproducible client export, public contract fixtures and client/server integration belong in explicit jobs with declared dependencies. Public CI does not certify private Zig, registry or Fovea coverage. Deployment is a separate workflow. |
| Client documentation | Command/security guides, implementation designs and this responsibility/acceptance map | Versioned network, asset, template, mod and cluster contracts must accompany the corresponding adapters. Record owners, fixtures, errors and proof limitations as each integration lands. |

## Template validation gate

Continue using the existing local command:

```bash
uo-godot-cli template registry inspect /path/to/registry
```

The implementation exposes `consumerReady` in JSON (the audit's
`consumer_ready` requirement). It must remain false when no compatible
strict-v1 template exists. A common schema alone, a family schema alone,
legacy examples, or an intended-consumer label do not establish readiness.
Integrity failures must also keep readiness false. Even a true readiness
result is registry inspection evidence, not full JSON Schema evaluation or
a successful Godot load.

The local schema-validation implementation follows these gates:

1. Record a fresh registry inspection and identify the exact strict template,
   family schema and common-contract version. Report Godot compatibility separately;
   absence of Godot evidence does not prevent local schema validation.
2. Define supported JSON Schema behavior and resolve only bounded local,
   catalogued references; reject unavailable references and unsupported
   behavior rather than silently accepting them.
3. Test a valid strict document and rejection of schema violations, altered
   checksums, missing dependencies, incompatible versions and exhausted limits.
4. Preserve source bytes and return a failing status for invalid or incomplete
   validation. Keep schema results separate from Godot runtime results.

`template validate` now implements the local gate described in the
[command guide](../README.md#strict-template-schema-validation), with explicit
limits on supported schemas and spec canonicalization. `instantiate` and
`migrate` remain unavailable. They need separate designs and evidence after
the strict validation gate. Runtime validation must actually invoke Godot and
inspect its logs before claiming a Godot result.

## Network adapter progression

Start from the existing request and replication inspectors. For each new wire
message, establish direction, opcode, exact lengths, endianness, numeric
limits and an authoritative fixture before adding a decoder. Client requests
and server broadcasts may reuse opcodes with different layouts.

Progress from fixture parity to an isolated authenticated client/server test,
then to observable Godot application of the received state. Include malformed
data, unknown messages, disconnect/reconnect and bounded resource use at each
applicable gate. Gameplay acceptance remains a server decision; a structurally
valid grab does not prove reach, ownership or physics outcome. A future
adapter remains `[Scaffolding / Proxy]` until its claimed runtime path is wired
and exercised end to end.

## Evidence records

For every gate, record the source revision, command, dependency versions,
fixture provenance, pass/fail/skip counts and relevant source fingerprints.
Declare optional dependencies that were absent. Keep recorded-wire, schema,
headless runtime, rendered client and headset results distinct so a successful
lower-level check cannot silently promote a higher-level capability.

Use the [README validation table](../README.md#validation-evidence) for dated
results and [SECURITY.md](../SECURITY.md) for enforced restrictions. This
roadmap is an acceptance plan, not an additional validation result.
