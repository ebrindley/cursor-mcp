// A fake Cursor CLI whose `env` and `status` commands are registered.
//
// No shebang: the test writes one naming the current node binary, then chmods the
// copy. Any invocation this fixture does not recognize exits 64, so a test that
// issues an unexpected command line fails loudly instead of passing by accident.

const args = process.argv.slice(2);
const line = args.join(" ");

if (line === "--version") {
  process.stdout.write("cursor 1.2.3\n");
  process.exit(0);
}

if (line === "--help") {
  process.stdout.write(
    [
      "Usage: cursor [options] [prompt]",
      "",
      "Commands:",
      "  agent       Start an agent from a prompt",
      "  env         Manage cloud environments",
      "  status      Show login status",
      "",
      "Options:",
      "  -h, --help  Show this help",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (line === "status --output json") {
  process.stdout.write(
    JSON.stringify({ loggedIn: true, user: { email: "Owner@Example.com" } }) + "\n",
  );
  process.exit(0);
}

if (line === "env list --output json") {
  process.stdout.write(
    JSON.stringify({
      environments: [
        {
          // A provider-internal numeric row key sits beside the public id. The
          // projection must keep it private and address the environment by the
          // public id alone.
          id: 1234,
          environmentPublicId: "env-alpha",
          name: "alpha",
          scope: "personal",
          repos: [{ url: "https://github.com/ExampleOrg/ExampleRepo" }],
          createdAtMs: 1756000000000,
          updatedAtMs: 1756100000000,
        },
        {
          environmentPublicId: "env-beta",
          displayName: "beta",
          owningTeam: 77,
          repositories: ["ExampleOrg/Other"],
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        // Only an internal id: unaddressable, so it must be dropped and counted.
        { id: 4321 },
      ],
    }) + "\n",
  );
  process.exit(0);
}

if (args[0] === "env" && args[1] === "get" && args[3] === "--output") {
  process.stdout.write(
    JSON.stringify({
      environmentPublicId: args[2],
      candidates: [
        {
          source: "repository",
          environmentJsonPath: ".cursor/environment.json",
          environmentJson: {
            start: "npm start",
            install: "npm ci && echo TOKEN_VALUE_SHOULD_NEVER_APPEAR",
          },
        },
        {
          source: "database",
          environmentJsonPath: null,
          environmentJson: null,
          environmentJsonNote: "Configuration is owner-restricted for this environment.",
        },
      ],
    }) + "\n",
  );
  process.exit(0);
}

process.stderr.write(`unexpected invocation: ${line}\n`);
process.exit(64);
