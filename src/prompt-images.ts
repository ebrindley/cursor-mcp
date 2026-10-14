/**
 * Image inputs for `prompt.images` on agent creation and follow-up.
 *
 * Cursor accepts up to 5 images per prompt, each either a URL Cursor fetches or
 * inline base64 bytes (max 15 MB), and an optional pixel `dimension`. The MCP
 * stdio transport buffers at most 10 MiB per message, so inline bytes are capped
 * well below that for the whole call. Every check runs before any network I/O.
 *
 * Image bytes and URLs may be private or signed, so nothing here echoes them:
 * errors name only the entry index and the rule that failed.
 */

import { z } from "zod";
import { PolicyError } from "./errors.js";

export const MAX_PROMPT_IMAGES = 5;
/** The API's per-image limit on decoded bytes. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/**
 * Decoded inline bytes per call. Base64 inflates this by a third, and the whole
 * JSON-RPC message (prompt included) must stay under the 10 MiB stdio buffer.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

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
    mimeType: z.enum(IMAGE_MIME_TYPES),
    dimension: Dimension,
  })
  .strict();

export const PromptImagesInput = z
  .array(z.union([UrlImage, DataImage]))
  .max(MAX_PROMPT_IMAGES)
  .optional()
  .describe(
    "Up to 5 images for the prompt: each `{url}` (https) or `{data, mimeType}` (png, jpeg, gif, webp). The whole tool call, prompt included, must stay under the MCP stdio 10 MiB message limit. The result reports only a count.",
  );

export type PromptImageInput = z.infer<typeof UrlImage> | z.infer<typeof DataImage>;

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
 * Validate and map tool images to the `prompt.images` wire shape. Returns
 * undefined for an absent or empty list, so the request body is unchanged.
 * `shield` runs the request and scrubs the images from any error it throws, in
 * place so the error keeps its type and fields.
 */
export function promptImages(
  images: readonly PromptImageInput[] | undefined,
):
  | { wire: WireImage[]; count: number; shield: <T>(call: () => Promise<T>) => Promise<T> }
  | undefined {
  if (images === undefined || images.length === 0) return undefined;
  if (images.length > MAX_PROMPT_IMAGES) {
    throw new PolicyError(`images accepts at most ${MAX_PROMPT_IMAGES} entries`);
  }
  let inline = 0;
  const wire = images.map((image, index): WireImage => {
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
      return { url: image.url, ...dimension };
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
        `inline images total more than ${MAX_INLINE_IMAGE_BYTES / (1024 * 1024)} MiB decoded; pass larger images by https url`,
      );
    }
    return { data: image.data, mimeType: image.mimeType, ...dimension };
  });
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
