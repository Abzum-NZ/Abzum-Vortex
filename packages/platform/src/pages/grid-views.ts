import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { gridLayoutSchema, type GridLayout } from "./grid-view-state";

/**
 * The stored grid layouts of the current person. Each operation runs inside the caller's protected
 * request transaction; the database takes the person, organisation and application from the
 * validated request context, never from these arguments, so another account, organisation or
 * installation can neither read nor write a layout here.
 */

type ResultRow = DatabaseRow & { readonly result: unknown };

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idSchema = z.string().regex(ID_PATTERN);
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const storedRowsSchema = z
  .array(
    z
      .object({
        placementId: idSchema,
        queryId: idSchema,
        revision: revisionSchema,
        layout: z.unknown(),
      })
      .strict(),
  )
  .max(500);

const conflictSchema = z
  .object({
    outcome: z.literal("conflict"),
    revision: revisionSchema.nullable(),
    queryId: idSchema.nullable(),
    layout: z.unknown(),
  })
  .strict();

const writeResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), revision: revisionSchema }).strict(),
  conflictSchema,
]);
const resetResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("reset") }).strict(),
  conflictSchema,
]);

/** One stored layout. A row whose layout does not parse is refused: its layout is undefined. */
export type StoredGridView = Readonly<{
  placementId: string;
  queryId: string;
  revision: number;
  layout: GridLayout | undefined;
}>;

/** The layout another tab stored after this one read it, or null when none is stored now. */
export type GridViewConflict = Readonly<{
  outcome: "conflict";
  stored: StoredGridView | null;
}>;

export type GridViewWriteOutcome =
  Readonly<{ outcome: "saved"; revision: number }> | GridViewConflict;
export type GridViewResetOutcome = Readonly<{ outcome: "reset" }> | GridViewConflict;

const only = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("GRID_VIEW_RESULT_INVALID");
  return rows[0].result;
};

/** A stored layout as the platform wrote it; anything else is logged and refused, never converted. */
const storedLayout = (placementId: string, layout: unknown): GridLayout | undefined => {
  const parsed = gridLayoutSchema.safeParse(layout);
  if (parsed.success) return parsed.data;
  console.error(
    `[grid-views] stored layout refused code=GRID_LAYOUT_MALFORMED placement=${placementId.toLowerCase()}`,
  );
  return undefined;
};

const conflictOf = (
  result: z.infer<typeof conflictSchema>,
  placementId: string,
): GridViewConflict => ({
  outcome: "conflict",
  stored:
    result.revision === null || result.queryId === null
      ? null
      : {
          placementId: placementId.toLowerCase(),
          queryId: result.queryId.toLowerCase(),
          revision: result.revision,
          layout: storedLayout(placementId, result.layout),
        },
});

/**
 * Reads the person's current layouts of the named placements of one page in one call, keyed by
 * lower-cased placement identity. A placement without a stored layout has no entry.
 */
export const readGridViews = async (
  transaction: RequestDatabaseTransaction,
  pageId: string,
  placementIds: readonly string[],
): Promise<ReadonlyMap<string, StoredGridView>> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.read_grid_views(
      ${pageId}::uuid,
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(placementIds)}::text::jsonb)::uuid)
    ) as result
  `;
  const stored = storedRowsSchema.parse(only(rows));
  return new Map(
    stored.map((row) => [
      row.placementId.toLowerCase(),
      {
        placementId: row.placementId.toLowerCase(),
        queryId: row.queryId.toLowerCase(),
        revision: row.revision,
        layout: storedLayout(row.placementId, row.layout),
      },
    ]),
  );
};

/**
 * Stores the person's layout of one placement at the revision it was made from (null for a first
 * layout). A newer layout stored meanwhile, by another tab, is returned as the conflict.
 */
export const writeGridView = async (
  transaction: RequestDatabaseTransaction,
  write: Readonly<{
    pageId: string;
    placementId: string;
    queryId: string;
    expectedRevision: number | null;
    layout: GridLayout;
  }>,
): Promise<GridViewWriteOutcome> => {
  const layout = gridLayoutSchema.parse(write.layout);
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.write_grid_view(
      ${write.pageId}::uuid,
      ${write.placementId}::uuid,
      ${write.queryId}::uuid,
      ${write.expectedRevision}::bigint,
      ${JSON.stringify(layout)}::text::jsonb
    ) as result
  `;
  const result = writeResultSchema.parse(only(rows));
  return result.outcome === "saved" ? result : conflictOf(result, write.placementId);
};

/** Removes the person's layout of one placement at its revision, so the authored layout shows. */
export const resetGridView = async (
  transaction: RequestDatabaseTransaction,
  reset: Readonly<{ pageId: string; placementId: string; expectedRevision: number }>,
): Promise<GridViewResetOutcome> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.reset_grid_view(
      ${reset.pageId}::uuid,
      ${reset.placementId}::uuid,
      ${reset.expectedRevision}::bigint
    ) as result
  `;
  const result = resetResultSchema.parse(only(rows));
  return result.outcome === "reset" ? result : conflictOf(result, reset.placementId);
};
