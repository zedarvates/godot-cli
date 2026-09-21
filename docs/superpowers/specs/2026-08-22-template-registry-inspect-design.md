# Template Registry Inspection Design

**Status:** Approved architecture; written design pending user review.

## Purpose

Add a bounded, local, read-only command:

```text
uo-godot-cli template registry inspect <root>
```

The command verifies the integrity and consumer readiness of one Ultimate
Odycer JSON template registry without executing repository code, validating a
template against JSON Schema, instantiating Godot content, migrating data, or
claiming runtime compatibility.

The current measured registry has a valid catalog v2, 4,063 legacy entries,
one common `strict-schema-v1` contract schema, no strict family schema, and no
`strict-v1` template. A successful inspection must therefore return
`consumer_ready: false` rather than treating legacy presence as compatibility.

## Scope

The first version:

- accepts one explicit local registry root;
- reads exactly `templates/catalog.json` and the files referenced by it;
- validates catalog structure, known profiles, bounded local paths, exact file
  membership, SHA-256 checksums, contract metadata, and strict schema metadata;
- reports readiness counts and reasons deterministically;
- recognizes exact Godot compatibility evidence when present;
- performs no network access and starts no child process.

Inspection is evidence about registry structure and publication integrity. It
is not JSON Schema validation of a strict template and is not a Godot adapter.

## Non-goals

- No `template validate` command until strict templates and family schemas
  exist in the registry.
- No `template instantiate`, `template migrate`, or template generation.
- No Python invocation and no execution of `scripts/validate_registry.py`.
- No embedded copy of `TEMPLATE-SPEC.md` or the contract schema.
- No Draft 2020-12 evaluator or new npm dependency.
- No legacy opt-in, fuzzy matching, implicit latest version, or alias fallback.
- No Godot runtime, addon, MCP, Zig2, asset, mod, network, or XR operation.

## Command Contract

```text
uo-godot-cli template registry inspect <root>
```

`<root>` is an explicit path to a local registry directory. Environment-based
or upward discovery is intentionally absent in v1 so the inspected target is
never ambiguous.

The command emits one deterministic JSON object to standard output. Exit code
`0` means inspection completed and every integrity rule passed. Exit code `1`
means the target, catalog, referenced files, checksums, contract, profiles, or
schema metadata were invalid or the evidence was incomplete.

`consumer_ready: false` is a valid exit-0 result when the registry is integral
but does not yet contain compatible strict content.

## Filesystem and Resource Boundaries

- The root must exist as a regular directory and must not be a symbolic link or
  junction/reparse-point traversal target.
- `templates/catalog.json` must be a regular non-symbolic file below the
  canonical root and at most 16 MiB.
- Catalog paths must use `/`, be relative, contain no empty, `.`, or `..`
  segments, no percent-encoded traversal, no absolute/UNC/drive prefix, and no
  URI scheme, query, fragment, NUL, or backslash.
- Every referenced path is resolved and canonicalized below the registry root.
  The final file and each existing parent segment must not redirect outside the
  root through a symlink or junction.
- At most 10,000 catalog entries, 10,000 aliases, 4 MiB per referenced JSON
  file, and 512 MiB total referenced bytes are accepted.
- JSON depth is limited to 64, arrays to 20,000 items, strings to 1 MiB UTF-8,
  and total visited values to 2,000,000 per document.
- At most 256 findings are retained. Reaching any input or finding limit makes
  the inspection incomplete and fails closed.
- Only files named by the catalog are opened. The command never recursively
  scans the registry tree.

Node's JSON parser cannot detect duplicate keys. This inspection reports that
strict duplicate-key and full schema validation remain the canonical registry
validator's responsibility; it does not claim to replace that gate.

## Catalog v2 Inspection

The catalog root must be an object with exactly these required fields:

```json
{
  "registry_version": "2.0.0",
  "generated_at": "2026-08-19",
  "source_set": "authoritative-server-schemas",
  "entries": [],
  "aliases": []
}
```

Additional top-level fields are reported as errors to keep the inspected format
closed. `generated_at` and `source_set` must be non-empty bounded strings; they
are metadata and do not influence readiness.

Every entry must be an object with bounded string fields and must contain:

- `name`, `kind`, `version`, `status`, `file`, `sha256`, `compatibility`;
- `validation_profile` and `contract_version`.

Known profiles are exactly:

- `legacy-unvalidated` with `contract_version: null`;
- `strict-v1` with `contract_version: "1.0.0"`;
- `strict-schema-v1` with `contract_version: "1.0.0"`.

