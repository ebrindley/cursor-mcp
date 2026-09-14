/**
 * Where a run export lands on disk, and the rules that keep it there.
 *
 * Two invariants, and every function here exists for one of them:
 *
 * 1. **A path is derived from validated identifiers, never from text.** The ids
 *    come from model-supplied tool arguments, so they are matched against
 *    `EXPORT_ID` before they are joined: no separator, no dot segment, no drive
 *    letter, nothing that could resolve outside the configured root. The resolved
 *    paths are then asserted to be exactly the expected children of that root,
 *    because a cheap second check costs nothing and a first check can be edited
 *    later by someone who does not know it was load-bearing.
 * 2. **Nothing is ever overwritten or appended to.** Every file is created
 *    exclusively (`wx`), and publication is `link` then `unlink` rather than
 *    `rename` -- `rename` replaces an existing destination silently, `link` fails.
 *    An earlier export, complete or partial, is evidence; removing it is the
 *    operator's decision.
 *
 * See docs/run-export.md section 3 for the contract this implements.
 */

import { link, mkdir, open, realpath, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { PolicyError } from "./errors.js";

/**
 * An identifier safe to use as a path component.
 *
 * Deliberately narrower than the tool argument schemas: those bound length and
 * leave the character set to the API, and this one has to survive `join`. A
 * leading character that must be alphanumeric is what rules out `.`, `..`, and
 * `-`-prefixed surprises in one condition. Observed Cursor ids (`bc-...`,
 * `run-...`) satisfy it.
 */
export const EXPORT_ID = new RegExp("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");

export interface ExportPaths {
  /** The configured root, resolved. Every path below is a child of it. */
  root: string;
  /** Directory holding this agent's exports. */
  dir: string;
  /**
   * That directory named relative to the root, for a response that must locate
   * an artifact without spending its budget on an operator-configured prefix.
   */
  dirUnderRoot: string;
  /** In-progress raw capture. */
  partial: string;
  /** Published raw replay. */
  raw: string;
  /** Derived tool-call index. */
  tools: string;
  /** Derived terminal log. */
  terminal: string;
  /** File names, for a response that must not spend its budget on directories. */
  names: { raw: string; partial: string; tools: string; terminal: string };
}

/**
 * Resolve the four paths one export uses, refusing anything that would leave the
 * root.
 */
export function exportPaths(root: string, agentId: string, runId: string): ExportPaths {
  for (const [what, value] of [["agent id", agentId], ["run id", runId]] as const) {
    if (!EXPORT_ID.test(value)) {
      throw new PolicyError(
        `refusing to export: the ${what} is not a safe file name. Export paths are ` +
          "derived from identifiers matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$.",
      );
    }
  }
  const base = resolve(root);
  const dir = join(base, agentId);
  const names = {
    raw: `${runId}.sse`,
    partial: `${runId}.sse.partial`,
    tools: `${runId}.tools.json`,
    terminal: `${runId}.terminal.md`,
  };
  const paths: ExportPaths = {
    root: base,
    dir,
    dirUnderRoot: agentId,
    partial: join(dir, names.partial),
    raw: join(dir, names.raw),
    tools: join(dir, names.tools),
    terminal: join(dir, names.terminal),
    names,
  };
  // Second check, on the resolved strings. EXPORT_ID already makes escape
  // impossible; this is what would still catch it if that regex were widened.
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  for (const path of [paths.partial, paths.raw, paths.tools, paths.terminal]) {
    if (resolve(path) !== path || !path.startsWith(prefix)) {
      throw new PolicyError(`refusing to export: ${path} is not inside the export root`);
    }
  }
  return paths;
}

/**
 * Create the agent's directory and open the partial file exclusively.
 *
 * The exclusive create is the collision check *and* the concurrency boundary: two
 * exports of one run cannot both proceed, and neither can continue a file the
 * other left behind. A pre-existing published export is refused first, so the
 * message names the finished artifact rather than the temporary one.
 */
export async function openPartial(paths: ExportPaths): Promise<FileHandle> {
  await mkdir(paths.dir, { recursive: true });
  await assertResolvedDir(paths);
  try {
    return await open(paths.partial, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PolicyError(
        `refusing to export: ${paths.partial} already exists. An earlier attempt's ` +
          "partial capture is never appended to or replaced; move or remove it to retry.",
      );
    }
    throw error;
  }
}

/**
 * Refuse an agent directory that does not actually live under the root.
 *
 * The string checks in `exportPaths` bound what the *identifiers* can express;
 * they say nothing about what the filesystem already holds. `mkdir -p` over a
 * pre-existing `<root>/<agentId>` symlink succeeds and every artifact then lands
 * wherever that link points, outside the one directory an operator authorized.
 * So the resolved directory is compared with the resolved root before a byte is
 * written: a symlinked agent directory is refused, including one pointing at
 * another directory inside the root, while a symlinked *root* stays fine because
 * both sides resolve through it.
 */
async function assertResolvedDir(paths: ExportPaths): Promise<void> {
  const realRoot = await realpath(paths.root);
  const realDir = await realpath(paths.dir);
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!realDir.startsWith(prefix) || realDir !== join(realRoot, basename(paths.dir))) {
    throw new PolicyError(
      `refusing to export: ${paths.dir} resolves to ${realDir}, which is not the ` +
        "expected directory inside the configured export root. A symlinked agent " +
        "directory is never followed; remove it or export to a clean root.",
    );
  }
}

/**
 * Write a whole buffer, however many writes that takes.
 *
 * `FileHandle.write` is allowed to persist fewer bytes than it was given, so one
 * call is not a written file. A short write that was treated as complete is how
 * a truncated capture gets published as evidence, and a write that persists
 * nothing is a failure rather than a loop.
 *
 * `onProgress` is called after each write that persisted bytes, before anything
 * can throw. The return value only exists on the path where every byte landed,
 * so a caller that counted bytes by it alone lost the whole chunk's progress to
 * a failure partway through -- and then treated a non-empty partial as an empty
 * one worth deleting.
 */
