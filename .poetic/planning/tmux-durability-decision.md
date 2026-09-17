# Decision: tmux stays caller-owned; this server does not manage tmux sessions (2026-09-16)

## Decisions

- cursor-mcp: no first-class `agent.v1.TmuxSessionService` integration. The durability contract
  stays as documented in docs/terminal.md ("Long-running and detached work"): a caller-owned
  detached tmux session, or an equivalent detach, with output and the workload's exit status in
  VM files, polled by short commands.
- claude-code-plugin provision bootstrap: keeps `nohup setsid` with a log file and an atomic
  exit file.

## Evidence (live probes, 2026-09-16)

- The pod exposes TmuxSessionService (Create/List/Kill/AttachSession; kinds USER_MANUAL,
  AGENT_BACKGROUND, AGENT_INTERACTIVE) and tmux 3.5a at /exec-daemon/tmux with
  /exec-daemon/tmux.portal.conf (status off, history-limit 10000).
- A service-created session survived a 110 s full client disconnect. Each AttachSession mints
  a new PTY and its stream replays a screen repaint (alternate-screen sequences), not clean
  bytes. An attachment's lifetime is not the workload's lifetime.
- Sessions are pod-global: ours was listed alongside everything else on the pod.
- Cursor IDE 3.20.10 runs cloud terminals as `/exec-daemon/tmux -u -f <conf> new-session -A -s
  <name>` with USER_MANUAL sessions, only behind the `cloud_glass_shared_sessions` gate (default
  off). `-A` attaches-or-creates, so an opened terminal is weak evidence of recovery.
- No consumer today needs a durable or interactive VM session beyond files.
- The bootstrap wrapper exits with the status of its final `mv`, so a tmux `pane_dead_status`
  would report the wrapper, not the installer. Running the installer under tmux gives it a TTY.
- Found in the same investigation, unrelated to tmux: the gateway drops idle AttachPty streams
  after about 60 s. The keepalive addresses that; tmux would not.

## Reconsider when

- A consumer needs interactive intervention on a VM job, or a detached workload fails in a way
  files do not recover.
- Cursor changes raw-PTY behavior or enables IDE shared sessions by default.
- The idle-drop fixes land and a durable-work failure remains.

## If reopened: first steps (bounded, at most two attempts each)

- Name the consumer and its requirement.
- Invoke /exec-daemon/tmux from an execute command with the portal conf; record separately
  whether ListSessions lists the session.
- Run the existing wrapper inside tmux; confirm identical log and exit files for exit 0, a
  fast nonzero exit, and an abrupt kill (no exit file plus unknown result is the correct
  outcome there).
- Run a tmux job and a nohup job across a cursor-mcp restart; recover both by files.
- Only if those change the answer: IDE visibility with the gate state recorded; suspend/wake
  with "transition unverified" allowed; tool-surface sizing against the semantic contract
  (durable session reference, temporary attachment, detach versus kill, completion, restart).
