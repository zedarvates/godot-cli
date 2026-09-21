# Mod Manifest Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `uo-godot-cli mod manifest inspect <manifest.json>` as a bounded local structural mirror of the Zig2 addon-manifest v1 contract while permanently refusing trust, package-integrity, and activation claims.

**Architecture:** `mod-manifest-inspection.ts` owns canonical file confinement, byte fingerprints, fatal UTF-8/JSON parsing, structural validation, deterministic findings, and the fail-closed report. `cli.ts` only registers the nested command and maps structural validity to exit status. Optional Zig parity runs only in tests when an explicit server root is configured.

**Tech Stack:** TypeScript ES2022, Node.js built-ins, Commander 13, Node test runner, optional Zig 0.15.2 test-only parity.

**Spec:** `docs/superpowers/specs/2026-08-25-mod-manifest-inspect-design.md`

## Global Constraints

- Explicit regular local `.json` only; no project/env/URL/`res://` discovery.
- Reject symlink/non-file and realpath ambiguity; cap input at 256 KiB.
- Bound JSON depth 32, arrays 64, strings 4 KiB, visited values 8,192, findings 128.
- Mirror every current `addon_manifest.zig` structural rule and preserve signed array order.
- Unknown root/signature fields and duplicate tokens are warnings, not trust evidence.
- Always return `trustVerdict: "not_checked"`, `packageIntegrity: "not_checked"`, `activationEligible: false`, and `serverAuthorityRequired: true`.
- Never read a package/trust store, verify Ed25519, execute Zig/Godot/Python/shell/network, mutate lifecycle, or run mod code in production.
- No addon runtime catalog, MCP mapping, npm dependency, or server-file change.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/mod-manifest-inspection.ts` | Load/fingerprint manifest, validate contract and cross-field state, assemble report. |
| `src/cli.ts` | Register `mod manifest inspect` and exit behavior. |
| `test/mod-manifest-inspection.test.mjs` | Real temporary-file positive/negative structural tests. |
| `test/mod-manifest-server-parity.test.mjs` | Explicit optional execution of the two authoritative Zig test files. |
| `test/package-consumer.test.mjs` | Installed CLI behavior and source immutability. |
| `README.md` | Usage and structural/trust boundary. |
| `SECURITY.md` | File, JSON, signature-envelope, and no-execution boundaries. |
| `CHANGELOG.md` | Unreleased inspection feature and non-goals. |

---

### Task 1: Confined file loading and minimal valid manifest report

**Files:**
- Create: `src/mod-manifest-inspection.ts`
- Create: `test/mod-manifest-inspection.test.mjs`

**Interfaces:**
- Produces: `inspectModManifest(options): Promise<ModManifestInspectionReport>`
- Produces exported limits and stable finding/report types

- [ ] **Step 1: Write the failing registered/pending manifest test**

Create a temporary `.json` file containing this hand-derived fixture shape:

```js
const manifest = {
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
```

Assert:

```js
assert.equal(report.status, "ok");
assert.equal(report.complete, true);
assert.equal(report.structurallyValid, true);
assert.equal(report.trustVerdict, "not_checked");
assert.equal(report.packageIntegrity, "not_checked");
assert.equal(report.activationEligible, false);
assert.equal(report.serverAuthorityRequired, true);
assert.equal(report.contract.schemaVersion, 1);
assert.equal(report.contract.signingDomain, "ultimate-odycer/addon-manifest/v1\n");
assert.equal(report.integrity.unchanged, true);
assert.deepEqual(report.findings, []);
```

- [ ] **Step 2: Run and verify RED**

```powershell
rtk npm run build
rtk proxy node --test test/mod-manifest-inspection.test.mjs
```

Expected: module resolution fails because `dist/mod-manifest-inspection.js` is
absent.

- [ ] **Step 3: Implement public contracts and constants**

Create `src/mod-manifest-inspection.ts` with:

```ts
export const MAX_MOD_MANIFEST_BYTES = 256 * 1024;
export const MAX_MOD_JSON_DEPTH = 32;
export const MAX_MOD_JSON_ARRAY_ITEMS = 64;
export const MAX_MOD_JSON_STRING_BYTES = 4 * 1024;
export const MAX_MOD_JSON_VALUES = 8_192;
export const MAX_MOD_FINDINGS = 128;

export interface ModManifestInspectionOptions { manifest: string }

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
    signingDomain: "ultimate-odycer/addon-manifest/v1\n";
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
```

- [ ] **Step 4: Implement canonical file and fatal JSON handling**

Require `.json`, `lstat` regular/non-symbolic file, max size before read, and
`realpath`. Read bytes once, reject BOM, decode with `TextDecoder("utf-8",
{ fatal: true })`, parse exactly one JSON value, require object root, and walk
iteratively for depth/array/string/value/dangerous-key limits.

Fingerprint original bytes with SHA-256. After validation, re-lstat/re-read/hash
the canonical file. Any size/hash/type drift adds `MOD_SOURCE_CHANGED`, makes
the report incomplete, and returns exit-state error.

- [ ] **Step 5: Implement minimal required-field validation**

Validate schema version, bounded strings, addon ID, SemVer, engine API,
package hash, enum statuses, token arrays, budgets, and signature envelope using
focused helpers. Populate only bounded summary values. Sort findings by code,
location, message. Slice to 128 only after recording whether truncation occurred;
finding truncation makes `complete: false`.

- [ ] **Step 6: Add failing filesystem/JSON rejection tests**

Cover missing path, wrong extension, directory, symlink when supported,
oversized sparse file, BOM, invalid UTF-8 bytes, malformed/trailing JSON,
non-object root, depth/array/string/value limits, dangerous keys, and source
drift via a test-only validation hook below filesystem read level. Assert the
specific production guard each test catches.

- [ ] **Step 7: Verify and commit Task 1**

```powershell
rtk npm run build
rtk proxy node --test test/mod-manifest-inspection.test.mjs
rtk git diff --check
rtk git add -- src/mod-manifest-inspection.ts test/mod-manifest-inspection.test.mjs
rtk git commit -m "feat: inspect bounded mod manifests" -- src/mod-manifest-inspection.ts test/mod-manifest-inspection.test.mjs
```

---

### Task 2: Exact claims, versions, tokens, and budgets

**Files:**
- Modify: `src/mod-manifest-inspection.ts`
- Modify: `test/mod-manifest-inspection.test.mjs`

**Interfaces:**
- Consumes Task 1 report/finding helpers
- Produces stable codes: `MOD_FIELD_REQUIRED`, `MOD_FIELD_INVALID`, `MOD_BUDGET_INVALID`, `MOD_TOKEN_INVALID`, `MOD_SIGNATURE_ENVELOPE_INVALID`

- [ ] **Step 1: Write table-driven failing field tests**

For every required field, delete it from a fresh real manifest object and
assert `MOD_FIELD_REQUIRED` at the exact JSON-pointer-like location. Add wrong
JSON types separately so missing and mistyped values cannot collapse into one
untestable branch.

- [ ] **Step 2: Verify RED for representative fields**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="required field|wrong field type" test/mod-manifest-inspection.test.mjs
```

- [ ] **Step 3: Implement SemVer and engine API parity**

Port the behavior of Zig `isSemver`, `isIdentifierList`,
`isNumericIdentifier`, and `isEngineApiVersion` without copying source text.
Accept `1.2.3`, prerelease/build identifiers, and `2.1`; reject empty parts,
extra core parts, invalid characters, repeated `+`, and numeric leading zero.

- [ ] **Step 4: Implement IDs, hashes, tokens, arrays, and budgets**

Match Zig bounds exactly: addon ID prefix/length/characters; 64 hexadecimal
package hash; token alphabet/length; permissions 0–64; capabilities 1–64;
finite CPU `(0,50]`; integer memory `[1,4096]`. Preserve array order and warn
on duplicates without deduplicating.

- [ ] **Step 5: Add boundary and negative-control tests**

Test every inclusive/exclusive numeric boundary, uppercase/lowercase hex,
maximum lengths, 65-item arrays, empty capability array, invalid token chars,
valid prerelease/build, invalid leading zeros, and non-finite budgets through a
focused exported pure-value test helper because JSON cannot encode NaN/Infinity.

- [ ] **Step 6: Verify and commit Task 2**

```powershell
rtk npm run build
rtk proxy node --test test/mod-manifest-inspection.test.mjs
rtk npm test
rtk git add -- src/mod-manifest-inspection.ts test/mod-manifest-inspection.test.mjs
rtk git commit -m "feat: mirror addon manifest claim bounds" -- src/mod-manifest-inspection.ts test/mod-manifest-inspection.test.mjs
```

---

### Task 3: Signature envelope, mutable state, and warnings

**Files:**
- Modify: `src/mod-manifest-inspection.ts`
- Modify: `test/mod-manifest-inspection.test.mjs`

**Interfaces:**
- Consumes Task 2 validators
- Produces warnings: `unrecognized_manifest_field`, `unrecognized_signature_field`, `duplicate_signed_token`, `active_package_status_missing`

- [ ] **Step 1: Write failing signature-envelope tests**

Test wrong algorithm, missing/malformed key ID, Base64 lengths 87/89, missing
terminal `==`, URL-safe characters, invalid alphabet, and valid 88-character
shape. Every failure remains structural; no test expects a verified signature.

- [ ] **Step 2: Write failing mutable-state tests**

Cover all status/signature/package enums; active+pending/rejected; active with
present non-admitted package; active+verified+admitted; active+verified without
package status warning; optional reasons/timestamps/package counts with valid,
negative, float, and wrong-type values.

- [ ] **Step 3: Verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="signature envelope|mutable state" test/mod-manifest-inspection.test.mjs
```

- [ ] **Step 4: Implement signature and cross-field validation**

Validate envelope shape exactly as the spec, but allow unknown envelope fields
as sorted warnings. Enforce active signature/package structural rules. Validate
optional non-negative integers and token reasons.

- [ ] **Step 5: Implement unknown/duplicate warnings and signed claims report**

Define known root fields as required plus optional registry/package fields.
Unknown bounded fields produce warnings. Duplicate permission/capability values
produce warnings while order remains unchanged. Return the exact eleven ordered
signed claim names; never serialize or hash a signed payload.

Assert a structurally valid active/verified/admitted manifest still returns
trust not checked and activation false.

- [ ] **Step 6: Verify and commit Task 3**

```powershell
rtk npm run build
rtk proxy node --test test/mod-manifest-inspection.test.mjs
rtk git diff --check
rtk git add -- src/mod-manifest-inspection.ts test/mod-manifest-inspection.test.mjs
rtk git commit -m "feat: inspect mod signature envelopes" -- src/mod-manifest-inspection.ts test/mod-manifest-inspection.test.mjs
```

---

### Task 4: CLI and installed-package behavior

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/mod-manifest-inspection.test.mjs`
- Modify: `test/package-consumer.test.mjs`

**Interfaces:**
- Produces `uo-godot-cli mod manifest inspect <manifest.json>`

- [ ] **Step 1: Write failing CLI success/error tests**

Spawn the built CLI with a valid manifest and assert exit 0, JSON-only stdout,
empty stderr, trust not checked, activation false, and unchanged bytes. Use an
invalid budget fixture and assert exit 1 with structured JSON error report.
Assert `mod manifest --help` exposes only `inspect`; install/activate/rollback
remain unknown commands.

- [ ] **Step 2: Verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="mod manifest inspect CLI" test/mod-manifest-inspection.test.mjs
```

Expected: Commander reports unknown command `mod`.

- [ ] **Step 3: Register nested CLI commands**

```ts
const modCommands = program
  .command("mod")
  .description("Inspect Ultimate Odycer mod contracts without executing them");

const modManifestCommands = modCommands
  .command("manifest")
  .description("Inspect local addon-manifest v1 structure");

modManifestCommands
  .command("inspect")
  .description("Preflight one manifest without trust or activation")
  .argument("<manifest>", "Explicit local .json manifest file")
  .action(async (manifest: string) => {
    try {
      const report = await inspectModManifest({ manifest });
      printLocalResult(report);
      if (report.status !== "ok") process.exitCode = 1;
    } catch (error) {
      reportLocalError(error);
    }
  });
```

Do not add runtime token/host/port or mutation options.

- [ ] **Step 4: Add installed-package test**

Inside the existing package-consumer temporary root, write a valid manifest,
run the installed CLI, assert fail-closed trust values and unchanged bytes.
Exercise behavior rather than README text.

- [ ] **Step 5: Verify and commit Task 4**

```powershell
rtk npm run build
rtk proxy node --test test/mod-manifest-inspection.test.mjs
rtk npm test
rtk git add -- src/cli.ts test/mod-manifest-inspection.test.mjs test/package-consumer.test.mjs
rtk git commit -m "feat: expose mod manifest inspection" -- src/cli.ts test/mod-manifest-inspection.test.mjs test/package-consumer.test.mjs
```

---

### Task 5: Optional Zig parity, documentation, gates, and review

**Files:**
- Create: `test/mod-manifest-server-parity.test.mjs`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes test-only `UO_ZIG_SERVER_ROOT`; production does not
- Produces explicit parity status separate from structural validity

- [ ] **Step 1: Add optional real Zig parity test**

Skip visibly when `UO_ZIG_SERVER_ROOT` is absent. When present, canonicalize the
root, require the two exact files, snapshot `git status --porcelain`, and spawn
without shell:

```text
zig test src/core/addon_manifest.zig
zig test src/core/addon_trust_store.zig
```

Bound each child to 60 seconds and 1 MiB combined output. Assert 5/5 and 11/11
success signals, zero exit codes, no source status change, and no retained child.
This test does not feed a trust verdict into production reports.

- [ ] **Step 2: Update README, SECURITY, and CHANGELOG**

Document command usage, manifest bounds, warning semantics, signed claim list,
and the immutable trust/package/activation false values. State the absence of
package reading, signature verification, trust store, lifecycle, sandbox, mod
execution, network, and server mutation.

- [ ] **Step 3: Run final component gates with parity configured**

```powershell
rtk npm run build
rtk proxy cmd /c "set UO_ZIG_SERVER_ROOT=F:\_Serv ULtimate Od\Development\Backend\Servers\zig-server-v2&& npm test"
rtk npm audit --omit=dev --audit-level=moderate
rtk npm publish --dry-run
rtk git diff --check
rtk proxy cmd /c "set PYTHONPATH=C:\Users\redga\botte-secrete&& python -m skills.checkup.cli ."
```

Record exact pass/fail/skip counts. Keep checkup structural drift separate.

- [ ] **Step 4: Re-run authoritative Zig gates separately**

```powershell
rtk zig test src/core/addon_manifest.zig
rtk zig test src/core/addon_trust_store.zig
rtk git status --short
```

Expected current results are 5/5 and 11/11, with server working-tree state
unchanged. These are Zig totals, not CLI totals.

- [ ] **Step 5: Review scope and commit documentation/parity test**

Confirm no production `spawn`, crypto verification, package read, network,
install/activate/rollback command, addon/MCP change, dependency, or server edit.

```powershell
rtk git add -- test/mod-manifest-server-parity.test.mjs README.md SECURITY.md CHANGELOG.md
rtk git commit -m "docs: document mod manifest trust boundary" -- test/mod-manifest-server-parity.test.mjs README.md SECURITY.md CHANGELOG.md
```

- [ ] **Step 6: Request independent code review**

Use `superpowers:requesting-code-review`. Review the full feature range against
the spec, focusing on Node/Zig rule parity, SemVer edge cases, fatal UTF-8,
symlink/source integrity, unknown fields, mutable-versus-signed claims, and any
path that could accidentally report trust or activation. Fix every Critical and
Important issue with RED tests and repeat review.
