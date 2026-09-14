#!/usr/bin/env node

import { log } from "./log.js";
import { main } from "./server.js";
import { VERSION } from "./version.js";
import { runSetupCommand } from "./setup.js";

// `--version` answers before anything that needs a key or a policy file, so an
// installer or a person at a terminal can read which build this is without
// starting an MCP session. Human subcommands also stay outside the transport;
// only an argument-free launch starts the stdio server.
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write(`${VERSION}\n`);
} else if (process.argv.length > 2) {
  process.exitCode = await runSetupCommand(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`), (line) => process.stderr.write(`${line}\n`));
} else {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
