import "server-only";

import {
  BuilderAuthorityError,
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  DefinitionError,
  readApplicationDefinitionDraft,
  readLiveHumanContext,
  requireBuilderAuthority,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  compiledItemSlots,
  describeFailure,
  fingerprintSchema,
  organizationIdSchema,
  recordIdSchema,
  revisionSchema,
  sameId,
  sourceItemChildSlots,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type CompiledItem,
  type IdentitySession,
  type PageDefinition,
  type SourceItem,
} from "@vortex/platform/schema";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { pageCompiledSlotsFor, studioDraftTargetFacts } from "./studio-application-draft";
import { loadInstalledContext, requestDependencies } from "./application-page/load";
import { collectPlacements } from "./application-page/placement-helpers";
import { findModuleQuery } from "./application-page/query-helpers";
import { isStreamablePlacement, readPlacement } from "./application-page/placement-reader";
import { createPlacementReadServices } from "./application-page/placement-services";
import { loadOrganizationLauncher } from "./organization-context";
import { getQueryContinuationKey } from "./query-continuation-key";
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
      /** Blocks whose query the installed release does not have yet: publish and upgrade to read them. */
      notInstalled: readonly string[] }>
  /** The organisation has no installation of this application, so there are no records to read. */
  | Readonly<{ kind: "not_installed" }>
  | Readonly<{ kind: "conflict" }>
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
 * Reads, with the builder's own access, the records the data blocks of one saved draft page area
 * show. It reads through the running application's own placement reader against the installed
 * application, so a block shows on the canvas what it shows in the running app to this person:
 * records they may not read are not there, and a block they may not read reports that.
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
    const compiled = await humanOrganizationRequests().run(session, { organizationId: organization.data },
      async (transaction, scope, issuedAt) => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts: studioDraftTargetFacts,
          permissions: platformPermissionSource });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: request.rootId });
        } catch (error) {
          if (error instanceof BuilderAuthorityError) return { kind: "refused" } as const;
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope,
          { rootId: request.rootId, expectedDraftRevision: request.draftRevision });
        if (draft.sourceFingerprint !== request.sourceFingerprint) return { kind: "conflict" } as const;
        const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        const compilation = (await createDatabaseDefinitionPublicationService(installedReleaseCatalogue,
          transaction, authority).compileApplicationDraft(context,
          { rootId: draft.rootId, expectedDraftRevision: draft.draftRevision })).compilation;
        const content = compilation.canonical.content;
        const pageIndex = draft.source.body.pages.findIndex((page) => page.id === request.pageAlias);
        const page = draft.source.body.pages[pageIndex];
        const compiledPage = content.pages[pageIndex];
        const address = page === undefined ? undefined
          : sourcePageSlotAddresses(page).find((candidateAddress) => candidateAddress.key === request.area);
        const zone = page === undefined || address === undefined ? undefined : sourcePageSlotAt(page, address);
        const slot = pageCompiledSlotsFor(draft.source, content)[request.pageAlias]?.[request.area];
        if (page === undefined || compiledPage === undefined || zone === undefined || slot === undefined)
          return { kind: "refused" } as const;
        const aliases = new Map<string, string>();
        placementAliases(zone.items, slot, aliases);
        return { kind: "compiled", key: draft.key, pageKey: page.key, compiledPage: compiledPage as PageDefinition,
          slot, aliases } as const;
      });
    if (compiled.kind !== "available")
      return compiled.kind === "temporarily_unavailable" ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    const value = compiled.value;
    if (value.kind !== "compiled") return value;

    const dependencies = requestDependencies();
    const selection = { organizationId: organization.data, applicationRootId: request.rootId };
    const installed = await loadInstalledContext(session, dependencies, selection);
    if (installed.kind !== "available") return { kind: "not_installed" };
    const context = installed.value;
    const launcher = await loadOrganizationLauncher(session);
    const entry = launcher.kind === "available"
      ? launcher.entries.find((candidateEntry) => sameId(candidateEntry.organizationId, organization.data)) : undefined;
    if (entry === undefined) return { kind: "refused" };
    const services = createPlacementReadServices({ session, selection, dependencies,
      continuationKey: getQueryContinuationKey(), tenantShortName: entry.tenantShortName,
      organizationShortName: entry.organizationShortName });
    // The draft's page, drawn as the running page reads it: its content is this area's blocks.
    const page = { ...value.compiledPage, composition: { root: { props: {} }, content: value.slot } };
    // A query the draft has but the installed release does not cannot be read yet.
    const readable = collectPlacements(page).filter(isStreamablePlacement);
    const placements = readable.filter((placement) => findModuleQuery(context, String(placement.vortex.queryId)) !== undefined);
    const notInstalled = readable.filter((placement) => !placements.includes(placement))
      .flatMap((placement) => value.aliases.get(placement.placementId.toLowerCase()) ?? []);
    const data: Record<string, PageDataState> = {};
    const noSubject = recordIdSchema.safeParse(undefined);
    const input = {
      pageDefinition: value.compiledPage, pageSubjectRecordTypeId: undefined, data, page, context,
      referenceChoiceInputs: [], referenceChoices: services.referenceChoices, session, selection,
      referenceChoiceFirstPages: new Map(), address: { application: { key: value.key }, pageKey: value.pageKey },
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
      const alias = value.aliases.get(placementId.toLowerCase());
      if (alias !== undefined) records[alias] = state;
    }
    return { kind: "available", draftRevision: request.draftRevision, sourceFingerprint: request.sourceFingerprint,
      pageAlias: request.pageAlias, area: request.area, records, notInstalled };
  } catch (error) {
    if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return { kind: "conflict" };
    console.error(`[studio] canvas records unavailable: STUDIO_CANVAS_RECORDS_FAILED cause=${describeFailure(error)}`);
    return { kind: "temporarily_unavailable" };
  }
};
