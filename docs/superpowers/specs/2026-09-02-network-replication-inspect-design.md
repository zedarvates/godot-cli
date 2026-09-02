# Network Replication Frame Inspection Design

**Date:** 2026-09-02  
**Status:** Approved in chat; written specification pending final review  
**Target:** `uo-godot-cli network replication inspect <frame.bin>`

## Goal

Add a bounded, local, read-only inspector for one complete Zig2
`entity_update` wire frame. The command proves that captured bytes match the
current authoritative envelope and replication-batch structure. It does not
connect to a server or claim that Godot can synchronize, interpolate, render,
or apply the decoded entities.

This is the first deliberately narrow EntitySync foundation. Zig2 remains the
wire authority.

## Authoritative Contract

The implementation mirrors these existing server sources without modifying
them:

- `src/networking/handlers/entity.zig`: common network envelope
  `[u32 total_len BE][u16 message_type BE][payload]`;
- `src/main.zig`: `entity_update` opcode `80` and the 65,536-byte replication
  payload buffer;
- `src/network/replication.zig`: batch and entity-delta framing;
- `src/core/protocol_fields.zig`: field identifiers and primitive types.

Production code must not parse Zig source text. Source execution is allowed
only in an explicit optional parity test.

## Command Surface

```text
uo-godot-cli network replication inspect <frame.bin>
```

The command is local and tokenless. It exposes no host, port, TLS, credential,
timeout, connect, listen, capture, replay, send, interpolate, or apply option.
The `network replication` command group exposes only `inspect` in this version.

Successful complete inspection exits `0`. Invalid structure, incomplete
inspection, source-integrity uncertainty, or an internal bound being reached
exits `1` with a JSON report on stdout. Operational exceptions use the existing
local CLI error path.

## File Boundary

The input must be one explicit `.bin` path. The inspector:

1. resolves the absolute path without project or environment discovery;
2. rejects missing paths, directories, symbolic links, junction aliases, and
   non-`.bin` extensions;
3. rejects a file larger than 65,542 bytes before and during bounded reading;
4. reads through a file handle with a 65,543-byte hard ceiling;
5. fingerprints the exact original bytes with SHA-256;
6. rechecks type, size, bytes, and fingerprint after parsing.

Any source drift produces `REPLICATION_SOURCE_CHANGED`, sets `complete` and
`structurallyValid` to `false`, and prevents a success exit.

The inspector never writes beside the frame and never creates a decoded asset,
scene, cache, packet, or replay file.

## Wire Format

### Complete frame

```text
[u32 total_len BE]
[u16 opcode BE = 80]
[replication payload]
```

`total_len` is exactly the number of bytes after the four-byte length prefix:
two opcode bytes plus the payload. It must equal `file_size - 4`. The complete
file is therefore at least eight bytes: four length bytes, two opcode bytes,
and the two-byte entity count.

### Replication payload

```text
[u16 entity_count BE]
repeat entity_count:
  [u32 delta_size BE]
  [delta bytes]
```

An empty batch is valid only when `entity_count == 0` and the payload ends
immediately after the count. No trailing bytes are accepted.

### Entity delta

```text
[u64 entity_id BE]
[u8 field_count]
repeat field_count:
  [u8 field_id]
  [u32 raw_value BE]
```

`entity_id` must be non-zero and is returned as a decimal string so JavaScript
cannot lose `u64` precision. `field_count` is in `[0, 7]`. `delta_size` must be
exactly `9 + field_count * 5`, so its accepted range is 9 through 44 bytes.

## Current Field Contract

Only the exact fields currently emitted by `ReplicationSystem` are accepted,
as a duplicate-free subsequence of this canonical order:

| ID | Name | Value |
|---:|---|---|
| 1 | `pos_x` | finite IEEE-754 `f32` BE |
| 2 | `pos_y` | finite IEEE-754 `f32` BE |
| 3 | `pos_z` | finite IEEE-754 `f32` BE |
| 4 | `vel_x` | finite IEEE-754 `f32` BE |
| 6 | `vel_z` | finite IEEE-754 `f32` BE |
| 7 | `rot_y` | finite IEEE-754 `f32` BE |
| 10 | `health` | `u32` BE |

Unknown, repeated, or out-of-order fields are errors. `vel_y`, other protocol
fields, and future field IDs are not guessed or accepted until Zig2 changes and
this contract is deliberately versioned. NaN and infinities are rejected
because they cannot be represented faithfully in the JSON report or safely fed
to later interpolation. The inspector does not invent gameplay bounds for
finite positions, velocities, rotations, or health.

