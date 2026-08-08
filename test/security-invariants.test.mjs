import assert from "node:assert/strict";
import test from "node:test";
import { GodotClient } from "../dist/client.js";

const VALID_TOKEN = "a".repeat(32);

test("security invariant: token must be at least 32 characters", () => {
  assert.throws(
    () => new GodotClient({ token: "short-token" }),
    /at least 32 characters/
  );
});

test("security invariant: rejects remote non-loopback host addresses", () => {
  assert.throws(
    () => new GodotClient({ host: "10.0.0.1", token: VALID_TOKEN }),
    /Remote Godot hosts are disabled/
  );
});