import "server-only";

import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import {
  gridLayoutSchema,
  gridViewDocumentSchema,
  gridViewNameSchema,
  gridViewScopes,
  type AddressedGridView,
  type GridLayout,
  type GridViewDocument,
  type GridViewShareTargets,
  type GridViewSharing,
} from "./grid-view-state";
import {
  recordsTableContractOrLog,
  type RecordsTableContract,
} from "../definition/application-composition/records-display";
import {
  conditionalFormatFactsOf,
  conditionalFormatRuleFields,
  conditionalFormatRuleIssue,
} from "../definition/application-composition/records-table-features/conditional-formatting";
import type { ModuleField } from "../definition/module-contracts";
import { placementSettings } from "../definition/application-composition-catalogue";
import { walkPageComposition } from "./placement-walk";
import type { PageDefinition } from "../definition/application-contracts";

/**
 * The stored grid layouts and named views of the current person. Each operation runs inside the
 * caller's protected request transaction; the database takes the person, organisation and
 * application from the validated request context, never from these arguments, so another
 * account, organisation or installation can neither read nor write a layout or a view here.
 * Sharing is decided in the database against the person's live access, never by this module.
 */

type ResultRow = DatabaseRow & { readonly result: unknown };

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idSchema = z.string().regex(ID_PATTERN);
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const storedLayoutRowsSchema = z
  .array(
    z
      .object({
        placementId: idSchema,
        queryId: idSchema,
        revision: revisionSchema,
        basedOnViewId: idSchema.nullable(),
        layout: z.unknown(),
      })
      .strict(),
  )
  .max(500);

const storedViewRowsSchema = z
  .array(
    z
      .object({
        viewId: idSchema,
        placementId: idSchema,
        queryId: idSchema,
        name: gridViewNameSchema,
        scope: z.enum(gridViewScopes),
        mine: z.boolean(),
        personalDefault: z.boolean(),
        revision: revisionSchema,
        shareOrganization: z.boolean(),
        shareRoleIds: z.array(idSchema),
        shareGroupIds: z.array(idSchema),
        document: z.unknown().optional(),
        hiddenFilters: z.number().int().min(0).optional(),
        hiddenSorts: z.number().int().min(0).optional(),
        hiddenFormatting: z.number().int().min(0).optional(),
      })
      .strict(),
  )
  .max(500);

const storedReadSchema = z
  .object({
    visibleFields: z.record(idSchema, z.array(idSchema)),
    defaultDocuments: z
      .array(
        z
          .object({
            viewId: idSchema,
            document: z.unknown(),
            hiddenFilters: z.number().int().min(0),
            hiddenSorts: z.number().int().min(0),
            hiddenFormatting: z.number().int().min(0),
          })
          .strict(),
      )
      .max(10_000),
    roleKeys: z.array(z.string()),
    shareablePlacementIds: z.array(idSchema).max(500),
    layouts: storedLayoutRowsSchema,
    views: storedViewRowsSchema,
  })
  .strict();

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

/** One stored current layout, validated against the platform's storage contract. */
export type StoredGridView = Readonly<{
  placementId: string;
  queryId: string;
  revision: number;
  /** The named view this layout was arranged from, when it was. */
  basedOnViewId: string | null;
  layout: GridLayout;
}>;

/** One named view the person may see, with its document only when the address selected it. */
export type StoredNamedGridView = Readonly<{
  viewId: string;
  placementId: string;
  queryId: string;
  name: string;
  scope: (typeof gridViewScopes)[number];
  mine: boolean;
  personalDefault: boolean;
  revision: number;
  sharing: GridViewSharing;
  document: GridViewDocument | undefined;
  hiddenFilters: number;
  hiddenSorts: number;
  hiddenFormatting: number;
}>;

/** The page's current layouts and selected named views, keyed by placement. */
export type StoredGridViews = Readonly<{
  /** The columns the person may read, by access route, per requested record type (lower-cased). */
  readable: ReadonlyMap<string, ReadonlySet<string>>;
  /** Selected/automatic authored documents narrowed by the same bounds as stored shared views. */
  defaultDocuments: ReadonlyMap<
    string,
    Readonly<{
      document: GridViewDocument;
      hiddenFilters: number;
      hiddenSorts: number;
      hiddenFormatting: number;
    }>
  >;
  roleKeys: ReadonlySet<string>;
  /** The placements (lower-cased) whose tables name a share permission the person holds now. */
  shareable: ReadonlySet<string>;
  layouts: ReadonlyMap<string, StoredGridView>;
  views: ReadonlyMap<string, readonly StoredNamedGridView[]>;
}>;

