import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTrustedFile, trustedRoot } from "../src/trusted-folder.js";

async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "cursor-mcp-trusted-")));
}

describe("trustedRoot", () => {
  it("returns the resolved working directory", async () => {
    const root = await tempRoot();
    const home = await tempRoot();
    expect(await trustedRoot(root, home)).toBe(root);
  });

  it("refuses the home directory and a filesystem root", async () => {
    const home = await tempRoot();
    expect(await trustedRoot(home, home)).toBeUndefined();
    expect(await trustedRoot("/", home)).toBeUndefined();
  });
});

describe("readTrustedFile", () => {
  it("reads a file by absolute or relative path", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "shots"));
    await writeFile(join(root, "shots", "a.txt"), "abc");
    for (const path of [join(root, "shots", "a.txt"), "shots/a.txt"]) {
      const read = await readTrustedFile(root, path, 10);
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") expect(read.bytes.toString()).toBe("abc");
    }
  });

  it("refuses paths that resolve outside the root", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.txt"), "x");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    expect(await readTrustedFile(root, "link.txt", 10)).toEqual({ kind: "outside" });
    expect(await readTrustedFile(root, join(outside, "secret.txt"), 10)).toEqual({ kind: "outside" });
  });

  it("refuses directories", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "dir"));
    expect(await readTrustedFile(root, "dir", 10)).toEqual({ kind: "notFile" });
  });

  it.skipIf(process.platform === "win32")("refuses FIFOs without blocking", async () => {
    const root = await tempRoot();
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(await readTrustedFile(root, "pipe", 10)).toEqual({ kind: "notFile" });
  });

  it("reports absence and bounds size", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "big.bin"), Buffer.alloc(11));
    expect(await readTrustedFile(root, "missing.txt", 10)).toEqual({ kind: "absent" });
    expect(await readTrustedFile(root, "big.bin", 10)).toEqual({ kind: "tooLarge", sizeBytes: 11 });
  });
});
