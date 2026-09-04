import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const VR_GRAB_OPCODE = 128;
export const VR_RELEASE_OPCODE = 129;
export const VR_GRAB_FRAME_BYTES = 15;
export const VR_RELEASE_FRAME_BYTES = 38;
export const MAX_VR_REQUEST_FRAME_BYTES = VR_RELEASE_FRAME_BYTES;

export interface VrRequestFinding {
  severity: "error";
  code: string;
  offset: number | null;
  message: string;
}

export type VrGrabRequest = {
  requestType: "grab";
  objectId: string;
  hand: "left" | "right";
};

export type VrReleaseRequest = {
  requestType: "release";
  objectId: string;
  linearVelocity: { x: number; y: number; z: number };
  angularVelocity: { x: number; y: number; z: number };
};

export interface VrRequestDecodeResult {
  complete: boolean;
  structurallyValid: boolean;
  serverValidationRequired: true;
  frame: {
    bytes: number;
    declaredLength: number | null;
    payloadBytes: number | null;
    opcode: number | null;
    requestType: "grab" | "release" | null;
  };
  request: VrGrabRequest | VrReleaseRequest | null;
  findings: VrRequestFinding[];
}

export interface VrRequestInspectionReport extends VrRequestDecodeResult {
  status: "ok" | "error";
  frameFile: string;
  contract: {
    authority: "zig-server-v2";
    direction: "client-to-server";
    byteOrder: "big-endian";
    opcodes: { grab: 128; release: 129 };
    maxFrameBytes: 38;
  };
  integrity: { bytes: number; sha256: string; unchanged: boolean };
  boundaries: string[];
}

function addFinding(
  result: VrRequestDecodeResult,
  code: string,
  offset: number | null,
  message: string,
): VrRequestDecodeResult {
  result.findings.push({ severity: "error", code, offset, message });
  return result;
}

