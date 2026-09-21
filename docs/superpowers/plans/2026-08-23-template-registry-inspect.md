# Template Registry Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, local, read-only `uo-godot-cli template registry inspect <root>` command that verifies catalog/profile/contract/schema/checksum integrity and reports strict Godot consumer readiness without validating or instantiating templates.

**Architecture:** `template-registry-inspection.ts` owns canonical filesystem confinement, bounded JSON parsing, catalog semantics, exact SHA-256 verification, strict schema/template link inspection, and deterministic readiness reporting. `cli.ts` only registers the nested command and maps report status to the process exit code. No registry code, Python, Godot, network client, JSON Schema engine, addon command, or MCP capability is invoked.

**Tech Stack:** TypeScript ES2022, Node.js built-ins, Commander 13, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-22-template-registry-inspect-design.md`

## Global Constraints

- Read only one explicit local registry root; never discover it from cwd or environment in production.
- Read only `templates/catalog.json` and exact catalog-referenced files; never recursively scan.
- Reject root/catalog/file symlinks, junction escapes, absolute paths, traversal, URLs, query/fragment, NUL, backslash, and malformed percent encoding.
- Bound catalog to 16 MiB; 10,000 entries; 10,000 aliases; each referenced JSON to 4 MiB; total referenced bytes to 512 MiB.
- Bound JSON depth to 64, arrays to 20,000, strings to 1 MiB UTF-8, visited values to 2,000,000, and retained findings to 256.
- Known profiles are exactly `legacy-unvalidated`, `strict-v1`, and `strict-schema-v1` with their exact contract-version rules.
- `consumer_ready: false` with `status: ok` is expected for an integral registry without compatible strict content.
- `intended_consumers` never counts as compatibility; only exact evidence-bearing `godot-vr` compatibility does.
- Do not add `template validate`, `instantiate`, `migrate`, Python execution, Godot execution, network access, schema execution, or npm dependencies.
- Preserve all unrelated changes and commit only files owned by each task.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/template-registry-inspection.ts` | Resolve root and catalog, parse bounded JSON, verify entries/files/checksums/contracts/schemas/references, assemble readiness report. |
| `src/cli.ts` | Register `template registry inspect <root>` and JSON/exit behavior. |
| `test/template-registry-inspection.test.mjs` | Temporary positive/negative registries and deterministic report tests. |
| `test/template-registry-real.test.mjs` | Explicit optional real-registry read-only evidence. |
| `test/package-consumer.test.mjs` | Installed package exposes and runs the nested command. |
| `README.md` | Usage, readiness semantics, proof boundary. |
| `SECURITY.md` | Filesystem, JSON, checksum, reference, and no-execution boundaries. |
| `CHANGELOG.md` | Unreleased inspection feature and non-goals. |

---

### Task 1: Bounded registry root, catalog, and not-ready report

**Files:**
- Create: `src/template-registry-inspection.ts`
- Create: `test/template-registry-inspection.test.mjs`

**Interfaces:**
- Produces: `inspectTemplateRegistry(options): Promise<TemplateRegistryInspectionReport>`
- Produces: exported filesystem/JSON/finding limits
- Produces: deterministic `integrityReady`, `strictContentReady`, `consumerReady`

- [ ] **Step 1: Write the failing common-contract-only inspection test**

Create a temporary root containing `templates/catalog.json` and the exact
common contract schema path. Compute the fixture file checksum in the test with
Node `createHash`; do not use production helpers. Assert this literal behavior:

```js
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
```

The common schema fixture must contain Draft 2020-12, the exact `$id`, object
type, `additionalProperties: false`, and all twelve required envelope fields.

- [ ] **Step 2: Run the test and verify RED**

```powershell
rtk npm run build
rtk proxy node --test test/template-registry-inspection.test.mjs
```

Expected: module resolution fails because `dist/template-registry-inspection.js`
does not exist.

- [ ] **Step 3: Implement public types and fixed limits**

Create `src/template-registry-inspection.ts` with these exports:

```ts
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
    resource: "templates/catalog.json";
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
  contract: { version: "1.0.0" | null; schemaFile: string | null; ready: boolean };
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
```

- [ ] **Step 4: Implement canonical root/catalog resolution and bounded JSON**

