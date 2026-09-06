import { parentPort, workerData } from "node:worker_threads";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { inspectTemplateRegistry } from "./template-registry-inspection.js";
import { validationFailure, type TemplateValidationOptions, type TemplateValidationReport } from "./template-validation.js";

const CATALOG = "templates/catalog.json";
const COMMON = "templates/schemas/template-contract/v1.0.0/schema.json";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type ObjectValue = Record<string, any>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);

function resourcePath(value: string): void {
  if (!/^templates\/[a-zA-Z0-9_./-]+\.json$/.test(value) ||
      value.split("/").some(s => !s || s === "." || s === "..")) {
    throw new Error("Expected an exact catalogued templates/...json resource path");
  }
}

// Parse first, then examine JSON tokens to reject duplicate decoded object keys.
// JSON.parse alone would silently retain the last value.
function parse(bytes: Buffer): { value: any; exactIntegerTokens: boolean } {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  let values = 0;
  let exactIntegerTokens = true;
  for (let i = 0; i < tokens.length; i++) {
    if (++values > 2_000_000) throw new Error("JSON token limit exceeded");
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > 64) throw new Error("JSON depth limit exceeded");
    } else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"')) {
      const decoded = JSON.parse(token);
      if (decoded.length > 1_048_576) throw new Error("JSON string limit exceeded");
      if (tokens[i + 1] === ":") {
        const keys = stack[stack.length - 1];
        if (!keys || keys.has(decoded)) throw new Error("Duplicate JSON key");
        if (["__proto__", "prototype", "constructor"].includes(decoded)) throw new Error("Forbidden JSON key");
        keys.add(decoded);
      }
    } else if (![':', ',', 'true', 'false', 'null'].includes(token)) {
      if (!Number.isFinite(Number(token))) throw new Error("Non-finite JSON number");
      // Python distinguishes int tokens from float tokens (including 1.0/1e0).
      // Retain this evidence before JSON.parse's numeric representation is used.
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token))) {
        exactIntegerTokens = false;
      }
    }
  }
  return { value, exactIntegerTokens };
}

async function read(root: string, resource: string, limit: number) {
  resourcePath(resource);
  let current = root;
  const segments = resource.split("/");
  for (const [i, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("Symbolic or non-regular registry resource");
    }
  }
  const handle = await fs.open(current, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error("Resource size limit exceeded");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (size > limit || size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Resource changed or exceeded its read limit");
    }
    const data = bytes.subarray(0, size);
    return { ...parse(data), sha256: hash(data), resource, limit };
  } finally { await handle.close(); }
}

// Match Python sorted-key UTF-8 serialization for exact integer source tokens.
// The caller must also check lexical evidence: a parsed 1 might originate in 1.0.
function canonicalSpec(value: any): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Numeric spec requires exact safe integers");
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSpec).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort((a,b) => {
    const aa=Array.from(a, c=>c.codePointAt(0)!); const bb=Array.from(b, c=>c.codePointAt(0)!);
    for(let i=0;i<Math.min(aa.length,bb.length);i++) if(aa[i]!==bb[i]) return aa[i]-bb[i];
    return aa.length-bb.length;
  }).map(k=>`${canonicalSpec(k)}:${canonicalSpec(value[k])}`).join(",")}}`;
  if (typeof value === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error("Unpaired Unicode surrogate in spec");
  }
  return JSON.stringify(value);
}

function prepareSchema(schema: ObjectValue, resource: string, schemas: Map<string, ObjectValue>, ajv: Ajv2020, schemaNodes: Set<object>): string[] {
  let count = 0;
  const references = new Set<string>();
  function visit(node: any, top = false): void {
    if (++count > 4096) throw new Error("Schema node limit exceeded");
    if (typeof node === "boolean") return;
    if (!object(node)) throw new Error("Invalid schema node");
    schemaNodes.add(node);
    // Ajv may not compile unused definitions. Enforce the supported vocabulary
    // across all schema nodes, without interpreting const/default/example data.
    for (const keyword of Object.keys(node)) {
      // RULES.keywords includes annotation-only vocabulary entries such as
      // $schema/title; getKeyword covers only rules with validation definitions.
      if (!Object.hasOwn(ajv.RULES.keywords, keyword)) throw new Error(`Unsupported schema keyword: ${keyword}`);
    }
    if ("format" in node && node.format !== "date-time") {
      throw new Error("Unsupported schema format: only date-time is enabled");
    }
    for (const keyword of ["$async", "$vocabulary", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor", "contentSchema", "contentEncoding", "contentMediaType"]) {
      if (keyword in node) throw new Error(`Unsupported schema keyword: ${keyword}`);
    }
    if (!top && ("$id" in node || "$schema" in node)) throw new Error("Nested schema identifiers are unsupported");
    if (typeof node.$ref === "string" && !node.$ref.startsWith("#")) {
      const [base, fragment] = node.$ref.split("#");
      if (node.$ref.split("#").length > 2) throw new Error("Invalid schema reference");
      let target: ObjectValue | undefined;
      if (base === schemas.get(COMMON)?.$id) target = schemas.get(COMMON);
      else {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base) || /[%\\?\u0000]/.test(base) || base.startsWith("/")) {
          throw new Error("Remote or ambiguous schema reference is forbidden");
        }
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(resource), base));
        target = schemas.get(resolved);
      }
      if (!target) throw new Error("Schema reference is not a catalogued strict schema");
      node.$ref = target.$id + (fragment === undefined ? "" : `#${fragment}`);
    }
    if (typeof node.$ref === "string") {
      const hashIndex = node.$ref.indexOf("#");
      if (hashIndex !== -1) {
        const fragment = decodeURIComponent(node.$ref.slice(hashIndex + 1));
        if (fragment.startsWith("/") && /~(?:[^01]|$)/.test(fragment)) {
          throw new Error("Invalid JSON Pointer escape in schema reference");
        }
      }
      references.add(node.$ref.startsWith("#") ? schema.$id + node.$ref : node.$ref);
    }
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      if (object(node[key])) for (const child of Object.values(node[key])) visit(child);
    }
    if (object(node.dependencies)) {
      for (const child of Object.values(node.dependencies)) if (!Array.isArray(child)) visit(child);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child);
    }
    for (const key of ["additionalProperties", "unevaluatedProperties", "items", "unevaluatedItems", "contains", "propertyNames", "not", "if", "then", "else"]) {
      if (key in node) visit(node[key]);
    }
  }
  visit(schema, true);
  return [...references];
}

