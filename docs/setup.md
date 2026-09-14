# Client setup and maintenance

Start with the [quickstart](../README.md#quickstart) to install the server, provide
an API key, and enable a repository. Choose your client below, then return to
[verify the connection](../README.md#5-verify-the-connection).

The installer maintains a stable `current/dist/bin.js` under
`${XDG_DATA_HOME:-$HOME/.local/share}/cursor-mcp` (or `CURSOR_MCP_ROOT`). Replace the
absolute paths below with your Node executable and installation location. Use an
absolute path to `node` so startup does not depend on the client's `PATH`.
Do not register `dist/server.js`; it is the module behind the entrypoint.

For CLI clients, export `CURSOR_API_KEY` in the terminal before starting the
client. Registration alone does not save that terminal's environment. Keep keys
out of this checkout and shared configuration; the server does not load `.env`
files itself.

## Claude Code

Use `--scope user`, or the registration is local to one project:

```bash
claude mcp add --scope user cursor \
  -- /absolute/path/to/node /absolute/path/to/cursor-mcp/current/dist/bin.js
```

## Codex

In `~/.codex/config.toml`, name the variables to pass through; do not write
the key into the file:

```toml
[mcp_servers.cursor]
env_vars = ["CURSOR_API_KEY", "PATH", "HOME"]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/cursor-mcp/current/dist/bin.js"]
```

`env_vars` passes the named variables from the environment running Codex; it does
not set their values. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Grok

```bash
grok mcp add --scope user cursor -- /absolute/path/to/node \
  /absolute/path/to/cursor-mcp/current/dist/bin.js
```

## Cursor

Cursor has its own Cloud Agents UI. To use the `cursor_*` tools inside Cursor's
own chat, add this to `~/.cursor/mcp.json`.
This example references an environment variable available to the Cursor process:

```json
{
  "mcpServers": {
    "cursor": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/cursor-mcp/current/dist/bin.js"],
      "env": { "CURSOR_API_KEY": "${env:CURSOR_API_KEY}" }
    }
  }
}
```

A desktop client may not see variables exported in your terminal. For Cursor,
an alternative to the `env` entry is `"envFile": "/absolute/path/to/private/cursor-mcp.env"`,
containing `CURSOR_API_KEY=...`; keep that file outside the checkout with access
restricted to your user (mode `600` on macOS/Linux). See [Cursor's MCP configuration](https://cursor.com/docs/mcp).
Other clients, including Grok's Cursor compatibility scan, may read `mcp.json`;
do not assume it is a private credential store or that they support Cursor's
interpolation and `envFile` behavior. Configure each client explicitly.

## Custom policy and permissions

Without a policy file, the server exposes read-only tools. The default path is
`~/.config/cursor-mcp/policy.json`. The [example policy](../policy.example.json)
starts read-only; review its tool and repository permissions before enabling a
write profile.

Setup chooses its destination from `--policy`, then `CURSOR_MCP_POLICY` when set,
otherwise the default path. Existing files require explicit confirmation with `--yes`; use `--preview` first. To create and
check a policy at a custom location:

```bash
node dist/bin.js setup --repo ExampleOrg/ExampleRepo --policy /absolute/path/policy.json
node dist/bin.js doctor --policy /absolute/path/policy.json
```

Pass the same path as `CURSOR_MCP_POLICY` to the MCP server through your client's
environment configuration. For Codex, export its value before starting Codex and
add `"CURSOR_MCP_POLICY"` to the `env_vars` list above.

The [quickstart policy](../policy.quickstart.json) grants 14 everyday tools:
account and repository discovery, agent/run reads, usage, artifacts, launch,
follow-up, and cancellation. It excludes environment diagnostics, archive,
deletion, and no-repository launches. It requests automatic PR creation, but a
run can finish without a PR. See the [configuration reference](reference.md#configuration)
and [permission details](reference.md#guardrails) for custom profiles.

Restart the client after changing registration or policy; a running client does
not re-read its configuration.

## Diagnostics

`node dist/bin.js doctor` checks policy, API access, and repository visibility
without printing key values or account details. Look for `OK` on runtime, policy,
credential, account, and repository checks. `INFO` rows describe launch
permissions. A successful check does not guarantee that a launch will succeed.

`doctor --offline` checks local configuration only and still requires
`CURSOR_API_KEY` to be present. Doctor does not launch work or prove that your MCP
client is registered correctly. Verify that separately through the
[quickstart connection check](../README.md#5-verify-the-connection).

For failures, see [troubleshooting](first-task.md#troubleshooting).

## Installation and updates

The GitHub installer works independently of any personal plugin. Its interactive
mode reads confirmation from the terminal, so it can also be invoked by the
one-line command in the quickstart. Use `--yes` only when installation has already
been authorized. Missing prerequisites are reported before building.

Installation registers detected Claude Code, Codex and Grok clients.
Use `install --host claude` (or `codex` / `grok`, repeatable) to select clients or
add one later. Cursor is opt-in with `install --with-cursor`; a new Cursor entry
stores the supplied `CURSOR_API_KEY` in its private configuration. Existing
registrations retain their launcher, credentials and settings; legacy `npx`
package registrations migrate to Node. No policy permissions are granted by
installation. If no client is detected, the installer reports that and can be
rerun after a client is available.

```bash
bash ~/.local/share/cursor-mcp/current/scripts/install.sh status --porcelain
bash ~/.local/share/cursor-mcp/current/scripts/install.sh update
```

Updates build and check the new release before switching `current`. Existing
client settings and policy permissions are preserved; an update does not enroll
another client. Restart or reconnect clients to use the new release. Use
`rollback` to return to the retained predecessor. A failed build or executable
check leaves the active release unchanged. If registration fails after activation,
the release remains active; fix the reported configuration and rerun `install`.

For a committed local candidate, run the candidate's installer:

```bash
bash /absolute/path/to/cursor-mcp/scripts/install.sh pin --source /absolute/path/to/cursor-mcp --commit FULL_COMMIT_SHA
```

Pinning selects local Git objects without fetching source from GitHub; dependency
installation may still use the package registry. Ordinary updates leave the pin
unchanged. Run `unpin` explicitly before returning to upstream updates. Existing
development checkouts are preserved when registrations migrate to the installed
release. Local build identity is reported by `current/dist/bin.js --version`.

An optional external scheduler can invoke `update --unattended` for an existing
installation. Cursor MCP does not require a scheduler or a Claude Code plugin.
See [Development](reference.md#development) for manual source builds.


### Capability setup

Fresh installation runs `setup` automatically: account-wide repository and
environment access, agent management and terminal tools, no model pin, and no
deletion tools. Existing policies are preserved during installation and updates.
Run `setup --account --yes` to migrate an existing default profile. `--preview`
shows changes without writing. Model selections and unrelated settings survive
migration. Migration removes per-environment repository limits to inherit account-wide
repository access; existing identity pins remain enforced. Account setup also removes
repository-free VM and automatic-PR overrides, leaving these choices to each task.

For a restricted profile, use `setup --repo OWNER/REPO`, optionally adding
`--terminal` and `--environment NAME`. Restricted setup requires an existing
profile's repository scope to match. Account setup uses `repos: ["*"]` and
`environmentAccess: "account"`, subject to Cursor account permissions.

`--model ID` and optional `--fast false|true` select a catalog-verified model.
This requires authentication; setup without a model selection does not.
Pinned terminal settings, wildcard tool grants, and default-profile deletion tools
must be resolved before enabling terminal execution. Other profiles are preserved.

`doctor --offline` checks configuration without contacting Cursor. Missing
credentials are informational in this mode. Credentials are checked only in the
process running doctor, not in other clients. Terminal configuration is not proof
of a reachable VM. Optional CLI configuration is not required for terminal access.

The calling assistant supplies the current project's Git remote for repository
operations. It should ask only when the actual task target is ambiguous.

Account setup enables environment discovery. Without a configured CLI catalog,
`cursor_list_environments` reports environment names and repository associations
observed on a page of agents, with a continuation cursor. These observations are
partial and do not establish ownership scope or enumerate unused saved environments.
