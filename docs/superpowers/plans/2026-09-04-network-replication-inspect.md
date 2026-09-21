# Network Replication Frame Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `uo-godot-cli network replication inspect <frame.bin>` as a bounded local decoder for one complete Zig2 `entity_update=80` frame without network, Godot, or gameplay side effects.

**Architecture:** A pure byte decoder owns the envelope, batch, delta, field, numeric, output-detail, and deterministic-finding rules. A thin filesystem inspector owns canonical path confinement, bounded reads, SHA-256 evidence, and before/after integrity, while `cli.ts` only registers the nested command and maps report status to the exit code. Optional Zig execution remains test-only and never changes the production report.

**Tech Stack:** TypeScript ES2022, Node.js built-ins, Commander 13, Node test runner, optional Zig 0.15.2 parity.

**Spec:** `docs/superpowers/specs/2026-09-02-network-replication-inspect-design.md`

## Global Constraints

- Accept one explicit regular non-symbolic `.bin` file only; no stdin, hex text, URL, project, environment, `res://`, or capture discovery.
- Cap the complete frame at 65,542 bytes before and during a 65,543-byte bounded handle read.
- Require `[u32 total_len BE][u16 opcode=80][payload]` with `total_len == file_size - 4`.
- Require `[u16 entity_count BE]` followed by exact `[u32 delta_size BE][delta]` records and no final bytes.
- Require non-zero `u64` entity IDs rendered as decimal strings, `field_count <= 7`, and `delta_size == 9 + field_count * 5`.
- Accept only the duplicate-free canonical subsequence `1,2,3,4,6,7,10`; float fields must be finite and health remains an unbounded `u32` wire value.
- Validate every entity while returning details for at most 256 entities and findings for at most 128 errors.
- Preserve `complete: true` for a fully inspected but invalid frame; only integrity uncertainty or finding truncation makes inspection incomplete.
- Never connect, listen, capture, replay, send, authenticate, interpolate, apply entity state, mutate Godot, or modify Zig2.
- Add no npm dependency, Godot addon command, MCP tool, runtime token gate, server source, or protocol-source parser.

---

## File Map

| File | Responsibility |
|---|---|
| `src/network-replication-inspection.ts` | Pure frame decoder, stable report types, bounded local file loading, fingerprints, and integrity comparison. |
| `src/cli.ts` | Register `network replication inspect` and structured exit behavior. |
| `test/network-replication-inspection.test.mjs` | Hand-derived byte fixtures, parser/file negatives, CLI behavior, and source immutability. |
| `test/network-replication-server-parity.test.mjs` | Optional exact Zig replication test with scoped before/after status. |
| `test/package-consumer.test.mjs` | Packed installed CLI behavior against a real temporary `.bin` frame. |
| `README.md` | Usage, field table, evidence layers, and non-goals. |
| `SECURITY.md` | Input confinement, bounds, numeric rejection, and no-network/no-application boundary. |
| `CHANGELOG.md` | Unreleased command and proof limitations. |

---

### Task 1: Pure entity-update frame decoder

**Files:**
- Create: `src/network-replication-inspection.ts`
- Create: `test/network-replication-inspection.test.mjs`

**Interfaces:**
- Produces: `decodeReplicationFrame(bytes: Uint8Array): ReplicationDecodeResult`
- Produces: stable `ReplicationFinding`, `ReplicationField`, `ReplicationEntity`, and `ReplicationDecodeResult` types
- Produces exported constants `ENTITY_UPDATE_OPCODE`, `MAX_REPLICATION_FRAME_BYTES`, `MAX_REPLICATION_ENTITY_DETAILS`, and `MAX_REPLICATION_FINDINGS`

- [ ] **Step 1: Write the failing canonical frame test**

Create `test/network-replication-inspection.test.mjs`. Build the complete
41-byte fixture independently from the Zig test:

