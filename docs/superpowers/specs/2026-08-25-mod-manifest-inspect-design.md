# Mod Manifest Inspection Design

**Status:** Approved architecture; written design pending user review.

## Purpose

Add a bounded, local, read-only command:

```text
uo-godot-cli mod manifest inspect <manifest.json>
```

The command preflights the structure of one Ultimate Odycer addon manifest v1
without verifying publisher trust, reading a package, installing or activating
a mod, invoking Zig2, or executing mod content.

The authoritative contract remains:

- `Development/Backend/Servers/zig-server-v2/src/core/addon_manifest.zig` for
  server structural validation and canonical signed claims;
- `addon_trust_store.zig` for Ed25519 verification against the trusted
  publisher keyring;
- the server addon registry/lifecycle for package admission, activation,
  disable, uninstall, quarantine, SBOM, and rollback decisions.

The CLI is an advisory structural mirror. A valid CLI report is never an
authorization token or a substitute for server validation.

## Measured Server Baseline

The 2026-08-25 targeted baseline passed:

- `zig test src/core/addon_manifest.zig`: 5/5;
- `zig test src/core/addon_trust_store.zig`: 11/11, including the five manifest
  tests imported by the trust-store module.

The server contract declares:

```text
schema_version = 1
signing_domain = "ultimate-odycer/addon-manifest/v1\n"
signature algorithm = ed25519
```

These values identify the structural mirror. Their presence in the CLI does
not prove future parity; optional server-parity evidence is reported separately.

## Scope

The first version:

- accepts one explicit local `.json` file;
- parses and bounds the manifest without network or child processes;
- validates the v1 signed claims, mutable registry state, optional package
  evidence fields, resource budgets, token arrays, and signature envelope;
- distinguishes hard structural errors from non-authoritative warnings;
- reports the exact trust and activation boundaries.

## Non-goals

- No Ed25519 signature verification and no trust-store loading.
- No package file read, archive parsing, SHA-256 comparison, quarantine, SBOM,
  malware scan, dependency graph, or compatibility resolution.
- No install, register, activate, disable, uninstall, update, rollback, or
  lifecycle transition.
- No script, GDScript, native library, mod code, Zig, Godot, Python, shell, MCP,
  HTTP, or network execution.
- No mutation of the manifest or any adjacent file.
- No claim that a structurally valid manifest is safe, trusted, admitted,
  compatible, sandboxed, or runnable.

## Command Contract

```text
uo-godot-cli mod manifest inspect <manifest.json>
```

The input path is explicit. There is no cwd discovery, project discovery,
environment fallback, URL, `res://`, registry ID, or implicit package lookup.

The command emits one deterministic JSON report to standard output:

- exit `0` when inspection completed and the manifest is structurally valid;
- exit `1` when the file/JSON/contract is invalid or inspection is incomplete.

A valid report always contains:

```json
{
  "structurally_valid": true,
  "trust_verdict": "not_checked",
  "package_integrity": "not_checked",
  "activation_eligible": false,
  "server_authority_required": true
}
```

No combination of manifest fields changes these four trust/activation values.

## Filesystem and JSON Boundaries

- The path must end in `.json` case-insensitively and resolve to a regular file.
- The selected file and its existing parent path must not be a symbolic link,
  junction/reparse escape, directory, device, or other special file.
- The canonical file is read once and is limited to 256 KiB.
- The CLI fingerprints the full bytes before parsing and after report assembly;
  byte size and SHA-256 must remain identical.
- UTF-8 BOM, invalid UTF-8, comments, trailing data, non-finite numbers, and a
  non-object root are rejected.
- JSON is bounded to depth 32, arrays of 64 items, strings of 4 KiB UTF-8,
  8,192 object members/array values total, and 128 retained findings.
- Dangerous object keys `__proto__`, `prototype`, and `constructor` are rejected.

Node JSON parsing does not detect duplicate keys. The report states that
duplicate-key rejection is not proven and the server remains authoritative.

## Required Manifest Fields

The following root fields are required:

