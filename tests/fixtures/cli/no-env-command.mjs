// A fake Cursor CLI that advertises commands, but not `env`.
//
// Distinct from root-help.mjs: the parser exists, so the help is readable, yet
// the environment command is still not registered on this build.

const args = process.argv.slice(2);
const line = args.join(" ");

if (line === "--version") {
  process.stdout.write("cursor 1.2.3\n");
  process.exit(0);
}

if (line === "--help") {
  process.stdout.write(
    [
      "Usage: cursor <command> [options]",
      "",
      "Commands:",
      "  agent       Start an agent from a prompt",
      "  status      Show login status",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

process.stderr.write(`unknown command: ${line}\n`);
process.exit(1);