```js
const canonicalFrame = Buffer.from([
  0x00, 0x00, 0x00, 0x25, // total_len = opcode 2 + payload 35
  0x00, 0x50,             // entity_update = 80
  0x00, 0x01,             // one entity
  0x00, 0x00, 0x00, 0x1d, // delta_size = 29
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x04,
  0x01, 0x3f, 0x80, 0x00, 0x00, // pos_x = 1.0
  0x02, 0xc0, 0x00, 0x00, 0x00, // pos_y = -2.0
  0x03, 0x40, 0x60, 0x00, 0x00, // pos_z = 3.5
  0x0a, 0x00, 0x00, 0x00, 0x64, // health = 100
]);
```

Assert literal results:

```js
const decoded = decodeReplicationFrame(canonicalFrame);
assert.equal(decoded.complete, true);
assert.equal(decoded.structurallyValid, true);
assert.deepEqual(decoded.frame, {
  bytes: 41,
  declaredLength: 37,
  payloadBytes: 35,
  entityCount: 1,
  detailedEntities: 1,
  omittedEntities: 0,
});
assert.deepEqual(decoded.entities[0], {
  entityId: "1",
  deltaSize: 29,
  fieldCount: 4,
  fields: [
    { id: 1, name: "pos_x", kind: "f32", rawHex: "3f800000", value: 1 },
    { id: 2, name: "pos_y", kind: "f32", rawHex: "c0000000", value: -2 },
    { id: 3, name: "pos_z", kind: "f32", rawHex: "40600000", value: 3.5 },
    { id: 10, name: "health", kind: "u32", rawHex: "00000064", value: 100 },
  ],
});
assert.deepEqual(decoded.findings, []);
```

- [ ] **Step 2: Run and verify RED**

```powershell
rtk npm run build
rtk proxy node --test test/network-replication-inspection.test.mjs
```

Expected: module resolution fails because
`dist/network-replication-inspection.js` does not exist.

- [ ] **Step 3: Define the public decoder contracts**

Implement these exact constants and shapes:

```ts
export const ENTITY_UPDATE_OPCODE = 80;
export const MAX_REPLICATION_FRAME_BYTES = 65_542;
export const MAX_REPLICATION_ENTITY_DETAILS = 256;
export const MAX_REPLICATION_FINDINGS = 128;

export interface ReplicationFinding {
  severity: "error";
  code: string;
  offset: number | null;
  message: string;
}

export interface ReplicationField {
  id: number;
  name: "pos_x" | "pos_y" | "pos_z" | "vel_x" | "vel_z" | "rot_y" | "health";
  kind: "f32" | "u32";
  rawHex: string;
  value: number;
}

export interface ReplicationEntity {
  entityId: string;
  deltaSize: number;
  fieldCount: number;
  fields: ReplicationField[];
}
```

`ReplicationDecodeResult` contains `complete`, `structurallyValid`, the exact
`frame` summary from Step 1, bounded `entities`, and sorted `findings`.

- [ ] **Step 4: Implement the minimal successful decoder**

Use `DataView` over the exact `Uint8Array` window so non-zero byte offsets are
handled correctly. Read all multi-byte values big-endian. Maintain a numeric
cursor and check `needed <= bytes.length - cursor` before every read. Decode
`u64` with `getBigUint64(..., false).toString(10)`.

Map fields with a closed table:

```ts
const FIELD_CONTRACT = new Map([
  [1, { name: "pos_x", kind: "f32", order: 0 }],
  [2, { name: "pos_y", kind: "f32", order: 1 }],
  [3, { name: "pos_z", kind: "f32", order: 2 }],
  [4, { name: "vel_x", kind: "f32", order: 3 }],
  [6, { name: "vel_z", kind: "f32", order: 4 }],
  [7, { name: "rot_y", kind: "f32", order: 5 }],
  [10, { name: "health", kind: "u32", order: 6 }],
]);
```

For valid frames, consume exactly the declared count and require the final
cursor to equal `bytes.length`.

- [ ] **Step 5: Add the valid empty-batch and maximum-u64 tests**

Assert `[00 00 00 04][00 50][00 00]` is valid with no entities. Create a
one-entity, zero-field delta whose ID is `0xffffffffffffffff` and assert the
literal string `"18446744073709551615"`.

- [ ] **Step 6: Write table-driven structural negative tests**

