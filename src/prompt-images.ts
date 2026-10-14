/**
 * Image inputs for `prompt.images` on agent creation and follow-up.
 *
 * Cursor accepts up to 5 images per prompt, each either a URL Cursor fetches or
 * inline base64 bytes (max 15 MB), and an optional pixel `dimension`. The MCP
 * stdio transport buffers at most 10 MiB per message, so inline bytes are capped
 * well below that for the whole call. A `path` image is read here from the
 * trusted folder and sent inline, so its bytes never cross the stdio message.
 * Every check, and every file read, runs before any network I/O.
 *
 * Image bytes, URLs and paths may be private or signed, so nothing here echoes
 * them: errors name only the entry index and the rule that failed.
 */

import { z } from "zod";
import { extname } from "node:path";
import { PolicyError } from "./errors.js";
import { readTrustedFile, trustedRoot } from "./trusted-folder.js";

export const MAX_PROMPT_IMAGES = 5;
/** The API's per-image limit on decoded bytes, read as decimal megabytes. */
const MAX_IMAGE_BYTES = 15_000_000;
/** Decoded bytes per call across inline and path images; this server's limit. */
export const MAX_TOTAL_IMAGE_BYTES = 15_000_000;
/**
 * Decoded inline bytes per call. Base64 inflates this by a third, and the whole
 * JSON-RPC message (prompt included) must stay under the 10 MiB stdio buffer.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

const MIME_TYPE_MESSAGE = `mimeType must be one of ${IMAGE_MIME_TYPES.join(", ")}`;

const Dimension = z
  .object({
    width: z.number().int().min(1).describe("Width in pixels."),
    height: z.number().int().min(1).describe("Height in pixels."),
  })
  .strict()
  .optional()
  .describe("Pixel size of the image, when known.");

const UrlImage = z
  .object({
    url: z.string().min(1).describe("https URL Cursor fetches. No credentials in the URL."),
    dimension: Dimension,
  })
  .strict();

const DataImage = z
  .object({
    data: z
      .string()
      .min(1)
      .describe(
        "Standard base64 bytes (no data: prefix, no whitespace). All inline images in one call total at most 5 MiB decoded.",
      ),
    mimeType: z.enum(IMAGE_MIME_TYPES, { error: MIME_TYPE_MESSAGE }),
    dimension: Dimension,
  })
  .strict();

const PathImage = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Local png, jpeg, gif or webp file inside the folder the host started this server in (absolute, or relative to it). The extension must match the file's contents.",
      ),
    dimension: Dimension,
  })
  .strict();

export const PromptImagesInput = z
  .array(
    z.union([UrlImage, DataImage, PathImage], {
      // A union reports only "Invalid input", hiding the branch's own message.
      // Surface the allowed types only when a bad mimeType is the sole problem:
      // the same object with a valid type must pass the inline-image schema.
      error: (issue) => {
        if (issue.code !== "invalid_union") return undefined;
        const input = issue.input as { mimeType?: unknown } | null;
        return typeof input?.mimeType === "string" &&
          DataImage.safeParse({ ...input, mimeType: IMAGE_MIME_TYPES[0] }).success
          ? MIME_TYPE_MESSAGE
          : undefined;
      },
    }),
  )
  .max(MAX_PROMPT_IMAGES)
  .optional()
  .describe(
    "Up to 5 images for the prompt: each `{url}` (https), `{data, mimeType}` (png, jpeg, gif, webp), or `{path}` for a local screenshot. The whole tool call, prompt included, must stay under the MCP stdio 10 MiB message limit. The result reports only a count.",
  );

export type PromptImageInput =
  | z.infer<typeof UrlImage>
  | z.infer<typeof DataImage>
  | z.infer<typeof PathImage>;

type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

const EXTENSION_TYPES: Record<string, ImageMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * The format named by a file's leading bytes. This catches a wrong path, such as
 * a text or config file; it does not prove the file is a well-formed image.
 */
