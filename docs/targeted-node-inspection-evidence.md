# Targeted node inspection and MCP bridge — 2026-10-04

The primary task is to improve the existing Godot CLI/MCP and Blender
connectors, using the Mixar demonstration as a reference. AIMesher interface
work is secondary. The first change added focused Godot CLI inspection. The
second adds a bounded read-only MCP adapter to that same client. Neither
implements an agent orchestrator or a Blender connector.

## Behavior

An agent inspecting an object's movement can request:

```sh
uo-godot-cli get-node /root/Main/Player --properties position velocity
```

The output preserves `id`, `status`, node `name`, `type`, and `path`, then returns
only the requested property values and `_cli` selection metadata. Unrequested
properties, groups, child names and script details are not included. Zero,
false and null values are preserved. Missing properties reject the selection
instead of returning partial data or falling back to the full node.

Selections accept 1–32 unique exact names, each at most 128 UTF-8 bytes, without
control characters. Invalid selections are rejected before connecting.
Without `--properties`, the previous complete response remains available.

The existing authenticated, loopback-only `get_node` request is reused exactly.
Selection occurs after that bounded response reaches the CLI. The improvement
is less JSON supplied to the agent; it does not reduce addon work, transport
bytes or prove a billed-token or latency saving. No additional dependency,
model call, server, mutation or unsafe gate is introduced for this feature.

## First change: validation

Base commit: `600ffa99a5a04b0dd36717813be57026fcc7f11e`.
Local branch: `feat/targeted-node-inspection`.

| Check | Result | Scope |
| --- | --- | --- |
| `npm run build` | Passed | TypeScript compilation |
| Node inspection, client and live-command CLI tests | 23 passed; 0 failed | Includes 11 new selection and CLI tests; transport uses an authenticated local fixture, not Godot |
| Final `npm test` | 223 passed; 2 failed; 26 skipped (251 total) | Full suite is not green in this environment |
| Original-commit runtime tests | 1 passed; the same 2 failed | Reproduced before the dependency update, in a separate baseline worktree |
| Child-process diagnostic | `/proc/<child-pid>/cmdline` and `/proc/<child-pid>/exe` both return `ENOENT` | Explains unavailable process identity here; ownership guards remain enforced |
| Final production dependency audit | 0 vulnerabilities | `npm audit --omit=dev --audit-level=moderate` |
| Package dry-run | Passed | Verification only; no package published |

The two original-commit failures are:

- `managed runtime owns one process, keeps bounded logs, and stops it`
- `runtime stop fails closed when the process marker no longer matches`

Both require process identity observation unavailable in this environment.
The second receives `process_identity_unavailable` instead of
`identity_mismatch`. No guard was relaxed and no test was suppressed. Real
Godot and external integration tests still require their target executables
and repositories; the local fixture is not proof of a live game scene.

## Dependency correction

The required audit found the pre-existing transitive `fast-uri` 3.1.7 entry.
Only that lockfile entry was updated to patched 3.1.8; `package.json` and the
dependency range are unchanged. The authoritative advisory is
[GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj).
The final full-suite result above uses the updated dependency installation.

## Second change: bounded MCP entry point

`uo-godot-cli mcp serve` now exposes six read-only tools over stdio:
`godot_doctor`, `godot_get_node`, `godot_ping`, `godot_scene_tree`,
`godot_validate_scene`, and `godot_viewport_info`. It reuses the same
authenticated, loopback-only client and addon commands. The addon and its
wire protocol were not modified. Existing CLI commands remain available.

The node tool requires an exact property selection. Scene inspection defaults
to depth 2, accepts at most depth 8, and rejects traversal truncation. Invalid
or incomplete validation is a tool error. Strict argument validation blocks
unknown tools, extra fields and invalid ranges before TCP. The catalog is
small and ordered consistently; there is no generic command forwarding.

Four reads may run concurrently, with no queue or automatic retry. MCP
requests, JSON depth/value counts, input buffering, output and runtime responses
have explicit budgets. Deadlines, cancellation and stdin EOF release owned
reads. Native hostname work remains charged against a four-lookup budget even
after cancellation. The CLI exits when its MCP session closes so stalled stdout
cannot keep the process alive. Secret-bearing input closes the session and
returned token matches, including JSON-escaped forms, are redacted.

This is an MCP connector for external agents, not a multi-agent scheduler.
It makes no model, sampling, image-generation, Parcimonia or JEV backend call.
No paid service, HTTP listener, addon activation or project-file change is
introduced. Context is narrowed; runtime-speed and billed-token savings still
require measurements on the target workflow.

### Dependencies and installation

The official MIT-licensed MCP TypeScript SDK is pinned to 1.32.0. Its supported
`@hono/node-server` 1.19.17 version is an explicit dependency pin, with Node's
minimum updated to 18.14.1. The HTTP transport is not used here. A local-only
override was replaced because npm does not honor overrides in an installed
dependency; see [npm's package.json documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides).

A fresh consumer installed only the actual CLI archive through npm, with no
preseeded dependency tree or root overrides. Its 96 installed dependency entries
all accepted Node 18.14.1; Hono was deduplicated at 1.19.17. The installed MCP
entry point then initialized under Node 18.14.1 and advertised all six tools.
This was a manual installation check, not a live Godot test.

The existing offline package-consumer fixture now supports normal nested
dependency versions. It seeds an isolated production tree, its declared bins
and a consumer lock, installs the real CLI archive without network access,
and exercises MCP discovery as well as the previous addon and local validators.
It does not flatten distinct versions, copy development dependencies, skip
the package test or link back to the checkout.

### Final validation

| Check | Result | Scope |
| --- | --- | --- |
| `npm ci --ignore-scripts`, TypeScript build | Passed | Reproducible installation and compilation |
| MCP, node selection, client and live-command checks | 55 passed on Node 18.14.1 | Five test files; Node 18's runner reports five passing file groups containing 55 named checks |
| Final `npm test` on Node 24.19.0 | 255 passed; 2 failed; 26 skipped (283 total) | All 32 additional MCP/cancellation checks and the expanded package-consumer test pass |
| Protocol negotiation | Passed for `2025-11-25` and `2025-06-18` | Official SDK client; legacy MCP, not a newer stateless-protocol claim |
| Cold archive-only consumer installation | Passed | Installed MCP executes under Node 18.14.1; no root override |
| Offline package consumer | Passed | Actual archive, isolated dependencies, MCP discovery and existing commands |
| Production dependency audit | 0 vulnerabilities | Final SDK/dependency installation, `npm audit --omit=dev --audit-level=moderate` |
| Package dry-run | Passed | Build and package verification only; no publication |
| Diff whitespace check | Passed | No generated build output or machine configuration is committed |

The two full-suite failures are the same baseline process-identity failures
listed above. No ownership guard or assertion was weakened. The blocked-stdout
process check is Linux-specific; the transport's budget, deadline and error
checks are portable. No Godot or Blender executable was available here, so
these checks do not establish live-scene, rendering or visual-quality results.

## Remaining integration

The canonical source of the user's Blender connector was not identified in
the accessible repositories or prior context. The Hermes `blender-mcp` skill
is a reference, not evidence of the user's implementation or installation.
Its repository or local folder is required before applying an equivalent
targeted-inspection improvement there.

The Godot changes are local and reviewable. They have not been pushed,
published, merged or deployed to a user machine.
