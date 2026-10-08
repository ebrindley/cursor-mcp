# Cursor Cloud Agents & VMs

An MCP server that lets Claude Code, Codex, and Grok launch and manage Cursor
Cloud Agents, use their VM terminals, and manage associated environments.
It is not a general local coding or research runner. Choose which repositories
cloud agents can access, launch a task, follow up, and inspect the reported branch or PR.

This is an independent project, not an official Cursor product.

```text
You: Use a Cursor Cloud Agent to fix the empty-search bug in ExampleOrg/ExampleRepo.
     Start from main.
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

## Local Cursor or Cloud Agents?

This integration manages Cursor Cloud Agents, not local Cursor sessions. A new
repository-backed Cloud Agent does not automatically receive local-only files
or unpushed changes. See [execution context](docs/reference.md#local-cursor-or-cloud-agents)
for local/cloud selection and tool authority.

## Quickstart

You need:

- Git and Node.js 24 LTS, including npm. See [runtime compatibility][development]
  for other supported versions.
- A Cursor account with an API key and access to the repository you want to use.
- Claude Code, Codex, Grok, or Cursor as your MCP client.

Installation uses GitHub source and automates dependency installation and building.
Without a policy file, the server is read-only. On a fresh installation, the
installer creates an account-wide policy for agent management and terminal access
across repositories and environments your Cursor account can access. Deletion
tools are excluded, and existing policies are preserved. For narrower access,
see [restricted profiles][policy-setup] before launching work.

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

Run the installation check:

```bash
node ~/.local/share/cursor-mcp/current/dist/bin.js doctor
```

Read the reported permissions and confirm that they match your intended use.
No model is pinned by default. For restricted profiles, policy migration and
model selection, see [capability setup](docs/setup.md#capability-setup).

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

> Use the Cursor Cloud Agent integration to list the repositories I can access.
> Do not launch an agent.

Success means the assistant calls `cursor_list_repos` and returns repository
information without a connection or authentication error. Confirm your intended
repository is available. Doctor alone does not verify MCP client registration;
see [troubleshooting][troubleshooting] if this check fails.

### 6. Try your first task

> Use a Cursor Cloud Agent to fix a small bug in OWNER/REPO, starting from main. State the target
> before launching. Keep the returned agent and run IDs. Check the result and
> report any returned PR link and remaining work. Do not merge it.

Real launches may incur Cursor charges. Replace `OWNER/REPO` with the intended
repository available to your account and permitted by your policy. A successful launch
returns agent and run IDs; continue checking the run until it finishes. The
task asks for a PR, but a run may finish without one.
Inspect any reported branch or PR before deciding what to do next.

For a follow-up: **"Ask that same Cursor Cloud Agent to add the missing regression test."**
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

[first-task]: docs/first-task.md
[setup]: docs/setup.md
[claude-setup]: docs/setup.md#claude-code
[codex-setup]: docs/setup.md#codex
[grok-setup]: docs/setup.md#grok
[cursor-setup]: docs/setup.md#cursor
[policy-setup]: docs/setup.md#custom-policy-and-permissions
[troubleshooting]: docs/first-task.md#troubleshooting
[activity]: docs/streaming.md
[reference]: docs/reference.md
[design]: docs/reference.md#design
[guardrails]: docs/reference.md#guardrails
[configuration]: docs/reference.md#configuration
[tools]: docs/reference.md#tools
[development]: docs/reference.md#development
[version]: docs/reference.md#version
[packaging]: docs/reference.md#preparing-a-package