For fresh copies of controlled buffers, cover:

- fewer than eight bytes;
- declared length below four, above the file length, or unequal to
  `bytes.length - 4`;
- opcode `79` and `81`;
- count `0` with a final byte;
- count `2` with one record;
- truncated delta-size and delta payload;
- delta sizes `8`, `10` for zero fields, and `45`;
- entity ID zero;
- field count eight;
- unknown ID `5`;
- duplicate ID `1`;
- order `2,1`;
- NaN bits `0x7fc00000`, positive infinity `0x7f800000`, and negative infinity
  `0xff800000`.

Assert stable codes and exact byte offsets rather than message text. Invalid
frames remain `complete: true` unless findings overflow.

- [ ] **Step 7: Implement strict negative validation and finding bounds**

Require canonical field order using the table's `order`, reject repeated IDs,
and use `Number.isFinite` for decoded floats. Continue across records only when
the current delta boundary remains known. Sort findings by code, numeric offset
(`null` last), and message.

Construct 129 validly framed one-field entities containing NaN to force finding
overflow. Keep the first 127 sorted findings plus one
`REPLICATION_FINDINGS_TRUNCATED`; set `complete: false`.

- [ ] **Step 8: Add and implement the 256-entity detail cap**

Build 257 valid zero-field entities. Assert `entityCount == 257`,
`detailedEntities == 256`, `omittedEntities == 1`, `entities.length == 256`,
`complete == true`, and `structurallyValid == true`. Parse and validate the
257th record even though its summary is not retained.

- [ ] **Step 9: Verify and commit Task 1**

```powershell
rtk npm run build
rtk proxy node --test test/network-replication-inspection.test.mjs
rtk git diff --check
rtk git add -- src/network-replication-inspection.ts test/network-replication-inspection.test.mjs
rtk git commit -m "feat: decode entity replication frames" -- src/network-replication-inspection.ts test/network-replication-inspection.test.mjs
```

---

### Task 2: Confined file inspection and integrity evidence

**Files:**
- Modify: `src/network-replication-inspection.ts`
- Modify: `test/network-replication-inspection.test.mjs`

**Interfaces:**
- Consumes: `decodeReplicationFrame(bytes)` from Task 1
- Produces: `inspectReplicationFrame(options: { frame: string }): Promise<ReplicationInspectionReport>`
- Produces: `replicationSourceSnapshotsMatch(initial, final): boolean`

- [ ] **Step 1: Write the failing regular-file inspection test**

Write `canonicalFrame` to a temporary `capture.bin`, call
`inspectReplicationFrame({ frame })`, and assert:

```js
assert.equal(report.status, "ok");
assert.equal(report.complete, true);
assert.equal(report.structurallyValid, true);
assert.equal(report.frameFile, await fs.realpath(frame));
assert.equal(report.contract.authority, "zig-server-v2");
assert.equal(report.contract.messageType, "entity_update");
assert.equal(report.contract.opcode, 80);
assert.equal(report.contract.byteOrder, "big-endian");
assert.equal(report.contract.maxFrameBytes, 65542);
assert.equal(report.integrity.bytes, 41);
assert.match(report.integrity.sha256, /^[0-9a-f]{64}$/);
assert.equal(report.integrity.unchanged, true);
assert.equal(report.boundaries.length > 6, true);
```

- [ ] **Step 2: Run and verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="regular replication file" test/network-replication-inspection.test.mjs
```

Expected: `inspectReplicationFrame` is not exported.

- [ ] **Step 3: Implement bounded file loading**

Require a case-insensitive `.bin` extension, `lstat().isFile()`, no symbolic
link, `realpath` identity, and an initial size not exceeding 65,542. Open a
read-only file handle, verify its handle stat, and read at most 65,543 bytes in
a loop. Never call unbounded `readFile` after a size-only check.

Build the report around Task 1's decode result. File/confinement failures return
a bounded error report with empty entities, `complete: false`, and
`integrity.unchanged: false`.

- [ ] **Step 4: Add filesystem rejection tests**

Cover missing path, `.dat`, directory named `capture.bin`, symbolic link when
the platform permits it, and a 65,543-byte sparse file. Assert respectively
`REPLICATION_FILE_UNREADABLE`, `REPLICATION_FILE_INVALID`, and
`REPLICATION_FILE_TOO_LARGE` without reading an oversized payload.

- [ ] **Step 5: Implement deterministic source comparison**

Define:

```ts
export interface ReplicationSourceSnapshot {
  regular: boolean;
  bytes: number;
  sha256: string;
}

