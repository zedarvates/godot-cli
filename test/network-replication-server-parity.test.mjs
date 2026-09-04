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
  "authoritative Zig entity_update replication tests remain green",
  { skip: serverRoot ? false : "UO_ZIG_SERVER_ROOT not set" },
  async () => {
    const canonicalRoot = await realpath(path.resolve(serverRoot));
    const sources = [
      "src/network/replication.zig",
      "src/core/protocol_fields.zig",
      "src/networking/handlers/entity.zig",
      "src/main.zig",
    ];
    for (const source of sources) {
      assert.equal((await lstat(path.join(canonicalRoot, source))).isFile(), true, source);
    }

    const statusArgs = ["status", "--porcelain", "--", ...sources];
    const before = await run("git", statusArgs, canonicalRoot);
    const parity = await run(
      "zig",
      ["build", "test-replication", "--summary", "all"],
      canonicalRoot,
    );
    const after = await run("git", statusArgs, canonicalRoot);
    const output = `${parity.stdout}\n${parity.stderr}`;

    assert.match(output, /5\/5 tests passed/);
    assert.match(output, /test-replication success/);
    assert.equal(after.stdout, before.stdout, "Zig parity must not change authoritative sources");
  },
);
