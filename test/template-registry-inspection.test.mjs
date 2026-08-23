import assert from "node:assert/strict";
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
