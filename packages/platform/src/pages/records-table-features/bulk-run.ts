import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  authoredGridLayout,
  isRecord,
  readRecordsTableContract,
  sameId,
  type ExecuteNamedActionResult,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type RecordsSelectionCountRequest,
  type RecordsSelectionCountResult,
  type RecordsTableBulkActionContract,
  type RecordsTableBulkActionRequest,
  type RecordsTableBulkRefusalReason,
  type RecordsTableBulkRunLine,
  type RecordsTableContract,
  type RecordsTableFilterValue,
  type RecordsTableSortKey,
} from "../../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/index";
import {
  placementSettings,
  TABLE_BLOCK_RELEASE,
} from "../../definition/application-composition-catalogue";
import { createHumanInstalledPageBundleContextLoader } from "../../definition/installed-page-bundle-context";
import { installedNamedActions } from "../../definition/installed-named-actions";
import type { InstalledRuntimeContext } from "../../definition/index";
import {
  createProtectedQueryService,
  tableReadCandidatesPerRequest,
  type QueryContinuationKey,
} from "../../queries/index";
import {
  createNamedActionRecordPort,
  namedActionBatchMaximum,
  type NamedActionEligibility,
} from "../../records/index";
import { collectActionFlowTasks, flowLibraryOf, type ActionFlowRunner } from "../../rules/index";
import {
  fieldChoiceLabelsOf,
  fieldDateTypesOf,
  fieldFilterTargetsOf,
  fieldLabelsOf,
  fieldLinkTypesOf,
  type PlacementModule,
  type PlacementQuery,
} from "../placement-read/shared";
import { buildRecordsTableQueryCommand } from "../records-table-query";
import { recordsSelectionCountCeiling } from "../records-selection";
import { openRecordsSelection, type RecordsSelectionDescriptor } from "../records-selection-seal";
import { installedPlacementProps } from "./flow-dispatch";
import { readNamedActionEligibility } from "./named-action-eligibility";

/**
 * Bulk named actions over a Records table selection, and the count behind "Select all matching
 * records". Both re-read the installed placement and decide everything under the person's current
 * access: a selection of rows the person saw, or the sealed descriptor of every matching record,
 * is resolved on the server, in batches of at most 200 records, and each batch of a named action
 * runs in ONE transaction through the named action's own protected path (receipt, revision check,
 * Activity and Events per record). The browser loops over nothing and fetches no records.
 */

export type RecordsTableBulkDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ continuationKey: QueryContinuationKey }>;

/** The application the request's own address resolved, and the installed context it read. */
export type RecordsTableBulkAddress = Readonly<{
  selection: OrganizationSelectionCandidate & Readonly<{ applicationRootId: string }>;
  installedContext?: InstalledRuntimeContext;
}>;

type BulkPlacement = Readonly<{
  installed: InstalledRuntimeContext;
  contract: RecordsTableContract;
  settings: ReturnType<typeof placementSettings>;
  module: PlacementModule;
  query: PlacementQuery;
  recordTypeId: string;
}>;

/**
 * The most scan-limited reader requests one "matching" enumeration follows. A full page is bounded
 * by the run's own limit; a scan-limited page spent its whole budget of
 * `tableReadCandidatesPerRequest` candidates, so this many of them examine the candidate ceiling
 * the count uses (`recordsSelectionCountCeiling`) before the run refuses as "too many".
 */
const enumerationScanLimitedCeiling = Math.ceil(
  recordsSelectionCountCeiling / tableReadCandidatesPerRequest,
);

const refuse = (cause: string): undefined => {
  console.error(`[records-table] bulk request refused cause=${cause}`);
  return undefined;
};

