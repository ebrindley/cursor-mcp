// A fake Cursor CLI whose version the operator has not checked.
//
// It would happily answer `env list`, which is the point: an unlisted version
// must stop the probe before `--help` is even read.

const args = process.argv.slice(2);
const line = args.join(" ");

if (line === "--version") {
  process.stdout.write("cursor 9.9.9\n");
  process.exit(0);
}

if (line === "--help") {
  process.stdout.write("Commands:\n  env    Manage cloud environments\n  status Show login\n");
  process.exit(0);
}

if (line === "env list --output json") {
  process.stdout.write(JSON.stringify({ environments: [] }) + "\n");
  process.exit(0);
}

process.stderr.write(`unexpected invocation: ${line}\n`);
process.exit(64);
