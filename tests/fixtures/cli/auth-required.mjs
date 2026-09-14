// A fake Cursor CLI that is installed, registered, and not logged in.
//
// This server never forwards its own API key to the CLI, so "not logged in" is a
// state the operator resolves, not one this server can paper over.

const args = process.argv.slice(2);
const line = args.join(" ");

if (line === "--version") {
  process.stdout.write("cursor 1.2.3\n");
  process.exit(0);
}

if (line === "--help") {
  process.stdout.write("Commands:\n  env     Manage cloud environments\n  status  Show login\n");
  process.exit(0);
}

process.stderr.write("Error: not logged in. Run `cursor login` first.\n");
process.exit(1);
