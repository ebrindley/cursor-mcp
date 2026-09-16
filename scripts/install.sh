#!/usr/bin/env bash
# Public source installer: archive, build, atomic release. Scheduling belongs to the caller.
set -euo pipefail
umask 077
ROOT="${CURSOR_MCP_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/cursor-mcp}"
STATE="$ROOT/state"
SOURCE="$ROOT/src"
REPOSITORY="${CURSOR_MCP_REPOSITORY:-https://github.com/ebrindley/cursor-mcp.git}"
REF="${CURSOR_MCP_REF:-refs/heads/main}"
MODE=install YES=0 UNATTENDED=0 DRY_RUN=0 PORCELAIN=0 WITH_CURSOR=0
PIN_SOURCE='' PIN_COMMIT='' HOSTS=()
ENTRY_REL=dist/bin.js
usage() {
  cat <<'HELP'
Usage: install.sh [install] [--host claude|codex|grok] [--with-cursor] [--yes]
       install.sh update [--unattended|--yes]
       install.sh pin --source PATH --commit FULL_SHA [--yes]
       install.sh unpin [--yes] | rollback [--yes]
       install.sh status [--porcelain]
All mutation commands accept --dry-run (no writes or network).

Installs from GitHub into ~/.local/share/cursor-mcp (CURSOR_MCP_ROOT overrides).
New installations enable account-wide agent management and terminal access.
Existing policies and model selections are preserved.
Requires Bash, Git, Node >=22.4, npm and tar; it does not install OS packages.
Installation registers detected Claude Code, Codex and Grok clients,
unless --host selects specific clients. Cursor is explicitly opt-in.
Updates preserve existing registrations and never add a new client.
A local pin archives the specified commit without fetching from GitHub. Updates
leave a pin untouched. Rollback selects and pins the retained previous release.
Client settings, credentials and unrelated entries are preserved. New entries
inherit authentication; configure CURSOR_API_KEY before using the server.
HELP
}
if [ "$#" -gt 0 ]; then
  case "$1" in install|update|pin|unpin|status|rollback) MODE="$1"; shift ;; esac
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --unattended) UNATTENDED=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --porcelain) PORCELAIN=1 ;;
    --with-cursor) WITH_CURSOR=1 ;;
    --host) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; case "$1" in claude|codex|grok) HOSTS+=("$1") ;; *) echo 'Invalid host.' >&2; exit 2 ;; esac ;;
    --source) shift; [ "$#" -gt 0 ] || exit 2; PIN_SOURCE="$1" ;;
    --commit) shift; [ "$#" -gt 0 ] || exit 2; PIN_COMMIT="$1" ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
