import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_READY_INTERVAL_MS,
  MAX_READY_TIMEOUT_MS,
  MIN_READY_INTERVAL_MS,
  waitForReady,
} from "../dist/readiness.js";

function deterministicTime() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  };
}

test("waitForReady retries transient failures and returns the ping envelope", async () => {
  const time = deterministicTime();
  let calls = 0;
  const client = {
    async send(command) {
      calls += 1;
      assert.equal(command, "ping");
      if (calls < 3) throw new Error("connection refused");
      return {
        id: "ready",
        status: "ok",
        data: { ready: true, addon_version: "0.1.0-uo.7" },
      };
    },
  };

  const report = await waitForReady(client, {
    timeoutMs: 500,
    intervalMs: 50,
    ...time,
  });

  assert.equal(report.status, "ok");
  assert.equal(report.ready, true);
  assert.equal(report.attempts, 3);
  assert.equal(report.elapsed_ms, 100);
  assert.equal(report.response.data.addon_version, "0.1.0-uo.7");
});

test("waitForReady fails closed with the last bounded probe error", async () => {
  const time = deterministicTime();
  const client = {
    async send() {
      throw new Error("engine unavailable");
    },
  };

  const report = await waitForReady(client, {
    timeoutMs: 120,
    intervalMs: 50,
    ...time,
  });

  assert.equal(report.status, "error");
  assert.equal(report.ready, false);
  assert.equal(report.elapsed_ms, 120);
  assert.equal(report.error, "engine unavailable");
  assert.ok(report.attempts >= 3);
});

test("waitForReady rejects unbounded timeout and interval values", async () => {
  const client = { async send() { throw new Error("must not be called"); } };

  await assert.rejects(
    () =>
      waitForReady(client, {
        timeoutMs: MAX_READY_TIMEOUT_MS + 1,
        intervalMs: MIN_READY_INTERVAL_MS,
      }),
    /timeoutMs must be between/
  );
  await assert.rejects(
    () =>
      waitForReady(client, {
        timeoutMs: 1_000,
        intervalMs: MAX_READY_INTERVAL_MS + 1,
      }),
    /intervalMs must be between/
  );
});
