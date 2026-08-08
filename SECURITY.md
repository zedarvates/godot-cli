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
properties, input simulation and scene loading.

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

## Remaining limitations

The automated P0 suite includes Node protocol controls, source invariants, and
four headless runtime scenarios against the isolated addon fixture with Godot
4.7-dev5: missing-token refusal, authenticated read-only access, explicit
mutation/unsafe capability gates, and stalled-client saturation recovery.

This proves the isolated addon/client boundary. Copying and enabling the addon
inside the canonical Ultimate Odycer client, checking coexistence with its
existing tooling, and validating an actual game scene remain pending. That
canonical integration is still `[Scaffolding / Proxy]`.
