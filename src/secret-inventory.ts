/**
 * Secret-name inventory: the read-only half of Cursor's secrets API.
 *
 * Only names and metadata cross this module. The published responses carry no
 * value, and the projection below is an allowlist, so a value-like field Cursor
 * adds later is dropped before it exists in our types. `redactSecretFields` still
 * runs over the finished projection as a second, fail-closed layer.
 *
 * Output keys are chosen so that layer keeps the inventory itself:
 * `SECRET_VALUE_KEY` strips keys such as `secrets`, `env`, and `value`, so the
 * list is `inventory.items`, and each item uses `name`, `type`, `versionId`,
 * `repos`, `createdAt`, and `owner`.
 */

import { z } from "zod";
import { CursorCancelledError, currentRequestScope, seg, type CursorClient } from "./client.js";
import { CursorTransportError } from "./errors.js";
import { structuredCost } from "./tools/result.js";
import { redactSecretFields } from "./workspace-controls.js";

export type SecretInventoryScope = "environment" | "team" | "account";

export interface SecretOwner {
  /** `team`, `user`, or `environment`; an unknown future kind passes through. */
  kind: string;
  environmentPublicId?: string;
  /** Only present for a personal owner, and only on account-wide listings. */
  userEmail?: string | null;
}

export interface SecretEntry {
  name: string;
  type: string;
  versionId?: string;
  repos: string[];
  createdAt?: string;
  owner: SecretOwner;
}

export type SecretInventoryStop =
  | "page_cap"
  | "time_budget"
  | "size_budget"
  | "cursor_repeat"
  | "interrupted";

export interface SecretInventory {
  scope: SecretInventoryScope;
  environmentPublicId?: string;
  items: SecretEntry[];
  returned: number;
  pages: number;
  /** True only when Cursor reported a null cursor, so nothing further exists. */
  complete: boolean;
  /** True when the read began at a caller-supplied cursor, so earlier pages are absent. */
  resumed: boolean;
  nextCursor?: string;
  stoppedBecause?: SecretInventoryStop;
  /**
   * Versions on the first page that did not fit the size budget and cannot be
   * fetched again: Cursor's cursor is opaque, so a page cannot be resumed
   * partway. Only ever set when the very first page alone is over budget.
   */
  omitted?: number;
}

/**
 * Loose on purpose: an unknown field is ignored by the projection, never
 * rejected, and never copied.
 */
const SecretVersionSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string(),
  type: z.string(),
  repos: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
});

const OwnerSchema = z.looseObject({
  type: z.string(),
  environmentId: z.string().optional(),
  user: z.looseObject({ email: z.string().nullable().optional() }).optional(),
});

const InventoryVersionSchema = SecretVersionSchema.extend({ owner: OwnerSchema });

/** Required: only an explicit null proves the list ended. */
const cursorField = z.string().min(1).nullable();

const ScopedListSchema = z.looseObject({
  items: z.array(SecretVersionSchema),
  nextCursor: cursorField,
});

const AccountListSchema = z.looseObject({
  items: z.array(InventoryVersionSchema),
  nextCursor: cursorField,
});

/** A hard ceiling on pages per call. A caller continues with `nextCursor`. */
export const MAX_SECRET_PAGES = 20;
/** Items per page requested from `GET /v1/secrets`; below the API maximum so one page stays well inside the size budget. */
const PAGE_LIMIT = 50;
/** Do not start another page with less than this much of the wait budget left. */
export const MIN_PAGE_BUDGET_MS = 5_000;

/** Raised when not even an empty inventory fits the caller's size budget. */
export class SecretInventoryTooLargeError extends Error {
  constructor() {
    super("the size budget cannot hold even an empty secret inventory result");
    this.name = "SecretInventoryTooLargeError";
  }
}

/**
 * The simplest size rule: the candidate's own serialized cost fits `maxBytes`.
 * A caller that knows the surrounding result supplies its own `fits` instead.
 */
export function bytesFit(maxBytes: number): (candidate: SecretInventory) => boolean {
  return (candidate) => structuredCost(candidate) <= maxBytes;
}

function projectOwner(owner: z.infer<typeof OwnerSchema>): SecretOwner {
  return {
    kind: owner.type,
    ...(owner.environmentId === undefined ? {} : { environmentPublicId: owner.environmentId }),
    ...(owner.user === undefined ? {} : { userEmail: owner.user.email ?? null }),
  };
}

function projectVersion(
  version: z.infer<typeof SecretVersionSchema>,
  owner: SecretOwner,
): SecretEntry {
  return {
    name: version.name,
    type: version.type,
    ...(version.id === undefined ? {} : { versionId: version.id }),
    repos: [...version.repos],
    ...(version.createdAt === undefined ? {} : { createdAt: version.createdAt }),
    owner,
  };
}

export interface SecretInventoryRequest {
  scope: SecretInventoryScope;
  /** Resolved, profile-checked environment id; required for `environment`. */
  environmentPublicId?: string;
  /** Continue from a `nextCursor` an earlier call returned. */
  cursor?: string;
}

export interface SecretInventoryLimits {
  maxPages?: number;
  /**
   * Whether a candidate inventory fits the response, judged on the whole
   * result it will be part of. A candidate with `complete: false` and no
   * `stoppedBecause` is provisional: the read may still stop for any reason, so
   * the judge must allow for every one. A page that does not fit is left out
   * whole and fetched again by the returned cursor.
   */
  fits: (candidate: SecretInventory) => boolean;
  /** Milliseconds left in the wait budget; undefined means unbounded. */
  remainingMs?: () => number | undefined;
}

function defaultRemaining(): number | undefined {
  return currentRequestScope()?.remainingMs();
}

