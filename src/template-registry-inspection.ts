import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";

export const MAX_REGISTRY_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_REGISTRY_REFERENCED_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_REGISTRY_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_REGISTRY_ENTRIES = 10_000;
export const MAX_REGISTRY_ALIASES = 10_000;
export const MAX_REGISTRY_FINDINGS = 256;
export const MAX_REGISTRY_JSON_DEPTH = 64;
export const MAX_REGISTRY_JSON_ARRAY_ITEMS = 20_000;
export const MAX_REGISTRY_JSON_STRING_BYTES = 1024 * 1024;
export const MAX_REGISTRY_JSON_VALUES = 2_000_000;

const CATALOG_RESOURCE = "templates/catalog.json" as const;
const CONTRACT_RESOURCE =
  "templates/schemas/template-contract/v1.0.0/schema.json";
const CONTRACT_SCHEMA_ID =
  "https://ultimateodycer.com/schemas/template-contract/1.0.0";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const BOUNDARY =
  "Registry inspection is not template schema validation, Godot instantiation, migration, or runtime compatibility proof.";
const REQUIRED_ENVELOPE_FIELDS = new Set([
  "$schema",
  "contract_version",
  "id",
  "slug",
  "family",
  "version",
  "authority",
  "intended_consumers",
  "compatibility",
  "dependencies",
  "spec_checksum",
  "spec",
]);

export interface TemplateRegistryInspectionOptions {
  root: string;
}

export interface RegistryFinding {
  severity: "error" | "warning";
  code: string;
  location: string;
  message: string;
}

export interface TemplateRegistryInspectionReport {
  status: "ok" | "error";
  complete: boolean;
  registryRoot: string;
  catalog: {
    resource: typeof CATALOG_RESOURCE;
    registryVersion: string | null;
    entries: number;
    aliases: number;
    verifiedFiles: number;
    verifiedBytes: number;
  };
  profiles: {
    "legacy-unvalidated": number;
    "strict-schema-v1": number;
    "strict-v1": number;
  };
  contract: {
    version: "1.0.0" | null;
    schemaFile: string | null;
    ready: boolean;
  };
  strictFamilySchemas: number;
  strictTemplates: number;
  godotCompatibleTemplates: number;
  integrityReady: boolean;
  strictContentReady: boolean;
  consumerReady: boolean;
  reasons: string[];
  findings: RegistryFinding[];
  boundaries: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireRegistryRoot(root: string): Promise<string> {
  if (!root.trim()) throw new Error("Template registry root is required");
  const resolved = path.resolve(root);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Template registry root must be a regular directory");
  }
  return fs.realpath(resolved);
}

