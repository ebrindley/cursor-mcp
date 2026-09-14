# Your first Cursor task

The goal is one useful task in one approved repository. You do not need to configure
environment operations, a local Cursor CLI, or a self-hosted worker to do that.

## Try it without an account

After [building the server](../README.md#1-build-the-server):

```bash
npm run demo
```

The demo calls real MCP handlers over an in-memory MCP connection. Cursor HTTP
responses, task results, IDs, and the PR link are simulated. It reads the committed
[quickstart policy](../policy.quickstart.json), not your personal policy or API key.
No network request, VM, repository edit, or PR creation takes place. An unexpected
request fails instead of reaching the network. This demonstrates behavior; it does
not verify account access or prove a cloud task will succeed.

The walkthrough shows a launch with a verified target, a finished run and reported
PR link inside the output envelope, a follow-up on the same agent, and an out-of-scope
launch refused before HTTP. It exits nonzero if those demonstrated behaviors do not hold.

An excerpt from the offline demonstration (IDs and results are fixtures):

```text
Policy: one repository; launch/follow-up/cancel enabled; deletion unavailable.
Launch: target verified; agent=bc-00000000-0000-4000-8000-000000000001; run=run-1
...
Follow-up: same agent; new run=run-2
Scope: OtherOrg/OtherRepo refused before any simulated HTTP request.
Demo complete. No cloud agent or PR was created; use the quickstart for real work.
```

## Launch real work

Follow the [client setup](setup.md) and
[account setup](../README.md#3-check-setup). Use the current project's Git remote
or name the repository in your request. Your Cursor account must have access to it. Real launches may incur Cursor charges.

Ask your assistant:

> Use Cursor to fix the empty-search bug in OWNER/REPO, starting from main.
> State the target before launching, retain the returned agent/run IDs, and check
> the result. Report the PR link if one is returned. Do not merge it.

The expected tool sequence is `cursor_create_agent`, then `cursor_get_run` or
`cursor_wait_run` using the returned IDs. A wait can return while work is still
running; continue checking that same run. A successful launch is not a completed
task. A reported branch is not proof it was pushed. Review any reported PR yourself.
The quickstart requests automatic PR creation, but a task may finish without one.

For more work on the same conversation:

> Ask that same Cursor agent to add a regression test for whitespace-only input.

The assistant uses `cursor_create_run` with the existing agent ID and receives a
new run ID. For cancellation, ask it to cancel the specific run, rather than
deleting the agent. If a launch result is lost, do not blindly launch again:
[caller-supplied IDs and retries](reference.md#guardrails) explain the distinction.

## Resume after restarting the client

Cursor keeps the agents and runs; this server needs no local task database. If you
kept the IDs, call `cursor_get_run` or `cursor_wait_run` with them. Otherwise list
agents, identify the intended repository/task, list that agent's runs, and select
the intended run. Follow pagination when necessary. Do not launch a replacement
just because a tool call or client session ended. The current policy is checked
again, so changed repository/environment permissions can refuse access.

## Start from a pull request link

When review lands on a PR an agent opened and you no longer have its IDs, the link is
enough. Ask your assistant:

> Which Cursor agent worked on https://github.com/OWNER/REPO/pull/123? List its runs
> and show the latest run's status. Do not launch anything or send a follow-up.

The assistant calls `cursor_list_agents` with
`prUrl: "https://github.com/OWNER/REPO/pull/123"`, then `cursor_list_runs` and
`cursor_get_run` with the returned agent ID. Read the filtered result as one page of
Cursor's answer: it may return no agent, one, or several, and an empty page is not proof
that no agent touched the PR — an agent outside your policy stays hidden, and a returned
`nextCursor` means more pages remain. To continue, repeat the same `prUrl` with that
cursor; the server never remembers the filter for you. Nothing here launches work or
sends a follow-up: those stay explicit `cursor_create_agent` and `cursor_create_run`
calls.

## Reusable examples

Three shapes cover most repeat work. Each is one `cursor_create_agent` call using only
fields the [tool schema](reference.md#tools) already accepts, so adapting them needs no
new dependency and no change to this server. Replace `OWNER/REPO`, refs, and PR numbers;
keep everything else.

Read the arguments as a request, not a result. Every example here **launches new work**
in a cloud VM and may incur Cursor charges, and it only runs if the active profile
already allows that repository and registers `cursor_create_agent` — otherwise you get a
policy refusal before any HTTP request. Reading existing work (`cursor_list_agents`,
`cursor_list_runs`, `cursor_get_run`, `cursor_tail_run`) launches nothing and is what the
sections above and below cover.

What the readback does and does not settle, for all three:

- A requested `prUrl` is verified. If Cursor reads back a different pull request, or
  none, the *launch result* is refused: you get an error instead of a success, but the
  agent and the run already exist in your account. The refusal names both IDs, and it
  says whether cancellation was requested or could not be confirmed — cancellation here
  is best-effort, and a requested cancel is never proof a run stopped (one 200 was
  followed by `FINISHED`). Keep the IDs from the error, read `cursor_get_run` until the
  status is terminal, and cancel again yourself if it is not.
- A requested `startingRef` is *reported*, not enforced: `sourcePinned: false` means
  Cursor did not confirm the pin. `metadata` is confirmed the same way, via
  `metadataVerified`.
- `name` is not verified at all — there is no `nameVerified` — and on 2026-09-08 supplied
  names were observed absent from readback. Use it as a label you may not get back, never
  as the way you find an agent again.
- Requesting `autoCreatePR: true` is a request. It is not proof a PR was produced; read
  `cursor_get_run` for a reported PR link, and review the PR yourself. A profile may pin
  `autoCreatePR`, and passing the opposite value is refused rather than silently
  overridden — the quickstart pins it to `true`, `policy.example.json` to `false`. Omit
  the field to inherit whatever your profile pins. A pinned `model` behaves the same way.
- Do not combine `startingRef` with `prUrl` (Cursor ignores the ref; the server refuses
  the pair), and do not pass `prUrl` alongside an `environment` target.
- `metadata` is an optional convenience for your own bookkeeping. Nothing here requires it,
  and no campaign or grouping feature reads it. Keep it non-sensitive: it is caller text
  persisted on the agent, so no keys, tokens, or private task content.

Retain the returned `agentId` and `runId` in all three cases. Those are the authoritative
handles for `cursor_get_run`, `cursor_create_run`, and `cursor_cancel_run`; a name, a
prompt, or a PR link is not. If you might retry the call, supply your own
`agentId: "bc-<uuid>"` first — see
[caller-supplied IDs and retries](reference.md#guardrails).

### Python: add the missing tests

Useful when a module has behavior nobody has pinned down yet, and you want the tests
written where they can be reviewed rather than in your working tree.

```json
{
  "repo": "OWNER/REPO",
  "startingRef": "main",
  "prompt": "Add unit tests for the retry helper in src/http/retry.py, covering the backoff bounds and the give-up path. Use this repository's declared test tooling and configuration rather than assuming a runner: read the project's dependency and tool config first, and follow whatever it declares. Run the tests you add. Do not change library behavior to make a test pass.",
  "name": "retry helper tests",
  "autoCreatePR": true,
  "metadata": { "topic": "test-coverage" }
}
```

Expect `agentId`, `runId`, `status`, `url`, `targetVerified: true`, and `sourcePinned`
reflecting the `main` pin. Then `cursor_get_run` for the final reply, reported branch,
and PR link if one exists. "The tests pass" is a claim in the agent's reply; a green
report is not a run of your CI.

### Rust: review an existing pull request

Useful for a second pass on a PR that is already open — the agent works on that PR's
branch instead of starting a new one.

```json
{
  "repo": "OWNER/REPO",
  "prUrl": "https://github.com/OWNER/REPO/pull/123",
  "prompt": "Review this pull request for correctness and unsound assumptions in the changed modules, then report findings. Build and test using the repository's declared tooling and its committed toolchain and feature configuration; do not assume a default command set or a stable-toolchain default. Comment findings on the pull request; do not push behavior changes and do not merge.",
  "name": "PR 123 review"
}
```

No `startingRef` here: the PR supplies the source. Expect `repoDetails` carrying that
`prUrl` — if it does not, the launch result is refused, and the run Cursor already
created is still yours to settle: take the two IDs out of the error and follow the
readback rule above. To
find this agent later without the IDs, filter by the same `prUrl` through
[`cursor_list_agents`](#start-from-a-pull-request-link).

### Investigate a failing repository test or CI run

Useful when a repository test or CI job fails and you want the cause isolated before
anyone changes code. This is a *repository* failure, not a Cursor environment Build — for
a broken Build, see [inspecting an environment](#inspect-an-environment-without-launching-anything).

```json
{
  "repo": "OWNER/REPO",
  "startingRef": "COMMIT_OR_BRANCH",
  "prompt": "The job 'integration' fails on this ref: <paste the failing job name and the relevant log excerpt>. Reproduce it using the repository's declared tooling and CI configuration, identify the cause, and report it with the exact failing command and output. Do not fix anything and do not open a pull request unless the fix is a one-line, obviously correct change, in which case propose it separately.",
  "name": "integration failure on COMMIT_OR_BRANCH",
  "metadata": { "topic": "ci-triage" }
}
```

Pin `startingRef` to the exact commit that failed; on a moving branch the agent may not
see the failure at all, and `sourcePinned` is your only signal about the pin. Paste the
failing job name and log excerpt into the prompt — the agent cannot read your CI. Keep
credentials and private customer data out of the excerpt. This example asks for a
diagnosis rather than a PR, so it leaves `autoCreatePR` out: under the quickstart's pinned
`true` a launch asking for `false` is refused, and the way to suppress PR creation is a
profile that pins it. Expect the diagnosis in the run's final reply. For long runs,
`cursor_tail_run` samples activity and `cursor_export_run` writes the whole replay to
disk; see
[the recovery playbook](reference.md#recovering-evidence-from-a-stopped-run) if a run
stops before you read it.

## Optional run activity

For an activity excerpt between status checks, add `cursor_tail_run` to your
policy's tool list and restart the client. Ask it to inspect the intended run's
activity. Pass the returned `lastEventId` to continue; partial results may replay
the final ID group. If `replayRequired` is true or the cursor does not advance,
use `cursor_get_run` or Cursor's UI instead of repeating indefinitely.
`done` describes the stream, while `statusVerified` says whether REST confirmed
the run status. This tool does not supply a continuous progress UI or cancel
cloud work. [Full activity contract](streaming.md).

## See why scope matters

With the single-repository policy active, a request to launch work in another
repository returns a policy refusal. It is rejected before a launch request reaches
Cursor. Permanent deletion is absent from the registered tools. Change the policy
yourself and restart the client when you intentionally want different permissions;
an instruction in a task cannot edit the policy through this server.

## Inspect an environment without launching anything

This advanced tool is excluded from the everyday quickstart. Add
`cursor_inspect_environment_definition` to your policy tool list and restart the
client before trying it. This is a local read, not permission for paid Build work.

Ask your assistant:

> Inspect this proposed Cursor environment definition: {"snapshot":"example-snapshot"}.
> Explain whether the agent can update its snapshot. Do not save or launch anything.

`cursor_inspect_environment_definition` reports the effective default as true for
this snapshot base. Explicit false disables it; build/image bases have different
rules. Supplying text makes this a local check independent of the server's working
directory. It does not validate that the snapshot exists in your account.

For an actual broken Build, [environment operations](reference.md#tools) can inspect
Build metadata and logs after explicit policy configuration. Some diagnostics launch
paid delegates. Activation and other unsupported operations still need owner action;
the tools do not promise complete automatic environment repair.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Doctor reports a policy error | Run setup for a new policy; it will refuse an existing file. For an existing policy, check the chosen path, JSON, default profile, and tool list. |
| Doctor reports account or repository access failure | Check the key and Cursor GitHub installation. Wait after a rate-limit response. Doctor makes read requests only and never guarantees a launch. |
| Want to check installation before supplying a key | Run `node dist/bin.js --version`, then `npm run check:bin` from the checkout. The existing check uses a dummy key and temporary policy for startup/tool discovery; it does not call Cursor or validate your personal configuration. |
| `dist/bin.js` is missing | Run `npm ci` and `npm run build` from the checkout using Node 24 LTS. |
| Client cannot start the server | Use absolute paths to Node and `dist/bin.js`; check the client's MCP startup log. Source updates require rebuilding and restarting the client. |
| Missing `CURSOR_API_KEY` | Make the variable available to the process that starts the client. A desktop app may not inherit a terminal export. Use the client's documented credential mechanism; never put a real key in the repository. |
| Configured policy is missing or invalid | Read the startup error and check that exact path and JSON. A configured-but-missing policy refuses startup. |
| Launch tool is missing | No policy means read-only. Check `defaultProfile` and that profile's `tools`, then restart the client. The generic `policy.example.json` starts read-only; the quickstart example enables one repository. |
| Launch or agent read is refused | Check the repository against the active profile. The quickstart deliberately denies no-repository and named-environment launches. Existing agents spanning multiple repositories need every repository allowed. |
| Cursor returns 401/403 | Check the API key and Cursor account/repository permissions. Passing offline checks does not verify credentials. |
| Environment inspection reads the wrong checkout | Supply definition text. Local-file mode reads `.cursor/environment.json` under the MCP server's working directory. |

Bug reports are welcome. Include the version, client, tool, sanitized error, and
expected behavior. Omit keys, private task content, presigned artifact URLs, and
other credentials. See [reporting policy](../README.md#support-and-security).