Require an explicit absolute or cwd-resolved root directory. Use `lstat`, reject
symbolic links/non-directories, then `realpath`. Resolve only
`templates/catalog.json`, reject symlink/non-file and realpath escape, enforce
16 MiB before reading. Parse JSON and walk it iteratively to enforce depth,
array, string, dangerous-key, non-finite-number, and visited-value limits.

Require a root object with exactly `registry_version`, `generated_at`,
`source_set`, `entries`, and `aliases`. Require registry version `2.0.0`, bounded
non-empty metadata strings, and arrays within count limits.

- [ ] **Step 5: Implement the minimal common contract entry check**

For Task 1, require exactly one entry matching the fixed common contract tuple.
Resolve its file under the root, verify regular/non-symbolic confinement and
SHA-256, parse bounded JSON, and check Draft, `$id`, `type`,
`additionalProperties`, and the twelve required names. Count it as one
`strict-schema-v1`; do not treat it as a family schema.

Build sorted reasons independently of error findings. With zero errors,
`complete` and `integrityReady` are true even when strict/consumer readiness is
false.

- [ ] **Step 6: Add failing root/catalog safety tests**

Add separate tests for missing root, non-directory root, root symlink when the
platform permits it, missing catalog, catalog symlink, oversized catalog,
malformed JSON, excessive JSON nesting, wrong/extra root keys, wrong registry
version, non-array entries/aliases, and entry/alias count limits. Name the
production guard each test would catch.

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

```powershell
rtk npm run build
rtk proxy node --test test/template-registry-inspection.test.mjs
rtk git diff --check
```

- [ ] **Step 8: Commit Task 1 only**

```powershell
rtk git add -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
rtk git commit -m "feat: inspect bounded template registry roots" -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
```

---

### Task 2: Entry profiles, confined files, and exact checksums

**Files:**
- Modify: `src/template-registry-inspection.ts`
- Modify: `test/template-registry-inspection.test.mjs`

**Interfaces:**
- Consumes: root/catalog/report contracts from Task 1
- Produces stable finding codes: `REGISTRY_ENTRY_INVALID`, `REGISTRY_PROFILE_INVALID`, `REGISTRY_PATH_FORBIDDEN`, `REGISTRY_FILE_MISSING`, `REGISTRY_FILE_SYMLINK`, `REGISTRY_CHECKSUM_MISMATCH`, `REGISTRY_LIMIT_EXCEEDED`

- [ ] **Step 1: Write failing mixed-profile checksum test**

Extend the fixture with one valid legacy file plus the common schema. Assert two
verified files/bytes and exact profile counts. Then corrupt only the legacy
file and assert exit-state report error, checksum finding, `complete: false`,
and every readiness flag false.

