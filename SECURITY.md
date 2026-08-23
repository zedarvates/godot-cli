# Security boundary

This fork is an authenticated development control plane for a running Godot
debug build. It must never be treated as a production gameplay API.

## Enforced defaults

- The server starts only when `OS.is_debug_build()` is true.
- TCP is bound to `127.0.0.1`; remote hosts are rejected by the Node client.
  Literal addresses must be inside `127.0.0.0/8` or IPv6 loopback. The
  `localhost` name is resolved before every connection, every answer must be a
  loopback address, and the client connects to the verified literal address.
- `GODOT_CLI_TOKEN` is mandatory and must contain at least 32 characters.
- Every request is authenticated with a constant-time token comparison before
  command dispatch; failed authentication closes the connection.
- Requests are limited to 1 MiB on both sides and responses to 16 MiB.
- At most eight TCP clients are retained. A connection that does not present a
  valid token-bearing request within two seconds is rejected and released.
- At most eight `wait-for` operations may be pending. Their timeout is bounded
  to 300 seconds and polling intervals to 0.01–5 seconds.
- `validate-scene` traversal is capped at depth 64 and a shared budget of 4,096 visited nodes; if reached, traversal stops deterministically, `complete` is set to `false`, `valid` is set to `false`, and a `validation_budget_exceeded` error is returned (fail-closed). Visible-node output is capped at 4,096 entries and assertions at 256 checks per request.
- TCP response bytes are decoded incrementally as UTF-8. The client accepts
  only a JSON object with the matching request ID and an `ok` or `error`
  status; malformed, stale, or cross-request responses fail closed.
- File reads and writes are confined to `res://`; individual files are limited
  to 4 MiB and directory listings to 4,096 entries.
- Inspection, structured assertions and captures are available by default.

## Capability gates

`GODOT_CLI_ALLOW_MUTATIONS=1` enables runtime mutations such as changing node
properties, input simulation, scene loading, and adding an unsaved
`FoveaSplat3D` through an installed compatible FoveaCore bridge. The Fovea
operation is confined to an existing `res://` asset, checks the bridge's
versioned no-file-write/no-listener contract, and never saves the scene.

`GODOT_CLI_ALLOW_UNSAFE=1` enables arbitrary method calls, GDScript evaluation,
script attachment, scene saving, and file creation/deletion. Expression-based
`assert` and `wait-for` checks are also unsafe; structured node/property checks
remain available in read-only mode.

Environment variables are read only when Godot starts. Restart Godot after
changing a gate. Use a fresh token for each development session and do not
commit it to the repository.

## Compatibility gate

Authenticated `server_info` reports protocol/addon versions, Godot version,
renderer, loopback endpoint, active capability gates, resource limits, and
command classes. It never returns the authentication token.

`uo-godot-cli doctor` fails closed on malformed metadata, protocol/addon
version mismatch, non-Godot-4.7 runtimes, release builds, non-loopback binds,
or enabled mutation/unsafe gates. `--allow-elevated` acknowledges only the two
capability gates; it does not bypass version, engine, build, or bind checks.

## Project preflight boundary

`uo-godot-cli project discover`, `project info`, and `project preflight` are
local, read-only operations. They do not require `GODOT_CLI_TOKEN`, connect to
Godot, import assets, follow symbolic links, or write project files.

- Discovery accepts an explicit start path, then `UO_GODOT_PROJECT`, then the
  current directory and walks upward to a regular `project.godot`.
- `project.godot` is limited to 1 MiB.
- Static scanning is limited to 20,000 files, 4 MiB per file, 128 MiB total,
  and 256 returned issues. Generated/build directories and nested standalone
  Godot projects are isolated from the root project scan.
- A truncated scan, unreadable entry, skipped symbolic link, or oversized text
  resource makes the preflight incomplete and fails the readiness result.
- Missing `.tscn`/`.tres` external-resource declarations are errors. Arbitrary
  path strings found in code or scene properties are warnings because they may
  be generated dynamically.
- Static scanning cannot validate Godot's binary UID cache. UID use is reported
  as requiring a later runtime scene-load gate.

## Template registry inspection boundary

`template registry inspect <root>` is local, tokenless, read-only, and is not a
live runtime/addon command.

- The explicit root, fixed `templates/catalog.json`, and every named file are
  canonicalized. Symlinks, junction escapes, traversal, absolute/UNC/drive
  paths, URLs, query/fragment, NUL, backslash, and malformed percent encoding
  fail closed.
- The command reads only catalogued files. Catalog, entries, aliases, individual
  JSON files, total bytes, JSON depth/arrays/strings/values, and findings are
  bounded before or during access. File-size totals are checked before hashing.
- Known profiles and contract versions are closed. Legacy never counts as
  strict content. `intended_consumers` never counts as compatibility.
- Consumer readiness requires a verified strict family schema, linked strict
  template, and closed evidence-bearing `godot-vr` compatibility record.
- No child process, Python, Godot, network operation, schema evaluator, addon,
  MCP tool, template mutation, or migration is used.
- Node JSON parsing does not detect duplicate keys. Inspection also does not
  execute JSON Schema or recompute canonical `spec_checksum`; the registry's
  own validator remains authoritative for those publication gates.

## Managed process boundary

`runtime start/status/logs/stop` use a per-project registry outside the Godot
project. The authentication token is never stored: the registry contains only
its SHA-256 verifier and uses user-only permissions where supported.

