// A fake Cursor CLI logged in as somebody else.
//
// It would answer `env list` for that other account. Reporting those environments
// under this server's API-key authority is the confusion the identity gate exists
// to stop, so the read must never reach the command below.

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

if (line === "status --output json") {
  process.stdout.write(JSON.stringify({ user: { email: "someone-else@example.com" } }) + "\n");
  process.exit(0);
}

if (line === "env list --output json") {
  process.stdout.write(
    JSON.stringify({ environments: [{ environmentPublicId: "env-of-another-account" }] }) + "\n",
  );
  process.exit(0);
}

process.stderr.write(`unexpected invocation: ${line}\n`);
process.exit(64);
