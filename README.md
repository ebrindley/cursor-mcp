# Cursor MCP

An MCP server that lets Claude Code, Codex, and Grok launch and manage Cursor
Cloud Agents. Choose which repositories they can access, launch a task, follow
up, and inspect the reported branch or PR.

No policy means read-only; enabling launches is an explicit step. This is an
independent project, not an official Cursor product.

```text
You: Fix the empty-search bug in ExampleOrg/ExampleRepo, starting from main.
     Open a PR, report the result, and leave merging to me.
Assistant: Launches a scoped cloud agent and keeps its agent/run IDs.
You: Check its progress, then ask the same agent to cover whitespace-only input.
Assistant: Reads the run and sends a follow-up to the existing agent.
```

This illustrates the interaction; your assistant chooses its wording. For a
runnable example with **simulated Cursor responses**, try `npm run demo` after
building. It exercises real MCP handlers, including a refused out-of-scope
launch, without network requests or a key. See the [offline walkthrough][first-task].

[Quickstart](#quickstart) · [Client setup][setup] ·
[Troubleshooting][troubleshooting] · [Documentation](#documentation)

## Quickstart

You need:

- Git and Node.js 24 LTS, including npm. See [runtime compatibility][development]
  for other supported versions.
- A Cursor account with an API key and access to the repository you want to use.
- Claude Code, Codex, Grok, or Cursor as your MCP client.

Installation uses GitHub source and automates dependency installation and building.

### 1. Install the server

```bash
curl -fsSL https://raw.githubusercontent.com/ebrindley/cursor-mcp/main/scripts/install.sh | bash -s -- install
```

The installer checks prerequisites and offers to install or update. It builds and
verifies a separate release before activating it, retaining the previous release.
The default installation is `~/.local/share/cursor-mcp`; `CURSOR_MCP_ROOT` overrides
it. See [installation and updates][setup] for client selection and local pinning.

### 2. Provide your API key

Create a [Cursor API key](https://cursor.com/dashboard/api) and export it as
`CURSOR_API_KEY` in the terminal where you will run doctor and start your CLI
client. Keep the key out of this checkout and shared configuration. The server
does not load `.env` files itself. Desktop clients may need their own
[environment configuration][cursor-setup].

### 3. Check setup

The installer enables agent management and terminal access across repositories and
environments your Cursor account can access. No repository registration or model
selection is required. Deletion tools are excluded from fresh setup.

```bash
node ~/.local/share/cursor-mcp/current/dist/bin.js doctor
```

To migrate an existing restricted policy to account-wide access:

```bash
node ~/.local/share/cursor-mcp/current/dist/bin.js setup --account --yes
```

Existing model selections and unrelated settings are preserved. To choose a model,
use `--model ID` and optional `--fast false|true`; explicit selections are verified
against Cursor's model catalog. No model is pinned by default.

The calling assistant should resolve the current project's Git remote when a task
needs a repository. Account-wide permission does not choose a repository for a task.
For optional restricted profiles and diagnostics, see [setup][policy-setup].

### 4. Connect your client

The installer registers detected Claude Code, Codex and Grok clients during
installation. To select clients explicitly or add one later, rerun it with
`install --host claude` (or `codex` / `grok`). Cursor registration requires
`install --with-cursor`.

For manual registration or configuration details, see:

[Claude Code][claude-setup] · [Codex][codex-setup] · [Grok][grok-setup] ·
[Cursor][cursor-setup]

Use absolute paths to your Node executable and the installation's `current/dist/bin.js`.
Restart the client after registration or policy changes. For CLI clients, start
it from the terminal where `CURSOR_API_KEY` is exported.

### 5. Verify the connection

Ask your connected assistant:

> Use Cursor to list the repositories I can access. Do not launch an agent.

Success means the assistant calls `cursor_list_repos` and returns repository
information without a connection or authentication error. Confirm your intended
repository is available. Doctor alone does not verify MCP client registration;
see [troubleshooting][troubleshooting] if this check fails.

### 6. Try your first task

> Use Cursor to fix a small bug in OWNER/REPO, starting from main. State the target
> before launching. Keep the returned agent and run IDs. Check the result and
> report any returned PR link and remaining work. Do not merge it.

Replace `OWNER/REPO` with the repository enabled above. A successful launch
returns agent and run IDs; continue checking the run until it finishes. The
policy requests automatic PR creation, but a run may finish without a PR.
Inspect any reported branch or PR before deciding what to do next.

For a follow-up: **"Ask that same Cursor agent to add the missing regression test."**
See the [first-task guide][first-task] for examples and resuming after a restart.

## Capabilities and limits

- Launch cloud agents, read their runs and artifacts, send follow-ups, and cancel
  work. Operator-owned profiles control repositories, environments, and tools;
  deletion requires a separate grant.
- Optional activity excerpts support resume cursors; they do not provide
  continuous UI progress. See the [activity guide][activity].
- Advanced environment diagnostics are opt-in. Some launch paid cloud work or
  require an explicitly configured Cursor CLI. Unsupported operations report the
  owner action still needed; coverage does not include every Cursor API operation
  or fully automatic environment management.

## Documentation

- [Cloud Agent VM terminal](docs/terminal.md): command execution, interactive sessions, and detached long-running jobs without a Cursor IDE dependency.

- [Client configuration, custom policies, diagnostics, and updates][setup]
- [First task, follow-ups, recovery, and examples][first-task]
- [Run activity and streaming][activity]
- [Technical reference][reference]: [architecture][design], [permissions][guardrails],
  [configuration][configuration], and [tool catalog][tools]
- [Development and runtime compatibility][development], [version identity][version],
  and [package preparation][packaging]

## Support and security

Bug reports are welcome through [GitHub Issues](https://github.com/ebrindley/cursor-mcp/issues).
This is an independently maintained project. Pull requests are not accepted.
Support, response times, and fixes are not guaranteed.

Report vulnerabilities privately through
[GitHub's vulnerability reporting form](https://github.com/ebrindley/cursor-mcp/security/advisories/new).
Keep vulnerability details and credentials out of public issues.

## License

[MIT](LICENSE). You may fork, modify, and redistribute the project, including for
commercial use.

[first-task]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/first-task.md
[setup]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/setup.md
[claude-setup]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/setup.md#claude-code
[codex-setup]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/setup.md#codex
[grok-setup]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/setup.md#grok
[cursor-setup]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/setup.md#cursor
[policy-setup]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/setup.md#custom-policy-and-permissions
[troubleshooting]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/first-task.md#troubleshooting
[activity]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/streaming.md
[reference]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md
[design]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#design
[guardrails]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#guardrails
[configuration]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#configuration
[tools]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#tools
[development]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#development
[version]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#version
[packaging]: https://github.com/ebrindley/cursor-mcp/blob/main/docs/reference.md#preparing-a-package