/** The layout another tab stored after this one read it, or null when none is stored now. */
export type GridViewConflict = Readonly<{
  outcome: "conflict";
  stored: Readonly<{
    revision: number;
    queryId: string;
    layout: GridLayout;
  }> | null;
}>;

export type GridViewWriteOutcome =
  Readonly<{ outcome: "saved"; revision: number }> | GridViewConflict;
export type GridViewResetOutcome = Readonly<{ outcome: "reset" }> | GridViewConflict;

const only = (rows: readonly ResultRow[]): unknown => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("GRID_VIEW_RESULT_INVALID");
  return rows[0].result;
};

/** A stored layout or view as the platform wrote it; anything else is logged and refused. */
const stored = <Parsed>(
  kind: string,
  subject: string,
  schema: z.ZodType<Parsed>,
  value: unknown,
): Parsed => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.error(
    `[grid-views] stored ${kind} refused code=GRID_VIEW_MALFORMED subject=${subject.toLowerCase()}`,
    parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
  );
  throw new Error("GRID_VIEW_MALFORMED", { cause: parsed.error });
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
          revision: result.revision,
          queryId: result.queryId.toLowerCase(),
          layout: stored("layout", placementId, gridLayoutSchema, result.layout),
        },
});

const namedViews = (rows: z.infer<typeof storedViewRowsSchema>) => {
  const views = new Map<string, StoredNamedGridView[]>();
  for (const row of rows) {
    const placementId = row.placementId.toLowerCase();
    const named: StoredNamedGridView = {
      viewId: row.viewId.toLowerCase(),
      placementId,
      queryId: row.queryId.toLowerCase(),
      name: row.name,
      scope: row.scope,
      mine: row.mine,
      personalDefault: row.personalDefault,
      revision: row.revision,
      sharing: {
        organization: row.shareOrganization,
        roleIds: row.shareRoleIds.map((id) => id.toLowerCase()),
        groupIds: row.shareGroupIds.map((id) => id.toLowerCase()),
      },
      hiddenFilters: row.hiddenFilters ?? 0,
      hiddenSorts: row.hiddenSorts ?? 0,
      hiddenFormatting: row.hiddenFormatting ?? 0,
      document:
        row.document === undefined
          ? undefined
          : stored("view", row.viewId, gridViewDocumentSchema, row.document),
    };
    views.set(placementId, [...(views.get(placementId) ?? []), named]);
  }
  return views;
};

/** Fresh picker inventory for one placement; authorization is evaluated inside this request. */
export const listGridViews = async (
  transaction: RequestDatabaseTransaction,
  pageId: string,
  placementId: string,
) => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.list_grid_views(${pageId}::uuid, ${placementId}::uuid) as result
  `;
  const read = stored(
    "list",
    placementId,
    z
      .object({
        roleKeys: z.array(z.string()),
        canShare: z.boolean(),
        views: storedViewRowsSchema.max(200),
      })
      .strict(),
    only(rows),
  );
  return {
    roleKeys: new Set(read.roleKeys),
    canShare: read.canShare,
    views: namedViews(read.views).get(placementId.toLowerCase()) ?? [],
  };
};

/**
 * Reads the person's current layouts and selected named views for the named placements of
 * one page in one call, keyed by lower-cased placement identity. Only the views named in
 * `selectedViewIds` (the page address) carry their document. The database checks the fixed platform
 * sharing permission for the current person.
 */
export const readGridViews = async (
  transaction: RequestDatabaseTransaction,
  pageId: string,
  placementIds: readonly string[],
  selectedViewIds: readonly string[],
  recordTypeIds: readonly string[],
  defaultViews: readonly Readonly<{
    viewId: string;
    placementId: string;
    role: string;
    isDefault: boolean;
    selectedViewId: string | null;
    queryId: string;
    document: GridViewDocument;
  }>[] = [],
): Promise<StoredGridViews> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.read_grid_views(
      ${pageId}::uuid,
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(placementIds)}::text::jsonb)::uuid),
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(selectedViewIds)}::text::jsonb)::uuid),
      ${JSON.stringify(defaultViews)}::text::jsonb,
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(recordTypeIds)}::text::jsonb)::uuid)
    ) as result
  `;
  const read = stored("read", pageId, storedReadSchema, only(rows));
  const views = namedViews(read.views);
  return {
    readable: new Map(
      Object.entries(read.visibleFields).map(([recordTypeId, ids]) => [
        recordTypeId.toLowerCase(),
        new Set(ids.map((id) => id.toLowerCase())),
      ]),
    ),
    defaultDocuments: new Map(
      read.defaultDocuments.map((row) => [
        row.viewId.toLowerCase(),
        {
          document: stored("default view", row.viewId, gridViewDocumentSchema, row.document),
          hiddenFilters: row.hiddenFilters,
          hiddenSorts: row.hiddenSorts,
          hiddenFormatting: row.hiddenFormatting,
        },
      ]),
    ),
    roleKeys: new Set(read.roleKeys),
    shareable: new Set(read.shareablePlacementIds.map((id) => id.toLowerCase())),
    layouts: new Map(
      read.layouts.map((row) => [
        row.placementId.toLowerCase(),
        {
          placementId: row.placementId.toLowerCase(),
          queryId: row.queryId.toLowerCase(),
          revision: row.revision,
          basedOnViewId: row.basedOnViewId?.toLowerCase() ?? null,
          layout: stored("layout", row.placementId, gridLayoutSchema, row.layout),
        },
      ]),
    ),
    views,
  };
};

