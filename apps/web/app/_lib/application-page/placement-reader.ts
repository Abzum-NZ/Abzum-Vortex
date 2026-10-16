import type {
  createReferenceChoiceService,
  createLinkTilesQueryResolver,
  createQueryNoticeQueryResolver,
  createProtectedQueryService,
  createRecordsTableQueryResolver,
} from "@vortex/platform/server";
import {
  projectReferenceChoiceInputValues,
  projectRecordDetailData,
  collectRecordLinks,
  collectRecordLinkValues,
  type RecordLinkResolver,
  protectedQueryCommandSchema,
  type ProtectedQueryRow,
  protectedQuerySummaryCommandSchema,
  type InstalledRuntimeContext,
  type HumanOrganizationRequestDependencies,
  type PageSubjectReadResult,
  type PermittedApplicationsRead,
} from "@vortex/platform/server";
import {
  type ApplicationLauncherQueryRow,
  applicationLauncherQueryRowsToListValues,
  type DisplayCellValue,
  parseBoardPayload,
  parseDisplayData,
} from "@vortex/ui";
import {
  ATTACHMENT_LIST_BLOCK_RELEASE,
  CALENDAR_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  CHART_BLOCK_RELEASE,
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE,
  projectBoardPlacement,
  readCalendarPlacementContract,
} from "@vortex/platform/server";
import {
  recordIdSchema,
  type BlockPropertyValueContract,
  readRecordsTableContract,
  readRecordDetailContract,
  type JsonValue,
  type PageDefinition,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  sameId,
  isRecord,
  describeFailure,
} from "@vortex/platform/schema";
import { hasReferenceChoiceSource, projectedReferenceChoiceForm } from "../reference-choices";
import {
  parseTablePagePosition,
  tablePageParameterName,
  type TablePageRequest,
} from "../table-page-position";
import type { collectPlacements } from "./placement-helpers";
import { projectedUseAvailability, isBoardPlacement, first } from "./placement-helpers";
import { readCalendarPlacement } from "./calendar";
import { projectChartPlacement } from "./chart";
import {
  logPlacementFailure,
  isApplicationLauncherPlacement,
  fieldLabelsOf,
  fieldChoiceLabelsOf,
  fieldDateTypesOf,
  fieldLinkTypesOf,
  findModuleQuery,
  noticeQueryInput,
  coerceInput,
  MAXIMUM_LAUNCHER_QUERY_ROWS,
  launcherCellKey,
  summaryAggregateCellValue,
  summaryAggregateLabel,
  requestState,
} from "./query-helpers";
import type {
  PlacementFlowBinding,
  PageDataState,
  ApplicationPageModel,
  ApplicationPageLoaderAddress,
  PageSubjectType,
  SearchParameters,
  BoardContinuationTarget,
  TableContinuationTarget,
} from "./types";
import { projectInitialReferenceChoice, type ReferenceChoiceFirstPage } from "./reference-choice";
import { readAttachmentListPlacement } from "./attachment-placement";

/** The labels of the linked records the rows carry, read once; undefined when none or unreadable. */
const readRecordLinks = async (
  resolve: RecordLinkResolver,
  rows: readonly ProtectedQueryRow[],
): ReturnType<RecordLinkResolver> => {
  const links = collectRecordLinks(rows);
  return links.length === 0 ? undefined : resolve(links);
};

