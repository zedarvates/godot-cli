# Publishing @zedarvates/godot-cli

The public npm name `godot-cli` is already owned by another project. This repository therefore uses the scoped package name:

`@zedarvates/godot-cli`

The executable names remain unchanged:

- `godot-cli`
- `godot-cli-mcp`

## Pre-publish validation

Run:

```bash
npm ci
npm test
npm pack --dry-run
```

The package must contain at least:

- `dist/src/cli.js`
- `dist/src/mcp-cli.js`
- `godot-addon/addons/godot_cli/cli_server.gd`
- `README.md`
- `docs/`

CI performs the same tarball validation.

## First publication

Publication requires an npm account that owns or can publish under the `@zedarvates` scope and any npm 2FA required by that account.

```bash
npm login
npm publish --access public
```

Do not place an npm token in the repository, documentation, workflow source, or project files.

For automated release later, use a repository secret or npm trusted publishing and require a tagged/reviewed release workflow.

## Consumer install

After publication:

```bash
npm install -g @zedarvates/godot-cli
```

The command invoked by users remains:

```bash
godot-cli --help
godot-cli-mcp
```