| Field | Structural rule |
| --- | --- |
| `schema_version` | integer exactly `1` |
| `id` | 1–96 chars, begins `addon_`, ASCII alphanumeric/`_`/`-` |
| `name` | non-empty UTF-8 string, max 160 bytes |
| `version` | SemVer with optional prerelease/build, no numeric leading zero |
| `engine_api` | SemVer or exact `major.minor`, numeric identifiers |
| `publisher` | non-empty UTF-8 string, max 160 bytes |
| `package_sha256` | exactly 64 ASCII hexadecimal characters |
| `status` | `registered`, `active`, or `disabled` |
| `signature_status` | `pending`, `verified`, or `rejected` |
| `signature` | signature envelope described below |
| `permissions` | array, max 64 tokens, empty allowed |
| `capabilities` | array, 1–64 tokens |
| `cpu_budget_ms` | finite number `> 0` and `<= 50` |
| `memory_budget_mb` | integer `1..4096` |

Permission/capability tokens are 1–96 characters and contain only ASCII
alphanumeric, `_`, `-`, `.`, `:`, or `/`. Duplicate tokens are warnings because
the current Zig validator accepts them; the CLI does not silently normalize
their signed order.

## Signature Envelope

`signature` must be an object containing:

```json
{
  "algorithm": "ed25519",
  "publisher_key_id": "uo.addons.primary",
  "value_base64": "<88-character padded Base64>"
}
```

- `publisher_key_id` is a 1–96 character token.
- A 64-byte Ed25519 signature uses exactly 88 Base64 characters, the final two
  are `==`, and the first 86 use the standard alphanumeric/`+`/`/` alphabet.
- Envelope shape proves only encoding plausibility. The CLI does not decode and
  verify the signature, load a public key, check publisher binding, revocation,
  enablement, or validity windows.

Unknown fields inside `signature` produce warnings. They are excluded from any
CLI trust inference because no trust inference exists.

## Registry and Package State

Optional mutable fields mirror the server registry contract:

| Field | Rule |
| --- | --- |
| `package_status` | `missing`, `admitted`, or `rejected` |
| `package_reason` | 1–64 character token |
| `package_size_bytes` | non-negative integer |
| `package_entry_count` | non-negative integer |
| `package_uncompressed_bytes` | non-negative integer |
| `registered_at` | non-negative integer timestamp |
| `updated_at` | non-negative integer timestamp |
| `signature_checked_at` | non-negative integer timestamp |
| `package_checked_at` | non-negative integer timestamp |
| `signature_reason` | 1–64 character token |

Cross-field structural rules:

- `status: active` requires `signature_status: verified`;
- when `package_status` is present on an active manifest, it must be `admitted`;
- an active manifest without `package_status` matches the current structural
  Zig validator but produces warning `active_package_status_missing`, because
  the lifecycle admission gate separately requires an admitted package;
- `signature_status: verified` is a claimed mutable state, not CLI trust proof.

## Unknown Fields and Signed Claims

The current Zig structural validator parses a generic JSON object and permits
additional registry fields. The CLI therefore does not reject unknown root
fields solely for being unknown. It reports each bounded unknown root field as
warning `unrecognized_manifest_field`.

The immutable claims protected by the server signing domain are exactly:

```text
schema_version, id, name, version, engine_api, publisher, package_sha256,
permissions, capabilities, cpu_budget_ms, memory_budget_mb
```

The CLI reports this ordered field list but does not serialize, hash, sign, or
verify the canonical signed payload. Mutable status/signature/package/timestamp
fields are not treated as signed claims.

## Report Model

```json
{
  "status": "ok",
  "complete": true,
  "manifest_file": "<canonical absolute path>",
  "contract": {
    "schema_version": 1,
    "signing_domain": "ultimate-odycer/addon-manifest/v1\n",
    "authority": "zig-server-v2"
  },
  "manifest": {
    "id": "addon_example",
    "version": "1.0.0",
    "engine_api": "2.1",
    "publisher": "Example Publisher",
    "status": "registered",
    "signature_status": "pending",
    "package_status": null,
    "permissions": 0,
    "capabilities": 1,
    "cpu_budget_ms": 4.5,
    "memory_budget_mb": 128
  },
  "structurally_valid": true,
  "trust_verdict": "not_checked",
  "package_integrity": "not_checked",
  "activation_eligible": false,
  "server_authority_required": true,
  "signed_claim_fields": [],
  "integrity": {
    "bytes": 0,
    "sha256": "<64 lowercase hex>",
    "unchanged": true
  },
  "findings": [],
  "boundaries": [
    "Structural inspection is not signature trust, package admission, sandboxing, compatibility, activation, or runtime safety proof."
  ]
}
```