async function requireRegularFile(
  root: string,
  resource: string,
  maximumBytes: number
): Promise<{ absolutePath: string; bytes: number }> {
  const candidate = path.resolve(root, ...resource.split("/"));
  const within = path.relative(root, candidate);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  ) {
    throw new Error(`Registry resource escapes the root: ${resource}`);
  }
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Registry resource must be a regular file: ${resource}`);
  }
  if (stat.size > maximumBytes) {
    throw new Error(`Registry resource exceeds ${maximumBytes} bytes: ${resource}`);
  }
  const canonical = await fs.realpath(candidate);
  const canonicalWithin = path.relative(root, canonical);
  if (
    canonicalWithin === ".." ||
    canonicalWithin.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalWithin)
  ) {
    throw new Error(`Registry resource resolves outside the root: ${resource}`);
  }
  return { absolutePath: canonical, bytes: stat.size };
}

function validateJsonShape(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    visited += 1;
    if (visited > MAX_REGISTRY_JSON_VALUES) {
      throw new Error("Registry JSON exceeds the visited-value limit");
    }
    if (current.depth > MAX_REGISTRY_JSON_DEPTH) {
      throw new Error("Registry JSON exceeds the depth limit");
    }
    if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw new Error("Registry JSON contains a non-finite number");
    }
    if (typeof current.value === "string") {
      if (
        Buffer.byteLength(current.value, "utf8") >
        MAX_REGISTRY_JSON_STRING_BYTES
      ) {
        throw new Error("Registry JSON contains an oversized string");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_REGISTRY_JSON_ARRAY_ITEMS) {
        throw new Error("Registry JSON contains an oversized array");
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new Error(`Registry JSON contains forbidden key: ${key}`);
        }
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

async function readJson(
  root: string,
  resource: string,
  maximumBytes: number
): Promise<{ value: unknown; absolutePath: string; bytes: number }> {
  const file = await requireRegularFile(root, resource, maximumBytes);
  const value: unknown = JSON.parse(await fs.readFile(file.absolutePath, "utf8"));
  validateJsonShape(value);
  return { value, ...file };
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  location: string
): void {
  const expected = [...required].sort();
  const actual = Object.keys(value).sort();
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new Error(`${location} must contain exactly: ${expected.join(", ")}`);
  }
}

function boundedNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_REGISTRY_JSON_STRING_BYTES) {
    throw new Error(`${name} exceeds the string limit`);
  }
  return value;
}

function pathIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function validateResourcePath(resource: string): void {
  if (
    resource.length === 0 ||
    resource.includes("\\") ||
    resource.includes("\0") ||
    resource.includes("?") ||
    resource.includes("#") ||
    resource.startsWith("/") ||
    resource.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource)
  ) {
    throw new Error(`Registry path is forbidden: ${resource}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(resource);
  } catch {
    throw new Error(`Registry path has invalid percent encoding: ${resource}`);
  }
  for (const candidate of [resource, decoded]) {
    const segments = candidate.replaceAll("\\", "/").split("/");
    if (
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      candidate.startsWith("/") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)
    ) {
      throw new Error(`Registry path contains forbidden segments: ${resource}`);
    }
  }
}

interface VerifiedEntry {
  entry: Record<string, unknown>;
  resource: string;
  value: unknown;
  bytes: number;
}

function validateBaseEntry(
  value: unknown,
  index: number
): { entry: Record<string, unknown>; profile: keyof TemplateRegistryInspectionReport["profiles"] } {
  if (!isRecord(value)) throw new Error(`Catalog entry ${index} must be an object`);
  for (const key of [
    "name",
    "kind",
    "version",
    "status",
    "file",
    "sha256",
    "validation_profile",
  ]) {
    boundedNonEmptyString(value[key], `entries/${index}/${key}`);
  }
  if (!Array.isArray(value.compatibility)) {
    throw new Error(`entries/${index}/compatibility must be an array`);
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(String(value.version))) {
    throw new Error(`entries/${index}/version must be SemVer`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(value.sha256))) {
    throw new Error(`entries/${index}/sha256 is malformed`);
  }
  const profile = value.validation_profile;
  if (
    profile !== "legacy-unvalidated" &&
    profile !== "strict-schema-v1" &&
    profile !== "strict-v1"
  ) {
    throw new Error(`entries/${index}/validation_profile is unknown`);
  }
  if (profile === "legacy-unvalidated" && value.contract_version !== null) {
    throw new Error(`entries/${index} legacy contract_version must be null`);
  }
  if (profile !== "legacy-unvalidated" && value.contract_version !== "1.0.0") {
    throw new Error(`entries/${index} strict contract_version must be 1.0.0`);
  }
  return { entry: value, profile };
}

function commonContractEntry(entries: unknown[]): Record<string, unknown> {
  const matches = entries.filter(
    (entry) =>
      isRecord(entry) &&
      entry.name === "template-contract" &&
      entry.kind === "json-schema" &&
      entry.version === "1.0.0" &&
      entry.file === CONTRACT_RESOURCE &&
      entry.validation_profile === "strict-schema-v1" &&
      entry.contract_version === "1.0.0"
  );
  if (matches.length !== 1) {
    throw new Error("Registry must contain exactly one template contract v1 entry");
  }
  return matches[0] as Record<string, unknown>;
}

function validateCommonSchema(schema: unknown): void {
  if (!isRecord(schema)) throw new Error("Template contract schema must be an object");
  if (schema.$schema !== DRAFT_2020_12) throw new Error("Template contract Draft is invalid");
  if (schema.$id !== CONTRACT_SCHEMA_ID) throw new Error("Template contract $id is invalid");
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new Error("Template contract must be a closed object schema");
  }
  if (!Array.isArray(schema.required)) {
    throw new Error("Template contract required must be an array");
  }
  const actual = new Set(schema.required);
  if (
    actual.size !== REQUIRED_ENVELOPE_FIELDS.size ||
    [...REQUIRED_ENVELOPE_FIELDS].some((field) => !actual.has(field))
  ) {
    throw new Error("Template contract required fields do not match envelope v1");
  }
}