- `start` accepts a regular executable, verifies that `--version` reports Godot
  4.7, requires the exact bundled addon and explicit GodotCLI autoload, and
  refuses an occupied loopback port.
- The child is launched directly without a shell, with a hidden Windows console
  and a random instance marker after Godot's `--` separator. The token remains
  in the child environment and never enters the command line.
- Inherited mutation and unsafe gates are cleared. Only explicit start switches
  enable them; unsafe mode also enables the mutation gate.
- State creation reserves the project atomically. A concurrent start cannot
  silently replace a live or in-progress instance.
- `stop` checks the token verifier, PID, canonical executable, and command-line
  marker. Missing process metadata or any mismatch fails closed. It sends only
  a bounded `SIGTERM`; no force-kill path exists.
- Combined stdout/stderr logs stay under the validated state root. Five are
  retained per project, reads are capped at 1 MiB and 2,000 lines, and symbolic
  log files or traversal are rejected.
- Failed readiness triggers a stop of the newly launched owned process and
  preserves the stopped state and log for diagnosis.

## Scene validation boundary

`scene validate <res://scene>` is a one-shot orchestration command that reuses
the managed-process security boundary.

- Only regular in-project `.tscn` and `.scn` files up to 64 MiB are accepted;
  traversal, symbolic links, missing files, and other extensions are rejected
  before Godot starts.
- Godot runs headless with mutation and unsafe gates disabled. The command
  invokes authenticated compatibility and structural checks but never
  `save_scene` or a file-write command.
- Combined stdout/stderr is scanned for script, parse, resource, shader, and
  engine errors. A truncated 1 MiB or 2,000-line log makes the proof incomplete.
- SHA-256 fingerprints must show that the selected scene and `project.godot`
  remained unchanged. Generated `.godot` import/cache updates are outside this
  source-integrity claim.
- A structurally invalid but fully checked scene returns `valid: false` with
  `complete: true`. Runtime, log, stop, or integrity uncertainty returns
  `complete: false` and fails closed.
- The owned runtime is stopped on both success and failure. Identity uncertainty
  never escalates to an unverified or forced process kill.

## Installer boundary

`uo-godot-cli addon status <project>` and `addon install <project>` operate on
the local filesystem and therefore do not require `GODOT_CLI_TOKEN`. They do
not connect to a running game.

- A regular `project.godot` file is required before the directory is accepted.
- The project root is canonicalized, while symbolic/non-directory addon paths
  are rejected to prevent writes through a Windows junction or filesystem link.
- The only installation target is `<project>/addons/godot_cli`.
- `--dry-run` performs inspection and reports the planned action without
  writing files.
- Installed files are compared to the bundled addon using SHA-256. Generated
  Godot `.uid` sidecars are tolerated.
- `project.godot` is never edited and the plugin/autoload is never enabled by
  the installer.
- An existing divergent addon is refused unless `--force` is explicit. Forced
  replacement uses a same-directory temporary copy and backup before rename.
- An enabled `godot_ai` addon produces a coexistence warning so a second
  runtime control plane is not activated accidentally.

## Project test profile boundary

`uo-godot-cli test list` and `test run` use the project-local
`.uo-godot-tests.json` manifest. Listing is read-only and never executes a
profile. Running a named profile is explicit authorization to execute that
project-defined test entry.

- The manifest is a regular non-symbolic file capped at 256 KiB, schema version
  1, and 128 unique profiles. Unknown fields fail closed.
- Entries must be regular, non-symbolic `res://` files inside the discovered
  project and match the runner extension. Arbitrary command strings and shell
  runners are not supported.
- `godot_scene`, `godot_script`, `python`, and `dotnet_test` processes are
  launched directly with `shell: false`. Godot must report version 4.7 and is
  forced to headless mode with XR disabled.
- Profiles accept at most 32 arguments, 1 KiB each and 8 KiB total. Only the
  resolved `${projectRoot}` and `${godotBin}` placeholders are accepted.
- Timeout is capped at 900 seconds and output at 1 MiB. Exceeding either limit
  stops the exact child started by the CLI, escalating from graceful stop to a
  forced stop after two seconds only for that owned child.
- The child receives a reduced environment. Authentication tokens and runtime
  mutation/unsafe gates are not forwarded.
- SHA-256 evidence covers the manifest and entry before/after execution. It is
  not a project-wide write audit: test code may create `.godot`, `bin`, `obj`,
  reports, screenshots, or other declared test artifacts.

## Remaining limitations

The automated suite includes Node protocol controls, source invariants, real
headless runtime scenarios against isolated addon fixtures, managed-process
ownership/logging/stop controls, and one cross-repository FoveaCore scenario.
The standalone runtime gate passes with Godot 4.7.1 stable; the full local
Fovea gate passes with 4.7-dev5. These include
missing-token refusal, authenticated read-only access, explicit mutation/unsafe
capability gates, stalled-client saturation recovery, runtime metadata, scene
traversal, fail-closed validation budgets, one-shot clean/structural/parse-error
scene proofs, and an unsaved one-splat Fovea load.

This proves the isolated addon/client boundary and the FoveaCore GDScript
automation contract. It does not prove Fovea native/GPU/XR behavior. Copying
and enabling the addon inside the canonical Ultimate Odycer client, checking
coexistence with its existing tooling, and validating an actual game scene
remain pending. That canonical game integration is still `[Scaffolding / Proxy]`.