/**
 * Read the inventory, following `nextCursor` until it is null.
 *
 * An empty page with a cursor is a page: only an explicit null cursor ends the
 * list. A missing or empty cursor fails the response schema and surfaces as a
 * contract error. The read stops early at a page boundary, never mid-page, and
 * says why, so a returned `nextCursor` resumes without losing a version. The
 * one exception is a first page that alone exceeds the size budget: it is
 * returned as a prefix with `omitted` counting what did not fit. When not even
 * an empty inventory fits, it throws `SecretInventoryTooLargeError`.
 */
export async function readSecretInventory(
  client: Pick<CursorClient, "get">,
  request: SecretInventoryRequest,
  limits: SecretInventoryLimits,
): Promise<SecretInventory> {
  const maxPages = Math.min(limits.maxPages ?? MAX_SECRET_PAGES, MAX_SECRET_PAGES);
  const remaining = limits.remainingMs ?? defaultRemaining;
  const items: SecretEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = request.cursor;
  let pages = 0;
  let stoppedBecause: SecretInventoryStop | undefined;
  if (cursor !== undefined) seen.add(cursor);

  const path =
    request.scope === "team"
      ? "/v1/team/secrets"
      : request.scope === "account"
        ? "/v1/secrets"
        : `/v1/environments/${seg(request.environmentPublicId ?? "")}/secrets`;
  if (request.scope === "environment" && !request.environmentPublicId) {
    throw new RangeError("environment scope needs an environment id");
  }

  let omitted = 0;
  const resumed = request.cursor !== undefined;
  const snapshot = (
    list: SecretEntry[],
    pageCount: number,
    extra: Partial<SecretInventory>,
  ): SecretInventory => ({
    scope: request.scope,
    ...(request.environmentPublicId === undefined
      ? {}
      : { environmentPublicId: request.environmentPublicId }),
    items: list,
    returned: list.length,
    pages: pageCount,
    complete: false,
    resumed,
    ...extra,
  });

  for (;;) {
    if (pages >= maxPages) {
      stoppedBecause = "page_cap";
      break;
    }
    if (pages > 0) {
      const left = remaining();
      if (left !== undefined && left < MIN_PAGE_BUDGET_MS) {
        stoppedBecause = "time_budget";
        break;
      }
    }
    const fetchedWith = cursor;
    const query = {
      ...(request.scope === "account" ? { limit: PAGE_LIMIT } : {}),
      ...(fetchedWith === undefined ? {} : { cursor: fetchedWith }),
    };
    let next: string | null;
    let page: SecretEntry[];
    try {
      if (request.scope === "account") {
        const listed = await client.get(path, AccountListSchema, { query });
        page = listed.items.map((version) => projectVersion(version, projectOwner(version.owner)));
        next = listed.nextCursor;
      } else {
        const owner: SecretOwner =
          request.scope === "team"
            ? { kind: "team" }
            : { kind: "environment", environmentPublicId: request.environmentPublicId ?? "" };
        const listed = await client.get(path, ScopedListSchema, { query });
        page = listed.items.map((version) => projectVersion(version, owner));
        next = listed.nextCursor;
      }
    } catch (error) {
      // A later page that times out does not erase the pages already read.
      if (
        pages > 0 &&
        error instanceof CursorTransportError &&
        !(error instanceof CursorCancelledError)
      ) {
        stoppedBecause = "interrupted";
        break;
      }
      throw error;
    }

    // Every page is checked, the last one included, before any of it is kept.
    const wholePage = snapshot([...items, ...page], pages + 1, {
      ...(next === null ? { complete: true } : { nextCursor: next }),
    });
    if (!limits.fits(wholePage)) {
      stoppedBecause = "size_budget";
      if (items.length > 0) {
        // Leave this page out whole; the same cursor fetches it again.
        cursor = fetchedWith;
        break;
      }
      // Nothing is kept yet, so refetching would hit the same wall. Return the
      // largest prefix that fits and say how many versions are missing.
      const prefix = (kept: number) =>
        snapshot(page.slice(0, kept), pages + 1, {
          stoppedBecause: "size_budget",
          ...(kept === page.length ? {} : { omitted: page.length - kept }),
          ...(next === null ? {} : { nextCursor: next }),
        });
      if (page.length === 0 || !limits.fits(prefix(0))) throw new SecretInventoryTooLargeError();
      // Fitting is monotone in the prefix length, so bisect: O(log n) judgments
      // instead of one per item.
      let kept = 0;
      let high = page.length;
      while (kept < high) {
        const mid = Math.ceil((kept + high) / 2);
        if (limits.fits(prefix(mid))) kept = mid;
        else high = mid - 1;
      }
      items.push(...page.slice(0, kept));
      omitted = page.length - kept;
      pages += 1;
      cursor = next === null ? undefined : next;
      break;
    }
    items.push(...page);
    pages += 1;

    if (next === null) {
      cursor = undefined;
      break;
    }
    if (seen.has(next)) {
      // A cursor that repeats would loop forever; stop and keep it as the
      // continuation so the caller sees the same value Cursor sent.
      cursor = next;
      stoppedBecause = "cursor_repeat";
      break;
    }
    seen.add(next);
    cursor = next;
  }

  const inventory: SecretInventory = {
    scope: request.scope,
    ...(request.environmentPublicId === undefined
      ? {}
      : { environmentPublicId: request.environmentPublicId }),
    items,
    returned: items.length,
    pages,
    complete: stoppedBecause === undefined,
    resumed: request.cursor !== undefined,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
    ...(omitted === 0 ? {} : { omitted }),
  };
  return redactSecretFields(inventory);
}
