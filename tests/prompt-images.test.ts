import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptImages } from "../src/prompt-images.js";

const SIGNATURES = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  gif: Buffer.from("GIF89a"),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
};

async function folder(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "cursor-mcp-images-")));
}

const rooted = (root: string | undefined) => () => Promise.resolve(root);

describe("path images", () => {
  it("reads each format and derives mimeType from the bytes", async () => {
    const root = await folder();
    const files: Array<[string, Buffer, string]> = [
      ["a.png", SIGNATURES.png, "image/png"],
      ["b.JPG", SIGNATURES.jpeg, "image/jpeg"],
      ["c.jpeg", SIGNATURES.jpeg, "image/jpeg"],
      ["d.gif", SIGNATURES.gif, "image/gif"],
      ["e.webp", SIGNATURES.webp, "image/webp"],
    ];
    for (const [name, bytes] of files) await writeFile(join(root, name), bytes);
    const result = await promptImages(
      files.map(([name], i) => (i === 0 ? { path: join(root, name), dimension: { width: 2, height: 1 } } : { path: name })),
      rooted(root),
    );
    expect(result?.wire).toEqual(
      files.map(([, bytes, mimeType], i) => ({
        data: bytes.toString("base64"),
        mimeType,
        ...(i === 0 ? { dimension: { width: 2, height: 1 } } : {}),
      })),
    );
  });

  it.each([
    ["notes.md", "must end in"],
    ["env.png", "do not match"],
    ["jpeg.png", "do not match"],
    ["missing.png", "does not exist"],
    ["link.png", "outside the folder"],
    ["dir.png", "not a regular file"],
  ])("refuses %s without echoing the path", async (name, message) => {
    const root = await folder();
    const outside = await folder();
    await writeFile(join(root, "notes.md"), "# notes");
    await writeFile(join(root, "env.png"), "TOKEN=abc");
    await writeFile(join(root, "jpeg.png"), SIGNATURES.jpeg);
    await writeFile(join(outside, "real.png"), SIGNATURES.png);
    await symlink(join(outside, "real.png"), join(root, "link.png"));
    await mkdir(join(root, "dir.png"));
    const error = await promptImages([{ path: join(root, name) }], rooted(root)).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("images[0].path");
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain(root);
  });

  it("refuses path images when there is no trusted folder", async () => {
    await expect(promptImages([{ path: "/x.png" }], rooted(undefined))).rejects.toThrow("not a trusted folder");
  });

  it("caps each image and the call total at 15 MB", async () => {
    const root = await folder();
    const big = Buffer.concat([SIGNATURES.png, Buffer.alloc(15_000_001 - SIGNATURES.png.length)]);
    const nine = Buffer.concat([SIGNATURES.png, Buffer.alloc(9_000_000 - SIGNATURES.png.length)]);
    await writeFile(join(root, "big.png"), big);
    await writeFile(join(root, "nine.png"), nine);
    await expect(promptImages([{ path: "big.png" }], rooted(root))).rejects.toThrow("15 MB per-image");
    await expect(promptImages([{ path: "nine.png" }, { path: "nine.png" }], rooted(root))).rejects.toThrow(
      "images total more than 15 MB",
    );
    await writeFile(join(root, "two.png"), Buffer.concat([SIGNATURES.png, Buffer.alloc(2_000_000)]));
    const inline = Buffer.alloc(4_500_000).toString("base64");
    await expect(
      promptImages([{ path: "nine.png" }, { data: inline, mimeType: "image/png" }, { path: "two.png" }], rooted(root)),
    ).rejects.toThrow("images total more than 15 MB");
    expect((await promptImages([{ path: "nine.png" }, { url: "https://example.com/a.png" }], rooted(root)))?.count).toBe(2);
  });
});