/** The listed view the address selected, with its document, in the form the resolver takes. */
export const addressedGridView = (
  views: readonly StoredNamedGridView[] | undefined,
  queryId: string,
  viewId: string | undefined,
  canShare: boolean,
): AddressedGridView | undefined => {
  const view = views?.find(
    (candidate) =>
      candidate.viewId === viewId?.toLowerCase() &&
      candidate.queryId === queryId.toLowerCase() &&
      candidate.document !== undefined,
  );
  if (view?.document === undefined) return undefined;
  return {
    item: {
      viewId: view.viewId,
      name: view.name,
      scope: view.scope,
      mine: view.mine,
      personalDefault: view.personalDefault,
      revision: view.revision,
    },
    document: view.document,
    hiddenFilters: view.hiddenFilters,
    hiddenSorts: view.hiddenSorts,
    hiddenFormatting: view.hiddenFormatting,
    sharing: view.mine || canShare ? view.sharing : null,
  };
};

/**
 * The query a grid placement reads, read
 * from the installed page; undefined when the page has no such grid with Saved views on. Every
 * view operation takes it from here, never from the request.
 */
export const gridViewPlacement = (
  page: PageDefinition,
  placementId: string,
): Readonly<{ queryId: string; contract: RecordsTableContract }> | undefined => {
  let found: Readonly<{ queryId: string; contract: RecordsTableContract }> | undefined;
  walkPageComposition(page.composition, (placement) => {
    if (placement.placementId.toLowerCase() !== placementId.toLowerCase()) return;
    const contract = recordsTableContractOrLog(placementSettings(placement.props), "grid views");
    if (
      contract === undefined ||
      !contract.features.savedViews.enabled ||
      typeof placement.vortex.queryId !== "string"
    )
      return;
    found = {
      queryId: placement.vortex.queryId.toLowerCase(),
      contract,
    };
  });
  return found;
};

/**
 * The placement's authored default views when a layout with these columns fits it (the named
 * query and only its declared columns), or undefined when it does not.
 */
const placementForLayout = (
  page: PageDefinition,
  placementId: string,
  queryId: string,
  fieldIds: readonly string[],
): readonly string[] | undefined => {
  let defaultViewIds: readonly string[] | undefined;
  walkPageComposition(page.composition, (placement) => {
    if (placement.placementId.toLowerCase() !== placementId.toLowerCase()) return;
    const contract = recordsTableContractOrLog(placementSettings(placement.props), "grid views");
    if (
      contract === undefined ||
      typeof placement.vortex.queryId !== "string" ||
      placement.vortex.queryId.toLowerCase() !== queryId.toLowerCase()
    )
      return;
    const fields = new Set(contract.columns.map((column) => column.field.toLowerCase()));
    if (!fieldIds.every((fieldId) => fields.has(fieldId))) return;
    defaultViewIds = contract.features.savedViews.enabled
      ? contract.features.savedViews.defaultViews.map((view) => view.viewId.toLowerCase())
      : [];
  });
  return defaultViewIds;
};