export function replicationSourceSnapshotsMatch(
  initial: ReplicationSourceSnapshot,
  final: ReplicationSourceSnapshot,
): boolean;
```

Return true only when both are regular and all byte/hash values match. Test
type, size, and hash mutations independently. The filesystem inspector creates
both snapshots through separate bounded handle reads and emits
`REPLICATION_SOURCE_CHANGED` when comparison fails.

- [ ] **Step 6: Verify source immutability and file report failures**

Assert the valid input bytes are unchanged after inspection. Assert a malformed
but stable frame returns `status: "error"`, `complete: true`,
`structurallyValid: false`, and `integrity.unchanged: true`.

- [ ] **Step 7: Verify and commit Task 2**

```powershell
rtk npm run build
rtk proxy node --test test/network-replication-inspection.test.mjs
rtk npm test
rtk git diff --check
rtk git add -- src/network-replication-inspection.ts test/network-replication-inspection.test.mjs
rtk git commit -m "feat: inspect bounded replication files" -- src/network-replication-inspection.ts test/network-replication-inspection.test.mjs
```

---

### Task 3: CLI and installed-package behavior

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/network-replication-inspection.test.mjs`
- Modify: `test/package-consumer.test.mjs`

**Interfaces:**
- Consumes: `inspectReplicationFrame({ frame })`
- Produces: `uo-godot-cli network replication inspect <frame.bin>`

- [ ] **Step 1: Write failing CLI tests**

Spawn the built CLI with a real temporary canonical frame. Assert exit `0`,
JSON-only stdout, empty stderr, exact opcode/identity/health values, and
unchanged source bytes. Change the opcode to `81` and assert exit `1` with a
structured report containing `REPLICATION_OPCODE_INVALID`.

Run `network replication --help` and assert it exposes `inspect`. Invoke
`connect`, `listen`, `capture`, `replay`, `send`, `interpolate`, and `apply` and
assert each remains an unknown command.

- [ ] **Step 2: Run and verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="replication inspect CLI" test/network-replication-inspection.test.mjs
```

Expected: Commander rejects the unknown `network` command.

- [ ] **Step 3: Register the nested command only**

Add the import and exact command group:

```ts
const networkCommands = program
  .command("network")
  .description("Inspect captured Ultimate Odycer wire data without connecting");

const replicationCommands = networkCommands
  .command("replication")
  .description("Inspect entity_update replication frames");

replicationCommands
  .command("inspect")
  .description("Validate one captured entity_update=80 binary frame")
  .argument("<frame>", "Explicit local .bin frame")
  .action(async (frame: string) => {
    try {
      const report = await inspectReplicationFrame({ frame });
      printLocalResult(report);
      if (report.status !== "ok") process.exitCode = 1;
    } catch (error) {
      reportLocalError(error);
    }
  });
