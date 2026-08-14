# Agent guide

This repository is a development-only, local Godot control plane. Preserve the
security contract in `SECURITY.md` and the public boundary in `README.md`.

## Commands

- Install: `npm ci --ignore-scripts`
- Build: `npm run build`
- Test: `npm test`
- Production dependency audit: `npm audit --omit=dev --audit-level=moderate`
- Package verification: `npm publish --dry-run`
- Real runtime tests: set `GODOT_BIN` to an official Godot 4.7.x executable,
  then run `npm test`.
- Optional Fovea integration: also set `FOVEA_PROJECT_ROOT` to a compatible
  local checkout.

## Non-negotiable boundaries

- Default to read-only, loopback-only, authenticated, debug-only operation.
- Keep mutations and unsafe execution behind their distinct explicit gates.
- Bound input, output, traversal, waits, files, clients, logs, and retained
  resources; reject incomplete results fail-closed.
- Never log, persist, or place the raw token on a command line.
- The installer must not edit `project.godot` or silently overwrite a divergent
  addon.
- Add success and rejection tests for every command or capability change.
- Do not commit generated `dist/`, `node_modules/`, screenshots, tokens, or
  machine-specific configuration.
- Do not push, publish npm packages, create releases, or move distribution tags
  without explicit authorization.

Keep diffs focused and preserve unrelated local work in this dirty branch.
