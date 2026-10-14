/**
 * Local file reads confined to the folder the host trusts.
 *
 * MCP hosts start this server in the folder the user opened and trusted: Claude
 * Code in the project directory, Codex in its trusted workspace. That working
 * directory is the trusted folder. Nothing here is host-specific; a host that
 * ever needs different handling is a branch in `trustedRoot`, not a new reader.
 *
 * Results never carry the requested path. A refusal names a reason only, so a
 * caller can report it without echoing a local path into tool output or logs.
 */
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { WaitScope } from "./wait.js";

/** Written as an escape so this file stays pure ASCII, like `untrusted.ts`. */
const NUL = String.fromCharCode(0);

/**
 * The folder the host started this server in, with symlinks resolved.
 *
 * Undefined when that folder is the home directory or a filesystem root: a host
 * launched from `~` has not trusted everything under it.
 */
export async function trustedRoot(
  cwd: string = process.cwd(),
  home: string = homedir(),
): Promise<string | undefined> {
  const root = await realpath(cwd).catch(() => undefined);
  if (root === undefined || parse(root).root === root) return undefined;
  const realHome = await realpath(home).catch(() => resolve(home));
  return root === realHome ? undefined : root;
}

export type TrustedRead =
  | { kind: "ok"; bytes: Buffer }
  | { kind: "absent" }
  | { kind: "tooLarge"; sizeBytes: number }
  | { kind: "outside" }
  | { kind: "notFile" };

/**
 * Read one regular file inside `root`.
 *
 * `path` is absolute or relative to `root`. Symlinks are resolved before the
 * containment check, so a link inside the folder that points out of it is
 * `outside`. The file is opened once, non-blocking so a FIFO cannot stall the
 * call, and read through that handle to at most one byte past `maxBytes`.
 * ENOENT and ENOTDIR are `absent`; any other filesystem error is thrown.
 */
export async function readTrustedFile(
  root: string,
  path: string,
  maxBytes: number,
  scope?: WaitScope,
): Promise<TrustedRead> {
  if (root.includes(NUL) || path.includes(NUL)) {
    throw new Error("path contains a NUL byte");
  }
  try {
    const [realRoot, realFile] = await Promise.all([
      realpath(root),
      realpath(resolve(root, path)),
    ]);
    const fromRoot = relative(realRoot, realFile);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      return { kind: "outside" };
    }
    scope?.throwIfStopped();
    if (!(await stat(realFile)).isFile()) return { kind: "notFile" };

    const handle = await open(
      realFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { kind: "notFile" };
      if (info.size > maxBytes) return { kind: "tooLarge", sizeBytes: info.size };
      // Read at most one byte past the limit. A file that grows after `stat`
      // cannot make this operation allocate or return an unbounded payload.
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        scope?.throwIfStopped();
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > maxBytes) return { kind: "tooLarge", sizeBytes: bytesRead };
      return { kind: "ok", bytes: buffer.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw error;
  }
}