async function execute(options: TemplateValidationOptions): Promise<TemplateValidationReport> {
  resourcePath(options.template);
  const resolved = path.resolve(options.root);
  if ((await fs.lstat(resolved)).isSymbolicLink()) throw new Error("Symbolic registry root is forbidden");
  const root = await fs.realpath(resolved);
  const catalog = await read(root, CATALOG, 16 * 1024 * 1024);
  const inspection = await inspectTemplateRegistry({ root });
  if (!inspection.complete || !inspection.integrityReady || !inspection.strictContentReady) {
    return validationFailure(options.template, "TEMPLATE_REGISTRY_NOT_READY", "Registry integrity and strict content are required");
  }
  const entries = catalog.value.entries as ObjectValue[];
  const entry = entries.find(e => e.file === options.template);
  if (!entry || entry.validation_profile !== "strict-v1") throw new Error("Selected resource is not a catalogued strict-v1 template");
  const template = await read(root, options.template, 256 * 1024);
  if (template.sha256 !== entry.sha256) throw new Error("Template checksum mismatch");
  if (!template.exactIntegerTokens) {
    throw new Error("Numeric spec requires safe integer tokens without decimals or exponents");
  }
  const snapshots = [catalog, template];
  const schemas = new Map<string, ObjectValue>();
  const schemaEntries = entries.filter(e => e.validation_profile === "strict-schema-v1");
  if (schemaEntries.length > 32) throw new Error("Schema count limit exceeded");
  for (const entry of schemaEntries) {
    const file = await read(root, entry.file, 256 * 1024);
    if (file.sha256 !== entry.sha256 || !object(file.value) || file.value.$schema !== DRAFT) throw new Error("Schema checksum or draft mismatch");
    if (!file.exactIntegerTokens) {
      throw new Error("Schema numbers require safe integer tokens without decimals or exponents");
    }
    schemas.set(entry.file, structuredClone(file.value));
    snapshots.push(file);
  }
  const family = schemas.get(entry.schema_file);
  if (!family || !schemas.has(COMMON)) throw new Error("Family or common schema is missing");
  const doc = template.value;
  if (!entry.schema_file.startsWith(`templates/schemas/${doc.family}/v`)) throw new Error("Selected schema belongs to another family");
  const expectedSchema = path.posix.relative(path.posix.dirname(options.template), entry.schema_file);
  if (doc.$schema !== expectedSchema && doc.$schema !== family.$id) throw new Error("Template schema disagrees with its catalogued family");
  if (`sha256:${hash(canonicalSpec(doc.spec))}` !== doc.spec_checksum) throw new Error("Spec checksum mismatch");
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: false, validateFormats: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false, logger: false });
  formats.default(ajv, { formats: ["date-time"] });
  const references = new Set<string>();
  const schemaNodes = new Set<object>();
  for (const [resource, schema] of schemas) {
    for (const reference of prepareSchema(schema, resource, schemas, ajv, schemaNodes)) references.add(reference);
  }
  for (const schema of schemas.values()) ajv.addSchema(schema);
  // Resolving every reference also compiles targets that Ajv would otherwise
  // leave lazy because their containing definition is unused by this template.
  for (const reference of references) {
    const target = ajv.getSchema(reference);
    if (!target || (typeof target.schema !== "boolean" && !schemaNodes.has(target.schema))) {
      throw new Error("Schema reference target is missing or is not a schema node");
    }
  }
  const findings: TemplateValidationReport["findings"] = [];
  for (const schema of [schemas.get(COMMON)!, family]) {
    const validate = ajv.getSchema(schema.$id)!;
    if (!validate(doc)) {
      const error = validate.errors?.[0];
      findings.push({ code: "TEMPLATE_SCHEMA_INVALID", location: (error?.instancePath ?? "").slice(0, 512),
        message: `${error?.keyword ?? "validation"}: ${error?.message ?? "schema rejected template"}`.slice(0, 1024) });
      break;
    }
  }
  for (const snapshot of snapshots) {
    if ((await read(root, snapshot.resource, snapshot.limit)).sha256 !== snapshot.sha256) throw new Error("Source changed during validation");
  }
  const valid = findings.length === 0;
  return { status: valid ? "ok" : "error", valid, complete: true, template: options.template,
    consumerReady: valid && inspection.consumerReady && doc.compatibility.some((c: ObjectValue) => c.consumer === "godot-vr"), godotValidation: "not_run",
    integrity: { unchanged: true, files: snapshots.map(({ resource, sha256 }) => ({ resource, sha256 })) }, findings };
}

if (parentPort) {
  const options = workerData as TemplateValidationOptions;
  execute(options).then(report => parentPort!.postMessage(report)).catch(error => {
    parentPort!.postMessage(validationFailure(options.template, "TEMPLATE_VALIDATION_FAILED",
      error instanceof Error ? error.message : "Template validation failed"));
  });
}
