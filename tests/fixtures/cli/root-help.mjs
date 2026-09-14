// A fake Cursor CLI whose root argument is an agent prompt.
//
// This is the feature-gated shape that matters most: `--help` describes a prompt
// and advertises no commands, so `env list` would be submitted as a prompt. Any
// argument that is not a recognized flag appends itself to `prompts.log` in the
// working directory, so a test can prove no operational command was issued. The
// working directory is used rather than an environment variable because the
// runner rebuilds the child's environment and would not forward one.

import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const line = args.join(" ");

if (line === "--version") {
  process.stdout.write("cursor 1.2.3\n");
  process.exit(0);
}

if (line === "--help") {
  process.stdout.write(
    [
      "Usage: cursor [options] <prompt>",
      "",
      "Start an agent from a prompt. Pass the prompt as the argument.",
      "",
      "Options:",
      "  -h, --help     Show this help",
      "  -v, --version  Print the version",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

appendFileSync(join(process.cwd(), "prompts.log"), `${line}\n`);
process.stdout.write(`launching an agent with prompt: ${line}\n`);
process.exit(0);