function collectSchemaRefs(value: unknown): string[] {
  const refs: string[] = [];
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (isRecord(current)) {
      if (typeof current.$ref === "string") refs.push(current.$ref);
      stack.push(...Object.values(current));
    }
  }
  return refs;
}

function validateFamilySchema(
  item: VerifiedEntry,
  catalogResources: Set<string>
): void {
  const match = item.resource.match(
    /^templates\/schemas\/([a-z0-9]+(?:-[a-z0-9]+)*)\/v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\/schema\.json$/
  );
  if (match === null) throw new Error(`Strict family schema path is invalid: ${item.resource}`);
  const [, family, version] = match;
  if (item.entry.version !== version) {
    throw new Error(`Strict family schema version disagrees with path: ${item.resource}`);
  }
  if (!isRecord(item.value)) throw new Error("Strict family schema must be an object");
  if (item.value.$schema !== DRAFT_2020_12) {
    throw new Error("Strict family schema must declare Draft 2020-12");
  }
  if (item.value.$id !== `https://ultimateodycer.com/schemas/${family}/${version}`) {
    throw new Error("Strict family schema $id disagrees with path");
  }
  if (item.value.type !== "object") throw new Error("Strict family schema type must be object");
  for (const reference of collectSchemaRefs(item.value)) {
    if (reference.startsWith("#")) continue;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference) || reference.startsWith("/")) {
      throw new Error(`Strict family schema contains remote or absolute $ref: ${reference}`);
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(reference.split("#", 1)[0]);
    } catch {
      throw new Error(`Strict family schema contains malformed $ref: ${reference}`);
    }
    if (decoded.includes("\\") || decoded.includes("\0")) {
      throw new Error(`Strict family schema contains forbidden $ref: ${reference}`);
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(item.resource), decoded)
    );
    if (resolved.startsWith("../") || !catalogResources.has(resolved)) {
      throw new Error(`Strict family schema $ref is not catalogued: ${reference}`);
    }
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateCompatibility(value: unknown, location: string): boolean {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error(`${location} compatibility must be an array of at most 16 records`);
  }
  let godotCompatible = false;
  for (const [index, record] of value.entries()) {
    if (!isRecord(record)) throw new Error(`${location}/${index} must be an object`);
    exactKeys(record, ["consumer", "version", "verified_at", "evidence"], `${location}/${index}`);
    const consumer = boundedNonEmptyString(record.consumer, `${location}/${index}/consumer`);
    boundedNonEmptyString(record.version, `${location}/${index}/version`);
    const verifiedAt = boundedNonEmptyString(record.verified_at, `${location}/${index}/verified_at`);
    const evidence = boundedNonEmptyString(record.evidence, `${location}/${index}/evidence`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumer)) {
      throw new Error(`${location}/${index}/consumer is invalid`);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(verifiedAt)) {
      throw new Error(`${location}/${index}/verified_at must be UTC ISO 8601`);
    }
    if (!/^[a-z0-9][a-z0-9\-/:._]*$/.test(evidence)) {
      throw new Error(`${location}/${index}/evidence is invalid`);
    }
    if (consumer === "godot-vr") godotCompatible = true;
  }
  return godotCompatible;
}

