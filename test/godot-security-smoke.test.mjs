import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GodotClient } from "../dist/client.js";

const GODOT_BIN = process.env.GODOT_BIN;
const TOKEN = "security-token-".padEnd(64, "x");
const FIXTURE = fileURLToPath(new URL("../godot-addon/", import.meta.url));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Godot readiness timed out. Output:\n${output}`));
    }, 10_000);
    const consume = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Godot exited before readiness (${code}).\n${output}`));
    });
  });
}

function waitForReady(child) {
  return waitForOutput(child, "GodotCLI: Server listening on 127.0.0.1:");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readLine(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Godot response: ${buffer}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Connection closed before a full response: ${buffer}`));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

function launch(port, environment) {
  return spawn(
    GODOT_BIN,
    ["--headless", "--path", FIXTURE, `--godot-cli-port=${port}`],
    {
      cwd: FIXTURE,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );
}

test(
  "real Godot runtime refuses to start without a token",
  { skip: !GODOT_BIN },
  async () => {
    const port = await reservePort();
    const env = { ...process.env };
    delete env.GODOT_CLI_TOKEN;
    delete env.GODOT_CLI_ALLOW_MUTATIONS;
    delete env.GODOT_CLI_ALLOW_UNSAFE;
    const child = launch(port, env);
    try {
      await waitForOutput(child, "GODOT_CLI_TOKEN must contain at least");
      const client = new GodotClient({ port, token: TOKEN });
      await assert.rejects(
        () => client.send("scene_tree", {}, 500),
        /Cannot connect to Godot/
      );
    } finally {
      await stop(child);
    }
  }
);

test(
  "real Godot runtime enforces auth, read-only mode and bounded waits",
  { skip: !GODOT_BIN },
  async () => {
    const port = await reservePort();
    const child = launch(port, {
      ...process.env,
      GODOT_CLI_TOKEN: TOKEN,
      GODOT_CLI_ALLOW_MUTATIONS: "",
      GODOT_CLI_ALLOW_UNSAFE: "",
    });
    try {
      await waitForReady(child);
      const client = new GodotClient({ port, token: TOKEN });
      assert.equal((await client.send("server_info")).status, "ok");

      const mutation = await client.send("set_property", {
        path: "/root/SecurityFixture/Probe",
        property: "process_mode",
        value: 1,
      });
      assert.equal(mutation.status, "error");
      assert.match(mutation.error, /Mutation commands are disabled/);

      const foveaMutation = await client.send("fovea_add_splat", {
        parent: "/root/SecurityFixture",
        source_path: "res://fixture.ply",
      });
      assert.equal(foveaMutation.status, "error");
      assert.match(foveaMutation.error, /Mutation commands are disabled/);

      const escapedRead = await client.send("read_file", {
        path: "res://../package.json",
      });
      assert.equal(escapedRead.status, "error");
      assert.match(escapedRead.error, /inside res:\/\//);

      const localRead = await client.send("read_file", {
        path: "res://project.godot",
      });
      assert.equal(localRead.status, "ok");

      const excessiveWait = await client.send("wait_for", {
        path: "/root/SecurityFixture/Probe",
        property: "visible",
        timeout: 301,
      });
      assert.equal(excessiveWait.status, "error");
      assert.match(excessiveWait.error, /at most 300\.0 seconds/);

      const zeroInterval = await client.send("wait_for", {
        path: "/root/SecurityFixture/Probe",
        property: "visible",
        interval: 0,
      });
      assert.equal(zeroInterval.status, "error");
      assert.match(zeroInterval.error, /between 0\.01 and 5\.0 seconds/);

      const wrongToken = new GodotClient({ port, token: "0".repeat(64) });
      const rejected = await wrongToken.send("scene_tree");
      assert.equal(rejected.status, "error");
      assert.equal(rejected.error, "Authentication failed");
    } finally {
      await stop(child);
    }
  }
);

test(
  "real Godot runtime enables mutation and unsafe gates explicitly",
  { skip: !GODOT_BIN },
  async () => {
    const port = await reservePort();
    const child = launch(port, {
      ...process.env,
      GODOT_CLI_TOKEN: TOKEN,
      GODOT_CLI_ALLOW_MUTATIONS: "1",
      GODOT_CLI_ALLOW_UNSAFE: "1",
    });
    try {
      await waitForReady(child);
      const client = new GodotClient({ port, token: TOKEN });
      const mutation = await client.send("set_property", {
        path: "/root/SecurityFixture/Probe",
        property: "process_mode",
        value: 1,
      });
      assert.equal(mutation.status, "ok");
      const evaluated = await client.send("eval", { code: "1 + 1" });
      assert.equal(evaluated.status, "ok");
      assert.equal(evaluated.data, 2);
    } finally {
      await stop(child);
    }
  }
);

test(
  "real Godot runtime caps stalled unauthenticated clients",
  { skip: !GODOT_BIN },
  async () => {
    const port = await reservePort();
    const child = launch(port, {
      ...process.env,
      GODOT_CLI_TOKEN: TOKEN,
      GODOT_CLI_ALLOW_MUTATIONS: "",
      GODOT_CLI_ALLOW_UNSAFE: "",
    });
    const sockets = [];
    try {
      await waitForReady(child);
      for (let index = 0; index < 8; index += 1) {
        sockets.push(await connect(port));
        await delay(30);
      }
      const overflow = await connect(port);
      sockets.push(overflow);
      const rejection = JSON.parse(await readLine(overflow));
      assert.match(rejection.error, /Maximum concurrent client limit/);

      const timedOut = JSON.parse(await readLine(sockets[0], 5000));
      assert.equal(timedOut.error, "Authentication timeout");

      for (const socket of sockets) socket.destroy();
      await delay(100);
      const client = new GodotClient({ port, token: TOKEN });
      assert.equal((await client.send("scene_tree")).status, "ok");
    } finally {
      for (const socket of sockets) socket.destroy();
      await stop(child);
    }
  }
);
