import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const serverRoot = process.env.UO_ZIG_SERVER_ROOT;

async function run(executable, args, cwd) {
  return execFileAsync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
}

test(
  "authoritative Zig addon manifest and trust store tests remain green",
  { skip: serverRoot ? false : "UO_ZIG_SERVER_ROOT not set" },
  async () => {
    const canonicalRoot = await realpath(path.resolve(serverRoot));
    const manifestSource = path.join(canonicalRoot, "src", "core", "addon_manifest.zig");
    const trustStoreSource = path.join(canonicalRoot, "src", "core", "addon_trust_store.zig");
    for (const source of [manifestSource, trustStoreSource]) {
      assert.equal((await lstat(source)).isFile(), true, source);
    }

    const statusArgs = [
      "status",
      "--porcelain",
      "--",
      "src/core/addon_manifest.zig",
      "src/core/addon_trust_store.zig",
    ];
    const before = await run("git", statusArgs, canonicalRoot);
    const manifest = await run("zig", ["test", "src/core/addon_manifest.zig"], canonicalRoot);
    const trustStore = await run("zig", ["test", "src/core/addon_trust_store.zig"], canonicalRoot);
    const after = await run("git", statusArgs, canonicalRoot);

    assert.match(`${manifest.stdout}\n${manifest.stderr}`, /All 5 tests passed\./);
    assert.match(`${trustStore.stdout}\n${trustStore.stderr}`, /All 11 tests passed\./);
    assert.equal(after.stdout, before.stdout, "Zig parity tests must not change server sources");
  },
);