function validateStrictTemplate(
  item: VerifiedEntry,
  validFamilySchemas: Set<string>
): boolean {
  const match = item.resource.match(
    /^templates\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\/template\.json$/
  );
  if (match === null) throw new Error(`Strict template path is invalid: ${item.resource}`);
  const [, family, slug, version] = match;
  const entry = item.entry;
  for (const key of ["id", "slug", "family", "schema_file", "spec_checksum"]) {
    boundedNonEmptyString(entry[key], `${item.resource}/${key}`);
  }
  for (const key of ["intended_consumers", "supersedes"]) {
    if (!Array.isArray(entry[key])) throw new Error(`${item.resource}/${key} must be an array`);
  }
  if (
    entry.version !== version ||
    entry.family !== family ||
    entry.slug !== slug ||
    entry.id !== `${family}:${slug}`
  ) {
    throw new Error(`Strict template identity disagrees with path: ${item.resource}`);
  }
  if (!validFamilySchemas.has(String(entry.schema_file))) {
    throw new Error(`Strict template schema_file is not a verified family schema`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(entry.spec_checksum))) {
    throw new Error(`Strict template spec_checksum is malformed`);
  }
  if (!isRecord(item.value)) throw new Error("Strict template document must be an object");
  exactKeys(item.value, [...REQUIRED_ENVELOPE_FIELDS], item.resource);
  if (
    item.value.contract_version !== "1.0.0" ||
    item.value.authority !== "declarative" ||
    item.value.id !== entry.id ||
    item.value.slug !== slug ||
    item.value.family !== family ||
    item.value.version !== version ||
    item.value.spec_checksum !== entry.spec_checksum
  ) {
    throw new Error(`Strict template document metadata disagrees with catalog`);
  }
  if (!Array.isArray(item.value.dependencies)) {
    throw new Error("Strict template dependencies must be an array");
  }
  if (!jsonEqual(item.value.intended_consumers, entry.intended_consumers)) {
    throw new Error("Strict template intended_consumers disagree with catalog");
  }
  if (!jsonEqual(item.value.compatibility, entry.compatibility)) {
    throw new Error("Strict template compatibility disagrees with catalog");
  }
  return validateCompatibility(entry.compatibility, `${item.resource}/compatibility`);
}

