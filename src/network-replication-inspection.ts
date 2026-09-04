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
  value: number | null;
}

export interface ReplicationEntity {
  entityId: string;
  deltaSize: number;
  fieldCount: number;
  fields: ReplicationField[];
}

export interface ReplicationDecodeResult {
  complete: boolean;
  structurallyValid: boolean;
  frame: {
    bytes: number;
    declaredLength: number | null;
    payloadBytes: number | null;
    entityCount: number | null;
    detailedEntities: number;
    omittedEntities: number;
  };
  entities: ReplicationEntity[];
  findings: ReplicationFinding[];
}

type FieldContract = {
  name: ReplicationField["name"];
  kind: ReplicationField["kind"];
  order: number;
};

const FIELD_CONTRACT = new Map<number, FieldContract>([
  [1, { name: "pos_x", kind: "f32", order: 0 }],
  [2, { name: "pos_y", kind: "f32", order: 1 }],
  [3, { name: "pos_z", kind: "f32", order: 2 }],
  [4, { name: "vel_x", kind: "f32", order: 3 }],
  [6, { name: "vel_z", kind: "f32", order: 4 }],
  [7, { name: "rot_y", kind: "f32", order: 5 }],
  [10, { name: "health", kind: "u32", order: 6 }],
]);

function finding(
  code: string,
  offset: number | null,
  message: string,
): ReplicationFinding {
  return { severity: "error", code, offset, message };
}

function rawHex(bytes: Uint8Array, offset: number): string {
  return Buffer.from(bytes.subarray(offset, offset + 4)).toString("hex");
}

function finalize(result: ReplicationDecodeResult): ReplicationDecodeResult {
  result.findings.sort((left, right) => {
    const byCode = left.code.localeCompare(right.code);
    if (byCode !== 0) return byCode;
    const leftOffset = left.offset ?? Number.MAX_SAFE_INTEGER;
    const rightOffset = right.offset ?? Number.MAX_SAFE_INTEGER;
    return leftOffset - rightOffset || left.message.localeCompare(right.message);
  });
  if (result.findings.length > MAX_REPLICATION_FINDINGS) {
    result.findings.length = MAX_REPLICATION_FINDINGS - 1;
    result.findings.push(finding(
      "REPLICATION_FINDINGS_TRUNCATED",
      null,
      "Finding limit reached",
    ));
    result.complete = false;
    result.findings.sort((left, right) =>
      left.code.localeCompare(right.code) ||
      (left.offset ?? Number.MAX_SAFE_INTEGER) - (right.offset ?? Number.MAX_SAFE_INTEGER) ||
      left.message.localeCompare(right.message),
    );
  }
  result.structurallyValid = result.complete && result.findings.length === 0;
  return result;
}

export function decodeReplicationFrame(bytes: Uint8Array): ReplicationDecodeResult {
  const result: ReplicationDecodeResult = {
    complete: true,
    structurallyValid: false,
    frame: {
      bytes: bytes.byteLength,
      declaredLength: null,
      payloadBytes: null,
      entityCount: null,
      detailedEntities: 0,
      omittedEntities: 0,
    },
    entities: [],
    findings: [],
  };

  if (bytes.byteLength < 8) {
    result.findings.push(finding("REPLICATION_FRAME_INVALID", 0, "Frame is shorter than the eight-byte minimum"));
    return finalize(result);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredLength = view.getUint32(0, false);
  result.frame.declaredLength = declaredLength;
  result.frame.payloadBytes = bytes.byteLength - 6;
  if (declaredLength !== bytes.byteLength - 4) {
    result.findings.push(finding("REPLICATION_FRAME_INVALID", 0, "Declared frame length does not match the file"));
    return finalize(result);
  }

  const opcode = view.getUint16(4, false);
  if (opcode !== ENTITY_UPDATE_OPCODE) {
    result.findings.push(finding("REPLICATION_OPCODE_INVALID", 4, "Frame opcode is not entity_update=80"));
    return finalize(result);
  }

  const entityCount = view.getUint16(6, false);
  result.frame.entityCount = entityCount;
  let cursor = 8;
  for (let entityIndex = 0; entityIndex < entityCount; entityIndex += 1) {
    if (cursor + 4 > bytes.byteLength) {
      result.findings.push(finding("REPLICATION_COUNT_MISMATCH", cursor, "Entity count exceeds available records"));
      return finalize(result);
    }
    const deltaSize = view.getUint32(cursor, false);
    cursor += 4;
    const deltaStart = cursor;
    const deltaEnd = deltaStart + deltaSize;
    if (deltaSize < 9 || deltaEnd > bytes.byteLength) {
      result.findings.push(finding("REPLICATION_DELTA_INVALID", deltaStart - 4, "Entity delta is truncated or too short"));
      return finalize(result);
    }

    const entityId = view.getBigUint64(cursor, false).toString(10);
    if (entityId === "0") {
      result.findings.push(finding("REPLICATION_DELTA_INVALID", cursor, "Entity ID must be non-zero"));
    }
    cursor += 8;
    const fieldCount = view.getUint8(cursor);
    cursor += 1;
    if (fieldCount > 7) {
      result.findings.push(finding("REPLICATION_DELTA_INVALID", cursor - 1, "Field count exceeds seven"));
    }
    if (deltaSize !== 9 + fieldCount * 5) {
      result.findings.push(finding("REPLICATION_DELTA_INVALID", deltaStart - 4, "Delta size disagrees with field count"));
      return finalize(result);
    }

    const fields: ReplicationField[] = [];
    const seenFields = new Set<number>();
    let previousOrder = -1;
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      const fieldId = view.getUint8(cursor);
      const contract = FIELD_CONTRACT.get(fieldId);
      if (contract === undefined) {
        result.findings.push(finding("REPLICATION_FIELD_INVALID", cursor, "Field ID is not emitted by the current replication contract"));
        cursor += 5;
        continue;
      }
      if (seenFields.has(fieldId)) {
        result.findings.push(finding("REPLICATION_FIELD_INVALID", cursor, "Field ID is duplicated"));
      }
      if (contract.order <= previousOrder) {
        result.findings.push(finding("REPLICATION_FIELD_INVALID", cursor, "Field order is not canonical"));
      }
      seenFields.add(fieldId);
      previousOrder = contract.order;
      const valueOffset = cursor + 1;
      const decodedValue = contract.kind === "f32"
        ? view.getFloat32(valueOffset, false)
        : view.getUint32(valueOffset, false);
      const value = Number.isFinite(decodedValue) ? decodedValue : null;
      if (value === null) {
        result.findings.push(finding("REPLICATION_FLOAT_NON_FINITE", valueOffset, "Float field is NaN or infinite"));
      }
      fields.push({
        id: fieldId,
        name: contract.name,
        kind: contract.kind,
        rawHex: rawHex(bytes, valueOffset),
        value,
      });
      cursor += 5;
    }

    if (result.entities.length < MAX_REPLICATION_ENTITY_DETAILS) {
      result.entities.push({ entityId, deltaSize, fieldCount, fields });
    }
    cursor = deltaEnd;
  }

  if (cursor !== bytes.byteLength) {
    result.findings.push(finding("REPLICATION_COUNT_MISMATCH", cursor, "Bytes remain after the declared entity records"));
    return finalize(result);
  }

  result.frame.detailedEntities = result.entities.length;
  result.frame.omittedEntities = entityCount - result.entities.length;
  return finalize(result);
}