Unknown profiles, profile/version disagreement, duplicate normalized file paths,
duplicate exact strict identities, malformed SHA-256, non-array compatibility,
or an unrecognized strict entry shape are errors. Legacy-specific provenance
fields are retained and ignored for consumer readiness.

For each entry, the command verifies the exact full-file lowercase SHA-256.
A missing, unreadable, non-regular, symbolic, oversized, out-of-root, or
checksum-divergent file is an error.

Aliases must be objects using exact versioned canonical references. This
command checks shape, uniqueness, self-reference, target presence, and cycles
using only exact strict catalog identities. It never resolves an alias for a
consumer.

## Contract and Schema Inspection

Exactly one common contract entry must exist with:

```json
{
  "name": "template-contract",
  "kind": "json-schema",
  "version": "1.0.0",
  "file": "templates/schemas/template-contract/v1.0.0/schema.json",
  "validation_profile": "strict-schema-v1",
  "contract_version": "1.0.0"
}
```

Its checksum must pass. Its JSON root must declare:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://ultimateodycer.com/schemas/template-contract/1.0.0",
  "type": "object",
  "additionalProperties": false
}
```

The required field list must contain the twelve v1 envelope fields:
`$schema`, `contract_version`, `id`, `slug`, `family`, `version`, `authority`,
`intended_consumers`, `compatibility`, `dependencies`, `spec_checksum`, and
`spec`. Inspection checks this metadata but does not execute the schema.

Each other `strict-schema-v1` entry is a strict family schema. It must use the
exact layout `templates/schemas/<family>/v<semver>/schema.json`, declare Draft
2020-12, use `$id` `https://ultimateodycer.com/schemas/<family>/<semver>`, and
have a catalog version matching the path. Remote `$ref` values are forbidden;
fragment references and normalized local registry references are inspected for
exact existence. The command reports their count as `strict_family_schemas`.

## Strict Template and Compatibility Inspection

Each `strict-v1` entry must expose the exact catalog fields required by
`TEMPLATE-SPEC.md`: `id`, `slug`, `family`, `schema_file`, `spec_checksum`,
`intended_consumers`, and `supersedes`, plus the common entry fields.

Inspection checks:

- exact layout `templates/<family>/<slug>/v<semver>/template.json`;
- path/family/slug/version agreement;
- `id == <family>:<slug>`;
- exact `schema_file` linkage to one catalogued strict family schema;
- exact dependency, supersession, alias, and schema reference closure;
- catalog `spec_checksum` shape and equality with the document value;
- intended consumer and compatibility arrays are bounded and well-shaped.

It does not recompute canonical `spec_checksum` or execute JSON Schema in this
increment. Those remain explicit reasons why `template validate` is absent.

A strict template is counted as Godot-compatible only when its compatibility
array contains at least one closed record with:

- `consumer: "godot-vr"`;
- non-empty exact `version`;
- valid ISO 8601 `verified_at` ending in `Z`;
- bounded non-empty `evidence`.

`intended_consumers` alone never counts as compatibility.

## Readiness Model

The report separates three levels:

1. `integrity_ready`: the complete bounded inspection passed with zero errors.
2. `strict_content_ready`: integrity passed, at least one strict family schema
   exists, and at least one `strict-v1` template links to one exactly.
3. `consumer_ready`: strict content is ready and at least one strict template
   contains exact `godot-vr` compatibility evidence.

The current registry is expected to report:

```json
{
  "integrity_ready": true,
  "strict_content_ready": false,
  "consumer_ready": false,
  "profiles": {
    "legacy-unvalidated": 4063,
    "strict-schema-v1": 1,
    "strict-v1": 0
  },
  "strict_family_schemas": 0,
  "godot_compatible_templates": 0
}
```

These counts are measured expectations for the current fixture, not hardcoded
production values.

## Report Model

```json
{
  "status": "ok",
  "complete": true,
  "registry_root": "<canonical absolute path>",
  "catalog": {
    "resource": "templates/catalog.json",
    "registry_version": "2.0.0",
    "entries": 4064,
    "aliases": 0,
    "verified_files": 4064,
    "verified_bytes": 0
  },
  "profiles": {
    "legacy-unvalidated": 4063,
    "strict-schema-v1": 1,
    "strict-v1": 0
  },
  "contract": {
    "version": "1.0.0",
    "schema_file": "templates/schemas/template-contract/v1.0.0/schema.json",
    "ready": true
  },
  "strict_family_schemas": 0,
  "strict_templates": 0,
  "godot_compatible_templates": 0,
  "integrity_ready": true,
  "strict_content_ready": false,
  "consumer_ready": false,
  "reasons": [
    "No strict-v1 template is catalogued.",
    "No strict family schema is catalogued."
  ],
  "findings": [],
  "boundaries": [
    "Registry inspection is not template schema validation, Godot instantiation, migration, or runtime compatibility proof."
  ]
}
```

