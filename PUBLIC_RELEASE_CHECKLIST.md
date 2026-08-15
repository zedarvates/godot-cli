# Public release checklist

This checklist covers the first public pre-release of
`@ultimate-odycer/godot-runtime-cli`. A local pass does not authorize a GitHub
push or npm publication.

## Repository and package hygiene

- [x] Keep the fork attribution to `mattias800/godot-cli` in the README and addon metadata.
- [x] Ship the full MIT license in both the Git repository and npm archive.
- [x] Restrict npm contents to compiled CLI files, the Godot addon, README, security policy, license, and manifest.
- [x] Use the distinct `uo-godot-cli` executable and test it from an installed archive.
- [x] Publish pre-release versions under the npm `next` tag, never `latest`.
- [x] Scan the current publishable tree and all 18 reachable Git commits with Gitleaks; no leak is present.
- [x] Audit production npm dependencies; zero vulnerabilities were reported on 2026-08-14.
- [x] Reconcile the dirty branch into focused commits without staging unrelated local files.

## Automated evidence

- [x] Run all 83 portable tests without Godot: 69 pass and 14 environment-dependent tests skip.
- [x] Run with Godot 4.7-dev5 and no Fovea checkout: 82 pass, zero fail, and only the external FoveaCore test skips.
- [x] Run the real cross-repository FoveaCore bridge with Godot 4.7-dev5: 83/83 pass.
- [x] Verify `npm publish --dry-run` preserves the executable, license, metadata, and `next` tag.
- [x] Add public CI for Node.js 18/22 and the verified official Godot 4.7.1 Linux archive.
- [x] Observe the new GitHub Actions workflow passing from a clean pushed branch.

## First npm pre-release

- [ ] Confirm that the publishing account owns or may create the `@ultimate-odycer` npm scope.
- [ ] Enable npm trusted publishing for this repository, or use a short-lived automation token with least privilege.
- [ ] Review the final archive with `npm pack --dry-run` and confirm the version is unused.
- [ ] Publish `0.1.0-uo.7` only after explicit approval; `publishConfig` routes it to `next`.
- [ ] Install `@ultimate-odycer/godot-runtime-cli@next` in a clean temporary project and rerun addon status/install plus `--version`.
- [ ] Create matching Git tag and GitHub pre-release notes only after the registry smoke test passes.

## Fovea boundary

- [x] The public package contains the provider-neutral Fovea protocol commands and a test stub, not the private FoveaCore implementation.
- [x] Fovea insertion is mutation-gated, uses an existing `res://` asset, remains unsaved, and rejects an incompatible bridge.
- [ ] Keep native/GPU/visual/OpenXR claims out of the CLI release until the separate Fovea hardware gates pass.
- [ ] If FoveaCore becomes public, add a separate CI integration job pinned to a reviewed FoveaCore commit.

## Recovery policy

- Do not overwrite or silently replace a published archive.
- If a pre-release is defective, deprecate that exact version, publish a higher
  corrected pre-release, and move `next` only after its clean-install smoke test.
- Never move `latest` to this pre-release line without a separate stable-release
  review and explicit approval.
