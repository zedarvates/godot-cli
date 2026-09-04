import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decodeReplicationFrame,
  inspectReplicationFrame,
  replicationSourceSnapshotsMatch,
} from "../dist/network-replication-inspection.js";

const canonicalFrame = Buffer.from([
  0x00, 0x00, 0x00, 0x25,
  0x00, 0x50,
  0x00, 0x01,
  0x00, 0x00, 0x00, 0x1d,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  0x04,
  0x01, 0x3f, 0x80, 0x00, 0x00,
  0x02, 0xc0, 0x00, 0x00, 0x00,
  0x03, 0x40, 0x60, 0x00, 0x00,
  0x0a, 0x00, 0x00, 0x00, 0x64,
]);

function wrapPayload(payload, opcode = 80) {
  const frame = Buffer.alloc(6 + payload.length);
  frame.writeUInt32BE(2 + payload.length, 0);
  frame.writeUInt16BE(opcode, 4);
  payload.copy(frame, 6);
  return frame;
}

function entityDelta(entityId, fields) {
  const delta = Buffer.alloc(9 + fields.length * 5);
  delta.writeBigUInt64BE(BigInt(entityId), 0);
  delta.writeUInt8(fields.length, 8);
  fields.forEach(({ id, raw }, index) => {
    const offset = 9 + index * 5;
    delta.writeUInt8(id, offset);
    delta.writeUInt32BE(raw >>> 0, offset + 1);
  });
  return delta;
}

function replicationFrame(deltas) {
  const payloadBytes = 2 + deltas.reduce((total, delta) => total + 4 + delta.length, 0);
  const payload = Buffer.alloc(payloadBytes);
  payload.writeUInt16BE(deltas.length, 0);
  let offset = 2;
  for (const delta of deltas) {
    payload.writeUInt32BE(delta.length, offset);
    offset += 4;
    delta.copy(payload, offset);
    offset += delta.length;
  }
  return wrapPayload(payload);
}

function findingCodes(decoded) {
  return decoded.findings.map((finding) => finding.code);
}

test("decodes the canonical entity_update frame without losing wire values", () => {
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
});

test("accepts an empty batch and preserves maximum u64 identity", () => {
  const empty = decodeReplicationFrame(Buffer.from([
    0x00, 0x00, 0x00, 0x04,
    0x00, 0x50,
    0x00, 0x00,
  ]));
  assert.equal(empty.structurallyValid, true);
  assert.equal(empty.frame.entityCount, 0);
  assert.deepEqual(empty.entities, []);

  const maximum = decodeReplicationFrame(
    replicationFrame([entityDelta(0xffffffffffffffffn, [])]),
  );
  assert.equal(maximum.structurallyValid, true);
  assert.equal(maximum.entities[0].entityId, "18446744073709551615");
});

test("rejects invalid outer frames at exact byte offsets", () => {
  const declaredMismatch = Buffer.from(canonicalFrame);
  declaredMismatch.writeUInt32BE(36, 0);
  const countMismatch = Buffer.from(canonicalFrame);
  countMismatch.writeUInt16BE(2, 6);
  const cases = [
    [Buffer.alloc(7), "REPLICATION_FRAME_INVALID", 0],
    [declaredMismatch, "REPLICATION_FRAME_INVALID", 0],
    [wrapPayload(Buffer.from([0x00, 0x00]), 81), "REPLICATION_OPCODE_INVALID", 4],
    [wrapPayload(Buffer.from([0x00, 0x00, 0xff])), "REPLICATION_COUNT_MISMATCH", 8],
    [countMismatch, "REPLICATION_COUNT_MISMATCH", 41],
    [wrapPayload(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00])), "REPLICATION_COUNT_MISMATCH", 8],
  ];

  for (const [frame, code, offset] of cases) {
    const decoded = decodeReplicationFrame(frame);
    assert.equal(decoded.structurallyValid, false, code);
    assert.equal(decoded.complete, true, code);
    assert.equal(decoded.findings[0].code, code);
    assert.equal(decoded.findings[0].offset, offset);
  }
});

test("rejects invalid delta sizes, field counts, and zero entity identity", () => {
  const zeroId = Buffer.from(canonicalFrame);
  zeroId.fill(0, 12, 20);
  const tooManyFields = entityDelta(1n, [
    { id: 1, raw: 0 }, { id: 2, raw: 0 }, { id: 3, raw: 0 },
    { id: 4, raw: 0 }, { id: 6, raw: 0 }, { id: 7, raw: 0 },
    { id: 10, raw: 0 }, { id: 10, raw: 0 },
  ]);
  const malformedDeltas = [
    Buffer.alloc(8),
    Buffer.concat([entityDelta(1n, []), Buffer.from([0])]),
    Buffer.concat([entityDelta(1n, [
      { id: 1, raw: 0 }, { id: 2, raw: 0 }, { id: 3, raw: 0 },
      { id: 4, raw: 0 }, { id: 6, raw: 0 }, { id: 7, raw: 0 },
      { id: 10, raw: 0 },
    ]), Buffer.from([0])]),
    tooManyFields,
  ];

  assert.equal(findingCodes(decodeReplicationFrame(zeroId)).includes("REPLICATION_DELTA_INVALID"), true);
  for (const delta of malformedDeltas) {
    const decoded = decodeReplicationFrame(replicationFrame([delta]));
    assert.equal(decoded.structurallyValid, false);
    assert.equal(findingCodes(decoded).includes("REPLICATION_DELTA_INVALID"), true);
  }
});

