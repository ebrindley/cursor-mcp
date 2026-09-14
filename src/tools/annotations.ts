/**
 * Tool annotations, in one place.
 *
 * Clients use these to decide what to auto-approve without asking, so they are
 * shared rather than restated per module: the same operation must not read as
 * read-only in one file and not in another.
 *
 * `destructiveHint` is load-bearing here, not advisory. `defineTool` refuses to
 * register a destructive tool unless the policy file sets `deleteEnabled`.
 */

/** A read. Safe to repeat, changes nothing. */
export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * A read that never leaves this machine: a repository-local file, or text the
 * caller passed in. Same permission class as `READ`, but `openWorldHint` is
 * false because no external system is consulted.
 */
export const LOCAL_READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A Cursor read that creates persistent local files.
 *
 * Not read-only, even though nothing in Cursor changes: `read:*` and no-policy
 * read-only mode must not grant writing to this machine's disk, and
 * `readOnlyHint: false` is what enforces that in `defineTool`. Not destructive
 * either -- it only ever creates files, and `destructiveHint` gates
 * `deleteEnabled`, which is about permanent deletion of cloud state. Not
 * idempotent: a second identical call refuses rather than overwrite an existing
 * export.
 */
export const LOCAL_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * A read that Cursor only answers from inside a run, so answering it launches an
 * agent into the environment.
 *
 * Not read-only, even though nothing in Cursor changes: it spends quota and hands
 * the delegate the environment's secrets and network policy, so `read:*` must not
 * grant it. Not destructive, because the mission itself only reads.
 */
export const DELEGATED_READ = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * A launch or a follow-up. It creates, so it is not destructive -- but calling it
 * twice starts two VMs and spends twice the quota, so it is not idempotent.
 */
export const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Cancelling. Not idempotent despite a second cancel having no additional
 * effect: it returns `409 run_not_cancellable` (verified live), which a client
 * treating the call as safe to repeat would surface as a failure.
 */
export const CANCEL = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Archive and unarchive. Reversible, so not destructive, and documented as
 * idempotent on an agent already in the target state.
 */
export const REVERSIBLE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Persisting configuration: an owner Save, a repository commit, or an
 * environment-version Restore.
 *
 * Not idempotent: a Save applied twice mints two versions and fires two
 * configuration-change Builds. Not destructive, because `destructiveHint` gates
 * registration on `deleteEnabled`, and a configuration write is not deletion.
 */
export const PERSIST = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Reserved annotation for future Build activate, deactivate, or rollback tools.
 * No current tool uses this annotation or the promotion gate.
 *
 * Deliberately not `destructiveHint`, because that hint gates `deleteEnabled` and
 * granting deletion must not grant promotion. `ToolSpec.activation` gates these on
 * `activationEnabled` instead.
 */
export const PROMOTE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Permanent deletion. `destructiveHint` also gates registration on
 * `deleteEnabled`, so this constant is the only thing that turns a tool into one
 * the operator must opt into.
 *
 * Not marked idempotent: a second delete almost certainly 404s, and that is
 * unverified, so the conservative hint is the honest one.
 */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