/** The deterministic identity of one record's change in one bulk command, so a resubmit replays. */
const recordCommandId = (commandId: string, recordId: string): string => {
  const digest = createHash("sha256")
    .update(`records.bulk:${commandId.toLowerCase()}:${recordId.toLowerCase()}`)
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const reasonOf = (
  eligibility: NamedActionEligibility | "removed",
): RecordsTableBulkRefusalReason =>
  eligibility === "not_applicable" ||
  eligibility === "not_permitted" ||
  eligibility === "changed" ||
  eligibility === "removed"
    ? eligibility
    : "refused";

/** A refused record's reason from the closed safe refusal its change returned. */
const reasonOfResult = (
  result: ExecuteNamedActionResult | undefined,
): RecordsTableBulkRefusalReason =>
  result?.outcome === "refused" && result.error.code === "conflict" ? "changed" : "refused";

export const createRecordsTableBulkService = (dependencies: RecordsTableBulkDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queries = createProtectedQueryService(dependencies);
  const actionRecords = createNamedActionRecordPort(dependencies);

  const selectionOf = (address: RecordsTableBulkAddress): OrganizationSelectionCandidate =>
    address.selection;

  /** The installed Records table placement with bulk actions on, under the person's own scope. */
  const placementFor = async (
    session: IdentitySession,
    address: RecordsTableBulkAddress,
    placementId: string,
  ): Promise<BulkPlacement | undefined> => {
    const selection = selectionOf(address);
    let installed = address.installedContext;
    if (
      installed === undefined ||
      !sameId(installed.organizationId, address.selection.organizationId) ||
      !sameId(installed.applicationRootId, address.selection.applicationRootId)
    ) {
      const read = await requests.run(session, selection, async (transaction, scope) => {
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
      if (read.kind !== "available") return refuse("installation_unavailable");
      installed = read.value;
    }
    const props = installedPlacementProps(installed.releaseSet.application.content, placementId);
    if (props === undefined) return refuse("placement_not_installed");
    const vortex = props.vortex;
    if (!isRecord(vortex) || !isRecord(vortex.block) || typeof vortex.queryId !== "string")
      return refuse("placement_metadata_unreadable");
    if (vortex.block.blockId !== TABLE_BLOCK_RELEASE.blockId) return refuse("not_a_table");
    const settings = placementSettings(props);
    const contract = readRecordsTableContract(settings);
    if (contract === undefined) return refuse("contract_unreadable");
    if (!contract.features.bulkActions.enabled) return refuse("feature_off");
    const queryId = vortex.queryId;
    const bound = installed.releaseSet.modules.flatMap((module) =>
      module.content.queries
        .filter((query) => sameId(query.queryId, queryId))
        .map((query) => ({ module, query })),
    );
    const only = bound.length === 1 ? bound[0] : undefined;
    if (only === undefined || only.query.recordType.state !== "resolved")
      return refuse("query_not_installed");
    return {
      installed,
      contract,
      settings,
      module: only.module,
      query: only.query,
      recordTypeId: String(only.query.recordType.recordTypeId),
    };
  };

  /** The sealed descriptor of a matching selection, opened for this person and this release. */
  const descriptorFor = (
    session: IdentitySession,
    address: RecordsTableBulkAddress,
    placement: BulkPlacement,
    placementId: string,
    token: string,
  ): RecordsSelectionDescriptor | undefined => {
    const descriptor = openRecordsSelection(token, dependencies.continuationKey, {
      session,
      selection: selectionOf(address),
      installationRevision: placement.installed.applicationReleaseRevision,
      placementId,
    });
    if (descriptor === undefined) return undefined;
    if (
      !sameId(descriptor.moduleRootId, String(placement.module.rootId)) ||
      !sameId(descriptor.queryId, String(placement.query.queryId))
    )
      return refuse("descriptor_other_query");
    return descriptor;
  };

  /** The query command of the descriptor, rebuilt from the installed placement's own contract. */
  const commandFor = (placement: BulkPlacement, descriptor: RecordsSelectionDescriptor) => {
    const authored = authoredGridLayout(placement.contract);
    if (authored === undefined) return refuse("layout_unavailable");
    // Only the record identities are needed: the read shows one column, the first declared one.
    const layout = {
      ...authored,
      columns: authored.columns.map((column, index) => ({ ...column, visible: index === 0 })),
    };
    const built = buildRecordsTableQueryCommand({
      moduleRootId: placement.module.rootId,
      queryId: placement.query.queryId,
      settings: placement.settings,
      inputValues: descriptor.inputValues as Readonly<Record<string, JsonValue>>,
      state: {
        sort: descriptor.sort as unknown as readonly RecordsTableSortKey[],
        filters: descriptor.filters as unknown as readonly RecordsTableFilterValue[],
        search: descriptor.search,
        page: undefined,
      },
      layout: {
        storage: "preview",
        queryId: String(placement.query.queryId).toLowerCase(),
        revision: null,
        layout,
        authored: layout,
        reset: false,
      },
      filterTargets: fieldFilterTargetsOf(placement.module),
      ...(descriptor.timeZone === undefined ? {} : { timeZone: descriptor.timeZone }),
      fieldLabels: fieldLabelsOf(placement.module),
      fieldChoiceLabels: fieldChoiceLabelsOf(placement.module),
      fieldDateTypes: fieldDateTypesOf(placement.module),
      fieldLinkTypes: fieldLinkTypesOf(placement.module),
    });
    if (built.kind === "refused") return refuse(`command_${built.part}_${built.reason}`);
    return built;
  };

  /**
   * Every record the descriptor matches now, in the table's order, minus the exclusions, read in
   * keyset pages of the bound query's own page size (at most 200 identities) under the person's
   * current access; at most `limit` + 1, so a run past its limit is known without reading further.
   * A scan-limited page (the reader's budget ran out before the page filled) is followed, up to
   * `enumerationScanLimitedCeiling` of them; past it the enumeration is "too_many".
   */
  const resolveMatching = async (
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    command: NonNullable<ReturnType<typeof commandFor>>["command"],
    queryPageSize: number,
    excluded: ReadonlySet<string>,
    limit: number,
  ): Promise<readonly string[] | "too_many" | undefined> => {
    const recordIds: string[] = [];
    const seen = new Set<string>();
    let continuationToken: string | undefined;
    let scanLimitedCount = 0;
    do {
      const result = await queries.run(session, selection, {
        ...command,
        pageSize: Math.min(namedActionBatchMaximum, queryPageSize),
        ...(continuationToken === undefined
          ? {}
          : { pageDirection: "forward" as const, continuationToken }),
      });
      if (result.kind !== "available")
        return refuse(`matching_read_${result.kind}${"cause" in result ? ` ${result.cause}` : ""}`);
      if (result.value.outcome !== "completed")
        return refuse(`matching_read_refused_${result.value.reasonCode}`);
      for (const row of result.value.rows) {
        const recordId = String(row.recordId).toLowerCase();
        if (seen.has(recordId) || excluded.has(recordId)) continue;
        seen.add(recordId);
        recordIds.push(recordId);
      }
      continuationToken = result.value.nextContinuationToken;
      if (result.value.scanLimited) scanLimitedCount += 1;
      if (continuationToken !== undefined && scanLimitedCount === enumerationScanLimitedCeiling) {
        console.error(
          `[records-table] bulk request refused cause=matching_enumeration_ceiling scanLimited=${scanLimitedCount}`,
        );
        return "too_many";
      }
    } while (continuationToken !== undefined && recordIds.length <= limit);
    return recordIds;
  };

  return Object.freeze({
    /** The one capped count of "Select all matching records", through the query summary path. */
    async count(
      session: IdentitySession,
      address: RecordsTableBulkAddress,
      request: RecordsSelectionCountRequest,
    ): Promise<RecordsSelectionCountResult> {
      const placement = await placementFor(session, address, request.placementId);
      if (placement === undefined) return { kind: "refused" };
      const descriptor = descriptorFor(
        session,
        address,
        placement,
        request.placementId,
        request.token,
      );
      if (descriptor === undefined) return { kind: "refused" };
      const built = commandFor(placement, descriptor);
      if (built === undefined) return { kind: "refused" };
      const summary = await queries.summarise(session, selectionOf(address), {
        moduleRootId: built.command.moduleRootId,
        queryId: built.command.queryId,
        inputValues: built.command.inputValues,
        ...(built.command.filter === undefined ? {} : { filter: built.command.filter }),
        filterableFieldIds: built.command.filterableFieldIds,
        ...(built.command.search === undefined ? {} : { search: built.command.search }),
        searchableFieldIds: built.command.searchableFieldIds,
      });
      if (summary.kind === "temporarily_unavailable") return { kind: "unavailable" };
      if (summary.kind !== "available") return { kind: "refused" };
      if (summary.value.outcome === "completed")
        return { kind: "counted", count: summary.value.totalRowCount };
      if (summary.value.reasonCode === "dataset_limit_exceeded") return { kind: "too_many" };
      console.error(`[records-table] selection count refused code=${summary.value.reasonCode}`);
      return { kind: "refused" };
    },

    /**
     * Runs one declared bulk action over a selection and reports progress after each batch, then
     * one summary. Explicit rows run all or nothing: every row is checked first, and the run
     * changes nothing when any row is refused. Every matching record runs in batches, each batch
     * atomic; a refused record is reported with its reason, never silently skipped.
     */
    async run(
      session: IdentitySession,
      address: RecordsTableBulkAddress,
      request: RecordsTableBulkActionRequest,
      report: (line: RecordsTableBulkRunLine) => void,
    ): Promise<void> {
      const selection = selectionOf(address);
      const placement = await placementFor(session, address, request.placementId);
      if (placement === undefined) return report({ kind: "refused" });
      const bulk = placement.contract.features.bulkActions;
      const declared: RecordsTableBulkActionContract | undefined = bulk.enabled
        ? bulk.actions.find((action) => sameId(action.action, request.action))
        : undefined;
      if (declared === undefined) return report({ kind: "refused" });
      const application = placement.installed.releaseSet.application;
      const named = installedNamedActions(application, placement.installed.releaseSet.modules).get(
        declared.action,
      );
      if (named === undefined || !sameId(named.subjectRecordTypeId, placement.recordTypeId)) {
        refuse("action_not_installed");
        return report({ kind: "refused" });
      }
      // The action's own compiled transaction flow, from the exact installed release.
      const flows = new Map<string, unknown>();
      for (const flow of [
        ...application.content.flows,
        ...placement.installed.releaseSet.modules.flatMap((module) => module.content.flows),
      ])
        flows.set(String(flow.id), flow);
      const library = flowLibraryOf(flows);
      const flowId = named.action.actionId;
      const flow = library(flowId);
      if (
        flow === undefined ||
        flow.execution !== "transaction" ||
        flow.runAs.kind !== "saver" ||
        flow.triggers.length > 0
      ) {
        refuse("action_flow_unavailable");
        return report({ kind: "refused" });
      }
      const runId = randomUUID();
      const runner: ActionFlowRunner = (seed) =>
        collectActionFlowTasks(library, flowId, runId, seed);

      // The records the run covers, with the revision each is bound at.
      let targets: readonly Readonly<{ recordId: string; revision?: number }>[];
      let limited = false;
      if (request.selection.kind === "ids") {
        if (request.selection.items.length > declared.maxRecords) {
          refuse("selection_larger_than_action_limit");
          return report({ kind: "refused" });
        }
        if (request.selection.items.length > placement.contract.pageSize) {
          refuse("selection_larger_than_page");
          return report({ kind: "refused" });
        }
        const unique = new Set(request.selection.items.map((item) => item.recordId.toLowerCase()));
        if (unique.size !== request.selection.items.length) {
          refuse("selection_duplicated");
          return report({ kind: "refused" });
        }
        targets = request.selection.items.map((item) => ({
          recordId: item.recordId.toLowerCase(),
          revision: item.revision,
        }));
      } else {
        const descriptor = descriptorFor(
          session,
          address,
          placement,
          request.placementId,
          request.selection.token,
        );
        const built = descriptor === undefined ? undefined : commandFor(placement, descriptor);
        if (built === undefined) return report({ kind: "refused" });
        const matching = await resolveMatching(
          session,
          selection,
          built.command,
          placement.query.pageSize,
          new Set(request.selection.excluded.map((recordId) => recordId.toLowerCase())),
          declared.maxRecords,
        );
        if (matching === undefined) return report({ kind: "unavailable" });
        if (matching === "too_many") return report({ kind: "refused" });
        limited = matching.length > declared.maxRecords;
        targets = matching.slice(0, declared.maxRecords).map((recordId) => ({ recordId }));
      }

      const total = targets.length;
      const refusals = new Map<RecordsTableBulkRefusalReason, number>();
      const refused = (reason: RecordsTableBulkRefusalReason, count = 1): void => {
        refusals.set(reason, (refusals.get(reason) ?? 0) + count);
      };
      let done = 0;
      let notProcessed = 0;
      let processed = 0;
      const summary = (): RecordsTableBulkRunLine => ({
        kind: "summary",
        total,
        done,
        refused: [...refusals.entries()].map(([reason, count]) => ({ reason, count })),
        notProcessed,
        limited,
      });
      report({ kind: "progress", total, processed });
      const allOrNothing = request.selection.kind === "ids";
      for (let start = 0; start < targets.length; start += namedActionBatchMaximum) {
        const batch = targets.slice(start, start + namedActionBatchMaximum);
        const commandIds = new Map(
          batch.map((target) => [
            target.recordId,
            recordCommandId(request.commandId, target.recordId),
          ]),
        );
        // ONE call decides every record of the batch under current access.
        const decided = await requests.run(session, selection, (transaction, _scope, issuedAt) =>
          readNamedActionEligibility(
            transaction,
            placement.recordTypeId,
            [{ action: named.action, run: runner }],
            batch.map((target) => ({
              recordId: target.recordId,
              commandId: commandIds.get(target.recordId)!,
            })),
            issuedAt,
          ).then((rows) =>
            rows.map(({ actions, ...row }) => ({ ...row, eligibility: actions[0]!.eligibility })),
          ),
        );
        if (decided.kind !== "available") {
          notProcessed += targets.length - start;
          break;
        }
        let runnable: Readonly<{ recordId: string; revision: number }>[] = [];
        let batchRefused = 0;
        for (const [index, eligibility] of decided.value.entries()) {
          const target = batch[index]!;
          // A row the person saw at another revision changed since they selected it.
          const stale =
            target.revision !== undefined &&
            eligibility.revision !== undefined &&
            eligibility.eligibility !== "replayed" &&
            eligibility.revision !== target.revision;
          if (stale) refused("changed");
          else if (eligibility.eligibility === "eligible" || eligibility.eligibility === "replayed")
            runnable.push({
              recordId: target.recordId,
              revision: target.revision ?? eligibility.revision!,
            });
          else refused(reasonOf(eligibility.eligibility));
          if (
            stale ||
            (eligibility.eligibility !== "eligible" && eligibility.eligibility !== "replayed")
          )
            batchRefused += 1;
        }
        if (allOrNothing && batchRefused > 0) {
          // Explicit rows run all or nothing: no row changes while any is refused.
          notProcessed += runnable.length;
          runnable = [];
        }
        // A refusal rolls the batch back. Report the other rows as not reached; never resubmit
        // a smaller mutation automatically after the person confirmed this selection.
        if (runnable.length > 0) {
          const result = await actionRecords.executeMany(
            session,
            selection,
            runnable.map((target) => ({
              contractVersion: "2.0.0",
              commandId: commandIds.get(target.recordId),
              action: named.action,
              recordTypeId: placement.recordTypeId,
              recordId: target.recordId,
              expectedConcurrencyNumber: target.revision,
              inputs: {},
            })),
            runner,
          );
          if (result.kind === "completed") {
            done += result.results.length;
          } else if (result.kind === "refused") {
            refused(reasonOfResult(result.result));
            notProcessed += runnable.length - 1;
          } else notProcessed += runnable.length;
        }
        processed = Math.min(total, start + batch.length);
        report({ kind: "progress", total, processed });
      }
      report(summary());
    },
  });
};