Reasons and findings use stable codes and deterministic ordering. Absolute file
paths are not emitted for individual catalog entries. A complete integral but
not-ready registry has `status: "ok"`; any error produces `status: "error"`,
`complete: false`, and all readiness flags false.

## Architecture and Files

- `src/template-registry-inspection.ts`: filesystem confinement, bounded JSON,
  catalog/profile/contract/schema/reference/checksum inspection, readiness, and
  report assembly.
- `src/cli.ts`: `template registry inspect <root>` registration and exit-code
  mapping.
- `test/template-registry-inspection.test.mjs`: disposable valid, not-ready,
  ready, and fail-closed fixtures.
- `test/template-registry-real.test.mjs`: optional read-only inspection of an
  explicitly configured real registry root; absence is a visible skip.
- `test/package-consumer.test.mjs`: installed package command behavior.
- `README.md`, `SECURITY.md`, `CHANGELOG.md`: usage and proof boundaries.

No addon, runtime command manifest, MCP catalog, dependency, or package script
changes are required.

## Test Strategy

Implementation follows red-green-refactor. Tests use real temporary files and
hand-computed SHA-256 literals/helpers outside production code.

Positive fixtures cover:

- integral catalog with common contract only and `consumer_ready: false`;
- strict family schema plus strict template without compatibility;
- exact `godot-vr` compatibility evidence producing `consumer_ready: true`;
- deterministic repeated reports and package-installed CLI behavior;
- the current real registry reporting 4,063 legacy, one strict schema, zero
  strict templates, and false consumer readiness.

Negative fixtures cover:

- wrong catalog version or unknown top-level/profile fields;
- catalog/root/file symlink, junction, traversal, URL, percent traversal,
  missing file, directory, and checksum mismatch;
- excessive entries, aliases, bytes, depth, arrays, strings, values, or
  findings;
- duplicate paths/identities and malformed entry/profile contracts;
- missing, duplicate, malformed, or divergent common contract schema;
- invalid Draft/$id/layout/version metadata and remote or broken `$ref`;
- broken strict schema/dependency/supersession/alias closure;
- intended-consumer hints incorrectly treated as compatibility;
- malformed compatibility records and alias cycles.

The real-registry test is inspection evidence only. The registry's own
`python scripts/validate_registry.py` remains the authority for duplicate-key,
canonical `spec_checksum`, policy, and full JSON Schema validation.

## Verification Gates

```text
npm run build
node --test test/template-registry-inspection.test.mjs
node --test test/template-registry-real.test.mjs
npm test
npm audit --omit=dev --audit-level=moderate
npm publish --dry-run
git diff --check
PYTHONPATH=C:\Users\redga\botte-secrete python -m skills.checkup.cli .
```

When the real registry is available, its independent gates are also rerun:

```text
python -m unittest discover -s tests -v
python scripts/validate_registry.py
```

The two repositories' proof totals remain separate.

## Activation Gate for `template validate`

`template validate` may be designed only after a real registry inspection
reports `strict_content_ready: true`: at least one strict family schema and one
linked strict template exist. Its later design must decide how Draft 2020-12
and canonical `spec_checksum` are validated without duplicating or silently
executing registry code.

`template validate` is not activated merely because the common schema exists,
the catalog is integral, or `intended_consumers` mentions Godot.

## Acceptance Criteria

1. The current integral registry returns exit 0, `complete: true`,
   `integrity_ready: true`, and `consumer_ready: false` with measured profile
   counts and explicit readiness reasons.
2. Every named catalog file is verified by exact SHA-256 under bounded local
   filesystem rules; no unlisted tree scan or network access occurs.
3. Unknown profiles, malformed profile/contract versions, broken schema or
   strict reference closure, and incomplete evidence fail closed.
4. Legacy entries never count as strict content or compatibility.
5. `intended_consumers` never counts as compatibility.
6. Only an exact evidence-bearing `godot-vr` compatibility record can make a
   strict template consumer-compatible.
7. `template validate`, `instantiate`, `migrate`, schema execution, Python
   execution, and Godot execution remain absent.
8. Documentation labels inspection as structural/integrity evidence, not
   template validity or runtime readiness.
