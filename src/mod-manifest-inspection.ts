import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_MOD_MANIFEST_BYTES = 256 * 1024;
export const MAX_MOD_JSON_DEPTH = 32;
export const MAX_MOD_JSON_ARRAY_ITEMS = 64;
export const MAX_MOD_JSON_STRING_BYTES = 4 * 1024;
export const MAX_MOD_JSON_VALUES = 8_192;
export const MAX_MOD_FINDINGS = 128;

export const MOD_SIGNING_DOMAIN = "ultimate-odycer/addon-manifest/v1\n" as const;

export interface ModManifestInspectionOptions {
  manifest: string;
}

export interface ModFinding {
  severity: "error" | "warning";
  code: string;
  location: string;
  message: string;
}

export interface ModManifestInspectionReport {
  status: "ok" | "error";
  complete: boolean;
  manifestFile: string;
  contract: {
    schemaVersion: 1;
    signingDomain: typeof MOD_SIGNING_DOMAIN;
    authority: "zig-server-v2";
  };
  manifest: {
    id: string | null;
    version: string | null;
    engineApi: string | null;
    publisher: string | null;
    status: string | null;
    signatureStatus: string | null;
    packageStatus: string | null;
    permissions: number | null;
    capabilities: number | null;
    cpuBudgetMs: number | null;
    memoryBudgetMb: number | null;
  };
  structurallyValid: boolean;
  trustVerdict: "not_checked";
  packageIntegrity: "not_checked";
  activationEligible: false;
  serverAuthorityRequired: true;
  signedClaimFields: string[];
  integrity: { bytes: number; sha256: string; unchanged: boolean };
  findings: ModFinding[];
  boundaries: string[];
}

type JsonObject = Record<string, unknown>;

const SIGNED_CLAIM_FIELDS = [
  "schema_version",
  "id",
  "name",
  "version",
  "engine_api",
  "publisher",
  "package_sha256",
  "permissions",
  "capabilities",
  "cpu_budget_ms",
  "memory_budget_mb",
] as const;

const REQUIRED_ROOT_FIELDS = new Set([
  ...SIGNED_CLAIM_FIELDS,
  "signature_status",
  "signature",
  "status",
]);

const KNOWN_ROOT_FIELDS = new Set([
  ...REQUIRED_ROOT_FIELDS,
  "package_status",
  "package_reason",
  "package_size_bytes",
  "package_entry_count",
  "package_uncompressed_bytes",
  "registered_at",
  "updated_at",
  "signature_checked_at",
  "package_checked_at",
  "signature_reason",
]);

const KNOWN_SIGNATURE_FIELDS = new Set([
  "algorithm",
  "publisher_key_id",
  "value_base64",
]);

function emptyReport(manifestFile: string): ModManifestInspectionReport {
  return {
    status: "error",
    complete: false,
    manifestFile,
    contract: {
      schemaVersion: 1,
      signingDomain: MOD_SIGNING_DOMAIN,
      authority: "zig-server-v2",
    },
    manifest: {
      id: null,
      version: null,
      engineApi: null,
      publisher: null,
      status: null,
      signatureStatus: null,
      packageStatus: null,
      permissions: null,
      capabilities: null,
      cpuBudgetMs: null,
      memoryBudgetMb: null,
    },
    structurallyValid: false,
    trustVerdict: "not_checked",
    packageIntegrity: "not_checked",
    activationEligible: false,
    serverAuthorityRequired: true,
    signedClaimFields: [...SIGNED_CLAIM_FIELDS],
    integrity: { bytes: 0, sha256: "", unchanged: false },
    findings: [],
    boundaries: [
      "structural inspection only",
      "signature trust is not checked",
      "package bytes are not read",
      "activation remains server-authoritative",
      "no mod code is executed",
    ],
  };
}

function addFinding(
  findings: ModFinding[],
  severity: ModFinding["severity"],
  code: string,
  location: string,
  message: string,
): void {
  findings.push({ severity, code, location, message });
}

