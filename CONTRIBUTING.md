# Contributing

Contributions are welcome when they preserve the development-only security
boundary in [`SECURITY.md`](SECURITY.md).

## Local checks

Use Node.js 18 or newer:

```bash
npm ci --ignore-scripts
npm test
npm audit --omit=dev --audit-level=moderate
npm publish --dry-run
```

Set `GODOT_BIN` to an official Godot 4.7.x debug editor to run the real runtime
tests. Set `FOVEA_PROJECT_ROOT` only when a compatible local FoveaCore checkout
is available; its absence should skip that one external integration test.

## Change rules

- Keep the default runtime read-only, loopback-only, authenticated, and
  debug-only.
- Put new mutations behind the mutation gate; reserve the unsafe gate for
  arbitrary execution or persistent file/scene changes.
- Add deterministic limits and fail-closed behavior to every new traversal,
  payload, wait, file operation, or retained resource.
- Never log or persist the raw authentication token.
- Keep `project.godot` unchanged unless the user explicitly edits it outside
  this installer.
- Add tests for rejection paths as well as successful paths.

Do not publish packages, push branches, or create releases as part of a code
contribution unless that external action was explicitly authorized.
