import "server-only";

import { randomUUID } from "node:crypto";
import {
  authoredGridLayout,
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
  type RecordsTableFilterValue,
  type RecordsTableSortKey,
} from "../../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../../access/index";
import { installedNamedActions } from "../../definition/installed-named-actions";
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
} from "../placement-read/shared";
import { buildRecordsTableQueryCommand } from "../records-table-query";
import { recordsSelectionCountCeiling, recordsTableBulkWarningMaximum } from "../records-selection";
import { openRecordsSelection, type RecordsSelectionDescriptor } from "../records-selection-seal";
import {
  loadRecordsTablePlacement,
  type RecordsTableCommandAddress,
  type RecordsTablePlacement,
} from "./placement";
import { readNamedActionEligibility } from "./named-action-eligibility";
import { recordCommandId } from "./record-command-id";

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
export type RecordsTableBulkAddress = RecordsTableCommandAddress;

type BulkPlacement = RecordsTablePlacement;

/**
 * The most scan-limited reader requests one "matching" enumeration follows. A full page is bounded
 * by the run's own limit; a scan-limited page spent its whole budget of
 * `tableReadCandidatesPerRequest` candidates, so this many of them examine the candidate ceiling
 * the count uses (`recordsSelectionCountCeiling`) before the run refuses as "too many".
 */
export const enumerationScanLimitedCeiling = Math.ceil(
  recordsSelectionCountCeiling / tableReadCandidatesPerRequest,
);

const refuse = (cause: string): undefined => {
  console.error(`[records-table] bulk request refused cause=${cause}`);
  return undefined;
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

  /**
   * The installed Records table placement under the person's own scope, with the feature that
   * uses it on: bulk actions run and count over a selection, and Export counts the same one.
   */
  const placementFor = async (
    session: IdentitySession,
    address: RecordsTableBulkAddress,
    placementId: string,
    use: "run" | "count",
  ): Promise<BulkPlacement | undefined> => {
    const loaded = await loadRecordsTablePlacement(requests, session, address, placementId);
    if ("refused" in loaded) return refuse(loaded.refused);
    const { bulkActions, export: exported } = loaded.contract.features;
    if (!bulkActions.enabled && !(use === "count" && exported.enabled))
      return refuse("feature_off");
    return loaded;
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
      pageId: address.pageId,
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
      const placement = await placementFor(session, address, request.placementId, "count");
      if (placement === undefined) return { kind: "refused", reason: "not_available" };
      const descriptor = descriptorFor(
        session,
        address,
        placement,
        request.placementId,
        request.token,
      );
      if (descriptor === undefined) return { kind: "refused", reason: "not_available" };
      const built = commandFor(placement, descriptor);
      if (built === undefined) return { kind: "refused", reason: "not_available" };
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
      if (summary.kind !== "available") return { kind: "refused", reason: "not_available" };
      if (summary.value.outcome === "completed")
        return { kind: "counted", count: summary.value.totalRowCount };
      if (summary.value.reasonCode === "dataset_limit_exceeded") return { kind: "too_many" };
      console.error(`[records-table] selection count refused code=${summary.value.reasonCode}`);
      return { kind: "refused", reason: "not_available" };
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
      const placement = await placementFor(session, address, request.placementId, "run");
      if (placement === undefined) return report({ kind: "refused", reason: "not_available" });
      const bulk = placement.contract.features.bulkActions;
      const declared: RecordsTableBulkActionContract | undefined = bulk.enabled
        ? bulk.actions.find((action) => sameId(action.action, request.action))
        : undefined;
      if (declared === undefined) return report({ kind: "refused", reason: "not_available" });
      const application = placement.installed.releaseSet.application;
      const named = installedNamedActions(application, placement.installed.releaseSet.modules).get(
        declared.action,
      );
      if (named === undefined || !sameId(named.subjectRecordTypeId, placement.recordTypeId)) {
        refuse("action_not_installed");
        return report({ kind: "refused", reason: "not_available" });
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
        return report({ kind: "refused", reason: "not_available" });
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
          return report({ kind: "refused", reason: "not_available" });
        }
        const unique = new Set(request.selection.items.map((item) => item.recordId.toLowerCase()));
        if (unique.size !== request.selection.items.length) {
          refuse("selection_duplicated");
          return report({ kind: "refused", reason: "not_available" });
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
        if (built === undefined) return report({ kind: "refused", reason: "not_available" });
        const matching = await resolveMatching(
          session,
          selection,
          built.command,
          placement.query.pageSize,
          new Set(request.selection.excluded.map((recordId) => recordId.toLowerCase())),
          declared.maxRecords,
        );
        if (matching === undefined) return report({ kind: "unavailable" });
        if (matching === "too_many") return report({ kind: "refused", reason: "not_available" });
        limited = matching.length > declared.maxRecords;
        targets = matching.slice(0, declared.maxRecords).map((recordId) => ({ recordId }));
      }

      const total = targets.length;
      const warningRecords = new Map<string, Set<string>>();
      const warningCodes = new Map<string, Set<string>>();
      let warningsTruncated = false;
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
        warnings: [...warningRecords].map(([message, records]) => ({
          message,
          count: records.size,
        })),
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
            recordCommandId("records.bulk", request.commandId, target.recordId),
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
            for (const { message, code, recordId } of result.warnings) {
              const coded = warningCodes.get(code) ?? new Set<string>();
              coded.add(recordId);
              warningCodes.set(code, coded);
              let records = warningRecords.get(message);
              if (records === undefined) {
                if (warningRecords.size === recordsTableBulkWarningMaximum) {
                  warningsTruncated = true;
                  continue;
                }
                records = new Set<string>();
                warningRecords.set(message, records);
              }
              records.add(recordId);
            }
          } else if (result.kind === "refused") {
            refused(reasonOfResult(result.result));
            notProcessed += runnable.length - 1;
          } else notProcessed += runnable.length;
        }
        processed = Math.min(total, start + batch.length);
        report({ kind: "progress", total, processed });
      }
      for (const [code, records] of warningCodes)
        console.info(
          `[records-bulk] warnings code=${code} count=${records.size} action=${request.action} commandId=${request.commandId}`,
        );
      if (warningsTruncated)
        console.error(
          `[records-bulk] cause=bulk_warnings_truncated max=${recordsTableBulkWarningMaximum} action=${request.action} commandId=${request.commandId}`,
        );
      report(summary());
    },
  });
};