function sortFindings(findings: ModFinding[]): ModFinding[] {
  return findings.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    left.location.localeCompare(right.location) ||
    left.message.localeCompare(right.message),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedRegularFile(
  file: string,
): Promise<{ bytes: Buffer; statSize: number }> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("manifest is not a regular file");
    if (stat.size > MAX_MOD_MANIFEST_BYTES) throw new Error("manifest exceeds 256 KiB");

    const buffer = Buffer.allocUnsafe(MAX_MOD_MANIFEST_BYTES + 1);
    let total = 0;
    while (total <= MAX_MOD_MANIFEST_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_MOD_MANIFEST_BYTES) throw new Error("manifest exceeds 256 KiB");
    return { bytes: Buffer.from(buffer.subarray(0, total)), statSize: stat.size };
  } finally {
    await handle.close();
  }
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSummaryString(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

function requiredString(
  object: JsonObject,
  field: string,
  maxBytes: number,
  findings: ModFinding[],
): string | null {
  const location = `/${field}`;
  if (!(field in object)) {
    addFinding(findings, "error", "MOD_FIELD_REQUIRED", location, `${field} is required`);
    return null;
  }
  const value = object[field];
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    addFinding(
      findings,
      "error",
      "MOD_FIELD_INVALID",
      location,
      `${field} must be a non-empty UTF-8 string of at most ${maxBytes} bytes`,
    );
    return null;
  }
  return value;
}

function requiredSignatureString(
  object: JsonObject,
  field: string,
  maxBytes: number,
  findings: ModFinding[],
): string | null {
  const location = `/signature/${field}`;
  const value = object[field];
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    addFinding(
      findings,
      "error",
      "MOD_SIGNATURE_ENVELOPE_INVALID",
      location,
      `${field} must be a non-empty UTF-8 string of at most ${maxBytes} bytes`,
    );
    return null;
  }
  return value;
}

function isNumericIdentifier(value: string, rejectLeadingZero: boolean): boolean {
  return /^[0-9]+$/.test(value) && !(rejectLeadingZero && value.length > 1 && value[0] === "0");
}

function isIdentifierList(value: string, rejectNumericLeadingZero: boolean): boolean {
  if (value.length === 0) return false;
  return value.split(".").every((part) => {
    if (part.length === 0 || !/^[0-9A-Za-z-]+$/.test(part)) return false;
    return !/^[0-9]+$/.test(part) || !rejectNumericLeadingZero || isNumericIdentifier(part, true);
  });
}

export function isModSemver(value: string): boolean {
  if (value.length === 0) return false;
  const plus = value.indexOf("+");
  if (plus !== -1 && (value.indexOf("+", plus + 1) !== -1 || !isIdentifierList(value.slice(plus + 1), false))) {
    return false;
  }
  const withoutBuild = plus === -1 ? value : value.slice(0, plus);
  const dash = withoutBuild.indexOf("-");
  if (dash !== -1 && !isIdentifierList(withoutBuild.slice(dash + 1), true)) return false;
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const parts = core.split(".");
  return parts.length === 3 && parts.every((part) => isNumericIdentifier(part, true));
}

export function isModEngineApiVersion(value: string): boolean {
  if (isModSemver(value)) return true;
  const parts = value.split(".");
  return parts.length === 2 && parts.every((part) => isNumericIdentifier(part, true));
}

function isToken(value: string): boolean {
  return /^[0-9A-Za-z_.:/-]+$/.test(value);
}

function validateJsonBounds(value: unknown, findings: ModFinding[]): boolean {
  const stack: Array<{ value: unknown; depth: number; location: string }> = [
    { value, depth: 0, location: "" },
  ];
  let visited = 0;
  let valid = true;
  while (stack.length > 0) {
    const item = stack.pop()!;
    visited += 1;
    if (visited > MAX_MOD_JSON_VALUES) {
      addFinding(findings, "error", "MOD_JSON_LIMIT", item.location || "/", "JSON value count exceeds 8192");
      return false;
    }
    if (item.depth > MAX_MOD_JSON_DEPTH) {
      addFinding(findings, "error", "MOD_JSON_LIMIT", item.location || "/", "JSON depth exceeds 32");
      valid = false;
      continue;
    }
    if (typeof item.value === "number" && !Number.isFinite(item.value)) {
      addFinding(findings, "error", "MOD_JSON_INVALID", item.location || "/", "JSON number is outside the finite numeric domain");
      valid = false;
    } else if (typeof item.value === "string" && Buffer.byteLength(item.value, "utf8") > MAX_MOD_JSON_STRING_BYTES) {
      addFinding(findings, "error", "MOD_JSON_LIMIT", item.location || "/", "JSON string exceeds 4096 UTF-8 bytes");
      valid = false;
    } else if (Array.isArray(item.value)) {
      if (item.value.length > MAX_MOD_JSON_ARRAY_ITEMS) {
        addFinding(findings, "error", "MOD_JSON_LIMIT", item.location || "/", "JSON array exceeds 64 items");
        valid = false;
      }
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item.value[index], depth: item.depth + 1, location: `${item.location}/${index}` });
      }
    } else if (isObject(item.value)) {
      for (const [key, child] of Object.entries(item.value)) {
        const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
        const childLocation = `${item.location}/${escaped}`;
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          addFinding(findings, "error", "MOD_DANGEROUS_KEY", childLocation, "dangerous object key is not allowed");
          valid = false;
        }
        if (Buffer.byteLength(key, "utf8") > MAX_MOD_JSON_STRING_BYTES) {
          addFinding(findings, "error", "MOD_JSON_LIMIT", childLocation, "JSON object key exceeds 4096 UTF-8 bytes");
          valid = false;
        }
        stack.push({ value: child, depth: item.depth + 1, location: childLocation });
      }
    }
  }
  return valid;
}

