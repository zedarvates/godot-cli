import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { inspectTemplateRegistry } from "../dist/template-registry-inspection.js";

const REGISTRY_ROOT = process.env.UO_TEMPLATE_REGISTRY_ROOT;

function gitStatus(root) {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

test(
  "real registry inspection verifies current profiles without changing its checkout",
  { skip: !REGISTRY_ROOT, timeout: 90_000 },
  async () => {
    const before = gitStatus(REGISTRY_ROOT);
    const first = await inspectTemplateRegistry({ root: REGISTRY_ROOT });
    const second = await inspectTemplateRegistry({ root: REGISTRY_ROOT });

    assert.deepEqual(second, first);
    assert.equal(first.status, "ok");
    assert.equal(first.complete, true);
    assert.equal(first.catalog.entries, 6382);
    assert.equal(first.catalog.verifiedFiles, 6382);
    assert.deepEqual(first.profiles, {
      "legacy-unvalidated": 4063,
      "strict-schema-v1": 6,
      "strict-v1": 2313,
    });
    assert.equal(first.strictFamilySchemas, 5);
    assert.equal(first.strictTemplates, 2313);
    assert.equal(first.godotCompatibleTemplates, 0);
    assert.equal(first.integrityReady, true);
    assert.equal(first.strictContentReady, true);
    assert.equal(first.consumerReady, false);
    assert.deepEqual(first.reasons, [
      "No strict-v1 template has exact godot-vr compatibility evidence.",
    ]);
    assert.equal(gitStatus(REGISTRY_ROOT), before);
  }
);