test("rejects unknown, duplicate, and out-of-order fields", () => {
  const cases = [
    entityDelta(1n, [{ id: 5, raw: 0 }]),
    entityDelta(1n, [{ id: 1, raw: 0 }, { id: 1, raw: 0 }]),
    entityDelta(1n, [{ id: 2, raw: 0 }, { id: 1, raw: 0 }]),
  ];
  for (const delta of cases) {
    const decoded = decodeReplicationFrame(replicationFrame([delta]));
    assert.equal(decoded.structurallyValid, false);
    assert.equal(findingCodes(decoded).includes("REPLICATION_FIELD_INVALID"), true);
  }
});

test("rejects non-finite float bit patterns without emitting non-JSON numbers", () => {
  for (const raw of [0x7fc00000, 0x7f800000, 0xff800000]) {
    const decoded = decodeReplicationFrame(
      replicationFrame([entityDelta(1n, [{ id: 1, raw }])]),
    );
    assert.equal(decoded.structurallyValid, false);
    assert.equal(findingCodes(decoded).includes("REPLICATION_FLOAT_NON_FINITE"), true);
    assert.equal(decoded.entities[0].fields[0].value, null);
    assert.doesNotThrow(() => JSON.stringify(decoded));
  }
});

test("truncates findings fail-closed while retaining the truncation marker", () => {
  const deltas = Array.from(
    { length: 129 },
    (_, index) => entityDelta(BigInt(index + 1), [{ id: 1, raw: 0x7fc00000 }]),
  );
  const decoded = decodeReplicationFrame(replicationFrame(deltas));
  assert.equal(decoded.complete, false);
  assert.equal(decoded.structurallyValid, false);
  assert.equal(decoded.findings.length, 128);
  assert.equal(findingCodes(decoded).includes("REPLICATION_FINDINGS_TRUNCATED"), true);
});

test("validates every entity while bounding returned details", () => {
  const deltas = Array.from(
    { length: 257 },
    (_, index) => entityDelta(BigInt(index + 1), []),
  );
  const decoded = decodeReplicationFrame(replicationFrame(deltas));
  assert.equal(decoded.complete, true);
  assert.equal(decoded.structurallyValid, true);
  assert.equal(decoded.frame.entityCount, 257);
  assert.equal(decoded.frame.detailedEntities, 256);
  assert.equal(decoded.frame.omittedEntities, 1);
  assert.equal(decoded.entities.length, 256);
  assert.equal(decoded.entities.at(-1).entityId, "256");
});

test("inspects a regular replication file with stable integrity evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-replication-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "capture.bin");
  await fs.writeFile(frame, canonicalFrame);

  const report = await inspectReplicationFrame({ frame });

  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.structurallyValid, true);
  assert.equal(report.frameFile, await fs.realpath(frame));
  assert.deepEqual(report.contract, {
    authority: "zig-server-v2",
    messageType: "entity_update",
    opcode: 80,
    byteOrder: "big-endian",
    maxFrameBytes: 65542,
  });
  assert.equal(report.integrity.bytes, 41);
  assert.match(report.integrity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.integrity.unchanged, true);
  assert.equal(report.boundaries.length > 6, true);
  assert.deepEqual(await fs.readFile(frame), canonicalFrame);
});

test("rejects unreadable, non-bin, directory, symbolic, and oversized sources", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-replication-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const missing = await inspectReplicationFrame({ frame: path.join(root, "missing.bin") });
  assert.equal(findingCodes(missing).includes("REPLICATION_FILE_UNREADABLE"), true);

  const wrongExtension = path.join(root, "capture.dat");
  await fs.writeFile(wrongExtension, canonicalFrame);
  const wrong = await inspectReplicationFrame({ frame: wrongExtension });
  assert.equal(findingCodes(wrong).includes("REPLICATION_FILE_INVALID"), true);

  const directory = path.join(root, "directory.bin");
  await fs.mkdir(directory);
  const directoryReport = await inspectReplicationFrame({ frame: directory });
  assert.equal(findingCodes(directoryReport).includes("REPLICATION_FILE_INVALID"), true);

  const target = path.join(root, "target.bin");
  const link = path.join(root, "link.bin");
  await fs.writeFile(target, canonicalFrame);
  try {
    await fs.symlink(target, link, "file");
    const linked = await inspectReplicationFrame({ frame: link });
    assert.equal(findingCodes(linked).includes("REPLICATION_FILE_INVALID"), true);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }

  const oversized = path.join(root, "oversized.bin");
  const handle = await fs.open(oversized, "w");
  try {
    await handle.truncate(65_543);
  } finally {
    await handle.close();
  }
  const large = await inspectReplicationFrame({ frame: oversized });
  assert.equal(findingCodes(large).includes("REPLICATION_FILE_TOO_LARGE"), true);
});

test("source snapshot comparison fails on type, size, or hash drift", () => {
  const initial = { regular: true, bytes: 41, sha256: "a".repeat(64) };
  assert.equal(replicationSourceSnapshotsMatch(initial, { ...initial }), true);
  assert.equal(replicationSourceSnapshotsMatch(initial, { ...initial, regular: false }), false);
  assert.equal(replicationSourceSnapshotsMatch(initial, { ...initial, bytes: 42 }), false);
  assert.equal(replicationSourceSnapshotsMatch(initial, { ...initial, sha256: "b".repeat(64) }), false);
});

test("a stable malformed frame is invalid but completely inspected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-replication-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "capture.bin");
  const malformed = Buffer.from(canonicalFrame);
  malformed.writeUInt16BE(81, 4);
  await fs.writeFile(frame, malformed);

  const report = await inspectReplicationFrame({ frame });

  assert.equal(report.status, "error");
  assert.equal(report.complete, true);
  assert.equal(report.structurallyValid, false);
  assert.equal(report.integrity.unchanged, true);
  assert.equal(findingCodes(report).includes("REPLICATION_OPCODE_INVALID"), true);
  assert.deepEqual(await fs.readFile(frame), malformed);
});