function validateTokenArray(
  object: JsonObject,
  field: "permissions" | "capabilities",
  allowEmpty: boolean,
  findings: ModFinding[],
): number | null {
  const value = object[field];
  const location = `/${field}`;
  if (!(field in object)) {
    addFinding(findings, "error", "MOD_FIELD_REQUIRED", location, `${field} is required`);
    return null;
  }
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && value.length === 0)) {
    addFinding(findings, "error", "MOD_TOKEN_INVALID", location, `${field} must contain ${allowEmpty ? "0" : "1"} to 64 tokens`);
    return null;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const token = value[index];
    if (typeof token !== "string" || token.length === 0 || Buffer.byteLength(token, "utf8") > 96 || !isToken(token)) {
      addFinding(findings, "error", "MOD_TOKEN_INVALID", `${location}/${index}`, "token must use the v1 token alphabet and be at most 96 bytes");
    } else if (seen.has(token)) {
      addFinding(findings, "warning", "duplicate_signed_token", `${location}/${index}`, "duplicate signed token preserves its original order");
    } else {
      seen.add(token);
    }
  }
  return value.length;
}

function validateOptionalNonNegativeInteger(object: JsonObject, field: string, findings: ModFinding[]): void {
  if (!(field in object)) return;
  const value = object[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", `/${field}`, `${field} must be a non-negative safe integer`);
  }
}