case "$ROOT" in /*) ;; *) echo 'CURSOR_MCP_ROOT must be absolute.' >&2; exit 2 ;; esac
if { [ "$UNATTENDED" = 1 ] && [ "$MODE" != update ]; } ||
   { [ "$PORCELAIN" = 1 ] && [ "$MODE" != status ]; } ||
   { { [ "${#HOSTS[@]}" -gt 0 ] || [ "$WITH_CURSOR" = 1 ]; } && [ "$MODE" != install ]; } ||
   { { [ -n "$PIN_SOURCE" ] || [ -n "$PIN_COMMIT" ]; } && [ "$MODE" != pin ]; }; then
  echo 'These options do not apply to this command.' >&2; exit 2
fi
read_state() { cat "$STATE/$1" 2>/dev/null || true; }
deployed_sha() { cat "$ROOT/current/.release-sha" 2>/dev/null || true; }
release_is_complete() { [ -s "$1/$ENTRY_REL" ] && [ -d "$1/node_modules" ] && [ -f "$1/scripts/install.sh" ]; }
log() { printf '%s\n' "$*"; }
status() {
  local deployed pinned failure
  deployed="$(deployed_sha)"; pinned="$(read_state pinned)"; failure="$(read_state last_failure)"
  if [ "$PORCELAIN" = 1 ]; then
    printf 'contract=1\ndeployed=%s\npinned=%s\nlast_failure=%s\n' "$deployed" "$pinned" "$failure"
  else
    printf 'Installation: %s\nDeployed: %s\nPinned: %s\nLast failure: %s\n' "$ROOT" "${deployed:-not installed}" "${pinned:-no}" "${failure:-none}"
  fi
}
[ "$MODE" != status ] || { status; exit 0; }
# The unattended path has no authority to install or unpin anything.
if [ "$MODE" = update ]; then
  [ -n "$(deployed_sha)" ] || { log 'Not installed; nothing to update.'; exit 0; }
  [ -z "$(read_state pinned)" ] || { log 'Local release is pinned; nothing fetched or built.'; exit 0; }
fi
if [ "$MODE" = pin ]; then
  if ! [[ "$PIN_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [ -z "$PIN_SOURCE" ]; then
    echo 'pin requires --source and an exact 40-character commit SHA.' >&2; exit 2
  fi
  [ "$(git -C "$PIN_SOURCE" rev-parse "${PIN_COMMIT}^{commit}" 2>/dev/null)" = "$PIN_COMMIT" ] || { echo 'Local commit not found.' >&2; exit 2; }
fi
if [ "$DRY_RUN" = 1 ]; then
  log "Would $MODE Cursor MCP at $ROOT; no files or network touched."
  [ "$MODE" != pin ] || log "Would archive $PIN_COMMIT from $PIN_SOURCE and pin it."
  exit 0
fi
confirm() {
  [ "$YES" = 1 ] || [ "$UNATTENDED" = 1 ] || {
    local reply
    if ! { printf '%s [y/N] ' "$1" > /dev/tty; IFS= read -r reply < /dev/tty; } 2>/dev/null; then
      echo 'No interactive terminal. Rerun with --yes to consent.' >&2; exit 2
    fi
    case "$reply" in y|Y|yes|YES) ;; *) log 'Nothing changed.'; return 1 ;; esac
  }
}
confirm "$MODE Cursor MCP at $ROOT?" || exit 0
# Hook callers can have a short PATH. Retain their chosen runtime if available.
for path_entry in /opt/homebrew/opt/node@24/bin /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$path_entry:"*) ;; *) [ ! -d "$path_entry" ] || PATH="$PATH:$path_entry" ;; esac
done
export PATH
for requirement in git node npm tar; do
  command -v "$requirement" >/dev/null 2>&1 || { echo "Missing prerequisite: $requirement. Install it and rerun this command." >&2; exit 2; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || a===22 && b>=4 ? 0 : 1)' || { echo 'Node >=22.4 is required for terminal access.' >&2; exit 2; }
NODE="$(command -v node)"
mkdir -p "$STATE"
LOCK="$STATE/update.lock" LOCK_HELD=0
release_lock() { if [ "$LOCK_HELD" = 1 ]; then rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true; fi; }
# Preserve the old updater's PID ownership: never evict a live builder.
if [ -d "$LOCK" ]; then
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  case "$owner" in ''|*[!0-9]*) ;;
    *) if ! kill -0 "$owner" 2>/dev/null; then rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null || true; fi ;;
  esac
fi
mkdir "$LOCK" 2>/dev/null || { echo 'Another install/update owns the lock; nothing changed.' >&2; exit 3; }
printf '%s\n' "$$" > "$LOCK/pid"
LOCK_HELD=1
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Recheck under the lock; a pin may have completed while this process waited.
if [ "$MODE" = update ] && [ -n "$(read_state pinned)" ]; then log 'Local release is pinned.'; exit 0; fi
write_state() { printf '%s\n' "$2" > "$STATE/.$1.$$"; mv "$STATE/.$1.$$" "$STATE/$1"; }
fail() { write_state last_failure "$1"; echo "Cursor MCP: $1; the prior release was retained where activation did not complete." >&2; return 1; }
record_backoff() {
  local previous next
  previous="$(read_state backoff-delay)"; case "$previous" in ''|*[!0-9]*) previous=0 ;; esac
  next=$((previous > 0 ? previous * 2 : 3600)); [ "$next" -le 86400 ] || next=86400
  write_state backoff-delay "$next"; write_state backoff-until "$(( $(date +%s) + next ))"
}
rename_path() { "$NODE" -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$1" "$2"; }
activate() {
  local target="$1" before
  before="$(readlink "$ROOT/current" 2>/dev/null || true)"
  ln -s "$target" "$ROOT/.current.$$"
  rename_path "$ROOT/.current.$$" "$ROOT/current" || { rm -f "$ROOT/.current.$$"; return 1; }
  [ -z "$before" ] || [ "$before" = "$target" ] || write_state previous "$before"
}
# Archive a clean commit; build only in a fresh staging directory. Never modify
# a source checkout or the active release. This is the original updater's unit
# of activation, with check:bin added before the rename.
publish_release() {
  local co="$1" sha="$2" staging final
  staging="$ROOT/staging/$sha.$$"
  final="$ROOT/releases/$sha-$(date +%s)-$$"
  mkdir -p "$staging" "$ROOT/releases" || return 2
  if ! git -C "$co" archive --format=tar "$sha" | tar -x -C "$staging"; then rm -rf "$staging"; return 2; fi
  if ! (cd "$staging" && env -u CURSOR_API_KEY npm ci --no-audit --no-fund --loglevel=error); then rm -rf "$staging"; return 2; fi
  if ! (cd "$staging" && env -u CURSOR_API_KEY CURSOR_MCP_RELEASE_SHA="$sha" npm run --silent build && env -u CURSOR_API_KEY npm run --silent check:bin); then rm -rf "$staging"; return 1; fi
  if ! release_is_complete "$staging" || [ ! -f "$staging/scripts/install-hosts.mjs" ]; then rm -rf "$staging"; return 1; fi
  printf '%s\n' "$sha" > "$staging/.release-sha"
  rename_path "$staging" "$final" || { rm -rf "$staging"; return 2; }
  activate "releases/$(basename "$final")" || return 2
}
if [ "$MODE" = unpin ]; then
  rm -f "$STATE/pinned"
  log 'Pin removed. The next update may fetch GitHub; this command did not.'
  exit 0
fi
if [ "$MODE" = rollback ]; then
  previous="$(read_state previous)"
  case "$previous" in releases/*) ;; *) fail no_previous_release; exit 1 ;; esac
  release_is_complete "$ROOT/$previous" || { fail incomplete_previous_release; exit 1; }
  activate "$previous" || { fail activation_failed; exit 1; }
  write_state pinned "$(deployed_sha)"
  rm -f "$STATE/last_failure"
  log 'Previous release restored and pinned. Restart your MCP clients.'
  exit 0
fi
sha=''
if [ "$MODE" = pin ]; then
  co="$PIN_SOURCE"; sha="$PIN_COMMIT"
  # Establish the pin before a build. Even a failed local candidate must not
  # authorize a later automatic update to replace the retained installation.
  write_state pinned "$sha"
elif [ "$MODE" = install ] && [ -n "$(read_state pinned)" ]; then
  release_is_complete "$ROOT/current" || { fail pinned_release_incomplete; exit 1; }
  co=''; sha="$(deployed_sha)"
else
  until="$(read_state backoff-until)"
  case "$until" in ''|*[!0-9]*) until=0 ;; esac
  if [ "$UNATTENDED" = 1 ] && [ "$(date +%s)" -lt "$until" ]; then log 'Update is in network/build backoff.'; exit 0; fi
  # src belongs to this installer, never to an editor's existing checkout.
  if [ ! -d "$SOURCE/.git" ]; then
    if [ -e "$SOURCE" ]; then fail source_directory_not_owned; exit 1; fi
    clone_stage="$ROOT/.src.$$"
    if ! GIT_TERMINAL_PROMPT=0 git clone --quiet --no-checkout "$REPOSITORY" "$clone_stage"; then rm -rf "$clone_stage"; record_backoff; fail clone_failed; exit 1; fi
    rename_path "$clone_stage" "$SOURCE" || { fail source_activation_failed; exit 1; }
  elif [ "$(git -C "$SOURCE" remote get-url origin)" != "$REPOSITORY" ]; then
    fail source_remote_mismatch; exit 1
  fi
  co="$SOURCE"
  if ! GIT_TERMINAL_PROMPT=0 git -C "$co" fetch --quiet origin "$REF"; then record_backoff; fail fetch_failed; exit 1; fi
  sha="$(git -C "$co" rev-parse 'FETCH_HEAD^{commit}')"
  write_state last-check "$(date +%s)"
  if [ "$(read_state failed-sha)" = "$sha" ]; then fail commit_quarantined; exit 1; fi
fi
if [ "$(deployed_sha)" != "$sha" ] || ! release_is_complete "$ROOT/current"; then
  result=0
  publish_release "$co" "$sha" || result=$?
  if [ "$result" = 1 ]; then write_state failed-sha "$sha"; fail build_or_verification_failed; exit 1; fi
  if [ "$result" != 0 ]; then record_backoff; fail release_infrastructure_failed; exit 1; fi
fi
# Existing registrations retain their settings; only explicit installs add hosts.
registration_args=(--root "$ROOT" --node "$NODE")
if [ "$MODE" = install ]; then
  registration_args+=(--install)
  for host in ${HOSTS[@]+"${HOSTS[@]}"}; do registration_args+=(--host "$host"); done
  [ "$WITH_CURSOR" = 0 ] || registration_args+=(--with-cursor)
fi
if ! "$NODE" "$ROOT/current/scripts/install-hosts.mjs" "${registration_args[@]}"; then
  record_backoff; write_state last_failure registration_failed
  echo 'Cursor MCP release is active, but client registration failed. Fix the reported configuration and rerun install.' >&2
  exit 1
fi
rm -f "$STATE/restart-needed" "$STATE/last_failure" "$STATE/failed-sha" "$STATE/backoff-delay" "$STATE/backoff-until"
# Keep the active and retained predecessor. No runtime output enters git.
current="$(readlink "$ROOT/current")"; previous="$(read_state previous)"
for release in "$ROOT"/releases/*; do
  [ -d "$release" ] || continue
  [ "releases/$(basename "$release")" = "$current" ] || [ "releases/$(basename "$release")" = "$previous" ] || rm -rf "$release"
done
log "Cursor MCP is installed at $ROOT/current ($sha). Restart changed MCP clients to load it."

# Updates preserve the existing policy. A policy written before terminal access
# existed therefore never gains it; report that once per update, without editing.
if [ "$MODE" = update ]; then
  existing_policy="${CURSOR_MCP_POLICY:-$HOME/.config/cursor-mcp/policy.json}"
  if [ -f "$existing_policy" ]; then
    terminal_rc=0
    "$NODE" -e 'let p; try { p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(2); } process.exit(p && p.terminal ? 0 : 1);' "$existing_policy" </dev/null 2>/dev/null || terminal_rc=$?
    [ "$terminal_rc" != 1 ] || log "Existing policy has no terminal block, so terminal tools are not registered. Preview the change with: $NODE $ROOT/current/dist/bin.js setup --account --preview"
  fi
fi

# First installation configures account access; updates preserve existing policy.
if [ "$MODE" = install ]; then
  setup_policy="${CURSOR_MCP_POLICY:-$HOME/.config/cursor-mcp/policy.json}"
  if [ ! -e "$setup_policy" ] && [ ! -L "$setup_policy" ]; then
    "$NODE" "$ROOT/current/dist/bin.js" setup --policy "$setup_policy" --yes </dev/null || {
      log 'Installation succeeded; setup could not finish. Run cursor-mcp setup to retry.'
    }
  fi
  "$NODE" "$ROOT/current/dist/bin.js" doctor --offline </dev/null || log 'Installation succeeded; check the configuration diagnostics above.'
fi
