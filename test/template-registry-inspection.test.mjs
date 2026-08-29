import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectTemplateRegistry } from "../dist/template-registry-inspection.js";

const REQUIRED_ENVELOPE_FIELDS = [
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
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      cwd: new URL("..", import.meta.url),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function createRegistry(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uo-template-registry-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const schemaResource =
    "templates/schemas/template-contract/v1.0.0/schema.json";
  const schema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ultimateodycer.com/schemas/template-contract/1.0.0",
    type: "object",
    required: REQUIRED_ENVELOPE_FIELDS,
    properties: {},
    additionalProperties: false,
  });
  const schemaFile = path.join(root, ...schemaResource.split("/"));
  await fs.mkdir(path.dirname(schemaFile), { recursive: true });
  await fs.writeFile(schemaFile, schema, "utf8");
  const catalog = {
    registry_version: "2.0.0",
    generated_at: "2026-08-23",
    source_set: "test-fixture",
    entries: [
      {
        name: "template-contract",
        kind: "json-schema",
        version: "1.0.0",
        status: "experimental",
        file: schemaResource,
        sha256: sha256(schema),
        compatibility: [],
        validation_profile: "strict-schema-v1",
        contract_version: "1.0.0",
      },
    ],
    aliases: [],
  };
  const catalogFile = path.join(root, "templates", "catalog.json");
  await fs.mkdir(path.dirname(catalogFile), { recursive: true });
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");
  return root;
}

test("inspection accepts an integral common-contract-only registry as not ready", async (t) => {
  const root = await createRegistry(t);

  const report = await inspectTemplateRegistry({ root });

  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.integrityReady, true);
  assert.equal(report.strictContentReady, false);
  assert.equal(report.consumerReady, false);
  assert.deepEqual(report.profiles, {
    "legacy-unvalidated": 0,
    "strict-schema-v1": 1,
    "strict-v1": 0,
  });
  assert.equal(report.contract.ready, true);
  assert.equal(report.strictFamilySchemas, 0);
  assert.equal(report.strictTemplates, 0);
  assert.deepEqual(report.reasons, [
    "No strict family schema is catalogued.",
    "No strict-v1 template is catalogued.",
  ]);
  assert.equal(report.catalog.entries, 1);
  assert.equal(report.catalog.verifiedFiles, 1);
});

test("inspection counts mixed profiles and rejects a referenced checksum change", async (t) => {
  const root = await createRegistry(t);
  const resource = "templates/items/iron-token/v0.1.0/template.json";
  const contents = JSON.stringify({ name: "iron-token" });
  const file = path.join(root, ...resource.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  const catalogFile = path.join(root, "templates", "catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
  catalog.entries.unshift({
    name: "iron-token",
    kind: "item-template",
    version: "0.1.0",
    status: "experimental",
    file: resource,
    sha256: sha256(contents),
    compatibility: [],
    validation_profile: "legacy-unvalidated",
    contract_version: null,
  });
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");

  const clean = await inspectTemplateRegistry({ root });
  assert.equal(clean.status, "ok");
  assert.equal(clean.profiles["legacy-unvalidated"], 1);
  assert.equal(clean.catalog.verifiedFiles, 2);
  assert.equal(clean.catalog.verifiedBytes > contents.length, true);

  await fs.writeFile(file, `${contents}\n`, "utf8");
  const changed = await inspectTemplateRegistry({ root });
  assert.equal(changed.status, "error");
  assert.equal(changed.complete, false);
  assert.equal(changed.integrityReady, false);
  assert.equal(changed.consumerReady, false);
  assert.ok(
    changed.findings.some(
      (finding) => finding.code === "REGISTRY_CHECKSUM_MISMATCH"
    )
  );
});

test("inspection recognizes an exact strict family schema without content readiness", async (t) => {
  const root = await createRegistry(t);
  const resource = "templates/schemas/monsters/v1.0.0/schema.json";
  const schema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ultimateodycer.com/schemas/monsters/1.0.0",
    type: "object",
    allOf: [
      { $ref: "../../template-contract/v1.0.0/schema.json" },
    ],
    properties: { spec: { type: "object", additionalProperties: false } },
    additionalProperties: false,
  });
  const file = path.join(root, ...resource.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, schema, "utf8");
  const catalogFile = path.join(root, "templates", "catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
  catalog.entries.push({
    name: "monsters",
    kind: "json-schema",
    version: "1.0.0",
    status: "experimental",
    file: resource,
    sha256: sha256(schema),
    compatibility: [],
    validation_profile: "strict-schema-v1",
    contract_version: "1.0.0",
  });
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");

  const report = await inspectTemplateRegistry({ root });

  assert.equal(report.status, "ok");
  assert.equal(report.strictFamilySchemas, 1);
  assert.equal(report.strictContentReady, false);
  assert.equal(report.consumerReady, false);
  assert.deepEqual(report.reasons, ["No strict-v1 template is catalogued."]);
});

test("inspection accepts a family schema composed from the exact common contract id", async (t) => {
  const root = await createRegistry(t);
  const resource = "templates/schemas/classes/v1.0.0/schema.json";
  const schema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ultimateodycer.com/schemas/classes/1.0.0",
    allOf: [
      { $ref: "https://ultimateodycer.com/schemas/template-contract/1.0.0" },
      {
        properties: {
          spec: { type: "object", additionalProperties: false },
        },
      },
    ],
  });
  const file = path.join(root, ...resource.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, schema, "utf8");
  const catalogFile = path.join(root, "templates", "catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
  catalog.entries.push({
    name: "classes",
    kind: "json-schema",
    version: "1.0.0",
    status: "experimental",
    file: resource,
    sha256: sha256(schema),
    compatibility: [],
    validation_profile: "strict-schema-v1",
    contract_version: "1.0.0",
  });
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");

  const report = await inspectTemplateRegistry({ root });

  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.strictFamilySchemas, 1);
  assert.equal(report.strictContentReady, false);
  assert.equal(report.consumerReady, false);
});