Each reported field contains its ID, canonical name, primitive kind, eight
lowercase hexadecimal raw digits, and decoded value.

## Report Model

The stable JSON report contains:

```text
status: "ok" | "error"
complete: boolean
structurallyValid: boolean
frameFile: canonical absolute path
contract:
  authority: "zig-server-v2"
  messageType: "entity_update"
  opcode: 80
  byteOrder: "big-endian"
  maxFrameBytes: 65542
frame:
  bytes: number
  declaredLength: number | null
  payloadBytes: number | null
  entityCount: number | null
  detailedEntities: number
  omittedEntities: number
entities: bounded decoded summaries
integrity:
  bytes: number
  sha256: lowercase hexadecimal string
  unchanged: boolean
findings: bounded deterministic findings
boundaries: explicit non-proof statements
```

At most 256 entities are included in `entities`; every entity and field is
still parsed and validated. `omittedEntities` records valid summaries omitted
from the JSON output. Detail omission is not incomplete inspection.

Findings are sorted by code, byte offset, and message. At most 128 findings are
returned. Reaching that limit adds a retained `REPLICATION_FINDINGS_TRUNCATED`
error and makes `complete: false`.

Stable finding families are:

- `REPLICATION_FILE_INVALID`
- `REPLICATION_FILE_TOO_LARGE`
- `REPLICATION_FILE_UNREADABLE`
- `REPLICATION_SOURCE_CHANGED`
- `REPLICATION_FRAME_INVALID`
- `REPLICATION_OPCODE_INVALID`
- `REPLICATION_COUNT_MISMATCH`
- `REPLICATION_DELTA_INVALID`
- `REPLICATION_FIELD_INVALID`
- `REPLICATION_FLOAT_NON_FINITE`
- `REPLICATION_FINDINGS_TRUNCATED`

The report includes byte offsets, never unbounded byte dumps.

## Failure Semantics

`status` is `ok` only when the inspection is complete, source bytes are
unchanged, and no error finding exists. `structurallyValid` follows the same
condition. A parser failure never returns partial entities as trusted or
applicable state.

The report is diagnostic evidence only. Even a valid frame includes boundaries
stating that the command did not prove authentication, authorization,
freshness, sequence ordering across frames, entity ownership, interpolation,
anti-cheat acceptance, Godot application, rendering, latency, packet delivery,
or server connectivity.

## Tests

TDD fixtures use the byte sequence already hand-checked in Zig's
`legacy replication batch matches canonical client framing` test, wrapped in
the six-byte common network envelope. Tests cover:

- valid one-entity frame and valid empty batch;
- exact decoded floats, health, raw values, and decimal `u64` identity;
- missing file, wrong extension, directory, symlink, and oversized sparse file;
- frame length underflow, overflow, mismatch, wrong opcode, and trailing bytes;
- entity-count mismatch and truncated delta-size/delta records;
- zero entity ID, delta-size mismatch, field count above seven;
- unknown, duplicate, and out-of-order fields;
- non-finite float bit patterns;
- 256-detail output cap while validating all entities;
- finding truncation and source-integrity drift;
- CLI success/error exit codes, JSON-only stdout, and absent network/mutation
  subcommands;
- behavior from the packed and installed npm package.

An optional test, enabled only by `UO_ZIG_SERVER_ROOT`, canonicalizes the server
root, requires the exact authoritative files, snapshots their scoped Git
status, and directly runs:

```text
zig test src/network/replication.zig
```

The child is test-only, shell-free, capped at 60 seconds and 1 MiB of combined
output. It must leave the authoritative files unchanged. Its success is
reported separately and does not turn local frame inspection into live network
proof.

## Documentation and Packaging

README, SECURITY, and CHANGELOG document the command, limits, current field
table, exit behavior, optional parity gate, and all non-goals. No npm dependency,
Godot addon command, MCP tool, protocol catalog, server file, or runtime token
gate is added.

## Explicit Non-Goals

This version does not implement StateSync snapshots, events, spawn/despawn,
PlayerSync, MapSync, ClusterSync, realm handoff, TLS, authentication, capture,
replay, network sockets, buffering across frames, delta history, interpolation,
prediction, reconciliation, entity creation, component mutation, Godot scene
updates, VR tracking, or anti-cheat decisions.

Those remain separate architectural increments. This command validates one
captured `entity_update=80` frame and nothing more.