export async function inspectTemplateRegistry(
  options: TemplateRegistryInspectionOptions
): Promise<TemplateRegistryInspectionReport> {
  const root = await requireRegistryRoot(options.root);
  const catalogFile = await readJson(root, CATALOG_RESOURCE, MAX_REGISTRY_CATALOG_BYTES);
  if (!isRecord(catalogFile.value)) throw new Error("Registry catalog must be an object");
  const catalog = catalogFile.value;
  exactKeys(
    catalog,
    ["registry_version", "generated_at", "source_set", "entries", "aliases"],
    "Registry catalog"
  );
  if (catalog.registry_version !== "2.0.0") {
    throw new Error("Registry catalog version must be 2.0.0");
  }
  boundedNonEmptyString(catalog.generated_at, "generated_at");
  boundedNonEmptyString(catalog.source_set, "source_set");
  if (!Array.isArray(catalog.entries) || !Array.isArray(catalog.aliases)) {
    throw new Error("Registry entries and aliases must be arrays");
  }
  if (catalog.entries.length > MAX_REGISTRY_ENTRIES) {
    throw new Error("Registry entry count exceeds the limit");
  }
  if (catalog.aliases.length > MAX_REGISTRY_ALIASES) {
    throw new Error("Registry alias count exceeds the limit");
  }

  const findings: RegistryFinding[] = [];
  const profiles: TemplateRegistryInspectionReport["profiles"] = {
    "legacy-unvalidated": 0,
    "strict-schema-v1": 0,
    "strict-v1": 0,
  };
  const verified: VerifiedEntry[] = [];
  const seenPaths = new Set<string>();
  let verifiedBytes = 0;
  for (const [index, rawEntry] of catalog.entries.entries()) {
    try {
      const { entry, profile } = validateBaseEntry(rawEntry, index);
      profiles[profile] += 1;
      const resource = String(entry.file);
      validateResourcePath(resource);
      const identity = pathIdentity(resource);
      if (seenPaths.has(identity)) {
        throw new Error(`Duplicate catalog path: ${resource}`);
      }
      seenPaths.add(identity);
      const file = await readJson(
        root,
        resource,
        MAX_REGISTRY_REFERENCED_FILE_BYTES
      );
      if (verifiedBytes + file.bytes > MAX_REGISTRY_TOTAL_BYTES) {
        throw new Error("Registry referenced bytes exceed the total limit");
      }
      const actualChecksum = await sha256File(file.absolutePath);
      if (actualChecksum !== entry.sha256) {
        findings.push({
          severity: "error",
          code: "REGISTRY_CHECKSUM_MISMATCH",
          location: `/entries/${index}/sha256`,
          message: `Checksum does not match ${resource}`,
        });
        continue;
      }
      verifiedBytes += file.bytes;
      verified.push({ entry, resource, value: file.value, bytes: file.bytes });
    } catch (error) {
      findings.push({
        severity: "error",
        code:
          error instanceof Error && /path|outside|escape|segment|percent/i.test(error.message)
            ? "REGISTRY_PATH_FORBIDDEN"
            : error instanceof Error && /limit|exceed/i.test(error.message)
              ? "REGISTRY_LIMIT_EXCEEDED"
              : "REGISTRY_ENTRY_INVALID",
        location: `/entries/${index}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const entry = commonContractEntry(catalog.entries);
  const verifiedContract = verified.find(
    (item) => item.resource === CONTRACT_RESOURCE
  );
  let contractReady = false;
  if (verifiedContract !== undefined) {
    try {
      validateCommonSchema(verifiedContract.value);
      contractReady = true;
    } catch (error) {
      findings.push({
        severity: "error",
        code: "REGISTRY_CONTRACT_INVALID",
        location: CONTRACT_RESOURCE,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (!findings.some((finding) => finding.location.includes("sha256"))) {
    findings.push({
      severity: "error",
      code: "REGISTRY_CONTRACT_INVALID",
      location: CONTRACT_RESOURCE,
      message: "Template contract file was not verified",
    });
  }

  const catalogResources = new Set(
    verified.map((item) => item.resource)
  );
  let strictFamilySchemas = 0;
  const validFamilySchemaResources = new Set<string>();
  for (const item of verified) {
    if (
      item.entry.validation_profile !== "strict-schema-v1" ||
      item.resource === CONTRACT_RESOURCE
    ) {
      continue;
    }
    try {
      validateFamilySchema(item, catalogResources);
      strictFamilySchemas += 1;
      validFamilySchemaResources.add(item.resource);
    } catch (error) {
      findings.push({
        severity: "error",
        code: "REGISTRY_SCHEMA_INVALID",
        location: item.resource,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let strictTemplates = 0;
  let godotCompatibleTemplates = 0;
  for (const item of verified) {
    if (item.entry.validation_profile !== "strict-v1") continue;
    try {
      const compatible = validateStrictTemplate(item, validFamilySchemaResources);
      strictTemplates += 1;
      if (compatible) godotCompatibleTemplates += 1;
    } catch (error) {
      findings.push({
        severity: "error",
        code: "REGISTRY_STRICT_TEMPLATE_INVALID",
        location: item.resource,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  findings.sort((left, right) =>
    left.code.localeCompare(right.code) ||
    left.location.localeCompare(right.location) ||
    left.message.localeCompare(right.message)
  );
  const integral = findings.every((finding) => finding.severity !== "error");
  const strictContentReady =
    integral && strictFamilySchemas > 0 && strictTemplates > 0;
  const reasons: string[] = [];
  if (strictFamilySchemas === 0) reasons.push("No strict family schema is catalogued.");
  if (strictTemplates === 0) reasons.push("No strict-v1 template is catalogued.");
  if (strictContentReady && godotCompatibleTemplates === 0) {
    reasons.push("No strict-v1 template has exact godot-vr compatibility evidence.");
  }
  const consumerReady = strictContentReady && godotCompatibleTemplates > 0;

  return {
    status: integral ? "ok" : "error",
    complete: integral,
    registryRoot: root,
    catalog: {
      resource: CATALOG_RESOURCE,
      registryVersion: "2.0.0",
      entries: catalog.entries.length,
      aliases: catalog.aliases.length,
      verifiedFiles: verified.length,
      verifiedBytes,
    },
    profiles,
    contract: {
      version: "1.0.0",
      schemaFile: CONTRACT_RESOURCE,
      ready: contractReady && integral,
    },
    strictFamilySchemas,
    strictTemplates,
    godotCompatibleTemplates,
    integrityReady: integral,
    strictContentReady,
    consumerReady,
    reasons,
    findings: findings.slice(0, MAX_REGISTRY_FINDINGS),
    boundaries: [BOUNDARY],
  };
}