- [ ] **Step 2: Verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="mixed-profile|checksum" test/template-registry-inspection.test.mjs
```

Expected: the legacy entry is ignored or its mismatch is not detected.

- [ ] **Step 3: Implement closed entry/profile validation**

Require each entry to contain bounded `name`, `kind`, `version`, `status`,
`file`, `sha256`, `compatibility`, `validation_profile`, and
`contract_version`. Reject malformed SemVer/checksum, non-array compatibility,
unknown profiles, legacy with non-null contract version, and strict profiles
without contract `1.0.0`.

Allow extra legacy provenance fields without using them. For strict entries,
reject unknown fields outside the exact spec-defined set.

- [ ] **Step 4: Implement path confinement and pre-hash resource accounting**

Validate raw and once-decoded catalog paths before normalization. Reject empty,
`.`/`..`, backslash, drive/UNC/absolute, URI scheme, query, fragment, NUL, and
percent traversal. Resolve with `lstat` and `realpath`; reject symlink,
non-regular, or escape. Check individual and cumulative stat sizes before
opening/hashing to avoid reading an already-invalid closure.

Deduplicate by canonical path using case folding only on Windows. Duplicate
normalized catalog file paths are errors even when checksums match.

- [ ] **Step 5: Add rejection tests for every path/file/profile boundary**

Use table-driven fixtures for `../`, `sub/../`, `%2e%2e`, `/abs`, `C:\\abs`,
UNC, `https:`, `file:`, query, fragment, NUL, backslash, missing file,
directory, symlink, duplicate path, unknown profile, profile/version mismatch,
malformed checksum, oversized file, and cumulative-byte overflow using sparse
files. Assert stable codes and no outside file reads.

- [ ] **Step 6: Verify Task 2 and full baseline**

```powershell
rtk npm run build
rtk proxy node --test test/template-registry-inspection.test.mjs
rtk npm test
```

- [ ] **Step 7: Commit Task 2 only**

```powershell
rtk git add -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
rtk git commit -m "feat: verify template registry checksums" -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
```

---

### Task 3: Strict contract and family schema metadata

**Files:**
- Modify: `src/template-registry-inspection.ts`
- Modify: `test/template-registry-inspection.test.mjs`

**Interfaces:**
- Consumes: verified parsed strict-schema entries from Task 2
- Produces: exact common-contract readiness and `strictFamilySchemas`
- Produces finding codes: `REGISTRY_CONTRACT_INVALID`, `REGISTRY_SCHEMA_INVALID`, `REGISTRY_SCHEMA_REF_FORBIDDEN`, `REGISTRY_SCHEMA_REF_MISSING`

- [ ] **Step 1: Write failing family-schema readiness test**

Add a catalogued `strict-schema-v1` family schema at
`templates/schemas/monsters/v1.0.0/schema.json`, with Draft 2020-12, exact `$id`,
object type, local contract `$ref`, and checksum. Assert
`strictFamilySchemas === 1` while strict/consumer readiness remains false
because no strict template exists.

- [ ] **Step 2: Verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="family schema" test/template-registry-inspection.test.mjs
```

- [ ] **Step 3: Harden exact common contract metadata**

Check exactly one common entry and exact schema path/version/profile/checksum.
Require the twelve fields as a set, not merely a count. Reject missing,
duplicate, divergent Draft/`$id`/type/closed-object metadata, malformed required
container, and remote `$ref` anywhere in the common schema.

- [ ] **Step 4: Implement strict family schema inspection**

Parse path with exact ASCII kebab-case family and `v<semver>` layout. Require
catalog version agreement, Draft 2020-12, exact family `$id`, object type, and
bounded local `$ref` values. Fragment refs are allowed. For file refs, remove
the fragment, decode once, reject traversal/network/absolute/backslash, resolve
relative to the schema, and require exact catalog membership and existence.

- [ ] **Step 5: Add contract/schema negative tests**

Cover missing/duplicate common entry, wrong tuple, missing required envelope
field, wrong Draft/`$id`, family/path/version disagreement, nested family,
remote ref, broken local ref, ref traversal, and uncatalogued referenced schema.

- [ ] **Step 6: Verify and commit Task 3**

```powershell
rtk npm run build
rtk proxy node --test test/template-registry-inspection.test.mjs
rtk git diff --check
rtk git add -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
rtk git commit -m "feat: inspect strict template schemas" -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
```

---

### Task 4: Strict templates, exact references, and consumer readiness

**Files:**
- Modify: `src/template-registry-inspection.ts`
- Modify: `test/template-registry-inspection.test.mjs`

**Interfaces:**
- Consumes: verified strict family schema index from Task 3
- Produces: `strictTemplates`, `godotCompatibleTemplates`, `strictContentReady`, `consumerReady`
- Produces finding codes: `REGISTRY_STRICT_TEMPLATE_INVALID`, `REGISTRY_REFERENCE_MISSING`, `REGISTRY_REFERENCE_DUPLICATE`, `REGISTRY_ALIAS_CYCLE`, `REGISTRY_COMPATIBILITY_INVALID`

- [ ] **Step 1: Write failing strict-content readiness test**

Add a valid strict template entry/file linked to the monsters schema, with exact
path/identity/version, declarative authority, matching document/catalog
`spec_checksum`, empty dependencies/supersedes, `intended_consumers:
["godot-vr"]`, and empty compatibility. Assert:

```js
assert.equal(report.strictTemplates, 1);
assert.equal(report.strictContentReady, true);
assert.equal(report.godotCompatibleTemplates, 0);
assert.equal(report.consumerReady, false);
```