test("inspection accepts an exact reciprocal strict-to-legacy supersession", async (t) => {
  const root = await createRegistry(t);
  const schemaResource = "templates/schemas/monsters/v1.0.0/schema.json";
  const familySchema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ultimateodycer.com/schemas/monsters/1.0.0",
    type: "object",
    allOf: [{ $ref: "../../template-contract/v1.0.0/schema.json" }],
    properties: { spec: { type: "object", additionalProperties: false } },
    additionalProperties: false,
  });
  const schemaFile = path.join(root, ...schemaResource.split("/"));
  await fs.mkdir(path.dirname(schemaFile), { recursive: true });
  await fs.writeFile(schemaFile, familySchema, "utf8");

  const legacyResource = "templates/monsters/forest-wolf/v0.1.0/template.json";
  const legacy = JSON.stringify({ name: "forest-wolf" });
  const legacyFile = path.join(root, ...legacyResource.split("/"));
  await fs.mkdir(path.dirname(legacyFile), { recursive: true });
  await fs.writeFile(legacyFile, legacy, "utf8");

  const strictResource = "templates/monsters/forest-wolf/v1.0.0/template.json";
  const specChecksum = `sha256:${"1".repeat(64)}`;
  const strict = JSON.stringify({
    $schema: "../../../schemas/monsters/v1.0.0/schema.json",
    contract_version: "1.0.0",
    id: "monsters:forest-wolf",
    slug: "forest-wolf",
    family: "monsters",
    version: "1.0.0",
    authority: "declarative",
    intended_consumers: ["zig-server-v2"],
    compatibility: [],
    dependencies: [],
    spec_checksum: specChecksum,
    spec: {},
  });
  const strictFile = path.join(root, ...strictResource.split("/"));
  await fs.mkdir(path.dirname(strictFile), { recursive: true });
  await fs.writeFile(strictFile, strict, "utf8");

  const catalogFile = path.join(root, "templates", "catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
  catalog.entries.push(
    {
      name: "monsters",
      kind: "json-schema",
      version: "1.0.0",
      status: "experimental",
      file: schemaResource,
      sha256: sha256(familySchema),
      compatibility: [],
      validation_profile: "strict-schema-v1",
      contract_version: "1.0.0",
    },
    {
      name: "forest-wolf",
      kind: "monster-template",
      version: "0.1.0",
      status: "experimental",
      file: legacyResource,
      sha256: sha256(legacy),
      compatibility: [],
      validation_profile: "legacy-unvalidated",
      contract_version: null,
      id: "monsters:forest-wolf",
      slug: "forest-wolf",
      family: "monsters",
      superseded_by: "monsters:forest-wolf@1.0.0",
    },
    {
      name: "forest-wolf",
      kind: "monster-template",
      version: "1.0.0",
      status: "experimental",
      file: strictResource,
      sha256: sha256(strict),
      compatibility: [],
      validation_profile: "strict-v1",
      contract_version: "1.0.0",
      id: "monsters:forest-wolf",
      slug: "forest-wolf",
      family: "monsters",
      schema_file: schemaResource,
      spec_checksum: specChecksum,
      intended_consumers: ["zig-server-v2"],
      supersedes: ["monsters:forest-wolf@0.1.0"],
    },
  );
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");

  const report = await inspectTemplateRegistry({ root });

  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.strictTemplates, 1);
  assert.equal(report.strictContentReady, true);
  assert.equal(report.consumerReady, false);

  catalog.entries.at(-2).superseded_by = "monsters:other@1.0.0";
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");
  const mismatched = await inspectTemplateRegistry({ root });
  assert.equal(mismatched.status, "error");
  assert.ok(
    mismatched.findings.some(
      (finding) => finding.code === "REGISTRY_REFERENCE_MISSING",
    ),
  );
});