/** The flow bindings one placement holds, projected for the browser by placement identity. */
export const projectPlacementBindings = (
  input: Readonly<{
    application: InstalledRuntimeContext["releaseSet"]["application"];
    recordTypeByPlacement: Map<string, string>;
    bindings: Record<string, PlacementFlowBinding[]>;
    pageDefinition: PageDefinition;
    pageSubjectRecordTypeId: string | undefined;
    selectedReadTypesByFlow: Map<string, ReadonlyMap<string, string>>;
  }>,
  { placementId, formId }: ReturnType<typeof collectPlacements>[number],
): void => {
  const {
    application,
    recordTypeByPlacement,
    bindings,
    pageDefinition,
    pageSubjectRecordTypeId,
    selectedReadTypesByFlow,
  } = input;
  const held = application.content.flowBindings.filter((binding) =>
    sameId(binding.controlId, placementId),
  );
  if (held.length > 0) {
    const placementRecordTypeId =
      recordTypeByPlacement.get(placementId.toLowerCase()) ??
      (formId === undefined ? undefined : recordTypeByPlacement.get(formId.toLowerCase()));
    bindings[placementId] = held.map((binding) => {
      // An action selects the page subject, so a foreign placement cannot lend it a record type.
      const selectedRecordTypeId =
        binding.event === "action"
          ? (pageDefinition.type === "detail" || pageDefinition.type === "form") &&
            pageSubjectRecordTypeId !== undefined &&
            (placementRecordTypeId === undefined ||
              sameId(placementRecordTypeId, pageSubjectRecordTypeId))
            ? pageSubjectRecordTypeId
            : undefined
          : placementRecordTypeId;
      const selectedReadTypes =
        selectedReadTypesByFlow.get(String(binding.flow.flowId).toLowerCase()) ??
        new Map<string, string>();
      const selectedReadInputs = Object.entries(binding.flow.inputs).flatMap(
        ([inputName, input]) => {
          const selectedRecordTypeId = selectedReadTypes.get(inputName);
          return selectedRecordTypeId !== undefined &&
            isRecord(input) &&
            input.kind === "caller" &&
            typeof input.name === "string"
            ? [{ callerInputName: input.name, recordTypeId: selectedRecordTypeId }]
            : [];
        },
      );
      return {
        bindingId: binding.bindingId,
        eventId: binding.eventId,
        event: binding.event,
        flowId: binding.flow.flowId,
        callerInputs: Object.values(binding.flow.inputs).flatMap((input) =>
          typeof input === "object" && input !== null && input.kind === "caller"
            ? [input.name]
            : [],
        ),
        ...(selectedRecordTypeId === undefined ? {} : { recordTypeId: selectedRecordTypeId }),
        ...(selectedReadInputs.length === 0 ? {} : { selectedReadInputs }),
      };
    });
  }
};

/**
 * Whether a placement's data comes only from its own bound query: nothing else on the page waits
 * for it and it never decides the page's availability, so the page may stream it after the frame.
 * Every placement this accepts writes its data entry in {@link readPlacement}.
 */
export const isStreamablePlacement = ({
  placement,
}: ReturnType<typeof collectPlacements>[number]): boolean => {
  if (typeof placement.queryId !== "string" || hasReferenceChoiceSource(placement)) return false;
  const block = placement.block;
  const blockIs = (release: Readonly<{ blockId: string }>): boolean =>
    isRecord(block) && typeof block.blockId === "string" && sameId(block.blockId, release.blockId);
  if (blockIs(ATTACHMENT_LIST_BLOCK_RELEASE) || blockIs(CALENDAR_BLOCK_RELEASE)) return false;
  const settings = placement.settings as Readonly<Record<string, BlockPropertyValueContract>>;
  return (
    readRecordsTableContract(settings) !== undefined ||
    readRecordDetailContract(settings) !== undefined ||
    blockIs(QUERY_NOTICE_BLOCK_RELEASE) ||
    blockIs(LINK_TILES_BLOCK_RELEASE) ||
    blockIs(SUMMARY_VALUES_BLOCK_RELEASE) ||
    blockIs(CHART_BLOCK_RELEASE) ||
    isApplicationLauncherPlacement(placement) ||
    isBoardPlacement(placement)
  );
};

