import {
  createHumanInstalledPageBundleContextLoader,
  createLinkTilesQueryResolver,
  createPageSubjectReader,
  createProtectedQueryService,
  createQueryNoticeQueryResolver,
  createRecordsSelectionSealer,
  createRecordsTableQueryResolver,
  createReferenceChoiceService,
  createViewerSafeRecordLinkService,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  runtimeDatabasePoolSize,
  type HumanOrganizationRequestDependencies,
  type InstalledRuntimeContext,
  type PlacementReadInput,
  type ProjectedRecordLink,
  type RecordLinkResolver,
} from "@vortex/platform/server";
import { applicationLauncherQueryRowsToListValues } from "@vortex/ui/launcher/bindings";
import { parseBoardPayload } from "@vortex/ui/display/board-payload";
import { parseDisplayData } from "@vortex/ui/display/projected-data";
import type { IdentitySession, OrganizationSelectionCandidate } from "@vortex/platform/schema";
import { createApplicationPageLinkReader } from "../application-page-link";
import { humanOrganizationRequests } from "../server-composition";
import { platformPermissionSource } from "../platform-permission-source";

/**
 * The readers a page's data placements use, each reading under the viewer's own protected
 * requests. The running page and the Studio canvas both read their placements through these and
 * `readPlacement`, so a block shows the same records, with the same access, in both.
 */
export const createPlacementReadServices = (
  input: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    dependencies: HumanOrganizationRequestDependencies;
    continuationKey: Parameters<typeof createProtectedQueryService>[0]["continuationKey"];
    /** The organisation's address, for the links a placement shows. */
    tenantShortName: string;
    organizationShortName: string;
  }>,
) => {
  const { session, selection, dependencies, continuationKey } = input;
  const queries = createProtectedQueryService({ ...dependencies, continuationKey });
  const referenceChoices = createReferenceChoiceService({ ...dependencies, continuationKey });
  // A table read seals its "every matching record" descriptor for this viewer, for bulk actions.
  const tables = {
    ...createRecordsTableQueryResolver(queries),
    sealSelection: createRecordsSelectionSealer(continuationKey, session, selection),
  };
  const queryNotices = createQueryNoticeQueryResolver(queries);
  const recordLinks = createViewerSafeRecordLinkService({
    ...dependencies,
    permissions: platformPermissionSource,
    createInstalledContextLoader(transaction, scope) {
      if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
      return createHumanInstalledPageBundleContextLoader({
        transaction,
        scope: {
          organizationId: scope.organizationId,
          organizationAccountId: scope.organizationAccountId,
          applicationRootId: scope.applicationRootId,
          ...(scope.previewInstallationId === undefined
            ? {}
            : { previewInstallationId: scope.previewInstallationId }),
        },
      });
    },
  });
  const applicationPageLinks = createApplicationPageLinkReader({
    tenantShortName: input.tenantShortName,
    organizationShortName: input.organizationShortName,
  });
  const readConcurrently = async <Input, Output>(
    candidates: readonly Input[],
    read: (candidate: Input) => Promise<Output>,
  ): Promise<readonly Output[]> => {
    if (candidates.length > 10_000) throw new Error("CONCURRENT_READ_BATCH_TOO_LARGE");
    const results = new Array<Output>(candidates.length);
    let nextIndex = 0;
    let failed = false;
    let failure: unknown;
    const worker = async (): Promise<void> => {
      while (true) {
        if (failed) return;
        const index = nextIndex++;
        if (index >= candidates.length) return;
        try {
          const candidate = candidates[index];
          if (candidate === undefined) throw new Error("CONCURRENT_READ_BATCH_INPUT_MISSING");
          results[index] = await read(candidate);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(runtimeDatabasePoolSize(), candidates.length) }, worker),
    );
    if (failed) throw failure;
    return Object.freeze(results);
  };
  const linkTiles = createLinkTilesQueryResolver(
    queries,
    (viewer, identities) =>
      readConcurrently(identities, (identity) => recordLinks.read(viewer, identity)),
    (viewer, selectors) =>
      readConcurrently(selectors, (selector) => applicationPageLinks.read(viewer, selector)),
  );
  const loadCalendarSettings = () =>
    humanOrganizationRequests(dependencies.identityAuthorityId).run(
      session,
      selection,
      async (transaction, scope) => ({
        settings: await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction),
        accessVersion: scope.accessVersion,
      }),
    );
  let calendarSettingsRead: ReturnType<typeof loadCalendarSettings> | undefined;
  const readCalendarSettings = () => (calendarSettingsRead ??= loadCalendarSettings());
  const subjects = createPageSubjectReader(dependencies);
  // One labelled read per page and link target: a link shows its target's name as the viewer may
  // read it, and a detail address only where the viewer may open that page.
  const recordLinkResolver =
    (context: InstalledRuntimeContext): RecordLinkResolver =>
    async (links) => {
      const read = await recordLinks.readLabels(session, selection, context, links);
      if (read.outcome !== "read") return undefined;
      return new Map(
        [...read.labels].map(([key, label]): [string, ProjectedRecordLink] => [
          key,
          label.outcome === "restricted"
            ? { kind: "restricted" }
            : {
                kind: "record_link",
                label: label.label,
                ...(label.detail === undefined
                  ? {}
                  : {
                      href: `/${encodeURIComponent(input.tenantShortName)}/${encodeURIComponent(input.organizationShortName)}/${encodeURIComponent(label.detail.applicationKey)}/${encodeURIComponent(label.detail.pageKey)}?${new URLSearchParams({ record_id: label.detail.recordId })}`,
                    }),
              },
        ]),
      );
    };
  // The readers one placement read takes: the page load and a tree level's read share them.
  const placementServices = (
    resolveRecordLinks: RecordLinkResolver,
    readSubject: PlacementReadInput["services"]["readSubject"],
  ): PlacementReadInput["services"] => ({
    queries,
    linkTiles,
    queryNotices,
    tables,
    resolveRecordLinks,
    readCalendarSettings,
    readSubject,
    launcherValues: applicationLauncherQueryRowsToListValues,
    boardData: (values) => parseDisplayData({ status: "ready", values }, parseBoardPayload),
  });
  return {
    queries,
    referenceChoices,
    tables,
    queryNotices,
    linkTiles,
    readCalendarSettings,
    subjects,
    recordLinkResolver,
    readConcurrently,
    placementServices,
  };
};
