// A fake Cursor CLI that wraps its JSON in prose.
//
// A banner, then a document, then a footer. Scraping the middle out of this is
// exactly how an error page or an agent transcript gets mistaken for a structured
// answer, so the whole output must be rejected.

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

process.stdout.write("Fetching environments...\n");
process.stdout.write(JSON.stringify({ environments: [{ environmentPublicId: "env-a" }] }) + "\n");
process.stdout.write("Done. Visit the dashboard for more.\n");
process.exit(0);