function validateManifest(object: JsonObject, report: ModManifestInspectionReport, findings: ModFinding[]): void {
  if (!("schema_version" in object)) {
    addFinding(findings, "error", "MOD_FIELD_REQUIRED", "/schema_version", "schema_version is required");
  } else if (object.schema_version !== 1) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/schema_version", "schema_version must be the integer 1");
  }

  const id = requiredString(object, "id", 96, findings);
  if (id !== null && (!id.startsWith("addon_") || id.length <= 6 || !/^[0-9A-Za-z_-]+$/.test(id))) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/id", "id must be an addon_ identifier");
  }
  requiredString(object, "name", 160, findings);
  const version = requiredString(object, "version", 64, findings);
  if (version !== null && !isModSemver(version)) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/version", "version must satisfy the addon v1 SemVer grammar");
  }
  const engineApi = requiredString(object, "engine_api", 32, findings);
  if (engineApi !== null && !isModEngineApiVersion(engineApi)) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/engine_api", "engine_api must be major.minor or valid SemVer");
  }
  const publisher = requiredString(object, "publisher", 160, findings);
  const packageHash = requiredString(object, "package_sha256", 64, findings);
  if (packageHash !== null && !/^[0-9A-Fa-f]{64}$/.test(packageHash)) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/package_sha256", "package_sha256 must contain exactly 64 hexadecimal characters");
  }

  const status = requiredString(object, "status", 16, findings);
  if (status !== null && !["registered", "active", "disabled"].includes(status)) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/status", "status is not a v1 registry status");
  }
  const signatureStatus = requiredString(object, "signature_status", 16, findings);
  if (signatureStatus !== null && !["pending", "verified", "rejected"].includes(signatureStatus)) {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/signature_status", "signature_status is not a v1 signature status");
  }

  let packageStatus: string | null = null;
  if ("package_status" in object) {
    if (typeof object.package_status !== "string" || !["missing", "admitted", "rejected"].includes(object.package_status)) {
      addFinding(findings, "error", "MOD_FIELD_INVALID", "/package_status", "package_status is not a v1 package status");
    } else {
      packageStatus = object.package_status;
    }
  }
  if (status === "active" && signatureStatus !== "verified") {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/signature_status", "active manifests require signature_status verified");
  }
  if (status === "active" && packageStatus !== null && packageStatus !== "admitted") {
    addFinding(findings, "error", "MOD_FIELD_INVALID", "/package_status", "active manifests require an admitted package when package_status is present");
  }
  if (status === "active" && packageStatus === null) {
    addFinding(findings, "warning", "active_package_status_missing", "/package_status", "server lifecycle requires package admission before activation");
  }

  const signature = object.signature;
  if (!("signature" in object)) {
    addFinding(findings, "error", "MOD_FIELD_REQUIRED", "/signature", "signature is required");
  } else if (!isObject(signature)) {
    addFinding(findings, "error", "MOD_SIGNATURE_ENVELOPE_INVALID", "/signature", "signature must be an object");
  } else {
    const algorithm = requiredSignatureString(signature, "algorithm", 16, findings);
    const keyId = requiredSignatureString(signature, "publisher_key_id", 96, findings);
    const value = requiredSignatureString(signature, "value_base64", 88, findings);
    if (algorithm !== null && algorithm !== "ed25519") {
      addFinding(findings, "error", "MOD_SIGNATURE_ENVELOPE_INVALID", "/signature/algorithm", "signature algorithm must be ed25519");
    }
    if (keyId !== null && !isToken(keyId)) {
      addFinding(findings, "error", "MOD_SIGNATURE_ENVELOPE_INVALID", "/signature/publisher_key_id", "publisher_key_id must use the v1 token alphabet");
    }
    if (value !== null && !/^[0-9A-Za-z+/]{86}==$/.test(value)) {
      addFinding(findings, "error", "MOD_SIGNATURE_ENVELOPE_INVALID", "/signature/value_base64", "value_base64 must have the padded 88-character Ed25519 envelope shape");
    }
    for (const field of Object.keys(signature)) {
      if (!KNOWN_SIGNATURE_FIELDS.has(field)) {
        addFinding(findings, "warning", "unrecognized_signature_field", `/signature/${field}`, "field is outside the v1 signature envelope");
      }
    }
  }

  const permissions = validateTokenArray(object, "permissions", true, findings);
  const capabilities = validateTokenArray(object, "capabilities", false, findings);

  const cpu = object.cpu_budget_ms;
  if (!("cpu_budget_ms" in object)) {
    addFinding(findings, "error", "MOD_FIELD_REQUIRED", "/cpu_budget_ms", "cpu_budget_ms is required");
  } else if (typeof cpu !== "number" || !Number.isFinite(cpu) || cpu <= 0 || cpu > 50) {
    addFinding(findings, "error", "MOD_BUDGET_INVALID", "/cpu_budget_ms", "cpu_budget_ms must be finite and in (0, 50]");
  }
  const memory = object.memory_budget_mb;
  if (!("memory_budget_mb" in object)) {
    addFinding(findings, "error", "MOD_FIELD_REQUIRED", "/memory_budget_mb", "memory_budget_mb is required");
  } else if (typeof memory !== "number" || !Number.isInteger(memory) || memory < 1 || memory > 4096) {
    addFinding(findings, "error", "MOD_BUDGET_INVALID", "/memory_budget_mb", "memory_budget_mb must be an integer in [1, 4096]");
  }

  for (const field of ["registered_at", "updated_at", "signature_checked_at", "package_checked_at", "package_size_bytes", "package_entry_count", "package_uncompressed_bytes"]) {
    validateOptionalNonNegativeInteger(object, field, findings);
  }
  for (const field of ["package_reason", "signature_reason"]) {
    if (!(field in object)) continue;
    const value = object[field];
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 64 || !isToken(value)) {
      addFinding(findings, "error", "MOD_TOKEN_INVALID", `/${field}`, `${field} must be a non-empty v1 token of at most 64 bytes`);
    }
  }
  for (const field of Object.keys(object)) {
    if (!KNOWN_ROOT_FIELDS.has(field)) {
      addFinding(findings, "warning", "unrecognized_manifest_field", `/${field}`, "field is outside the addon-manifest v1 contract");
    }
  }

  report.manifest = {
    id: boundedSummaryString(object.id, 96),
    version: boundedSummaryString(object.version, 64),
    engineApi: boundedSummaryString(object.engine_api, 32),
    publisher: boundedSummaryString(publisher, 160),
    status: boundedSummaryString(object.status, 16),
    signatureStatus: boundedSummaryString(object.signature_status, 16),
    packageStatus,
    permissions,
    capabilities,
    cpuBudgetMs: typeof cpu === "number" && Number.isFinite(cpu) ? cpu : null,
    memoryBudgetMb: typeof memory === "number" && Number.isFinite(memory) ? memory : null,
  };
}

