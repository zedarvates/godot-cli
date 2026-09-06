import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decodeVrRequestFrame,
  inspectVrRequestFrame,
} from "../dist/network-vr-request-inspection.js";

const grabFrame = Buffer.from([
  0x00, 0x00, 0x00, 0x0b,
  0x00, 0x80,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x01,
]);

const releaseFrame = Buffer.from([
  0x00, 0x00, 0x00, 0x22,
  0x00, 0x81,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a,
  0x3f, 0xa0, 0x00, 0x00,
  0xc0, 0x20, 0x00, 0x00,
  0x40, 0x70, 0x00, 0x00,
  0xc0, 0x80, 0x00, 0x00,
  0x40, 0xb0, 0x00, 0x00,
  0xc0, 0xc8, 0x00, 0x00,
]);

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("decodes the authoritative right-hand VR grab request", () => {
  const decoded = decodeVrRequestFrame(grabFrame);

  assert.equal(decoded.complete, true);
  assert.equal(decoded.structurallyValid, true);
  assert.equal(decoded.serverValidationRequired, true);
  assert.deepEqual(decoded.frame, {
    bytes: 15,
    declaredLength: 11,
    payloadBytes: 9,
    opcode: 128,
    requestType: "grab",
  });
  assert.deepEqual(decoded.request, {
    requestType: "grab",
    objectId: "72623859790382856",
    hand: "right",
  });
  assert.deepEqual(decoded.findings, []);
});

test("decodes the authoritative VR release request velocities", () => {
  const decoded = decodeVrRequestFrame(releaseFrame);

  assert.equal(decoded.complete, true);
  assert.equal(decoded.structurallyValid, true);
  assert.equal(decoded.serverValidationRequired, true);
  assert.deepEqual(decoded.frame, {
    bytes: 38,
    declaredLength: 34,
    payloadBytes: 32,
    opcode: 129,
    requestType: "release",
  });
  assert.deepEqual(decoded.request, {
    requestType: "release",
    objectId: "42",
    linearVelocity: { x: 1.25, y: -2.5, z: 3.75 },
    angularVelocity: { x: -4, y: 5.5, z: -6.25 },
  });
  assert.deepEqual(decoded.findings, []);
});

test("preserves the left hand and defers object existence to the server", () => {
  const frame = Buffer.from(grabFrame);
  frame.fill(0, 6, 14);
  frame[14] = 0;

  const decoded = decodeVrRequestFrame(frame);

  assert.equal(decoded.structurallyValid, true);
  assert.deepEqual(decoded.request, {
    requestType: "grab",
    objectId: "0",
    hand: "left",
  });
  assert.equal(decoded.serverValidationRequired, true);
});

test("rejects invalid envelope lengths, broadcasts, opcodes, and grab hands", () => {
  const wrongDeclaredLength = Buffer.from(grabFrame);
  wrongDeclaredLength.writeUInt32BE(10, 0);
  const invalidHand = Buffer.from(grabFrame);
  invalidHand[14] = 2;
  const grabBroadcast = Buffer.alloc(23);
  grabBroadcast.writeUInt32BE(19, 0);
  grabBroadcast.writeUInt16BE(128, 4);
  const releaseBroadcast = Buffer.alloc(22);
  releaseBroadcast.writeUInt32BE(18, 0);
  releaseBroadcast.writeUInt16BE(129, 4);
  const unknownOpcode = Buffer.from(grabFrame);
  unknownOpcode.writeUInt16BE(130, 4);
  const cases = [
    [Buffer.alloc(5), "VR_REQUEST_FRAME_INVALID", 0],
    [Buffer.alloc(39), "VR_REQUEST_FRAME_INVALID", 0],
    [wrongDeclaredLength, "VR_REQUEST_FRAME_INVALID", 0],
    [unknownOpcode, "VR_REQUEST_OPCODE_INVALID", 4],
    [grabBroadcast, "VR_REQUEST_LENGTH_INVALID", 6],
    [releaseBroadcast, "VR_REQUEST_LENGTH_INVALID", 6],
    [invalidHand, "VR_REQUEST_HAND_INVALID", 14],
  ];

  for (const [frame, code, offset] of cases) {
    const decoded = decodeVrRequestFrame(frame);
    assert.equal(decoded.complete, true, code);
    assert.equal(decoded.structurallyValid, false, code);
    assert.equal(decoded.request, null, code);
    assert.equal(decoded.findings[0].code, code);
    assert.equal(decoded.findings[0].offset, offset);
  }
});

test("rejects every non-finite release velocity without unsafe JSON values", () => {
  for (const [offset, raw] of [
    [14, 0x7fc00000],
    [18, 0x7f800000],
    [34, 0xff800000],
  ]) {
    const frame = Buffer.from(releaseFrame);
    frame.writeUInt32BE(raw, offset);
    const decoded = decodeVrRequestFrame(frame);
    assert.equal(decoded.structurallyValid, false);
    assert.equal(decoded.request, null);
    assert.equal(decoded.findings[0].code, "VR_REQUEST_FLOAT_NON_FINITE");
    assert.equal(decoded.findings[0].offset, offset);
    assert.doesNotThrow(() => JSON.stringify(decoded));
  }
});