```

Add one tokenless local-inspection line to `printOverview`. Do not add root
host/port usage to this command or change the runtime client.

- [ ] **Step 4: Add the installed-package test**

Inside the existing package-consumer temporary root, write the literal
canonical frame, invoke the installed CLI, and assert success, entity ID
`"1"`, `health == 100`, SHA-256 presence, and byte-identical source afterward.

- [ ] **Step 5: Verify and commit Task 3**

```powershell
rtk npm run build
rtk proxy node --test test/network-replication-inspection.test.mjs
rtk npm test
rtk git diff --check
rtk git add -- src/cli.ts test/network-replication-inspection.test.mjs test/package-consumer.test.mjs
rtk git commit -m "feat: expose replication frame inspection" -- src/cli.ts test/network-replication-inspection.test.mjs test/package-consumer.test.mjs
```

---

### Task 4: Zig parity, documentation, gates, and review

**Files:**
- Create: `test/network-replication-server-parity.test.mjs`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: test-only `UO_ZIG_SERVER_ROOT`
- Produces: separate authoritative replication parity evidence

- [ ] **Step 1: Add the optional Zig parity test**

Skip visibly when `UO_ZIG_SERVER_ROOT` is absent. When present, canonicalize
the root and require these exact regular files:

```text
src/network/replication.zig
src/core/protocol_fields.zig
src/networking/handlers/entity.zig
src/main.zig
```

Capture `git status --porcelain --` for only those paths, then launch directly
without a shell:

```text
zig build test-replication --summary all
```

Use a 60-second timeout and 1 MiB combined-output limit. Require exit zero,
`5/5 tests passed`, `test-replication success`, no retained child, and identical
scoped Git status. The build step is mandatory because direct `zig test` lacks
the `ecs` and `types` module imports configured by `build.zig`. Do not feed
parity into production reports.

- [ ] **Step 2: Update user and security documentation**

README documents command usage, the full envelope, current field table,
65,542-byte limit, 256-detail cap, exit behavior, and optional parity. SECURITY
documents file confinement, bounded handle reads, precision-safe IDs, finite
float enforcement, and no socket/application boundary. CHANGELOG records the
inspection command and explicitly excludes capture, replay, interpolation,
Godot mutation, and live EntitySync.

- [ ] **Step 3: Run the fully configured gate**

```powershell
rtk npm run build
rtk proxy cmd /d /s /c "set GODOT_BIN=F:\foveaengine\fovea-engine\.codex\tools\godot-4.7-dev5\Godot_v4.7-dev5_mono_win64\Godot_v4.7-dev5_mono_win64_console.exe&& set FOVEA_PROJECT_ROOT=F:\foveaengine\fovea-engine&& set UO_TEMPLATE_REGISTRY_ROOT=F:\_Serv ULtimate Od\artifacts\github-prep\ultod-json-template-registry&& set UO_ZIG_SERVER_ROOT=F:\_Serv ULtimate Od\Development\Backend\Servers\zig-server-v2&& npm test"
```

Record exact pass/fail/skip totals. A native Godot crash remains a real failed
gate; rerun only to distinguish a transient engine failure and report both
results.

- [ ] **Step 4: Run release and drift gates**

```powershell
rtk npm audit --omit=dev --audit-level=moderate
rtk npm publish --dry-run
rtk git diff --check
rtk proxy cmd /d /s /c "set PYTHONPATH=C:\Users\redga\botte-secrete&& python -m skills.checkup.cli ."
```

Keep checkup infrastructure warnings separate from feature correctness.

- [ ] **Step 5: Re-run authoritative Zig parity separately**

```powershell
rtk zig build test-replication --summary all
rtk git status --short -- src/network/replication.zig src/core/protocol_fields.zig src/networking/handlers/entity.zig src/main.zig
```

Run from `Development/Backend/Servers/zig-server-v2`. Record exact totals and
pre-existing scoped status without editing or cleaning it.

- [ ] **Step 6: Review scope and commit documentation/parity**

Confirm the production diff contains no `node:net`, socket, `fetch`, server
process, packet send, capture, replay, interpolation, Godot mutation, addon/MCP
change, dependency, or Zig file. Confirm every detailed entity cap and finding
cap is exercised by behavior tests.

```powershell
rtk git add -- test/network-replication-server-parity.test.mjs README.md SECURITY.md CHANGELOG.md
rtk git commit -m "docs: document replication inspection boundary" -- test/network-replication-server-parity.test.mjs README.md SECURITY.md CHANGELOG.md
```

- [ ] **Step 7: Request final code review**

Review the complete feature range against the design, focusing on byte-order,
offset arithmetic, `Uint8Array` windows, integer precision, bounds-before-read,
finding truncation, source races, field order, non-finite floats, stdout size,
and accidental live-network or gameplay claims. Fix every Critical or Important
finding with a failing regression test and repeat the review.