function sniffType(bytes: Buffer): ImageMimeType | undefined {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

async function readPathImage(
  where: string,
  path: string,
  root: string | undefined,
  remaining: number,
): Promise<{ data: string; mimeType: ImageMimeType; bytes: number }> {
  if (root === undefined) {
    throw new PolicyError(
      `${where}.path is unavailable: this server was started in the home directory or a filesystem root, not a trusted folder`,
    );
  }
  const expected = EXTENSION_TYPES[extname(path).toLowerCase()];
  if (expected === undefined) {
    throw new PolicyError(`${where}.path must end in .png, .jpg, .jpeg, .gif or .webp`);
  }
  const limit = Math.min(MAX_IMAGE_BYTES, remaining);
  let read;
  try {
    read = await readTrustedFile(root, path, limit);
  } catch {
    // Filesystem errors quote the path; report the index only.
    throw new PolicyError(`${where}.path could not be read`);
  }
  switch (read.kind) {
    case "absent":
      throw new PolicyError(`${where}.path does not exist`);
    case "outside":
      throw new PolicyError(`${where}.path is outside the folder this server was started in`);
    case "notFile":
      throw new PolicyError(`${where}.path is not a regular file`);
    case "tooLarge":
      throw new PolicyError(
        limit < MAX_IMAGE_BYTES
          ? `images total more than ${MAX_TOTAL_IMAGE_BYTES / 1_000_000} MB decoded`
          : `${where}.path exceeds the 15 MB per-image limit`,
      );
    case "ok":
      break;
  }
  if (sniffType(read.bytes) !== expected) {
    throw new PolicyError(`${where}.path contents do not match its ${extname(path).toLowerCase()} extension`);
  }
  return { data: read.bytes.toString("base64"), mimeType: expected, bytes: read.bytes.length };
}

type WireImage = Record<string, unknown>;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded size of canonical base64, or undefined when it is not canonical. */
function decodedBytes(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

export const IMAGE_PLACEHOLDER = "[image]";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove every submitted image URL and data string from a string. Upstream
 * errors can quote the request, and `summarize` may truncate the quote, so a URL
 * is also matched from its origin to the end of the token and base64 data as any
 * long base64-looking run; a truncated quote of data is matched from its first 16 characters.
 */
function scrubText(text: string, wire: readonly WireImage[]): string {
  let out = text;
  for (const image of wire) {
    if (typeof image.url === "string") {
      out = out.split(image.url).join(IMAGE_PLACEHOLDER);
      try {
        const origin = new URL(image.url).origin;
        // `)` and `]` are valid URL characters, so only whitespace, quotes and angle
        // brackets end the token; over-scrubbing a trailing delimiter is harmless.
        out = out.replace(new RegExp(`${escapeRegExp(origin)}[^\\s"'<>]*`, "gi"), IMAGE_PLACEHOLDER);
      } catch {
        // Validated earlier; nothing further to match.
      }
    }
    if (typeof image.data === "string") {
      out = out.split(image.data).join(IMAGE_PLACEHOLDER);
      // A truncated quote keeps the start of the data.
      out = out.replace(
        new RegExp(`${escapeRegExp(image.data.slice(0, 16))}[A-Za-z0-9+/_=-]*`, "g"),
        IMAGE_PLACEHOLDER,
      );
    }
  }
  return wire.some((image) => typeof image.data === "string")
    ? out.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, IMAGE_PLACEHOLDER)
    : out;
}

function scrubError(error: unknown, wire: readonly WireImage[], depth = 0): void {
  if (!(error instanceof Error) || depth > 3) return;
  error.message = scrubText(error.message, wire);
  if (error.stack !== undefined) error.stack = scrubText(error.stack, wire);
  scrubError(error.cause, wire, depth + 1);
}

/**
 * Validate and map tool images to the `prompt.images` wire shape, reading any
 * `path` images. Returns undefined for an absent or empty list, so the request
 * body is unchanged. `shield` runs the request and scrubs the images from any
 * error it throws, in place so the error keeps its type and fields.
 */
export async function promptImages(
  images: readonly PromptImageInput[] | undefined,
  root: () => Promise<string | undefined> = () => trustedRoot(),
): Promise<
  | { wire: WireImage[]; count: number; shield: <T>(call: () => Promise<T>) => Promise<T> }
  | undefined
> {
  if (images === undefined || images.length === 0) return undefined;
  if (images.length > MAX_PROMPT_IMAGES) {
    throw new PolicyError(`images accepts at most ${MAX_PROMPT_IMAGES} entries`);
  }
  let inline = 0;
  let total = 0;
  const wire: WireImage[] = [];
  for (const [index, image] of images.entries()) {
    const where = `images[${index}]`;
    const dimension = image.dimension === undefined ? {} : { dimension: image.dimension };
    if ("url" in image) {
      let parsed: URL;
      try {
        parsed = new URL(image.url);
      } catch {
        throw new PolicyError(`${where}.url is not a valid absolute URL`);
      }
      if (parsed.protocol !== "https:") {
        throw new PolicyError(`${where}.url must use https`);
      }
      if (parsed.username !== "" || parsed.password !== "") {
        throw new PolicyError(`${where}.url must not contain credentials`);
      }
      wire.push({ url: image.url, ...dimension });
      continue;
    }
    if ("path" in image) {
      const read = await readPathImage(where, image.path, await root(), MAX_TOTAL_IMAGE_BYTES - total);
      total += read.bytes;
      wire.push({ data: read.data, mimeType: read.mimeType, ...dimension });
      continue;
    }
    const bytes = decodedBytes(image.data);
    if (bytes === undefined) {
      throw new PolicyError(
        `${where}.data must be standard base64 without a data: prefix or whitespace`,
      );
    }
    if (bytes > MAX_IMAGE_BYTES) {
      throw new PolicyError(`${where}.data exceeds the 15 MB per-image limit`);
    }
    inline += bytes;
    if (inline > MAX_INLINE_IMAGE_BYTES) {
      throw new PolicyError(
        `inline images total more than ${MAX_INLINE_IMAGE_BYTES / (1024 * 1024)} MiB decoded; pass larger images by path or https url`,
      );
    }
    total += bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) {
      throw new PolicyError(`images total more than ${MAX_TOTAL_IMAGE_BYTES / 1_000_000} MB decoded`);
    }
    wire.push({ data: image.data, mimeType: image.mimeType, ...dimension });
  }
  return {
    wire,
    count: wire.length,
    shield: async (call) => {
      try {
        return await call();
      } catch (error) {
        scrubError(error, wire);
        throw error;
      }
    },
  };
}