test("decodes an exact Uint8Array window rather than its backing buffer", () => {
  const backing = Buffer.concat([Buffer.from([0xaa, 0xbb]), grabFrame, Buffer.from([0xcc])]);
  const window = new Uint8Array(backing.buffer, backing.byteOffset + 2, grabFrame.length);

  const decoded = decodeVrRequestFrame(window);

  assert.equal(decoded.structurallyValid, true);
  assert.equal(decoded.request.objectId, "72623859790382856");
});

test("inspects a regular VR request file with stable integrity evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-vr-request-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "grab.bin");
  await fs.writeFile(frame, grabFrame);

  const report = await inspectVrRequestFrame({ frame });

  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.structurallyValid, true);
  assert.equal(report.serverValidationRequired, true);
  assert.equal(report.frameFile, await fs.realpath(frame));
  assert.deepEqual(report.contract, {
    authority: "zig-server-v2",
    direction: "client-to-server",
    byteOrder: "big-endian",
    opcodes: { grab: 128, release: 129 },
    maxFrameBytes: 38,
  });
  assert.equal(report.integrity.bytes, 15);
  assert.match(report.integrity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.integrity.unchanged, true);
  assert.equal(report.boundaries.length > 6, true);
  assert.deepEqual(await fs.readFile(frame), grabFrame);
});

test("rejects unreadable, non-bin, directory, symbolic, and oversized VR sources", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-vr-request-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const missing = await inspectVrRequestFrame({ frame: path.join(root, "missing.bin") });
  assert.equal(missing.findings[0].code, "VR_REQUEST_FILE_UNREADABLE");

  const wrongExtension = path.join(root, "grab.dat");
  await fs.writeFile(wrongExtension, grabFrame);
  assert.equal(
    (await inspectVrRequestFrame({ frame: wrongExtension })).findings[0].code,
    "VR_REQUEST_FILE_INVALID",
  );

  const directory = path.join(root, "directory.bin");
  await fs.mkdir(directory);
  assert.equal(
    (await inspectVrRequestFrame({ frame: directory })).findings[0].code,
    "VR_REQUEST_FILE_INVALID",
  );

  const target = path.join(root, "target.bin");
  const link = path.join(root, "link.bin");
  await fs.writeFile(target, grabFrame);
  try {
    await fs.symlink(target, link, "file");
    assert.equal(
      (await inspectVrRequestFrame({ frame: link })).findings[0].code,
      "VR_REQUEST_FILE_INVALID",
    );
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }

  const oversized = path.join(root, "oversized.bin");
  await fs.writeFile(oversized, Buffer.alloc(39));
  assert.equal(
    (await inspectVrRequestFrame({ frame: oversized })).findings[0].code,
    "VR_REQUEST_FILE_TOO_LARGE",
  );
});

test("a stable malformed VR frame is invalid but completely inspected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-vr-request-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "grab.bin");
  const invalid = Buffer.from(grabFrame);
  invalid[14] = 2;
  await fs.writeFile(frame, invalid);

  const report = await inspectVrRequestFrame({ frame });

  assert.equal(report.status, "error");
  assert.equal(report.complete, true);
  assert.equal(report.structurallyValid, false);
  assert.equal(report.integrity.unchanged, true);
  assert.equal(report.findings[0].code, "VR_REQUEST_HAND_INVALID");
  assert.deepEqual(await fs.readFile(frame), invalid);
});

test("VR request inspect CLI emits JSON and preserves status and bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-vr-request-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "request.bin");

  await fs.writeFile(frame, grabFrame);
  const grab = await runCli(["network", "vr-request", "inspect", frame]);
  assert.equal(grab.code, 0);
  assert.equal(grab.stderr, "");
  const grabReport = JSON.parse(grab.stdout);
  assert.equal(grabReport.status, "ok");
  assert.equal(grabReport.request.objectId, "72623859790382856");
  assert.equal(grabReport.request.hand, "right");
  assert.equal(grabReport.serverValidationRequired, true);
  assert.deepEqual(await fs.readFile(frame), grabFrame);

  await fs.writeFile(frame, releaseFrame);
  const release = await runCli(["network", "vr-request", "inspect", frame]);
  assert.equal(release.code, 0);
  assert.equal(release.stderr, "");
  assert.deepEqual(JSON.parse(release.stdout).request.angularVelocity, {
    x: -4,
    y: 5.5,
    z: -6.25,
  });

  const invalid = Buffer.from(grabFrame);
  invalid[14] = 2;
  await fs.writeFile(frame, invalid);
  const failure = await runCli(["network", "vr-request", "inspect", frame]);
  assert.equal(failure.code, 1);
  assert.equal(failure.stderr, "");
  assert.equal(JSON.parse(failure.stdout).findings[0].code, "VR_REQUEST_HAND_INVALID");
});

test("network VR request exposes inspect only", async () => {
  const help = await runCli(["network", "vr-request", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: uo-godot-cli network vr-request/);
  assert.match(help.stdout, /inspect/);
  for (const forbidden of [
    "broadcast", "pose", "voice", "locomotion", "connect", "replay", "send", "apply",
  ]) {
    const result = await runCli(["network", "vr-request", forbidden]);
    assert.notEqual(result.code, 0, forbidden);
  }
});