/**
 * Stores the person's layout of one placement at the revision it was made from (null for a first
 * layout), noting the view it was arranged from. A newer layout stored meanwhile, by another tab,
 * is returned as the conflict.
 */
export const writeGridView = async (
  transaction: RequestDatabaseTransaction,
  write: Readonly<{
    page: PageDefinition;
    placementId: string;
    queryId: string;
    expectedRevision: number | null;
    basedOnViewId: string | null;
    layout: GridLayout;
  }>,
): Promise<GridViewWriteOutcome> => {
  const layout = gridLayoutSchema.parse(write.layout);
  // The page is resolved from the installed release by the server. A forged client cannot
  // invent a placement, switch its query or persist undeclared columns.
  const defaultViewIds = placementForLayout(
    write.page,
    write.placementId,
    write.queryId,
    layout.columns.map((column) => column.fieldId),
  );
  if (defaultViewIds === undefined) throw new Error("GRID_LAYOUT_PLACEMENT_INVALID");
  // A layout arranged from an authored default view notes that view; one arranged from a saved
  // view notes the saved view.
  const fromDefault =
    write.basedOnViewId !== null && defaultViewIds.includes(write.basedOnViewId.toLowerCase());
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.write_grid_view(
      ${write.page.pageId}::uuid,
      ${write.placementId}::uuid,
      ${write.queryId}::uuid,
      ${write.expectedRevision}::bigint,
      ${fromDefault ? null : write.basedOnViewId}::uuid,
      ${fromDefault ? write.basedOnViewId : null}::uuid,
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

const viewResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), viewId: idSchema, revision: revisionSchema }).strict(),
  z.object({ outcome: z.literal("deleted") }).strict(),
  z
    .object({
      outcome: z.literal("conflict"),
      revision: revisionSchema,
      name: z.string(),
      queryId: idSchema,
    })
    .strict(),
  z.object({ outcome: z.enum(["not_found", "forbidden", "limit", "target_unknown"]) }).strict(),
  z
    .object({
      outcome: z.literal("formatting_refused"),
      cause: z.enum(["field_not_readable", "rule_invalid"]),
    })
    .strict(),
]);

/** What a view operation came to; every refusal is a closed outcome, never a database message. */
export type GridViewOperationOutcome =
  | Readonly<{ outcome: "saved"; viewId: string; revision: number }>
  | Readonly<{ outcome: "deleted" }>
  | Readonly<{ outcome: "conflict" }>
  | Readonly<{ outcome: "not_found" | "forbidden" | "limit" | "target_unknown" }>
  /** A personal rule is not allowed here, reads a field the person cannot read, or does not fit. */
  | Readonly<{ outcome: "formatting_refused"; reason: string }>;

const viewOutcome = (rows: readonly ResultRow[]): GridViewOperationOutcome => {
  const result = viewResultSchema.parse(only(rows));
  if (result.outcome === "saved")
    return { outcome: "saved", viewId: result.viewId.toLowerCase(), revision: result.revision };
  if (result.outcome === "formatting_refused")
    return refuseFormatting(
      "database",
      result.cause,
      result.cause === "field_not_readable"
        ? "A rule reads a field you cannot read."
        : "A rule compares a field in a way its type does not allow.",
    );
  return result.outcome === "conflict" ? { outcome: "conflict" } : result;
};

const refuseFormatting = (
  placementId: string,
  cause: string,
  reason: string,
): GridViewOperationOutcome => {
  console.error(
    `[grid-views] save refused code=GRID_VIEW_FORMATTING_REFUSED placement=${placementId.toLowerCase()} cause=${cause}`,
  );
  return { outcome: "formatting_refused", reason };
};

/**
 * Creates a personal view (no `viewId`), or renames and/or replaces the document of one at its
 * revision. Only its owner, or someone who holds the share permission, may change a view; the
 * database decides that now, for the person of this request.
 */
