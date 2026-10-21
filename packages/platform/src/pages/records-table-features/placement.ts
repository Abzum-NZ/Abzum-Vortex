import "server-only";

import {
  isRecord,
  recordsTableContractOrLog,
  sameId,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecordsTableContract,
} from "../../schema";
import type { createHumanOrganizationRequestService } from "../../access/index";
import {
  placementSettings,
  TABLE_BLOCK_RELEASE,
} from "../../definition/application-composition-catalogue";
import { createHumanInstalledPageBundleContextLoader } from "../../definition/installed-page-bundle-context";
import type { InstalledRuntimeContext } from "../../definition/index";
import type { PlacementModule, PlacementQuery } from "../placement-read/shared";
import { installedPlacementProps } from "./flow-dispatch";

/**
 * The application the request's own address resolved, the installed context it read, and the page
 * (by its permanent identity) the request addressed.
 */
export type RecordsTableCommandAddress = Readonly<{
  pageId: string;
  selection: OrganizationSelectionCandidate & Readonly<{ applicationRootId: string }>;
  installedContext?: InstalledRuntimeContext;
}>;

/** One installed Records table placement, re-read from the exact release the request resolved. */
export type RecordsTablePlacement = Readonly<{
  installed: InstalledRuntimeContext;
  contract: RecordsTableContract;
  settings: ReturnType<typeof placementSettings>;
  module: PlacementModule;
  query: PlacementQuery;
  recordTypeId: string;
}>;

/**
 * Re-reads one installed Records table placement under the person's own scope: the installed
 * release (the address's own when it carries one for this application), the placement's compiled
 * contract and the one query it is bound to. The cause of a refusal is returned for the caller to
 * log; nothing about the placement comes from the browser.
 */
export const loadRecordsTablePlacement = async (
  requests: ReturnType<typeof createHumanOrganizationRequestService>,
  session: IdentitySession,
  address: RecordsTableCommandAddress,
  placementId: string,
): Promise<RecordsTablePlacement | Readonly<{ refused: string }>> => {
  let installed = address.installedContext;
  if (
    installed === undefined ||
    !sameId(installed.organizationId, address.selection.organizationId) ||
    !sameId(installed.applicationRootId, address.selection.applicationRootId)
  ) {
    const read = await requests.run(session, address.selection, async (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("BULK_SCOPE_UNAVAILABLE");
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
      }).load();
    });
    if (read.kind !== "available") return { refused: "installation_unavailable" };
    installed = read.value;
  }
  const props = installedPlacementProps(installed.releaseSet.application.content, placementId);
  if (props === undefined) return { refused: "placement_not_installed" };
  const vortex = props.vortex;
  if (!isRecord(vortex) || !isRecord(vortex.block) || typeof vortex.queryId !== "string")
    return { refused: "placement_metadata_unreadable" };
  if (vortex.block.blockId !== TABLE_BLOCK_RELEASE.blockId) return { refused: "not_a_table" };
  const settings = placementSettings(props);
  const contract = recordsTableContractOrLog(settings, "table placement");
  if (contract === undefined) return { refused: "contract_unreadable" };
  const queryId = vortex.queryId;
  const bound = installed.releaseSet.modules.flatMap((module) =>
    module.content.queries
      .filter((query) => sameId(query.queryId, queryId))
      .map((query) => ({ module, query })),
  );
  const only = bound.length === 1 ? bound[0] : undefined;
  if (only === undefined || only.query.recordType.state !== "resolved")
    return { refused: "query_not_installed" };
  return {
    installed,
    contract,
    settings,
    module: only.module,
    query: only.query,
    recordTypeId: String(only.query.recordType.recordTypeId),
  };
};