export function decodeVrRequestFrame(bytes: Uint8Array): VrRequestDecodeResult {
  const result: VrRequestDecodeResult = {
    complete: true,
    structurallyValid: false,
    serverValidationRequired: true,
    frame: {
      bytes: bytes.byteLength,
      declaredLength: null,
      payloadBytes: null,
      opcode: null,
      requestType: null,
    },
    request: null,
    findings: [],
  };

  if (bytes.byteLength < 6 || bytes.byteLength > MAX_VR_REQUEST_FRAME_BYTES) {
    return addFinding(result, "VR_REQUEST_FRAME_INVALID", 0, "VR request frame size is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredLength = view.getUint32(0, false);
  const opcode = view.getUint16(4, false);
  result.frame.declaredLength = declaredLength;
  result.frame.payloadBytes = bytes.byteLength - 6;
  result.frame.opcode = opcode;
  if (declaredLength !== bytes.byteLength - 4) {
    return addFinding(result, "VR_REQUEST_FRAME_INVALID", 0, "Declared length does not match the frame");
  }
  if (opcode !== VR_GRAB_OPCODE && opcode !== VR_RELEASE_OPCODE) {
    return addFinding(result, "VR_REQUEST_OPCODE_INVALID", 4, "Opcode is not a supported client VR request");
  }
  if (opcode === VR_GRAB_OPCODE) {
    result.frame.requestType = "grab";
    if (bytes.byteLength !== VR_GRAB_FRAME_BYTES) {
      return addFinding(result, "VR_REQUEST_LENGTH_INVALID", 6, "Grab request payload must be exactly nine bytes");
    }
    const hand = view.getUint8(14);
    if (hand > 1) {
      return addFinding(result, "VR_REQUEST_HAND_INVALID", 14, "Grab hand must be zero or one");
    }
    result.request = {
      requestType: "grab",
      objectId: view.getBigUint64(6, false).toString(10),
      hand: hand === 1 ? "right" : "left",
    };
  } else {
    result.frame.requestType = "release";
    if (bytes.byteLength !== VR_RELEASE_FRAME_BYTES) {
      return addFinding(result, "VR_REQUEST_LENGTH_INVALID", 6, "Release request payload must be exactly 32 bytes");
    }
    const velocityOffsets = [14, 18, 22, 26, 30, 34];
    const velocities = velocityOffsets.map((offset) => view.getFloat32(offset, false));
    const invalidVelocityIndex = velocities.findIndex((value) => !Number.isFinite(value));
    if (invalidVelocityIndex !== -1) {
      return addFinding(
        result,
        "VR_REQUEST_FLOAT_NON_FINITE",
        velocityOffsets[invalidVelocityIndex],
        "Release velocities must contain finite floats",
      );
    }
    result.request = {
      requestType: "release",
      objectId: view.getBigUint64(6, false).toString(10),
      linearVelocity: {
        x: velocities[0],
        y: velocities[1],
        z: velocities[2],
      },
      angularVelocity: {
        x: velocities[3],
        y: velocities[4],
        z: velocities[5],
      },
    };
  }
  result.structurallyValid = true;
  return result;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedVrFrame(file: string): Promise<{
  bytes: Buffer;
  sha256: string;
}> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("VR request is not a regular file");
    if (stat.size > MAX_VR_REQUEST_FRAME_BYTES) {
      throw new Error("VR request exceeds 38 bytes");
    }
    const buffer = Buffer.allocUnsafe(MAX_VR_REQUEST_FRAME_BYTES + 1);
    let total = 0;
    while (total <= MAX_VR_REQUEST_FRAME_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_VR_REQUEST_FRAME_BYTES) {
      throw new Error("VR request exceeds 38 bytes");
    }
    const bytes = Buffer.from(buffer.subarray(0, total));
    return { bytes, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

function emptyInspection(frameFile: string): VrRequestInspectionReport {
  return {
    status: "error",
    complete: false,
    structurallyValid: false,
    serverValidationRequired: true,
    frameFile,
    contract: {
      authority: "zig-server-v2",
      direction: "client-to-server",
      byteOrder: "big-endian",
      opcodes: { grab: 128, release: 129 },
      maxFrameBytes: 38,
    },
    frame: {
      bytes: 0,
      declaredLength: null,
      payloadBytes: null,
      opcode: null,
      requestType: null,
    },
    request: null,
    findings: [],
    integrity: { bytes: 0, sha256: "", unchanged: false },
    boundaries: [
      "Inspects client-to-server VR grab and release request frames only.",
      "Does not inspect server broadcasts, poses, voice, or locomotion.",
      "Does not connect, listen, capture, replay, or send network traffic.",
      "Does not authenticate or prove packet origin, freshness, or delivery.",
      "Does not prove object existence, ownership, reach, or grabbed state.",
      "Does not apply server velocity clamps or anti-cheat decisions.",
      "Does not mutate Godot, physics, scenes, or runtime entity state.",
      "Does not prove VR rendering, tracking, latency, or production behavior.",
    ],
  };
}

function fileFailure(
  report: VrRequestInspectionReport,
  code: string,
  message: string,
): VrRequestInspectionReport {
  report.findings = [{ severity: "error", code, offset: null, message }];
  return report;
}

export async function inspectVrRequestFrame(
  options: { frame: string },
): Promise<VrRequestInspectionReport> {
  const requested = path.resolve(options.frame);
  const report = emptyInspection(requested);
  if (path.extname(requested).toLowerCase() !== ".bin") {
    return fileFailure(report, "VR_REQUEST_FILE_INVALID", "Frame must be an explicit .bin file");
  }

  let canonical: string;
  let initial: Awaited<ReturnType<typeof readBoundedVrFrame>>;
  try {
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return fileFailure(report, "VR_REQUEST_FILE_INVALID", "Frame must be a regular non-symbolic file");
    }
    if (stat.size > MAX_VR_REQUEST_FRAME_BYTES) {
      return fileFailure(report, "VR_REQUEST_FILE_TOO_LARGE", "Frame exceeds 38 bytes");
    }
    canonical = await realpath(requested);
    if (comparablePath(canonical) !== comparablePath(requested)) {
      return fileFailure(report, "VR_REQUEST_FILE_INVALID", "Frame path traverses a symbolic filesystem alias");
    }
    initial = await readBoundedVrFrame(canonical);
    if (initial.bytes.length !== stat.size) {
      return fileFailure(report, "VR_REQUEST_SOURCE_CHANGED", "Frame changed during initial read");
    }
  } catch (error) {
    return fileFailure(
      report,
      "VR_REQUEST_FILE_UNREADABLE",
      error instanceof Error ? error.message : "Frame cannot be read",
    );
  }

  report.frameFile = canonical;
  report.integrity = {
    bytes: initial.bytes.length,
    sha256: initial.sha256,
    unchanged: false,
  };
  const decoded = decodeVrRequestFrame(initial.bytes);
  report.frame = decoded.frame;
  report.request = decoded.request;
  report.findings = decoded.findings;

  try {
    const finalStat = await lstat(canonical);
    const final = await readBoundedVrFrame(canonical);
    report.integrity.unchanged =
      finalStat.isFile() &&
      !finalStat.isSymbolicLink() &&
      finalStat.size === final.bytes.length &&
      final.bytes.length === initial.bytes.length &&
      final.sha256 === initial.sha256;
    if (!report.integrity.unchanged) {
      report.findings.push({
        severity: "error",
        code: "VR_REQUEST_SOURCE_CHANGED",
        offset: null,
        message: "Frame changed during inspection",
      });
    }
  } catch {
    report.findings.push({
      severity: "error",
      code: "VR_REQUEST_SOURCE_CHANGED",
      offset: null,
      message: "Frame became unreadable during inspection",
    });
  }

  report.findings.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    (left.offset ?? Number.MAX_SAFE_INTEGER) - (right.offset ?? Number.MAX_SAFE_INTEGER) ||
    left.message.localeCompare(right.message),
  );
  report.complete = decoded.complete && report.integrity.unchanged;
  report.structurallyValid = report.complete && report.findings.length === 0;
  report.status = report.structurallyValid ? "ok" : "error";
  return report;
}
