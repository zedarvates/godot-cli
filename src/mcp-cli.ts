#!/usr/bin/env node

import { Command } from "commander";
import { runMcpServer } from "./mcp.js";

const program = new Command();

program
  .name("godot-cli-mcp")
  .description("Stdio MCP (Model Context Protocol) Server for Godot Game Engine control")
  .version("0.3.0")
  .option("--host <host>", "Godot server host", "localhost")
  .option("--port <port>", "Godot server port", "9900")
  .action(async (opts: { host?: string; port?: string }) => {
    await runMcpServer({ host: opts.host, port: opts.port });
  });

program.parse();