export async function writeFully(
  handle: FileHandle,
  data: Uint8Array,
  onProgress?: (bytes: number) => void,
): Promise<number> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset);
    if (bytesWritten > 0) {
      offset += bytesWritten;
      onProgress?.(bytesWritten);
      continue;
    }
    throw new Error(`export write made no progress after ${offset} of ${data.byteLength} bytes`);
  }
  return offset;
}

/**
 * How many bytes the partial holds, or undefined when that cannot be read.
 *
 * A write that rejects does not say how much of the buffer reached the file, so
 * the file itself is the only honest answer. Undefined means unknown, and every
 * caller treats unknown as "there may be evidence here".
 */
export async function partialBytes(paths: ExportPaths): Promise<number | undefined> {
  const info = await stat(paths.partial).catch(() => undefined);
  return info?.size;
}

/** Refuse early when this run already has a published export. */
export async function assertNotExported(paths: ExportPaths): Promise<void> {
  const existing = await open(paths.raw, "r").catch(() => undefined);
  if (existing === undefined) return;
  await existing.close();
  throw new PolicyError(
    `refusing to export: ${paths.raw} already exists. An export is never replaced or ` +
      "re-run over itself; move or remove it to export this run again.",
  );
}

/** What publication actually did, which is two facts and not one. */
export interface Publication {
  /** The final name now exists and holds the capture. */
  linked: boolean;
  /** The partial was removed afterwards. False leaves a duplicate behind. */
  partialRemoved: boolean;
  /** Why the partial is still there, when it is. Ours, never upstream text. */
  detail?: string;
}

/**
 * Publish a completed partial under its final name.
 *
 * `link` then `unlink`, because `rename` would silently replace a file that
 * appeared at the destination after the partial was opened.
 *
 * The two steps fail differently and are reported differently. A failed `link`
 * published nothing and throws. A failed `unlink` published everything: the
 * final name holds the bytes, and throwing there would report a successful
 * export as a failure and send a caller looking for a file that exists. That one
 * comes back as `partialRemoved: false` -- a leftover duplicate to clean up, not
 * a lost capture.
 */
export async function publish(partial: string, final: string): Promise<Publication> {
  try {
    await link(partial, final);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PolicyError(
        `refusing to publish: ${final} appeared while this export was running; ` +
          `the capture is kept at ${partial}`,
      );
    }
    throw error;
  }
  try {
    await unlink(partial);
  } catch (error) {
    return {
      linked: true,
      partialRemoved: false,
      detail: `${final} was written, but ${partial} could not be removed (${
        (error as NodeJS.ErrnoException).code ?? "unknown error"
      })`,
    };
  }
  return { linked: true, partialRemoved: true };
}

export async function publishRaw(paths: ExportPaths): Promise<Publication> {
  return publish(paths.partial, paths.raw);
}

/**
 * Write one derived sidecar, never over an existing file and never half-written
 * under its final name.
 *
 * The content used to go straight to the final name with `wx`. Exclusive
 * creation stops a second export from overwriting a sidecar; it does nothing
 * about a full disk or a killed process midway through the write, which leaves a
 * truncated file under the name that promises a whole one. So a sidecar is built
 * in its own partial, closed, and then published by the same non-replacing
 * `link`: a failure leaves the final name absent, which is a state a reader
 * cannot misread.
 *
 * `stop` is consulted once, after the bytes are on disk and before the `link`.
 * Neither the write nor the close is interruptible, so this cancels nothing in
 * flight; what it prevents is publishing a final name -- a name that says this
 * sidecar is part of a finished export -- after the call it belongs to was
 * cancelled or ran out of time.
 */
export async function writeSidecar(
  path: string,
  content: string,
  stop?: () => string | undefined,
): Promise<Publication> {
  const partial = `${path}.partial`;
  const handle = await open(partial, "wx").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PolicyError(
        `refusing to write ${path}: ${partial} already exists. A half-written sidecar ` +
          "from an earlier attempt is never continued or replaced; move or remove it.",
      );
    }
    throw error;
  });
  try {
    await writeFully(handle, Buffer.from(content, "utf8"));
    // Before publication, not after: buffered bytes that never reached the file
    // must not be linked under a name that says they did.
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(partial).catch(() => {});
    throw error;
  }
  const stopped = stop?.();
  if (stopped !== undefined) {
    const removed = await unlink(partial).then(
      () => true,
      () => false,
    );
    return {
      linked: false,
      partialRemoved: removed,
      detail: `${basename(path)} was not published: the export was ${stopped} before it ` +
        `could be linked${removed ? "" : `, and ${basename(partial)} is still there`}`,
    };
  }
  return publish(partial, path);
}

/**
 * Remove a partial this call created and never wrote a byte into.
 *
 * The one deletion in this module, and narrow on purpose: without it a transient
 * failure -- a refused connection, an immediate cancel -- would leave an empty
 * file that refuses every later retry of the same run. A partial holding received
 * bytes is never removed here.
 *
 * Emptiness is read from the file, not inferred from a counter, and an
 * unreadable size keeps the file: a caller's byte count can miss bytes that a
 * failing write did persist, and deleting on that assumption destroys the only
 * copy of what arrived. Returns whether the partial is gone.
 */
export async function discardEmptyPartial(paths: ExportPaths): Promise<boolean> {
  const size = await partialBytes(paths);
  if (size !== 0) return false;
  return unlink(paths.partial).then(
    () => true,
    () => false,
  );
}