This test must fail if intended-consumer routing is treated as compatibility.

- [ ] **Step 2: Write failing exact Godot compatibility test**

Add one closed compatibility record with `consumer: "godot-vr"`, exact version,
UTC timestamp, and evidence. Assert compatible count one and consumer readiness
true. Add another fixture with only `consumer: "zig-server-v2"`; readiness must
stay false.

- [ ] **Step 3: Verify RED for both readiness branches**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="strict-content|Godot compatibility" test/template-registry-inspection.test.mjs
```

- [ ] **Step 4: Implement strict template entry/document inspection**

Require the exact strict fields from the spec and reject unknown strict fields.
Parse exact path, compare family/slug/version/id, require declarative authority,
matching document/catalog `spec_checksum` shape, exact `schema_file` mapping to
one strict family schema, bounded arrays, and exact versioned references.

Do not recompute canonical `spec_checksum` and do not execute the family schema;
retain these as report boundary statements.

- [ ] **Step 5: Implement exact reference and alias graph checks**

Index strict identities as `<id>@<version>`. Reject duplicates. Resolve every
dependency and supersession exactly once. Validate aliases as exact
source/target pairs, reject unknown fields, duplicate source, self target,
missing target, and cycles with a bounded iterative graph walk. Do not apply
aliases to readiness or consumer selection.

- [ ] **Step 6: Implement closed compatibility evidence inspection**

Require compatibility records to contain exactly `consumer`, `version`,
`verified_at`, and `evidence`; validate bounded strings, ASCII kebab consumer,
UTC ISO timestamp, and evidence pattern. Count a template as compatible once
when any valid record has consumer `godot-vr`.

- [ ] **Step 7: Add strict/reference/compatibility negative tests**

Cover path/identity disagreement, missing schema, duplicate identity, malformed
spec checksum, missing/duplicate dependency, supersession self/missing,
malformed alias, alias cycle, unknown compatibility field, non-UTC date, empty
evidence, and intended consumer without compatibility.

- [ ] **Step 8: Verify and commit Task 4**

```powershell
rtk npm run build
rtk proxy node --test test/template-registry-inspection.test.mjs
rtk npm test
rtk git add -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
rtk git commit -m "feat: report strict template readiness" -- src/template-registry-inspection.ts test/template-registry-inspection.test.mjs
```

---

### Task 5: CLI, installed package, and real-registry evidence

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/template-registry-inspection.test.mjs`
- Create: `test/template-registry-real.test.mjs`
- Modify: `test/package-consumer.test.mjs`

**Interfaces:**
- Consumes: `inspectTemplateRegistry()` from Tasks 1-4
- Produces: `uo-godot-cli template registry inspect <root>`
- Consumes optional test-only `UO_TEMPLATE_REGISTRY_ROOT`; production does not

- [ ] **Step 1: Write failing CLI success/error tests**

Spawn the built CLI against a valid not-ready fixture and assert exit 0, empty
stderr, `status: ok`, complete true, and consumer false. Corrupt a checksum and
assert exit 1 with structured JSON `status: error`. Assert `--help` exposes
only `inspect` under `template registry`; `validate`, `instantiate`, and
`migrate` remain unknown commands.

- [ ] **Step 2: Verify RED**

```powershell
rtk npm run build
rtk proxy node --test --test-name-pattern="registry inspect CLI" test/template-registry-inspection.test.mjs
```

Expected: Commander reports unknown command `template`.

- [ ] **Step 3: Register the nested CLI commands**

Add to `src/cli.ts`:

```ts
const templateCommands = program
  .command("template")
  .description("Inspect versioned Ultimate Odycer template contracts");

const templateRegistryCommands = templateCommands
  .command("registry")
  .description("Inspect a local JSON template registry without executing it");

templateRegistryCommands
  .command("inspect")
  .description("Verify catalog, profiles, schemas, checksums, and readiness")
  .argument("<root>", "Explicit local registry root")
  .action(async (root: string) => {
    try {
      const report = await inspectTemplateRegistry({ root });
      printLocalResult(report);
      if (report.status !== "ok") process.exitCode = 1;
    } catch (error) {
      reportLocalError(error);
    }
  });
```

Do not add runtime host/port/token options or addon manifest commands.