test("inspection requires exact compatibility evidence beyond intended consumers", async (t) => {
  const root = await createRegistry(t);
  const schemaResource = "templates/schemas/monsters/v1.0.0/schema.json";
  const familySchema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ultimateodycer.com/schemas/monsters/1.0.0",
    type: "object",
    allOf: [{ $ref: "../../template-contract/v1.0.0/schema.json" }],
    properties: { spec: { type: "object", additionalProperties: false } },
    additionalProperties: false,
  });
  const schemaFile = path.join(root, ...schemaResource.split("/"));
  await fs.mkdir(path.dirname(schemaFile), { recursive: true });
  await fs.writeFile(schemaFile, familySchema, "utf8");
  const templateResource = "templates/monsters/forest-wolf/v1.0.0/template.json";
  const specChecksum = `sha256:${"1".repeat(64)}`;
  const template = JSON.stringify({
    $schema: "../../../schemas/monsters/v1.0.0/schema.json",
    contract_version: "1.0.0",
    id: "monsters:forest-wolf",
    slug: "forest-wolf",
    family: "monsters",
    version: "1.0.0",
    authority: "declarative",
    intended_consumers: ["godot-vr"],
    compatibility: [],
    dependencies: [],
    spec_checksum: specChecksum,
    spec: {},
  });
  const templateFile = path.join(root, ...templateResource.split("/"));
  await fs.mkdir(path.dirname(templateFile), { recursive: true });
  await fs.writeFile(templateFile, template, "utf8");
  const catalogFile = path.join(root, "templates", "catalog.json");
  const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8"));
  catalog.entries.push(
    {
      name: "monsters",
      kind: "json-schema",
      version: "1.0.0",
      status: "experimental",
      file: schemaResource,
      sha256: sha256(familySchema),
      compatibility: [],
      validation_profile: "strict-schema-v1",
      contract_version: "1.0.0",
    },
    {
      name: "forest-wolf",
      kind: "monster-template",
      version: "1.0.0",
      status: "experimental",
      file: templateResource,
      sha256: sha256(template),
      compatibility: [],
      validation_profile: "strict-v1",
      contract_version: "1.0.0",
      id: "monsters:forest-wolf",
      slug: "forest-wolf",
      family: "monsters",
      schema_file: schemaResource,
      spec_checksum: specChecksum,
      intended_consumers: ["godot-vr"],
      supersedes: [],
    }
  );
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");

  const intendedOnly = await inspectTemplateRegistry({ root });
  assert.equal(intendedOnly.status, "ok");
  assert.equal(intendedOnly.strictContentReady, true);
  assert.equal(intendedOnly.godotCompatibleTemplates, 0);
  assert.equal(intendedOnly.consumerReady, false);

  const compatibility = {
    consumer: "godot-vr",
    version: "1.0.0",
    verified_at: "2026-08-23T00:00:00Z",
    evidence: "tests/template-registry/commit-abcdef1",
  };
  const compatibleTemplate = JSON.stringify({
    ...JSON.parse(template),
    compatibility: [compatibility],
  });
  await fs.writeFile(templateFile, compatibleTemplate, "utf8");
  catalog.entries.at(-1).compatibility = [compatibility];
  catalog.entries.at(-1).sha256 = sha256(compatibleTemplate);
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");
  const compatible = await inspectTemplateRegistry({ root });
  assert.equal(compatible.status, "ok");
  assert.equal(compatible.godotCompatibleTemplates, 1);
  assert.equal(compatible.consumerReady, true);
  assert.deepEqual(compatible.reasons, []);

  catalog.entries.at(-1).unexpected = true;
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");
  const unknownField = await inspectTemplateRegistry({ root });
  assert.equal(unknownField.status, "error");
  assert.ok(
    unknownField.findings.some(
      (finding) => finding.code === "REGISTRY_ENTRY_INVALID"
    )
  );
  delete catalog.entries.at(-1).unexpected;

  const missingDependencyTemplate = JSON.stringify({
    ...JSON.parse(compatibleTemplate),
    dependencies: ["items:missing@1.0.0"],
  });
  await fs.writeFile(templateFile, missingDependencyTemplate, "utf8");
  catalog.entries.at(-1).sha256 = sha256(missingDependencyTemplate);
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");
  const missingDependency = await inspectTemplateRegistry({ root });
  assert.equal(missingDependency.status, "error");
  assert.ok(
    missingDependency.findings.some(
      (finding) => finding.code === "REGISTRY_REFERENCE_MISSING"
    )
  );

  await fs.writeFile(templateFile, compatibleTemplate, "utf8");
  catalog.entries.at(-1).sha256 = sha256(compatibleTemplate);
  catalog.aliases = [
    {
      from: "monsters:forest-wolf@1.0.0",
      to: "monsters:missing@1.0.0",
    },
  ];
  await fs.writeFile(catalogFile, JSON.stringify(catalog), "utf8");
  const missingAliasTarget = await inspectTemplateRegistry({ root });
  assert.equal(missingAliasTarget.status, "error");
  assert.ok(
    missingAliasTarget.findings.some(
      (finding) => finding.code === "REGISTRY_REFERENCE_MISSING"
    )
  );
});

test("template registry inspect CLI emits a complete false-readiness JSON report", async (t) => {
  const root = await createRegistry(t);

  const result = await runCli(["template", "registry", "inspect", root]);

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ok");
  assert.equal(report.complete, true);
  assert.equal(report.consumerReady, false);
});
