import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { QueryContinuationKey } from "../../queries/continuation-token";
import { openToken, sealToken } from "../../queries/sealed-token";
import { canonicalJson } from "../../definition/canonical-json";
import {
  placementTokenBinding,
  placementTokenBindingShape,
  placementTokenRefusal,
  type PlacementTokenExpectation,
} from "../records-selection-seal";

/**
 * The sealed row position of a pivot: the group key the next page continues after, bound to the
 * person, organisation, application, installed release, page and placement it was issued for and
 * to the exact query the pivot ran (its resolved inputs, search, filters and dimensions). It is
 * encrypted and authenticated, so the browser holds an opaque token it can neither read nor edit,
 * and it never continues a read under other filters or another person.
 */
const cursorSchema = z
  .object({
    version: z.literal(1),
    ...placementTokenBindingShape,
    query: z.string().length(64),
    groupKey: z.string().min(1).max(4096),
  })
  .strict();

/** A cursor stays usable for an hour; the pivot's next page seals a fresh one. */
const cursorLifetimeMilliseconds = 3_600_000;
const purpose = "vortex.records.pivot.cursor.v1";

/** What a cursor is bound to: who reads, where, and which query the pivot ran. */
export type PivotCursorBinding = PlacementTokenExpectation &
  Readonly<{
    /** The pivot's summary command without its row position: the resolved filters and state. */
    query: unknown;
  }>;

const queryFingerprint = (query: unknown): string =>
  createHash("sha256").update(canonicalJson(query)).digest("hex");

export const sealPivotCursor = (
  key: QueryContinuationKey,
  binding: PivotCursorBinding,
  groupKey: string,
  now: () => number = Date.now,
): string =>
  sealToken(
    key,
    purpose,
    cursorSchema.parse({
      version: 1,
      ...placementTokenBinding(binding, now),
      query: queryFingerprint(binding.query),
      groupKey,
    }),
  );

type PivotCursorOpening =
  | Readonly<{ kind: "opened"; groupKey: string }>
  /** The cursor is not usable for this read; `cause` names why, for the log only. */
  | Readonly<{ kind: "stale"; cause: string }>;

/**
 * Opens a sealed cursor for the read that now asks for it. Anything that is not exactly the read
 * it was issued for (another person, scope, release, page, placement or query, a tampered or old
 * token) is stale; the caller logs the cause and restarts the pivot at its first page.
 */
export const openPivotCursor = (
  token: string,
  key: QueryContinuationKey,
  binding: PivotCursorBinding,
  now: () => number = Date.now,
): PivotCursorOpening => {
  const opening = openToken(key, purpose, token);
  if (opening.kind === "refused") return { kind: "stale", cause: opening.cause };
  const parsed = cursorSchema.safeParse(opening.payload);
  if (!parsed.success) return { kind: "stale", cause: "payload_invalid" };
  const cause =
    placementTokenRefusal(parsed.data, binding, cursorLifetimeMilliseconds, now) ??
    (parsed.data.query === queryFingerprint(binding.query) ? undefined : "query_changed");
  return cause === undefined
    ? { kind: "opened", groupKey: parsed.data.groupKey }
    : { kind: "stale", cause };
};