Invalid manifests return `status: error`, `structurally_valid: false`, and
stable findings. `trust_verdict`, `package_integrity`, `activation_eligible`,
and `server_authority_required` retain the same fail-closed values.

## Architecture and Files

- `src/mod-manifest-inspection.ts`: confined file loading, bounded JSON,
  structural field validation, warnings, integrity, and report assembly.
- `src/cli.ts`: nested `mod manifest inspect <file>` command and exit mapping.
- `test/mod-manifest-inspection.test.mjs`: real temporary files and positive /
  negative structural cases.
- `test/mod-manifest-server-parity.test.mjs`: optional test-only execution of
  the exact server Zig tests when `UO_ZIG_SERVER_ROOT` is explicitly configured.
- `test/package-consumer.test.mjs`: installed package command behavior.
- `README.md`, `SECURITY.md`, `CHANGELOG.md`: contract and non-proof boundary.

No addon, runtime command catalog, MCP compatibility map, package dependency,
or server file is modified by this increment.

## Test Strategy

Implementation follows red-green-refactor.

Positive tests cover:

- registered/pending manifest matching the server fixture shape;
- prerelease/build SemVer and `major.minor` engine API;
- empty permissions and non-empty capabilities;
- optional package/timestamp fields;
- active/verified/admitted structural state while activation remains false;
- unknown fields and duplicate tokens as warnings, not authority;
- deterministic repeated reports and unchanged source fingerprints;
- packaged CLI behavior without `GODOT_CLI_TOKEN`.

Negative tests cover:

- missing, symlinked, non-JSON, oversized, BOM, malformed, deep, non-object,
  dangerous-key, or source-drift input;
- wrong/missing schema version and every required field;
- traversal/invalid addon ID, invalid SemVer/engine API/hash/token arrays;
- non-finite/out-of-range budgets and invalid integer fields;
- bad status/signature/package transitions;
- malformed Ed25519 algorithm/key ID/Base64 envelope;
- output/finding truncation fail-closed behavior.

The optional parity test runs only:

```text
zig test src/core/addon_manifest.zig
zig test src/core/addon_trust_store.zig
```

It is test evidence, not a production child process or a proof that the Node
mirror cannot drift later. Absence of the configured server root is a visible
skip and never parity proof.

## Verification Gates

```text
npm run build
node --test test/mod-manifest-inspection.test.mjs
npm test
UO_ZIG_SERVER_ROOT=<explicit-root> npm test
npm audit --omit=dev --audit-level=moderate
npm publish --dry-run
git diff --check
PYTHONPATH=C:\Users\redga\botte-secrete python -m skills.checkup.cli .
```

The authoritative server tests are rerun separately from their own root. CLI
and Zig totals are reported separately.

## Future Gates

The following require separate designs and are not unlocked by this feature:

1. package hash comparison and bounded archive inventory;
2. shared machine-readable contract/parity artifact to reduce Node/Zig drift;
3. Ed25519 trust-store inspection and verification;
4. dependency/version compatibility;
5. quarantine, SBOM, sandbox, lifecycle, install, activation, and rollback;
6. client Godot/VR mod loading.

## Acceptance Criteria

1. A structurally valid v1 manifest returns exit 0 while trust remains
   `not_checked` and activation remains false.
2. Every field and cross-field rule enforced by the current Zig structural
   validator has a positive or negative Node test.
3. Input and JSON resources are bounded and source bytes remain unchanged.
4. Unknown fields and duplicate tokens cannot grant trust or activation.
5. No signature verification, package read, lifecycle mutation, child process,
   network access, or mod execution exists in production code.
6. Optional Zig parity evidence is explicit and remains distinct from CLI
   structural tests.
7. Documentation never presents structural validity as trust, admission,
   compatibility, sandbox, activation, or runtime safety.