- [ ] **Step 4: Add installed-package behavior**

In `test/package-consumer.test.mjs`, create a minimal integral registry fixture
inside the existing temporary consumer test, execute the installed CLI, assert
consumer false and unchanged bytes. Exercise behavior, not README source text.

- [ ] **Step 5: Add explicit real-registry test**

Create `test/template-registry-real.test.mjs`. Read only
`UO_TEMPLATE_REGISTRY_ROOT`; skip visibly when absent. When present, snapshot
`git status --porcelain` if the root is a Git checkout, run inspection twice,
assert deterministic reports, exact current counts (4,063 legacy, one strict
schema, zero strict templates), integrity true, consumer false, and unchanged
Git status. Never hardcode a machine path.

- [ ] **Step 6: Run CLI/package/real gates**

```powershell
rtk npm run build
rtk proxy node --test test/template-registry-inspection.test.mjs
rtk npm test
rtk proxy cmd /c "set UO_TEMPLATE_REGISTRY_ROOT=F:\_Serv ULtimate Od\artifacts\github-prep\ultod-json-template-registry&& npm test"
```

The default suite may show one explicit registry skip. The configured suite
must execute it; a skip is not real-registry proof.

- [ ] **Step 7: Commit Task 5 only**

```powershell
rtk git add -- src/cli.ts test/template-registry-inspection.test.mjs test/template-registry-real.test.mjs test/package-consumer.test.mjs
rtk git commit -m "feat: expose template registry inspection" -- src/cli.ts test/template-registry-inspection.test.mjs test/template-registry-real.test.mjs test/package-consumer.test.mjs
```

---

### Task 6: Documentation, cross-repository gates, and review

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: final command/report behavior from Tasks 1-5
- Produces: explicit inspection/readiness/proof boundaries

- [ ] **Step 1: Update user and security documentation**

Document the command, exit-0 false-readiness semantics, profile meanings,
exact `godot-vr` compatibility requirement, and limits. State that inspection
does not detect duplicate JSON keys, execute JSON Schema, recompute canonical
`spec_checksum`, validate/migrate/instantiate templates, run Python/Godot, or
prove runtime compatibility.

Add an Unreleased changelog entry labeled inspection tooling. Do not mark
`template validate` as available.

- [ ] **Step 2: Run final component gates**

```powershell
rtk npm run build
rtk proxy cmd /c "set UO_TEMPLATE_REGISTRY_ROOT=F:\_Serv ULtimate Od\artifacts\github-prep\ultod-json-template-registry&& npm test"
rtk npm audit --omit=dev --audit-level=moderate
rtk npm publish --dry-run
rtk git diff --check
rtk proxy cmd /c "set PYTHONPATH=C:\Users\redga\botte-secrete&& python -m skills.checkup.cli ."
```

Read complete logs for every failure. Record exact pass/fail/skip counts and
keep component checkup structural drift separate from feature evidence.

- [ ] **Step 3: Re-run independent registry authority gates**

From the real registry checkout:

```powershell
rtk python -m unittest discover -s tests -v
rtk python scripts/validate_registry.py
rtk git status --short
```

Expected current evidence: 35 tests pass; 4,065 JSON documents and 4,064
catalog entries validate; working tree stays clean. These totals are not CLI
test totals.

- [ ] **Step 4: Review requirements and diff scope**

Verify every acceptance criterion against a report/test. Confirm no new npm
dependency, no Python/Godot/network/spawn import, no addon/MCP/manifest change,
and no `template validate`, `instantiate`, or `migrate` command. Inspect branch
status and diff against its base.

- [ ] **Step 5: Commit documentation after gates**

```powershell
rtk git add -- README.md SECURITY.md CHANGELOG.md
rtk git commit -m "docs: document template registry readiness" -- README.md SECURITY.md CHANGELOG.md
```

- [ ] **Step 6: Request independent code review**

Use `superpowers:requesting-code-review`. The reviewer must inspect the full
feature range against the spec, with special attention to symlink/junction
confinement, pre-hash limits, strict-versus-legacy counting, compatibility
evidence, deterministic findings, and false validation/runtime claims. Fix all
Critical and Important findings with new RED tests, then re-review.