export async function inspectModManifest(
  options: ModManifestInspectionOptions,
): Promise<ModManifestInspectionReport> {
  const requested = path.resolve(options.manifest);
  const report = emptyReport(requested);
  const findings: ModFinding[] = [];

  if (path.extname(requested).toLowerCase() !== ".json") {
    addFinding(findings, "error", "MOD_FILE_INVALID", "/", "manifest must be an explicit .json file");
    report.findings = findings;
    return report;
  }

  let canonical: string;
  let initialBytes: Buffer;
  let initialSize = 0;
  try {
    const initialStat = await lstat(requested);
    if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
      addFinding(findings, "error", "MOD_FILE_INVALID", "/", "manifest must be a regular non-symbolic file");
      report.findings = findings;
      return report;
    }
    if (initialStat.size > MAX_MOD_MANIFEST_BYTES) {
      addFinding(findings, "error", "MOD_FILE_TOO_LARGE", "/", "manifest exceeds 256 KiB");
      report.findings = findings;
      return report;
    }
    canonical = await realpath(requested);
    if (comparablePath(canonical) !== comparablePath(requested)) {
      addFinding(findings, "error", "MOD_FILE_INVALID", "/", "manifest path must not traverse symbolic filesystem aliases");
      report.findings = findings;
      return report;
    }
    const boundedRead = await readBoundedRegularFile(canonical);
    initialBytes = boundedRead.bytes;
    initialSize = initialStat.size;
    if (boundedRead.statSize !== initialSize || initialBytes.byteLength !== initialSize) {
      addFinding(findings, "error", "MOD_SOURCE_CHANGED", "/", "manifest changed while it was being read");
      report.findings = findings;
      return report;
    }
  } catch (error) {
    addFinding(findings, "error", "MOD_FILE_UNREADABLE", "/", error instanceof Error ? error.message : "manifest cannot be read");
    report.findings = findings;
    return report;
  }

  const initialHash = sha256(initialBytes);
  report.manifestFile = canonical;
  report.integrity = { bytes: initialBytes.byteLength, sha256: initialHash, unchanged: false };

  let parsed: unknown;
  if (initialBytes.length >= 3 && initialBytes[0] === 0xef && initialBytes[1] === 0xbb && initialBytes[2] === 0xbf) {
    addFinding(findings, "error", "MOD_JSON_INVALID", "/", "UTF-8 BOM is not allowed");
  } else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(initialBytes);
      parsed = JSON.parse(text) as unknown;
      if (!isObject(parsed)) {
        addFinding(findings, "error", "MOD_JSON_INVALID", "/", "manifest root must be a JSON object");
      } else if (validateJsonBounds(parsed, findings)) {
        validateManifest(parsed, report, findings);
      }
    } catch (error) {
      addFinding(findings, "error", "MOD_JSON_INVALID", "/", error instanceof Error ? error.message : "manifest JSON is invalid");
    }
  }

  try {
    const finalStat = await lstat(canonical);
    const finalRead = await readBoundedRegularFile(canonical);
    const finalBytes = finalRead.bytes;
    const unchanged =
      finalStat.isFile() &&
      !finalStat.isSymbolicLink() &&
      finalRead.statSize === finalStat.size &&
      finalStat.size === initialSize &&
      finalBytes.byteLength === initialBytes.byteLength &&
      sha256(finalBytes) === initialHash;
    report.integrity.unchanged = unchanged;
    if (!unchanged) {
      addFinding(findings, "error", "MOD_SOURCE_CHANGED", "/", "manifest changed during inspection");
    }
  } catch {
    addFinding(findings, "error", "MOD_SOURCE_CHANGED", "/", "manifest became unreadable during inspection");
  }

  const findingOverflow = findings.length > MAX_MOD_FINDINGS;
  if (findingOverflow) {
    sortFindings(findings);
    findings.length = MAX_MOD_FINDINGS - 1;
    addFinding(findings, "error", "MOD_FINDINGS_TRUNCATED", "/", "finding limit reached");
  }
  report.findings = sortFindings(findings);
  report.complete = !findingOverflow && report.integrity.unchanged;
  report.structurallyValid = report.complete && !report.findings.some((finding) => finding.severity === "error");
  report.status = report.structurallyValid ? "ok" : "error";
  return report;
}
