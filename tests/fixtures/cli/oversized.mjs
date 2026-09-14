// A fake Cursor CLI that answers with far more JSON than the byte ceiling allows.
//
// The payload is legal JSON, so only the ceiling stops it: a truncated document
// must never be parsed as if it were the whole answer.

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
  process.stdout.write(JSON.stringify({ user: { email: "owner@example.com" } }) + "\n");
  process.exit(0);
}

const environments = [];
for (let index = 0; index < 4000; index += 1) {
  environments.push({
    environmentPublicId: `env-${index}`,
    name: `environment-number-${index}-with-a-deliberately-long-name`,
    scope: "personal",
    repos: ["ExampleOrg/ExampleRepo"],
  });
}
process.stdout.write(JSON.stringify({ environments }) + "\n");
process.exit(0);
