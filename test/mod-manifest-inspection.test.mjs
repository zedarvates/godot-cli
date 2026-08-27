import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectModManifest } from "../dist/mod-manifest-inspection.js";

function validManifest() {
  return {
    schema_version: 1,
    id: "addon_test_signed",
    name: "Signed Test Addon",
    version: "1.2.3-beta.1+build.7",
    engine_api: "2.1",
    publisher: "Ultimate Odycer Test",
    package_sha256: "0123456789abcdef".repeat(4),
    signature_status: "pending",
    signature: {
      algorithm: "ed25519",
      publisher_key_id: "uo.test.primary",
      value_base64: `${"A".repeat(86)}==`,
    },
    status: "registered",
    permissions: [],
    capabilities: ["world-authoring"],
    cpu_budget_ms: 4.5,
    memory_budget_mb: 128,
  };
}

async function inspectFixture(value, writer = async (file) => writeFile(file, JSON.stringify(value), "utf8")) {
  const root = await mkdtemp(path.join(tmpdir(), "uo-mod-manifest-"));
  try {
    const manifestFile = path.join(root, "addon.json");
    await writer(manifestFile);
    return await inspectModManifest({ manifest: manifestFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasFinding(report, code, location) {
  return report.findings.some(
    (finding) => finding.code === code && (location === undefined || finding.location === location),
  );
}

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

test("registered pending manifest is structurally valid but never trusted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uo-mod-manifest-"));
  try {
    const manifestFile = path.join(root, "addon.json");
    await writeFile(manifestFile, JSON.stringify(validManifest()), "utf8");

    const report = await inspectModManifest({ manifest: manifestFile });

    assert.equal(report.status, "ok");
    assert.equal(report.complete, true);
    assert.equal(report.structurallyValid, true);
    assert.equal(report.trustVerdict, "not_checked");
    assert.equal(report.packageIntegrity, "not_checked");
    assert.equal(report.activationEligible, false);
    assert.equal(report.serverAuthorityRequired, true);
    assert.equal(report.contract.schemaVersion, 1);
    assert.equal(
      report.contract.signingDomain,
      "ultimate-odycer/addon-manifest/v1\n",
    );
    assert.equal(report.integrity.unchanged, true);
    assert.deepEqual(report.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing, non-json, directory, symlink, and oversized inputs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uo-mod-file-"));
  try {
    const missing = await inspectModManifest({ manifest: path.join(root, "missing.json") });
    assert.equal(hasFinding(missing, "MOD_FILE_UNREADABLE"), true);

    const textFile = path.join(root, "addon.txt");
    await writeFile(textFile, "{}", "utf8");
    const wrongExtension = await inspectModManifest({ manifest: textFile });
    assert.equal(hasFinding(wrongExtension, "MOD_FILE_INVALID"), true);

    const directory = path.join(root, "directory.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory));
    const directoryReport = await inspectModManifest({ manifest: directory });
    assert.equal(hasFinding(directoryReport, "MOD_FILE_INVALID"), true);

    const target = path.join(root, "target.json");
    const link = path.join(root, "link.json");
    await writeFile(target, JSON.stringify(validManifest()), "utf8");
    try {
      await symlink(target, link, "file");
      const linkReport = await inspectModManifest({ manifest: link });
      assert.equal(hasFinding(linkReport, "MOD_FILE_INVALID"), true);
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
    }

    const large = path.join(root, "large.json");
    const handle = await open(large, "w");
    try {
      await handle.truncate(256 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const largeReport = await inspectModManifest({ manifest: large });
    assert.equal(hasFinding(largeReport, "MOD_FILE_TOO_LARGE"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects BOM, invalid UTF-8, malformed JSON, and non-object roots", async () => {
  const bom = await inspectFixture(null, (file) =>
    writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]))
  );
  assert.equal(hasFinding(bom, "MOD_JSON_INVALID"), true);

  const invalidUtf8 = await inspectFixture(null, (file) => writeFile(file, Buffer.from([0xc3, 0x28])));
  assert.equal(hasFinding(invalidUtf8, "MOD_JSON_INVALID"), true);

  const malformed = await inspectFixture(null, (file) => writeFile(file, "{} trailing", "utf8"));
  assert.equal(hasFinding(malformed, "MOD_JSON_INVALID"), true);

  const nonObject = await inspectFixture([]);
  assert.equal(hasFinding(nonObject, "MOD_JSON_INVALID"), true);
});

test("enforces JSON depth, array, string, and dangerous-key limits", async () => {
  let deep = {};
  for (let index = 0; index < 34; index += 1) deep = { child: deep };
  const deepReport = await inspectFixture(deep);
  assert.equal(hasFinding(deepReport, "MOD_JSON_LIMIT"), true);

  const wideReport = await inspectFixture({ values: Array.from({ length: 65 }, (_, index) => index) });
  assert.equal(hasFinding(wideReport, "MOD_JSON_LIMIT"), true);

  const stringReport = await inspectFixture({ value: "é".repeat(2049) });
  assert.equal(hasFinding(stringReport, "MOD_JSON_LIMIT"), true);

  const dangerousReport = await inspectFixture(JSON.parse('{"constructor":{}}'));
  assert.equal(hasFinding(dangerousReport, "MOD_DANGEROUS_KEY", "/constructor"), true);
});

test("reports every required addon-manifest v1 field", async () => {
  const required = [
    "schema_version", "id", "name", "version", "engine_api", "publisher",
    "package_sha256", "signature_status", "signature", "status", "permissions",
    "capabilities", "cpu_budget_ms", "memory_budget_mb",
  ];
  for (const field of required) {
    const fixture = validManifest();
    delete fixture[field];
    const report = await inspectFixture(fixture);
    assert.equal(hasFinding(report, "MOD_FIELD_REQUIRED", `/${field}`), true, field);
    assert.equal(
      report.findings.filter((finding) => finding.location === `/${field}`).length,
      1,
      `${field} should produce one focused finding`,
    );
    assert.equal(report.structurallyValid, false);
  }
});

test("validates SemVer and engine API with Zig-compatible boundaries", async () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3+001", "1.2.3-a+b"] ) {
    const fixture = validManifest();
    fixture.version = version;
    assert.equal((await inspectFixture(fixture)).structurallyValid, true, version);
  }
  for (const version of ["01.2.3", "1.02.3", "1.2", "1.2.3-01", "1.2.3+", "1.2.3+a+b"] ) {
    const fixture = validManifest();
    fixture.version = version;
    assert.equal(hasFinding(await inspectFixture(fixture), "MOD_FIELD_INVALID", "/version"), true, version);
  }
  for (const engineApi of ["0.0", "2.1", "2.1.0", "2.1.0-beta.1"]) {
    const fixture = validManifest();
    fixture.engine_api = engineApi;
    assert.equal((await inspectFixture(fixture)).structurallyValid, true, engineApi);
  }
  for (const engineApi of ["02.1", "2.01", "2", "2.1.0.0"]) {
    const fixture = validManifest();
    fixture.engine_api = engineApi;
    assert.equal(hasFinding(await inspectFixture(fixture), "MOD_FIELD_INVALID", "/engine_api"), true, engineApi);
  }
});

test("validates IDs, hashes, token arrays, and exact budget edges", async () => {
  const cases = [
    ["id", "addon_../escape", "MOD_FIELD_INVALID", "/id"],
    ["package_sha256", "f".repeat(63), "MOD_FIELD_INVALID", "/package_sha256"],
    ["cpu_budget_ms", 0, "MOD_BUDGET_INVALID", "/cpu_budget_ms"],
    ["cpu_budget_ms", 50.0001, "MOD_BUDGET_INVALID", "/cpu_budget_ms"],
    ["memory_budget_mb", 0, "MOD_BUDGET_INVALID", "/memory_budget_mb"],
    ["memory_budget_mb", 4097, "MOD_BUDGET_INVALID", "/memory_budget_mb"],
    ["memory_budget_mb", 1.5, "MOD_BUDGET_INVALID", "/memory_budget_mb"],
  ];
  for (const [field, value, code, location] of cases) {
    const fixture = validManifest();
    fixture[field] = value;
    assert.equal(hasFinding(await inspectFixture(fixture), code, location), true, `${field}=${value}`);
  }
  for (const [cpu, memory] of [[Number.MIN_VALUE, 1], [50, 4096]]) {
    const fixture = validManifest();
    fixture.cpu_budget_ms = cpu;
    fixture.memory_budget_mb = memory;
    assert.equal((await inspectFixture(fixture)).structurallyValid, true, `${cpu}/${memory}`);
  }

  const emptyCapabilities = validManifest();
  emptyCapabilities.capabilities = [];
  assert.equal(hasFinding(await inspectFixture(emptyCapabilities), "MOD_TOKEN_INVALID", "/capabilities"), true);
  const badToken = validManifest();
  badToken.permissions = ["unsafe token"];
  assert.equal(hasFinding(await inspectFixture(badToken), "MOD_TOKEN_INVALID", "/permissions/0"), true);
  const tooMany = validManifest();
  tooMany.permissions = Array.from({ length: 65 }, (_, index) => `permission.${index}`);
  assert.equal(hasFinding(await inspectFixture(tooMany), "MOD_JSON_LIMIT", "/permissions"), true);
});

test("validates signature envelope shape without checking trust", async () => {
  const mutations = [
    ["algorithm", "rsa", "/signature/algorithm"],
    ["publisher_key_id", "unsafe key", "/signature/publisher_key_id"],
    ["value_base64", `${"A".repeat(85)}==`, "/signature/value_base64"],
    ["value_base64", `${"A".repeat(87)}==`, "/signature/value_base64"],
    ["value_base64", `${"A".repeat(86)}-_`, "/signature/value_base64"],
  ];
  for (const [field, value, location] of mutations) {
    const fixture = validManifest();
    fixture.signature[field] = value;
    const report = await inspectFixture(fixture);
    assert.equal(hasFinding(report, "MOD_SIGNATURE_ENVELOPE_INVALID", location), true, field);
    assert.equal(report.trustVerdict, "not_checked");
    assert.equal(report.activationEligible, false);
  }
});

test("rejects missing signature members with envelope-specific findings", async () => {
  for (const field of ["algorithm", "publisher_key_id", "value_base64"]) {
    const fixture = validManifest();
    delete fixture.signature[field];
    const report = await inspectFixture(fixture);
    assert.equal(
      hasFinding(report, "MOD_SIGNATURE_ENVELOPE_INVALID", `/signature/${field}`),
      true,
      field,
    );
  }
});

test("validates optional registry metadata without claiming lifecycle authority", async () => {
  const valid = validManifest();
  Object.assign(valid, {
    package_status: "missing",
    package_reason: "awaiting/package",
    signature_reason: "queued:trust-check",
    package_size_bytes: 0,
    package_entry_count: 12,
    package_uncompressed_bytes: 4096,
    registered_at: 0,
    updated_at: 1,
    signature_checked_at: 2,
    package_checked_at: 3,
  });
  assert.equal((await inspectFixture(valid)).structurallyValid, true);

  for (const field of [
    "package_size_bytes", "package_entry_count", "package_uncompressed_bytes",
    "registered_at", "updated_at", "signature_checked_at", "package_checked_at",
  ]) {
    const fixture = validManifest();
    fixture[field] = -1;
    assert.equal(hasFinding(await inspectFixture(fixture), "MOD_FIELD_INVALID", `/${field}`), true, field);
  }
  for (const field of ["package_reason", "signature_reason"]) {
    const fixture = validManifest();
    fixture[field] = "unsafe reason";
    assert.equal(hasFinding(await inspectFixture(fixture), "MOD_TOKEN_INVALID", `/${field}`), true, field);
  }
});

test("accepts only declared mutable status enums", async () => {
  for (const [field, values] of [
    ["status", ["registered", "disabled"]],
    ["signature_status", ["pending", "verified", "rejected"]],
    ["package_status", ["missing", "admitted", "rejected"]],
  ]) {
    for (const value of values) {
      const fixture = validManifest();
      fixture[field] = value;
      assert.equal((await inspectFixture(fixture)).structurallyValid, true, `${field}=${value}`);
    }
    const invalid = validManifest();
    invalid[field] = "future";
    assert.equal(hasFinding(await inspectFixture(invalid), "MOD_FIELD_INVALID", `/${field}`), true, field);
  }
});

test("rejects non-finite JSON numbers produced by exponent overflow", async () => {
  const report = await inspectFixture(null, (file) =>
    writeFile(file, `${JSON.stringify(validManifest()).slice(0, -1)},"future":1e400}`, "utf8")
  );
  assert.equal(hasFinding(report, "MOD_JSON_INVALID", "/future"), true);
  assert.equal(report.structurallyValid, false);
});

test("enforces active state structure while preserving server authority", async () => {
  const pending = validManifest();
  pending.status = "active";
  assert.equal(hasFinding(await inspectFixture(pending), "MOD_FIELD_INVALID", "/signature_status"), true);

  const rejectedPackage = validManifest();
  rejectedPackage.status = "active";
  rejectedPackage.signature_status = "verified";
  rejectedPackage.package_status = "rejected";
  assert.equal(hasFinding(await inspectFixture(rejectedPackage), "MOD_FIELD_INVALID", "/package_status"), true);

  const admitted = validManifest();
  admitted.status = "active";
  admitted.signature_status = "verified";
  admitted.package_status = "admitted";
  const report = await inspectFixture(admitted);
  assert.equal(report.structurallyValid, true);
  assert.equal(report.trustVerdict, "not_checked");
  assert.equal(report.packageIntegrity, "not_checked");
  assert.equal(report.activationEligible, false);
  assert.equal(report.serverAuthorityRequired, true);

  const missingPackageState = structuredClone(admitted);
  delete missingPackageState.package_status;
  const warningReport = await inspectFixture(missingPackageState);
  assert.equal(warningReport.structurallyValid, true);
  assert.equal(hasFinding(warningReport, "active_package_status_missing", "/package_status"), true);
});

test("unknown fields and duplicate signed tokens are deterministic warnings", async () => {
  const fixture = validManifest();
  fixture.permissions = ["world.read", "world.read"];
  fixture.future_registry_value = true;
  fixture.signature.future_envelope_value = "opaque";
  const report = await inspectFixture(fixture);
  assert.equal(report.structurallyValid, true);
  assert.equal(hasFinding(report, "duplicate_signed_token", "/permissions/1"), true);
  assert.equal(hasFinding(report, "unrecognized_manifest_field", "/future_registry_value"), true);
  assert.equal(hasFinding(report, "unrecognized_signature_field", "/signature/future_envelope_value"), true);
  assert.deepEqual(report.signedClaimFields, [
    "schema_version", "id", "name", "version", "engine_api", "publisher",
    "package_sha256", "permissions", "capabilities", "cpu_budget_ms", "memory_budget_mb",
  ]);
});

test("finding overflow is fail-closed and retains the truncation marker", async () => {
  const fixture = validManifest();
  for (let index = 0; index < 140; index += 1) fixture[`future_${index}`] = index;
  const report = await inspectFixture(fixture);
  assert.equal(report.status, "error");
  assert.equal(report.complete, false);
  assert.equal(report.structurallyValid, false);
  assert.equal(report.findings.length, 128);
  assert.equal(hasFinding(report, "MOD_FINDINGS_TRUNCATED", "/"), true);
});

test("mod manifest inspect CLI returns JSON and preserves the source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "uo-mod-cli-"));
  try {
    const manifestFile = path.join(root, "addon.json");
    const original = Buffer.from(JSON.stringify(validManifest()), "utf8");
    await writeFile(manifestFile, original);
    const result = await runCli(["mod", "manifest", "inspect", manifestFile]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "ok");
    assert.equal(report.trustVerdict, "not_checked");
    assert.equal(report.activationEligible, false);
    assert.deepEqual(await readFileForTest(manifestFile), original);

    const invalid = validManifest();
    invalid.cpu_budget_ms = 500;
    await writeFile(manifestFile, JSON.stringify(invalid), "utf8");
    const failed = await runCli(["mod", "manifest", "inspect", manifestFile]);
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, "");
    assert.equal(JSON.parse(failed.stdout).status, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mod manifest exposes inspect only", async () => {
  const help = await runCli(["mod", "manifest", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /inspect/);
  for (const forbidden of ["install", "activate", "rollback", "migrate"]) {
    const result = await runCli(["mod", "manifest", forbidden]);
    assert.notEqual(result.code, 0, forbidden);
  }
});

async function readFileForTest(file) {
  return import("node:fs/promises").then(({ readFile }) => readFile(file));
}