export const readPlacement = async (
  input: {
    pageDefinition: PageDefinition;
    pageSubjectRecordTypeId: string | undefined;
    data: Record<string, PageDataState>;
    page: Parameters<typeof collectPlacements>[0];
    context: InstalledRuntimeContext;
    referenceChoiceInputs: Array<ApplicationPageModel["referenceChoiceInputs"][number]>;
    referenceChoices: ReturnType<typeof createReferenceChoiceService>;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    referenceChoiceFirstPages: Map<string, ReferenceChoiceFirstPage>;
    address: ApplicationPageLoaderAddress;
    subjectType: PageSubjectType | undefined;
    parameters: SearchParameters;
    dependencies: HumanOrganizationRequestDependencies;
    subjectId: ReturnType<typeof recordIdSchema.safeParse>;
    readSubject: (recordTypeId: string, recordId: string) => Promise<PageSubjectReadResult>;
    linkTiles: ReturnType<typeof createLinkTilesQueryResolver>;
    queryNotices: ReturnType<typeof createQueryNoticeQueryResolver>;
    boardContinuation: BoardContinuationTarget | undefined;
    permittedApplicationKeys: string[] | undefined;
    permittedApplicationsRead: PermittedApplicationsRead | undefined;
    queries: ReturnType<typeof createProtectedQueryService>;
    readCalendarSettings: Parameters<typeof readCalendarPlacement>[0]["readCalendarSettings"];
    tables: ReturnType<typeof createRecordsTableQueryResolver>;
    resolveRecordLinks: RecordLinkResolver;
    tableContinuation: TableContinuationTarget | undefined;
    adoptSubjectRead: (subject: PageSubjectReadResult) => void;
    markSubjectUnreadable: () => void;
  },
  { placementId, placement, formId }: ReturnType<typeof collectPlacements>[number],
): Promise<void> => {
  const {
    pageDefinition,
    pageSubjectRecordTypeId,
    data,
    page,
    context,
    referenceChoiceInputs,
    referenceChoices,
    session,
    selection,
    referenceChoiceFirstPages,
    address,
    subjectType,
    parameters,
    dependencies,
    subjectId,
    readSubject,
    linkTiles,
    queryNotices,
    boardContinuation,
    permittedApplicationKeys,
    permittedApplicationsRead,
    queries,
    readCalendarSettings,
    tables,
    resolveRecordLinks,
    tableContinuation,
    adoptSubjectRead,
    markSubjectUnreadable,
  } = input;
  const block = placement.block;
  const isAttachmentListBlock =
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, ATTACHMENT_LIST_BLOCK_RELEASE.blockId);
  const isCalendarBlock =
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, CALENDAR_BLOCK_RELEASE.blockId);
  const isQueryNoticeBlock =
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, QUERY_NOTICE_BLOCK_RELEASE.blockId);
  const isLinkTilesBlock =
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, LINK_TILES_BLOCK_RELEASE.blockId);
  const isSummaryValuesBlock =
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, SUMMARY_VALUES_BLOCK_RELEASE.blockId);
  const isChartBlock =
    isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, CHART_BLOCK_RELEASE.blockId);
  const settings = placement.settings as Readonly<Record<string, BlockPropertyValueContract>>;
  if (
    isLinkTilesBlock &&
    (!isRecord(block) ||
      (block.releaseVersion !== LINK_TILES_BLOCK_RELEASE.releaseVersion &&
        block.releaseVersion !== RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion &&
        block.releaseVersion !== APPLICATION_PAGE_LINK_TILES_BLOCK_RELEASE.releaseVersion) ||
      projectedUseAvailability(placement) !== "available")
  ) {
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const calendarContract = isCalendarBlock ? readCalendarPlacementContract(settings) : undefined;
  const isBoardBlock = isBoardPlacement(placement);
  const tableContract = readRecordsTableContract(settings);
  const detailContract =
    tableContract === undefined ? readRecordDetailContract(settings) : undefined;
  if (hasReferenceChoiceSource(placement)) {
    const form =
      formId === undefined
        ? undefined
        : projectedReferenceChoiceForm(page, context.releaseSet.modules, formId);
    const field = form?.placements.get(placementId);
    if (field === undefined || formId === undefined) {
      logPlacementFailure(address, placementId, "choice_settings_invalid");
      data[placementId] = { status: "disabled", reason: "Choices unavailable" };
      return;
    }
    const parent =
      field.dependency === undefined
        ? undefined
        : [...(form?.placements ?? [])].find(
            ([, candidate]) => candidate.fieldKey === field.dependency?.fromField,
          );
    referenceChoiceInputs.push({
      placementId,
      formId,
      fieldKey: field.fieldKey,
      releaseVersion: field.releaseVersion,
      ...(parent === undefined
        ? {}
        : {
            dependency: { fieldKey: parent[1].fieldKey, placementId: parent[0] },
          }),
    });
    if (field.dependency !== undefined) {
      data[placementId] = {
        status: "ready",
        values: projectReferenceChoiceInputValues([], null, undefined, { dependencyKey: null }),
      };
      return;
    }
    const result = await referenceChoices.run(session, selection, field.command);
    if (
      result.kind !== "available" ||
      result.value.outcome !== "completed" ||
      result.value.kind !== "record_reference"
    ) {
      data[placementId] = { status: "disabled", reason: "Choices unavailable" };
      return;
    }
    referenceChoiceFirstPages.set(placementId, {
      field,
      choices: result.value.choices,
      ...(result.value.nextContinuationToken === undefined
        ? {}
        : { nextContinuationToken: result.value.nextContinuationToken }),
    });
    data[placementId] = {
      status: "ready",
      values: projectReferenceChoiceInputValues(
        result.value.choices,
        undefined,
        undefined,
        result.value.nextContinuationToken === undefined
          ? {}
          : { nextContinuationToken: result.value.nextContinuationToken },
      ),
    };
    const initialRaw =
      field.initialValue === undefined
        ? undefined
        : first(parameters[field.initialValue.pageParameter]);
    if (initialRaw !== undefined) {
      const initialRecordId = recordIdSchema.safeParse(initialRaw);
      if (!initialRecordId.success) {
        logPlacementFailure(address, placementId, "choice_initial_value_invalid");
        return;
      }
      const initial = await projectInitialReferenceChoice({
        firstPage: referenceChoiceFirstPages.get(placementId)!,
        recordId: initialRecordId.data,
        service: referenceChoices,
        session,
        selection,
      });
      if (initial === undefined)
        logPlacementFailure(address, placementId, "choice_initial_value_unavailable");
      else data[placementId] = initial;
    }
    return;
  }
  if (isAttachmentListBlock) {
    await readAttachmentListPlacement({
      block,
      placement,
      pageDefinition,
      subjectType,
      pageSubjectRecordTypeId,
      data,
      placementId,
      settings,
      context,
      parameters,
      dependencies,
      session,
      selection,
      page,
      adoptSubjectRead,
    });
    return;
  }
  if (isCalendarBlock && calendarContract === undefined) {
    logPlacementFailure(address, placementId, "calendar_settings_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const queryId = typeof placement.queryId === "string" ? placement.queryId : undefined;
  const queryBoundLauncher = isApplicationLauncherPlacement(placement) && queryId !== undefined;
  const queryBoundSummary = (isSummaryValuesBlock || isChartBlock) && queryId !== undefined;
  const queryBoundBoard = isBoardBlock && queryId !== undefined;
  if (
    tableContract === undefined &&
    detailContract === undefined &&
    !isCalendarBlock &&
    !isQueryNoticeBlock &&
    !isLinkTilesBlock &&
    !queryBoundLauncher &&
    !queryBoundSummary &&
    !queryBoundBoard
  )
    return;
  // A Record detail on a detail or public page that binds no query reads its page subject: the
  // one record the page's own address names, of the page's declared record type, through the
  // record read path under the viewer's own authority. A public page shows no more than its
  // declared public fields. Nothing here comes from the browser except the id.
  if (detailContract !== undefined && queryId === undefined) {
    const subjectFieldIds =
      pageDefinition.type === "public" ? pageDefinition.publicFieldIds.map(String) : undefined;
    if (subjectType === undefined || pageDefinition.type === "form") {
      logPlacementFailure(address, placementId, "query_not_bound");
      data[placementId] = { status: "error" };
      return;
    }
    if (!subjectId.success) {
      markSubjectUnreadable();
      data[placementId] = { status: "refused", reason: "not_found" };
      return;
    }
    const subjectModule = context.releaseSet.modules.find((module) =>
      sameId(String(module.rootId), String(subjectType.moduleRootId)),
    );
    const subject = await readSubject(String(subjectType.recordTypeId), subjectId.data);
    if (subject.kind === "temporarily_unavailable") {
      logPlacementFailure(address, placementId, "subject_unavailable");
      data[placementId] = { status: "error" };
      return;
    }
    if (subject.kind === "refused") {
      markSubjectUnreadable();
      data[placementId] = { status: "refused", reason: "not_found" };
      return;
    }
    const subjectLinks = await readRecordLinks(resolveRecordLinks, [subject.row]);
    const display = projectRecordDetailData(
      {
        settings,
        ...(subjectLinks === undefined ? {} : { recordLinks: subjectLinks }),
        ...(subjectModule === undefined
          ? {}
          : {
              fieldLabels: fieldLabelsOf(subjectModule),
              fieldChoiceLabels: fieldChoiceLabelsOf(subjectModule),
              fieldDateTypes: fieldDateTypesOf(subjectModule),
              fieldLinkTypes: fieldLinkTypesOf(subjectModule),
            }),
        ...(subjectFieldIds === undefined ? {} : { readableFieldIds: subjectFieldIds }),
      },
      [subject.row],
    );
    data[placementId] =
      display === undefined
        ? { status: "refused", reason: "not_found" }
        : display.status === "empty"
          ? { status: "empty" }
          : { status: "ready", values: display.values };
    return;
  }

  const bound = queryId === undefined ? undefined : findModuleQuery(context, queryId);
  if (queryId === undefined || bound === undefined) {
    logPlacementFailure(address, placementId, "query_not_bound");
    data[placementId] = { status: "error" };
    return;
  }
  const declaredInput = (input: string) =>
    bound.query.inputs.find((declared) => declared.key === input);
  const fieldLabels = fieldLabelsOf(bound.module);

  if (isLinkTilesBlock) {
    const inputValues: Record<string, JsonValue> = {};
    let invalidInput = false;
    for (const declared of bound.query.inputs) {
      const raw = first(parameters[declared.key]);
      const value = raw === undefined ? undefined : noticeQueryInput(raw, declared);
      if (raw !== undefined && value === undefined) invalidInput = true;
      if (value !== undefined) inputValues[declared.key] = value;
    }
    if (invalidInput) {
      data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }
    const result = await linkTiles.resolve(
      session,
      selection,
      context,
      queryId,
      settings,
      inputValues,
      isRecord(block) && typeof block.releaseVersion === "string" ? block.releaseVersion : "",
    );
    data[placementId] =
      result.status === "ready" && result.values.rows.length === 0 ? { status: "empty" } : result;
    return;
  }

  if (isQueryNoticeBlock) {
    if (!isRecord(block) || block.releaseVersion !== QUERY_NOTICE_BLOCK_RELEASE.releaseVersion) {
      data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }
    const inputValues: Record<string, JsonValue> = {};
    let invalidInput = false;
    for (const declared of bound.query.inputs) {
      const raw = first(parameters[declared.key]);
      const value = raw === undefined ? undefined : noticeQueryInput(raw, declared);
      if (raw !== undefined && value === undefined) invalidInput = true;
      if (value !== undefined) inputValues[declared.key] = value;
    }
    if (invalidInput) {
      data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }
    data[placementId] = await queryNotices.resolve(
      session,
      selection,
      context,
      queryId,
      settings,
      inputValues,
    );
    return;
  }

  if (queryBoundBoard) {
    const continuation =
      boardContinuation !== undefined && sameId(boardContinuation.placementId, placementId)
        ? boardContinuation.request
        : undefined;
    const projection = await projectBoardPlacement({
      context,
      session,
      selection,
      placement: placement as unknown as Parameters<typeof projectBoardPlacement>[0]["placement"],
      parameters,
      queries,
      ...(continuation === undefined ? {} : { continuation }),
    });
    if (projection.outcome === "ready") {
      try {
        data[placementId] = parseDisplayData(
          { status: "ready", values: projection.values },
          parseBoardPayload,
        );
      } catch (error) {
        logPlacementFailure(address, placementId, "board_payload_invalid", describeFailure(error));
        data[placementId] = { status: "error" };
      }
      return;
    }
    logPlacementFailure(address, placementId, projection.cause, projection.detail);
    data[placementId] =
      projection.outcome === "unavailable"
        ? { status: "error" }
        : { status: "refused", reason: "not_permitted" };
    return;
  }

  if (queryBoundLauncher) {
    if (permittedApplicationKeys === undefined) {
      data[placementId] =
        permittedApplicationsRead?.kind === "temporarily_unavailable"
          ? { status: "error" }
          : { status: "refused", reason: "not_permitted" };
      return;
    }
    const target = bound.query.recordType;
    if (target.state !== "resolved") {
      logPlacementFailure(address, placementId, "launcher_query_invalid");
      data[placementId] = { status: "error" };
      return;
    }
    const targetModule = context.releaseSet.modules.find((module) =>
      sameId(String(module.rootId), String(target.moduleRootId)),
    );
    const targetRecordType = targetModule?.content.recordTypes.find((recordType) =>
      sameId(String(recordType.recordTypeId), String(target.recordTypeId)),
    );
    if (targetRecordType === undefined) {
      logPlacementFailure(address, placementId, "launcher_query_invalid");
      data[placementId] = { status: "error" };
      return;
    }
    const inputValues: Record<string, JsonValue> = {};
    for (const declared of bound.query.inputs) {
      const raw = first(parameters[declared.key]);
      const value = raw === undefined ? undefined : coerceInput(raw, declared);
      if (value !== undefined) inputValues[declared.key] = value;
    }
    const command = protectedQueryCommandSchema.safeParse({
      moduleRootId: bound.module.rootId,
      queryId: bound.query.queryId,
      inputValues,
      requestedFieldIds: bound.query.selectedFieldIds,
      requestedSystemFieldKeys: [],
      sort: [],
      sortableFieldIds: [],
      filterableFieldIds: [],
      searchableFieldIds: [],
      pageSize: bound.query.pageSize,
    });
    if (!command.success) {
      logPlacementFailure(address, placementId, "launcher_query_invalid");
      data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }

    const queryRows: ProtectedQueryRow[] = [];
    const seenContinuationTokens = new Set<string>();
    let continuationToken: string | undefined;
    let failure: "unavailable" | "refused" | "too_many_rows" | undefined;
    do {
      const result = await queries.run(session, selection, {
        ...command.data,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      });
      if (result.kind === "temporarily_unavailable") {
        failure = "unavailable";
        break;
      }
      if (result.kind !== "available" || result.value.outcome !== "completed") {
        failure = "refused";
        break;
      }
      queryRows.push(...result.value.rows);
      if (queryRows.length > MAXIMUM_LAUNCHER_QUERY_ROWS) {
        failure = "too_many_rows";
        break;
      }
      const nextToken = result.value.nextContinuationToken;
      if (nextToken !== undefined && seenContinuationTokens.has(nextToken)) {
        failure = "too_many_rows";
        break;
      }
      if (nextToken !== undefined) seenContinuationTokens.add(nextToken);
      continuationToken = nextToken;
    } while (continuationToken !== undefined);

    if (failure !== undefined) {
      logPlacementFailure(
        address,
        placementId,
        failure === "unavailable" ? "launcher_query_unavailable" : "launcher_query_refused",
      );
      data[placementId] =
        failure === "unavailable"
          ? { status: "error" }
          : { status: "refused", reason: "not_permitted" };
      return;
    }

    const fieldKeys = new Map(
      targetRecordType.fields.map(
        (field) => [String(field.fieldId).toLowerCase(), field.key] as const,
      ),
    );
    const launcherRows: ApplicationLauncherQueryRow[] = queryRows.map((row) => {
      const cells: Record<string, { kind: "text"; text: string }> = {};
      for (const [fieldId, value] of Object.entries(row.values)) {
        const fieldKey = fieldKeys.get(fieldId.toLowerCase());
        if (fieldKey !== undefined && typeof value === "string")
          cells[fieldKey] = { kind: "text", text: value };
      }
      const key = cells.key;
      return { applicationKey: key?.kind === "text" ? key.text : undefined, cells };
    });
    const values = applicationLauncherQueryRowsToListValues(
      launcherRows,
      permittedApplicationKeys,
      launcherCellKey(settings, "name_key", "name"),
      launcherCellKey(settings, "icon_key", "icon"),
    );
    data[placementId] = { status: "ready", values };
    return;
  }

  if (queryBoundSummary) {
    const inputValues: Record<string, JsonValue> = {};
    for (const declared of bound.query.inputs) {
      const raw = first(parameters[declared.key]);
      const value = raw === undefined ? undefined : coerceInput(raw, declared);
      if (value !== undefined) inputValues[declared.key] = value;
    }
    const command = protectedQuerySummaryCommandSchema.safeParse({
      moduleRootId: bound.module.rootId,
      queryId: bound.query.queryId,
      inputValues,
    });
    if (!command.success) {
      logPlacementFailure(address, placementId, "summary_query_invalid");
      data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }

    let summaryResult: Awaited<ReturnType<typeof queries.summarise>>;
    try {
      summaryResult = await queries.summarise(session, selection, command.data);
    } catch (error) {
      logPlacementFailure(address, placementId, "summary_query_threw", describeFailure(error));
      data[placementId] = { status: "error" };
      return;
    }
    if (summaryResult.kind === "temporarily_unavailable") {
      logPlacementFailure(address, placementId, "summary_query_unavailable");
      data[placementId] = { status: "error" };
      return;
    }
    if (summaryResult.kind !== "available" || summaryResult.value.outcome !== "completed") {
      const isDatasetLimitExceeded =
        summaryResult.kind === "available" &&
        summaryResult.value.outcome === "refused" &&
        summaryResult.value.reasonCode === "dataset_limit_exceeded";
      logPlacementFailure(
        address,
        placementId,
        isDatasetLimitExceeded ? "summary_dataset_limit_exceeded" : "summary_query_refused",
        summaryResult.kind === "available" && summaryResult.value.outcome === "refused"
          ? summaryResult.value.reasonCode
          : summaryResult.kind,
      );
      data[placementId] = { status: "refused", reason: "not_permitted" };
      return;
    }

    if (isChartBlock) {
      const chartRecordType = bound.query.recordType;
      const chartFields = new Map(
        (chartRecordType.state === "resolved"
          ? (context.releaseSet.modules
              .find((module) => sameId(String(module.rootId), String(chartRecordType.moduleRootId)))
              ?.content.recordTypes.find((recordType) =>
                sameId(String(recordType.recordTypeId), String(chartRecordType.recordTypeId)),
              )?.fields ?? [])
          : []
        ).map((field) => [String(field.fieldId).toLowerCase(), field] as const),
      );
      // One labelled read per chart for the linked groups, never one per bar.
      const groupLinks = collectRecordLinkValues(
        summaryResult.value.groups.flatMap((group) => Object.values<JsonValue>(group.groupValues)),
      );
      const groupLabels =
        groupLinks.length === 0 ? undefined : await resolveRecordLinks(groupLinks);
      const projection = projectChartPlacement({
        settings,
        query: bound.query,
        fields: chartFields,
        summary: summaryResult.value,
        ...(groupLabels === undefined ? {} : { recordLinks: groupLabels }),
      });
      if (!projection.ok) {
        logPlacementFailure(address, placementId, projection.code);
        data[placementId] = { status: "error" };
        return;
      }
      data[placementId] =
        projection.chart.points.length === 0
          ? { status: "empty" }
          : { status: "ready", values: projection.chart };
      return;
    }

    const declaredAggregates = bound.query.aggregates;
    const projectedAggregates = summaryResult.value.aggregates;
    const aliases = declaredAggregates.map((aggregate) => aggregate.alias);
    const resultAliases = Object.keys(projectedAggregates);
    if (
      resultAliases.length !== aliases.length ||
      aliases.some((alias) => !Object.hasOwn(projectedAggregates, alias))
    ) {
      logPlacementFailure(address, placementId, "summary_result_invalid");
      data[placementId] = { status: "error" };
      return;
    }

    const recordTypeReference = bound.query.recordType;
    const summaryRecordType =
      recordTypeReference.state === "resolved"
        ? context.releaseSet.modules
            .find((module) =>
              sameId(String(module.rootId), String(recordTypeReference.moduleRootId)),
            )
            ?.content.recordTypes.find((recordType) =>
              sameId(String(recordType.recordTypeId), String(recordTypeReference.recordTypeId)),
            )
        : undefined;
    const fieldById = new Map(
      (summaryRecordType?.fields ?? []).map((field) => [
        String(field.fieldId).toLowerCase(),
        field,
      ]),
    );
    const values: Array<{
      key: string;
      label: string;
      value: DisplayCellValue | Readonly<{ kind: "unavailable" }>;
    }> = [];
    let invalidAggregate = false;
    for (const aggregate of declaredAggregates) {
      const field =
        aggregate.fieldId === undefined
          ? undefined
          : fieldById.get(aggregate.fieldId.toLowerCase());
      const value = summaryAggregateCellValue(
        aggregate,
        field,
        projectedAggregates[aggregate.alias]!,
      );
      if (value === undefined) {
        invalidAggregate = true;
        break;
      }
      values.push({
        key: aggregate.alias,
        label: summaryAggregateLabel(aggregate.alias) || aggregate.alias,
        value,
      });
    }
    if (invalidAggregate) {
      logPlacementFailure(address, placementId, "summary_result_invalid");
      data[placementId] = { status: "error" };
    } else if (values.length === 0) data[placementId] = { status: "empty" };
    else
      data[placementId] = {
        status: "ready",
        values: { kind: "summary_values", values },
      };
    return;
  }

  if (isCalendarBlock && calendarContract !== undefined) {
    await readCalendarPlacement({
      readCalendarSettings,
      address,
      placementId,
      data,
      page,
      bound,
      calendarContract,
      parameters,
      queries,
      session,
      selection,
      resolveRecordLinks,
    });
    return;
  }

  if (tableContract !== undefined) {
    const pageParameters: Record<string, JsonValue> = {};
    for (const parameter of tableContract.parameters) {
      const raw =
        parameter.pageParameter === undefined
          ? undefined
          : first(parameters[parameter.pageParameter]);
      const declared = declaredInput(parameter.input);
      const value =
        raw === undefined || declared === undefined ? undefined : coerceInput(raw, declared);
      if (parameter.pageParameter !== undefined && value !== undefined)
        pageParameters[parameter.pageParameter] = value;
    }
    const state = requestState(placementId, parameters);
    const explicitRequest =
      tableContinuation !== undefined && sameId(tableContinuation.placementId, placementId)
        ? tableContinuation.request
        : undefined;
    // An explicit page request wins; otherwise the page position in the address is honoured.
    const addressRequest =
      explicitRequest === undefined
        ? parseTablePagePosition(first(parameters[tablePageParameterName(placementId)]))
        : undefined;
    const readPage = (request: TablePageRequest | undefined) =>
      tables.resolve(session, selection, {
        moduleRootId: bound.module.rootId,
        queryId: bound.query.queryId,
        settings,
        pageParameters,
        fieldLabels,
        fieldChoiceLabels: fieldChoiceLabelsOf(bound.module),
        fieldDateTypes: fieldDateTypesOf(bound.module),
        fieldLinkTypes: fieldLinkTypesOf(bound.module),
        resolveRecordLinks,
        page: request?.page ?? 1,
        ...(request === undefined ? {} : { pageDirection: request.pageDirection }),
        ...(request?.continuationToken === undefined
          ? {}
          : { continuationToken: request.continuationToken }),
        sort: state.sort,
        filters: state.filters,
        search: state.search,
      });
    const fromAddress =
      addressRequest !== undefined ||
      (explicitRequest !== undefined && tableContinuation?.fromAddress === true);
    let resolved = await readPage(explicitRequest ?? addressRequest);
    // A shared link opened by another account, or after an access, release, sort or filter
    // change, no longer matches its sealed cursor (invalid or stale): it opens the first page
    // without an error.
    if (
      fromAddress &&
      resolved.kind === "refused" &&
      (resolved.reasonCode === "cursor_invalid" || resolved.reasonCode === "cursor_stale")
    )
      resolved = await readPage(undefined);
    if (resolved.kind === "unavailable") {
      console.error(
        "[page] data placement unavailable: class=protected_query code=query_unavailable",
      );
      data[placementId] = { status: "error" };
    } else if (resolved.kind === "refused") {
      console.error(
        `[page] data placement refused: class=${resolved.reasonCode === undefined ? "records_table" : "protected_query"} code=${resolved.reasonCode ?? "query_refused"}`,
      );
      data[placementId] = { status: "refused", reason: "not_permitted" };
    } else if (resolved.display.status === "empty") data[placementId] = { status: "empty" };
    else
      data[placementId] = {
        status: "ready",
        values: {
          ...resolved.display.values,
          ...(state.sort === null
            ? {}
            : { sort: { columnKey: state.sort.fieldId, direction: state.sort.direction } }),
        },
      };
    return;
  }

  const queryRecordType = bound.query.recordType;
  const detailModule =
    queryRecordType.state === "resolved"
      ? context.releaseSet.modules.find((module) =>
          sameId(String(module.rootId), String(queryRecordType.moduleRootId)),
        )
      : undefined;
  if (detailModule === undefined) {
    logPlacementFailure(address, placementId, "detail_record_type_unavailable");
    data[placementId] = { status: "error" };
    return;
  }

  // A Record detail reads only the inputs its bound query declares, from the page's own query
  // string; the Query engine validates each against the declared type and refuses the rest.
  const inputValues: Record<string, JsonValue> = {};
  for (const declared of bound.query.inputs) {
    const raw = first(parameters[declared.key]);
    const value = raw === undefined ? undefined : coerceInput(raw, declared);
    if (value !== undefined) inputValues[declared.key] = value;
  }
  const fieldIds = [...new Set(detailContract!.fields.map((field) => field.field))];
  const command = protectedQueryCommandSchema.safeParse({
    moduleRootId: bound.module.rootId,
    queryId: bound.query.queryId,
    inputValues,
    requestedFieldIds: fieldIds,
    requestedSystemFieldKeys: [],
    sort: [],
    sortableFieldIds: [],
    filterableFieldIds: [],
    searchableFieldIds: [],
    pageSize: 1,
  });
  if (!command.success) {
    logPlacementFailure(address, placementId, "detail_command_invalid");
    data[placementId] = { status: "refused", reason: "not_permitted" };
    return;
  }
  const result = await queries.run(session, selection, command.data);
  if (result.kind === "temporarily_unavailable") {
    logPlacementFailure(address, placementId, "detail_query_unavailable");
    data[placementId] = { status: "error" };
  } else if (result.kind !== "available" || result.value.outcome !== "completed") {
    logPlacementFailure(address, placementId, "detail_query_refused");
    data[placementId] = { status: "refused", reason: "not_permitted" };
  } else {
    const rows: readonly ProtectedQueryRow[] = result.value.rows;
    const detailLinks = await readRecordLinks(resolveRecordLinks, rows);
    const display = projectRecordDetailData(
      {
        settings,
        ...(detailLinks === undefined ? {} : { recordLinks: detailLinks }),
        fieldLabels: fieldLabelsOf(detailModule),
        fieldChoiceLabels: fieldChoiceLabelsOf(detailModule),
        fieldDateTypes: fieldDateTypesOf(detailModule),
        fieldLinkTypes: fieldLinkTypesOf(detailModule),
      },
      rows,
    );
    data[placementId] =
      display === undefined
        ? { status: "refused", reason: "not_found" }
        : display.status === "empty"
          ? { status: "empty" }
          : { status: "ready", values: display.values };
  }
};
