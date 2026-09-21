import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { GodotClient } from "../dist/client.js";

const VALID_TOKEN = "a".repeat(32);
const serverSource = fs.readFileSync(
  new URL("../godot-addon/addons/godot_cli/cli_server.gd", import.meta.url),
  "utf8"
);

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

test("Godot server is loopback-only, authenticated and fail-closed", () => {
  assert.match(serverSource, /_server\.listen\(port, BIND_ADDRESS\)/);
  assert.match(serverSource, /BIND_ADDRESS := "127\.0\.0\.1"/);
  assert.match(serverSource, /OS\.is_debug_build\(\)/);
  assert.match(serverSource, /OS\.get_environment\("GODOT_CLI_TOKEN"\)/);
  assert.match(serverSource, /func _constant_time_equals/);
  assert.match(serverSource, /client\["authenticated"\] = true/);
  assert.match(serverSource, /MAX_CLIENTS := 8/);
  assert.match(serverSource, /AUTH_TIMEOUT_MSEC := 2000/);
  assert.match(serverSource, /PROTOCOL_VERSION := 1/);
  assert.doesNotMatch(serverSource, /_server\.listen\(port\)\s/);
});

test("dangerous commands, files and traversals remain gated", () => {
  assert.match(serverSource, /GODOT_CLI_ALLOW_MUTATIONS/);
  assert.match(serverSource, /GODOT_CLI_ALLOW_UNSAFE/);
  assert.match(serverSource, /func _command_denial/);
  assert.match(serverSource, /func _resolve_project_path/);
  assert.match(serverSource, /Path must stay inside res:\/\//);
  assert.match(serverSource, /MAX_PENDING_WAITS := 8/);
  assert.match(serverSource, /MAX_WAIT_TIMEOUT_SECONDS := 300\.0/);
  assert.match(serverSource, /MIN_WAIT_INTERVAL_SECONDS := 0\.01/);
  assert.match(serverSource, /MAX_SCENE_TREE_DEPTH := 64/);
  assert.match(serverSource, /MAX_SCENE_NODES := 4096/);
  assert.match(serverSource, /MAX_VISIBLE_NODES := 4096/);
  assert.match(serverSource, /MAX_ASSERT_CHECKS := 256/);
  assert.match(serverSource, /validation_budget_exceeded/);
  assert.match(serverSource, /"complete": not bool\(traversal\["truncated"\]\)/);
  assert.match(serverSource, /FOVEA_BRIDGE_PATH := "res:\/\/addons\/foveacore\/scripts\/integration\/fovea_cli_bridge\.gd"/);
  assert.match(serverSource, /"fovea_add_splat": true/);
  assert.match(serverSource, /func _cmd_fovea_validate/);
  assert.match(serverSource, /const COMMAND_DESCRIPTIONS :=/);
  assert.match(serverSource, /"catalog_version": 1/);
  assert.match(serverSource, /"mcp_server": false/);
  assert.match(serverSource, /"annotations_are_security_controls": false/);
  assert.match(serverSource, /"readOnlyHint": read_only/);
  assert.match(serverSource, /"destructiveHint": DESTRUCTIVE_COMMANDS\.has\(command\)/);
  assert.match(serverSource, /"idempotentHint": read_only or IDEMPOTENT_MUTATING_COMMANDS\.has\(command\)/);
  assert.match(serverSource, /"openWorldHint": true/);
});