export const saveGridView = async (
  transaction: RequestDatabaseTransaction,
  save: Readonly<{
    page: PageDefinition;
    placementId: string;
    queryId: string;
    viewId: string | null;
    expectedRevision: number | null;
    name: string | null;
    document: GridViewDocument | null;
    /** The bound record type's fields, to check a personal rule's operators against their types. */
    recordFields: readonly ModuleField[];
  }>,
): Promise<GridViewOperationOutcome> => {
  const document = save.document === null ? null : gridViewDocumentSchema.parse(save.document);
  const name = save.name === null ? null : gridViewNameSchema.parse(save.name);
  if (
    document !== null &&
    placementForLayout(
      save.page,
      save.placementId,
      save.queryId,
      document.columns.map((column) => column.fieldId),
    ) === undefined
  )
    throw new Error("GRID_VIEW_PLACEMENT_INVALID");
  // Every document carries a rule list; only a view that holds rules needs personal formatting.
  if (document !== null && document.formatting.length > 0) {
    const contract = gridViewPlacement(save.page, save.placementId)?.contract;
    const features = contract?.features;
    if (
      features === undefined ||
      !features.savedViews.enabled ||
      !features.savedViews.personalFormatting ||
      !features.conditionalFormatting.enabled
    )
      return refuseFormatting(
        save.placementId,
        "personal_formatting_off",
        "Personal formatting is not turned on for this table.",
      );
    const facts = conditionalFormatFactsOf(save.recordFields);
    // A rule reads only the table's own columns: the query reads no other field for it.
    const columns = new Set(contract?.columns.map((column) => column.field.toLowerCase()));
    for (const rule of document.formatting) {
      if (!conditionalFormatRuleFields(rule).every((fieldId) => columns.has(fieldId.toLowerCase())))
        return refuseFormatting(
          save.placementId,
          `field_not_in_table rule=${rule.id}`,
          "A rule reads a field this table does not show.",
        );
      const issue = conditionalFormatRuleIssue(rule, facts);
      if (issue !== undefined)
        return refuseFormatting(save.placementId, `rule_invalid rule=${rule.id}`, issue);
    }
  }
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.save_grid_view(
      ${save.page.pageId}::uuid,
      ${save.placementId}::uuid,
      ${save.queryId}::uuid,
      ${save.viewId}::uuid,
      ${save.expectedRevision}::bigint,
      ${name}::text,
      ${document === null ? null : JSON.stringify(document)}::text::jsonb
    ) as result
  `;
  return viewOutcome(rows);
};

/** Shares a view with the organisation, roles or groups (or makes it personal again). */
export const shareGridView = async (
  transaction: RequestDatabaseTransaction,
  share: Readonly<{
    pageId: string;
    placementId: string;
    viewId: string;
    expectedRevision: number;
    sharing: GridViewSharing;
  }>,
): Promise<GridViewOperationOutcome> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.share_grid_view(
      ${share.pageId}::uuid,
      ${share.placementId}::uuid,
      ${share.viewId}::uuid,
      ${share.expectedRevision}::bigint,
      ${share.sharing.organization}::boolean,
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(share.sharing.roleIds)}::text::jsonb)::uuid),
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(share.sharing.groupIds)}::text::jsonb)::uuid)
    ) as result
  `;
  return viewOutcome(rows);
};

/** Deletes a view at its revision; only its owner or someone who may share can. */
export const deleteGridView = async (
  transaction: RequestDatabaseTransaction,
  remove: Readonly<{
    pageId: string;
    placementId: string;
    viewId: string;
    expectedRevision: number;
  }>,
): Promise<GridViewOperationOutcome> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.delete_grid_view(
      ${remove.pageId}::uuid,
      ${remove.placementId}::uuid,
      ${remove.viewId}::uuid,
      ${remove.expectedRevision}::bigint
    ) as result
  `;
  return viewOutcome(rows);
};

const shareTargetsSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("listed"),
      roles: z.array(z.object({ roleId: idSchema, label: z.string() }).strict()),
      groups: z.array(z.object({ groupId: idSchema, label: z.string() }).strict()),
    })
    .strict(),
  z.object({ outcome: z.literal("forbidden") }).strict(),
]);

/** The roles and groups a view can be shared with; null for someone who may not share. */
export const listGridViewShareTargets = async (
  transaction: RequestDatabaseTransaction,
): Promise<GridViewShareTargets | null> => {
  const rows = await transaction.query<ResultRow>`
    select vortex_platform.list_grid_view_share_targets() as result
  `;
  const result = shareTargetsSchema.parse(only(rows));
  if (result.outcome === "forbidden") return null;
  return {
    roles: result.roles.map((role) => ({ id: role.roleId.toLowerCase(), label: role.label })),
    groups: result.groups.map((group) => ({ id: group.groupId.toLowerCase(), label: group.label })),
  };
};
