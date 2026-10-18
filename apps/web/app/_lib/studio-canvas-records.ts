import "server-only";

import { DefinitionError } from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  compiledItemSlots,
  describeFailure,
  fingerprintSchema,
  organizationIdSchema,
  recordIdSchema,
  revisionSchema,
  sourceItemChildSlots,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type CompiledItem,
  type IdentitySession,
  type PageDefinition,
  type SourceItem,
} from "@vortex/platform/schema";
import { z } from "zod";
import { pageCompiledSlotsFor } from "./studio-application-draft";
import { compiledDraftContent } from "./studio-compiled-drafts";
import { collectPlacements } from "./application-page/placement-helpers";
import { findModuleQuery } from "./application-page/query-helpers";
import { isStreamablePlacement, readPlacement } from "./application-page/placement-reader";
import { openStudioPreviewRead } from "./studio-preview-read";
import type { PageDataState } from "./application-page/types";

const requestSchema = z.object({
  rootId: applicationRootIdSchema,
  draftRevision: revisionSchema,
  sourceFingerprint: fingerprintSchema,
  pageAlias: z.string().min(1).max(160).regex(/^[a-z][a-z0-9_]*$/),
  area: z.string().min(1).max(400),
}).strict();

/**
 * The records the data blocks of one content area of a saved draft page show, by block name, for
 * exactly that draft revision. A block whose records come from elsewhere (the page's own record,
 * a form) is not read here.
 */
export type StudioCanvasRecordsResult =
  | Readonly<{ kind: "available"; draftRevision: number; sourceFingerprint: string; pageAlias: string;
      area: string; records: Readonly<Record<string, PageDataState>>;
      /**
       * The preview still runs an older revision's data shape and is moving to this one: blocks
       * whose query it does not have yet have no records here; read again shortly.
       */
      behind: boolean }>
  | Readonly<{ kind: "conflict" }>
  /** The builder may not edit or preview this application, so the canvas reads no records. */
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** The compiled slot of one page area beside its stored items, and the block name of each compiled placement. */
const placementAliases = (stored: readonly SourceItem[], compiled: readonly CompiledItem[],
  aliases: Map<string, string>): void => {
  if (stored.length !== compiled.length) throw new Error("STUDIO_CANVAS_RECORDS_SLOT_MISMATCH");
  stored.forEach((item, index) => {
    const compiledItem = compiled[index]!;
    aliases.set(String(compiledItem.props.id).toLowerCase(), item.props.id);
    const children = new Map(compiledItemSlots(compiledItem));
    for (const [key, items] of sourceItemChildSlots(item))
      placementAliases(items, children.get(key) ?? [], aliases);
  });
};

/**
 * Reads the records the data blocks of one saved draft page area show, through the builder's own
 * preview installation of that draft. The area's blocks are the saved revision's own compile; the
 * records are read with the running application's own placement reader against the preview, so a
 * block shows on the canvas what it shows in the preview to this builder: the records they may
 * read, a draft-only record type's and those made in the preview included, and nothing of records
 * they may not read.
 */
export const readStudioCanvasRecords = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioCanvasRecordsResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const parsed = requestSchema.safeParse(candidate);
  if (!organization.success || !parsed.success) return { kind: "refused" };
  const request = parsed.data;
  try {
    const preview = await openStudioPreviewRead(session, organization.data, request.rootId, request.draftRevision);
    if (preview.kind !== "available") return preview;
    const { draft, context, services, selection, dependencies } = preview;
    if (draft.sourceFingerprint !== request.sourceFingerprint) return { kind: "conflict" };
    const content = await compiledDraftContent(session, organization.data, draft);
    if (typeof content === "string") return { kind: content };
    const pageIndex = draft.source.body.pages.findIndex((page) => page.id === request.pageAlias);
    const page = draft.source.body.pages[pageIndex];
    const compiledPage = content.pages[pageIndex] as PageDefinition | undefined;
    const address = page === undefined ? undefined
      : sourcePageSlotAddresses(page).find((candidateAddress) => candidateAddress.key === request.area);
    const zone = page === undefined || address === undefined ? undefined : sourcePageSlotAt(page, address);
    const slot = pageCompiledSlotsFor(draft.source, content)[request.pageAlias]?.[request.area];
    if (page === undefined || compiledPage === undefined || zone === undefined || slot === undefined)
      return { kind: "refused" };
    const aliases = new Map<string, string>();
    placementAliases(zone.items, slot, aliases);

    // The draft's page, drawn as the running page reads it: its content is this area's blocks.
    const areaPage = { ...compiledPage, composition: { root: { props: {} }, content: slot } };
    // A query the preview does not run yet is read once the preview has moved to this revision.
    const placements = collectPlacements(areaPage).filter(isStreamablePlacement)
      .filter((placement) => findModuleQuery(context, String(placement.vortex.queryId)) !== undefined);
    const data: Record<string, PageDataState> = {};
    const noSubject = recordIdSchema.safeParse(undefined);
    const input = {
      pageDefinition: compiledPage, pageSubjectRecordTypeId: undefined, data, page: areaPage, context,
      referenceChoiceInputs: [], referenceChoices: services.referenceChoices, session, selection,
      address: { application: { key: draft.key }, pageKey: page.key },
      subjectType: undefined, parameters: {}, dependencies, subjectId: noSubject,
      readSubject: async () => ({ kind: "refused" } as const), linkTiles: services.linkTiles,
      queryNotices: services.queryNotices, boardContinuation: undefined, permittedApplicationKeys: undefined,
      permittedApplicationsRead: undefined, queries: services.queries,
      readCalendarSettings: services.readCalendarSettings, tables: services.tables,
      resolveRecordLinks: services.recordLinkResolver(context), tableContinuation: undefined,
      adoptSubjectRead: () => {}, markSubjectUnreadable: () => {},
    };
    await Promise.all(placements.map((placement) => readPlacement(input, placement)));
    const records: Record<string, PageDataState> = {};
    for (const [placementId, state] of Object.entries(data)) {
      const alias = aliases.get(placementId.toLowerCase());
      if (alias !== undefined) records[alias] = state;
    }
    return { kind: "available", draftRevision: request.draftRevision, sourceFingerprint: request.sourceFingerprint,
      pageAlias: request.pageAlias, area: request.area, records, behind: preview.behind };
  } catch (error) {
    if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return { kind: "conflict" };
    console.error(`[studio] canvas records unavailable: STUDIO_CANVAS_RECORDS_FAILED cause=${describeFailure(error)}`);
    return { kind: "temporarily_unavailable" };
  }
};
