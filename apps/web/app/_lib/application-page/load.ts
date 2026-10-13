import {
  type HumanOrganizationRequestDependencies,
  createHumanInstalledPageBundleContextLoader,
  createStoredPageCapabilityService,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  decideOrganizationAccessBatch,
  createStoredNavigationProjectionService,
  createProtectedQueryService,
  createReferenceChoiceService,
  createRecordsTableQueryResolver,
  createQueryNoticeQueryResolver,
  createViewerSafeRecordLinkService,
  createLinkTilesQueryResolver,
  createPageSubjectReader,
  type PageSubjectReadResult,
  readCurrentRecordOwnerGroupsAfterAuthorization,
} from "@web/platform-server";
import { FORM_CONTAINER_BLOCK_RELEASE } from "@vortex/platform/server";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type BlockPropertyValueContract,
  readRecordDetailContract,
  readRecordsTableContract,
  organizationRuntimeSettingsSchema,
  type OrganizationAccessDeclaration,
  recordIdSchema,
  type FlowTask,
  flowTaskChildLists,
  type JsonValue,
  fieldIdSchema,
  sameId,
  isRecord,
} from "@vortex/platform/schema";
import { createApplicationPageLinkReader } from "../application-page-link";
import { readApplicationReleaseAdoption } from "../application-release-adoption";
import { getQueryContinuationKey } from "../query-continuation-key";
import { loadPermittedApplicationsAtAddress } from "../organization-context";
import {
  getGuidedFormRecordType,
  getGuidedFormStepFields,
  getGuidedFormVisiblePlacementIds,
  getGuidedFormFlowId,
  guidedFormDraftScope,
  openGuidedFormDraft,
  guidedFormInitialValues,
  visibleGuidedFormValues,
  computeGuidedFormStepId,
  earlierGuidedStepId,
  guidedFormInputData,
  visibleGuidedFormValidation,
} from "@vortex/platform/server";
import { guidedFormDependencies } from "../guided-form-dependencies";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequests,
} from "../server-composition";
import type {
  ApplicationPageLoaderAddress,
  SearchParameters,
  BoardContinuationTarget,
  TableContinuationTarget,
  ApplicationPageInternalResult,
  PermissionEntry,
  DateTimeZones,
  PageDataState,
  PlacementFlowBinding,
  ApplicationPageModel,
} from "./types";
import {
  first,
  pageSubjectParameter,
  projectedBodyContentAvailable,
  collectPlacements,
  isBoardPlacement,
  projectedUseAvailability,
  isTablePlacement,
  fieldControl,
  fieldForPlacement,
  isEditFieldPlacement,
  isUnboundReferenceChoicePlacement,
} from "./placement-helpers";
import { isApplicationLauncherPlacement } from "./query-helpers";
import {
  type ReferenceChoiceFirstPage,
  projectSelectedReferenceChoiceEditField,
  projectEditField,
} from "./reference-choice";
import { projectPlacementRecordTypes, projectFlowBindingTargets } from "./flow-bindings";
import { readPlacement } from "./placement-reader";
import { projectPageWebMcpTools } from "./webmcp-projection";

export const requestDependencies = (): HumanOrganizationRequestDependencies =>
  humanOrganizationRequestDependencies();

/** The exact installed runtime context, read once under the person's own verified request scope. */
export const loadInstalledContext = (
  session: IdentitySession,
  dependencies: HumanOrganizationRequestDependencies,
  selection: OrganizationSelectionCandidate,
) =>
  humanOrganizationRequests(dependencies.identityAuthorityId).run(
    session,
    selection,
    async (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
      return createHumanInstalledPageBundleContextLoader({
        transaction,
        scope: { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
      }).load();
    },
  );

/**
 * Loads one page. Reads the loader starts ahead of where their results are consulted are joined
 * before it returns or throws, whichever path it takes, so no HUMAN request outlives the loader.
 */
export const loadApplicationPageInternal = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  selectedPlacementIds?: ReadonlySet<string>,
  boardContinuation?: BoardContinuationTarget,
  expectedInstallationRevision?: number,
  tableContinuation?: TableContinuationTarget,
): Promise<ApplicationPageInternalResult> => {
  const startedReads: Promise<unknown>[] = [];
  try {
    return await loadApplicationPageJoined(startedReads, session, address, parameters,
      selectedPlacementIds, boardContinuation, expectedInstallationRevision, tableContinuation);
  } finally {
    await Promise.allSettled(startedReads);
  }
};

const loadApplicationPageJoined = async (
  startedReads: Promise<unknown>[],
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  selectedPlacementIds?: ReadonlySet<string>,
  boardContinuation?: BoardContinuationTarget,
  expectedInstallationRevision?: number,
  tableContinuation?: TableContinuationTarget,
): Promise<ApplicationPageInternalResult> => {
  if (boardContinuation !== undefined && tableContinuation !== undefined)
    return { kind: "unavailable" };
  const dependencies = requestDependencies();
  const initialContinuationKey =
    expectedInstallationRevision === undefined ? getQueryContinuationKey() : undefined;
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
  };

  // The installed context is read once, under the person's own verified request scope. The address
  // resolution of this same request already read it for exactly this organisation and application;
  // that context is reused unless the caller expects a different installed revision.
  const carried = address.installedContext;
  const reusable =
    carried !== undefined &&
    sameId(carried.organizationId, selection.organizationId) &&
    sameId(carried.applicationRootId, address.application.applicationRootId) &&
    (expectedInstallationRevision === undefined ||
      carried.applicationReleaseRevision === expectedInstallationRevision)
      ? carried
      : undefined;
  const loaded =
    reusable === undefined
      ? await loadInstalledContext(session, dependencies, selection)
      : ({ kind: "available", value: reusable } as const);
  if (loaded.kind !== "available") return loaded;
  const context = loaded.value;
  if (
    expectedInstallationRevision !== undefined &&
    context.applicationReleaseRevision !== expectedInstallationRevision
  )
    return { kind: "reload" };

  const continuationKey = initialContinuationKey ?? getQueryContinuationKey();
  const application = context.releaseSet.application;

  // The offered release is read under the viewer's own application scope. A refusal or an absent
  // target reads as "nothing to adopt"; publishing a release alone never changes this page.
  const adoptionRead =
    selectedPlacementIds === undefined
      ? readApplicationReleaseAdoption(session, {
          organizationId: context.organizationId,
          applicationRootId: context.applicationRootId,
        })
      : undefined;

  const pageDefinition = application.content.pages.find((page) => page.key === address.pageKey);
  if (pageDefinition === undefined) {
    await adoptionRead;
    return { kind: "unavailable" };
  }

  const conditionSubjectId = first(parameters[pageSubjectParameter]);
  const pageService = createStoredPageCapabilityService({
    ...dependencies,
    context,
    selection: {
      pageId: pageDefinition.pageId,
      ...(conditionSubjectId === undefined ? {} : { subjectRecordId: conditionSubjectId }),
    },
  });
  // The adoption read, the page projection and the navigation projection are independent reads of
  // the same installed context, each under its own HUMAN request; they run together and their
  // results are still consulted in the original order.
  const projectedPageRead = pageService.project(session, selection);
  const navigationRead = createStoredNavigationProjectionService({
    ...dependencies,
    context,
  }).project(session, selection);
  // A failure is rethrown where its result is consulted, never left unobserved meanwhile, and
  // both reads are joined before the loader returns on any path (early returns included).
  void projectedPageRead.catch(() => undefined);
  void navigationRead.catch(() => undefined);
  startedReads.push(projectedPageRead, navigationRead);
  const adoptionTarget = await adoptionRead;
  const projectedPage = await projectedPageRead;
  if (projectedPage.kind !== "available") return projectedPage;
  // An undefined projection is the page refused for this viewer: never an empty page.
  if (projectedPage.value === undefined) return { kind: "unavailable" };
  // The page capability projection is authoritative, but its derived choice settings still
  // contain every declared option. Work on a copy so gated options never reach the browser.
  const page = structuredClone(projectedPage.value);
  const bodyContentAvailable =
    pageDefinition.type === "guided_form"
      ? undefined
      : projectedBodyContentAvailable(pageDefinition, application.content.shells, page);
  const allPlacements = collectPlacements(page);
  if (boardContinuation !== undefined) {
    const targets = allPlacements.filter(({ placementId }) =>
      sameId(placementId, boardContinuation.placementId),
    );
    const target = targets[0]?.placement;
    if (
      targets.length !== 1 ||
      !isBoardPlacement(target) ||
      projectedUseAvailability(target) !== "available"
    )
      return { kind: "unavailable" };
  }
  if (tableContinuation !== undefined) {
    const targets = allPlacements.filter(({ placementId }) =>
      sameId(placementId, tableContinuation.placementId),
    );
    const target = targets[0]?.placement;
    if (
      targets.length !== 1 ||
      !isTablePlacement(target) ||
      projectedUseAvailability(target) !== "available"
    )
      return { kind: "unavailable" };
  }
  const choicePlacements: Array<{
    options: Record<string, unknown>;
    items: unknown[];
    permissionKeys: readonly (string | undefined)[];
  }> = [];
  const gatedPermissions = new Map<string, PermissionEntry>();
  let needsDateTimeZones = false;
  for (const { placement } of allPlacements) {
    const control = fieldControl(placement);
    if (control === "date_time") needsDateTimeZones = true;
    if (control !== "choice" && control !== "several_choices") continue;
    const source = fieldForPlacement(placement, context.releaseSet.modules);
    const settings = placement.settings;
    const options = isRecord(settings) ? settings.options : undefined;
    if (
      source === undefined ||
      (source.field.type !== "choice" && source.field.type !== "several_choices") ||
      source.field.type !== control ||
      !isRecord(options) ||
      options.kind !== "list" ||
      !Array.isArray(options.items) ||
      options.items.length !== source.field.settings.options.length
    )
      return { kind: "temporarily_unavailable" };
    const permissionKeys: Array<string | undefined> = [];
    for (const [index, declared] of source.field.settings.options.entries()) {
      const item = options.items[index];
      if (
        !isRecord(item) ||
        !isRecord(item.properties) ||
        !isRecord(item.properties.key) ||
        !isRecord(item.properties.label) ||
        item.properties.key.value !== declared.value ||
        item.properties.label.value !== declared.label
      )
        return { kind: "temporarily_unavailable" };
      const permissionId = declared.requiredPermissionId;
      if (permissionId === undefined) {
        permissionKeys.push(undefined);
        continue;
      }
      const key = `${String(source.module.rootId).toLowerCase()}:${String(permissionId).toLowerCase()}`;
      const matches = context.permissionRegistration.entries.filter(
        (entry) =>
          entry.ownerKind === "module" &&
          sameId(String(entry.ownerId), String(source.module.rootId)) &&
          sameId(String(entry.permission.permissionId), String(permissionId)),
      );
      if (matches.length !== 1 || matches[0] === undefined)
        return { kind: "temporarily_unavailable" };
      gatedPermissions.set(key, matches[0]);
      permissionKeys.push(key);
    }
    choicePlacements.push({ options, items: options.items, permissionKeys });
  }

  const displayedFieldIds = new Set(
    allPlacements.flatMap(({ placement }) => {
      const settings = placement.settings;
      if (!isRecord(settings)) return [];
      const contractSettings = settings as Readonly<Record<string, BlockPropertyValueContract>>;
      const detail = readRecordDetailContract(contractSettings);
      const table = readRecordsTableContract(contractSettings);
      return [
        ...(detail?.fields.map((field) => field.field.toLowerCase()) ?? []),
        ...(table?.columns.map((column) => column.field.toLowerCase()) ?? []),
      ];
    }),
  );
  for (const module of context.releaseSet.modules)
    for (const recordType of module.content.recordTypes)
      for (const field of recordType.fields) {
        if (
          !displayedFieldIds.has(String(field.fieldId).toLowerCase()) ||
          (field.type !== "several_choices" && field.type !== "choice")
        )
          continue;
        for (const option of field.settings.options) {
          const permissionId = option.requiredPermissionId;
          if (permissionId === undefined) continue;
          const key = `${String(module.rootId).toLowerCase()}:${String(permissionId).toLowerCase()}`;
          const matches = context.permissionRegistration.entries.filter(
            (entry) =>
              entry.ownerKind === "module" &&
              sameId(String(entry.ownerId), String(module.rootId)) &&
              sameId(String(entry.permission.permissionId), String(permissionId)),
          );
          if (matches.length !== 1 || matches[0] === undefined)
            return { kind: "temporarily_unavailable" };
          gatedPermissions.set(key, matches[0]);
        }
      }

  let dateTimeZones: DateTimeZones = {};
  let allowedPermissions = new Set<string>();
  if (needsDateTimeZones || gatedPermissions.size > 0) {
    const authorized = await humanOrganizationRequests(dependencies.identityAuthorityId).run(
      session,
      selection,
      async (transaction, scope) => {
        const zones: DateTimeZones = {};
        if (needsDateTimeZones) {
          const profileRows = await transaction.query<{ time_zone: unknown }>`
            select time_zone from vortex_access.read_own_profile()
          `;
          if (profileRows.length !== 1 || profileRows[0] === undefined)
            throw new Error("PAGE_PROFILE_TIME_ZONE_UNAVAILABLE");
          const profileZone = profileRows[0].time_zone;
          if (profileZone !== null) {
            const parsed = organizationRuntimeSettingsSchema.shape.timeZone.safeParse(profileZone);
            if (!parsed.success) throw new Error("PAGE_PROFILE_TIME_ZONE_UNAVAILABLE");
            zones.personTimeZone = parsed.data;
          }
          const organizationSettings =
            await readCurrentOrganizationRuntimeSettingsAfterAuthorization(transaction);
          if (organizationSettings !== undefined)
            zones.organizationTimeZone = organizationSettings.timeZone;
        }
        const keys: string[] = [];
        const declarations: OrganizationAccessDeclaration[] = [];
        for (const [key, entry] of gatedPermissions) {
          const declaration: OrganizationAccessDeclaration = {
            operationKey: "application.page.field_choice.view",
            action: {
              actionKind: entry.permission.actionKind,
              ...(entry.permission.namedAction === undefined
                ? {}
                : { namedAction: entry.permission.namedAction }),
            },
            target: { kind: "application", applicationRootId: context.applicationRootId },
            requiredPermission: {
              applicationRootId: entry.applicationRootId,
              ownerKind: entry.ownerKind,
              ownerId: entry.ownerId,
              permissionId: entry.permission.permissionId,
            },
            recentAuthentication: { kind: "none" },
            authority: { kind: "permission" },
          };
          keys.push(key);
          declarations.push(declaration);
        }
        const decisions = await decideOrganizationAccessBatch(transaction, scope, declarations);
        const allowed = keys.filter((_, index) => decisions[index]?.allowed === true);
        return { zones, allowed, accessVersion: scope.accessVersion };
      },
    );
    if (authorized.kind !== "available") return authorized;
    if (page.accessVersion !== authorized.value.accessVersion)
      return { kind: "temporarily_unavailable" };
    dateTimeZones = authorized.value.zones;
    allowedPermissions = new Set(authorized.value.allowed);
  }
  for (const choice of choicePlacements)
    choice.options.items = choice.items.filter((_, index) => {
      const key = choice.permissionKeys[index];
      return key === undefined || allowedPermissions.has(key);
    });

  const navigation = await navigationRead;
  if (navigation.kind !== "available") return navigation;

  const queries = createProtectedQueryService({ ...dependencies, continuationKey });
  const referenceChoices = createReferenceChoiceService({ ...dependencies, continuationKey });
  const tables = createRecordsTableQueryResolver(queries);
  const queryNotices = createQueryNoticeQueryResolver(queries);
  const recordLinks = createViewerSafeRecordLinkService({
    ...dependencies,
    createInstalledContextLoader(transaction, scope) {
      if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
      return createHumanInstalledPageBundleContextLoader({
        transaction,
        scope: { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
      });
    },
  });
  const applicationPageLinks = createApplicationPageLinkReader({
    tenantShortName: address.tenantShortName,
    organizationShortName: address.organizationShortName,
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
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, worker));
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

  // The page subject: the one record the page's own address names, of the page's declared record
  // type, read once through the record read path under the viewer's own authority. Nothing here
  // comes from the browser except the id.
  const subjectType =
    (pageDefinition.type === "detail" ||
      pageDefinition.type === "public" ||
      pageDefinition.type === "form" ||
      pageDefinition.type === "guided_form") &&
    pageDefinition.recordType?.state === "resolved"
      ? pageDefinition.recordType
      : undefined;
  const subjectId = recordIdSchema.safeParse(first(parameters[pageSubjectParameter]));
  if (
    pageDefinition.type === "guided_form" &&
    first(parameters[pageSubjectParameter]) !== undefined &&
    !subjectId.success
  )
    return { kind: "unavailable" };
  let subjectRead: Promise<PageSubjectReadResult> | undefined;
  const readSubject = (recordTypeId: string, recordId: string): Promise<PageSubjectReadResult> =>
    (subjectRead ??= subjects.read(session, selection, { recordTypeId, recordId }));
  // A detail address always names one readable record, even if its authored placements do not
  // include a record-detail block. Other-org and unreadable IDs have the same outcome as absence.
  if (pageDefinition.type === "detail") {
    if (!subjectId.success || subjectType === undefined) return { kind: "unavailable" };
    const addressedSubject = await readSubject(String(subjectType.recordTypeId), subjectId.data);
    if (addressedSubject.kind === "temporarily_unavailable")
      return { kind: "temporarily_unavailable" };
    if (addressedSubject.kind !== "read") return { kind: "unavailable" };
  }

  if (
    selectedPlacementIds !== undefined &&
    [...selectedPlacementIds].some(
      (requestedId) => !allPlacements.some((entry) => sameId(entry.placementId, requestedId)),
    )
  )
    return { kind: "unavailable" };
  const editFormPlacementIds = new Set(
    allPlacements.flatMap(({ placementId, placement }) => {
      const block = placement.block;
      const isFormContainer =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
      const submitsPageRecord = application.content.flowBindings.some(
        (binding) =>
          sameId(binding.controlId, placementId) &&
          binding.event === "form_submit" &&
          Object.values(binding.flow.inputs).some(
            (input) => isRecord(input) && input.kind === "caller" && input.name === "record",
          ),
      );
      return isFormContainer && submitsPageRecord ? [placementId] : [];
    }),
  );
  // A form baseline is valid only when every declared field was projected. A selected field also
  // needs its owning form's subject read, even though only the requested field is returned.
  const selectedForProjection =
    selectedPlacementIds === undefined ? undefined : new Set(selectedPlacementIds);
  if (selectedForProjection !== undefined)
    for (const { placementId, placement, formId } of allPlacements) {
      const editFormId = editFormPlacementIds.has(placementId)
        ? placementId
        : formId !== undefined && editFormPlacementIds.has(formId)
          ? formId
          : undefined;
      if (editFormId === undefined) continue;
      if (
        selectedForProjection.has(editFormId.toLowerCase()) ||
        (isEditFieldPlacement(placement) && selectedForProjection.has(placementId.toLowerCase()))
      ) {
        selectedForProjection.add(editFormId.toLowerCase());
        for (const entry of allPlacements)
          if (
            entry.formId !== undefined &&
            sameId(entry.formId, editFormId) &&
            isEditFieldPlacement(entry.placement)
          )
            selectedForProjection.add(entry.placementId.toLowerCase());
      }
    }
  const placements =
    selectedForProjection === undefined
      ? allPlacements
      : allPlacements.filter((entry) => selectedForProjection.has(entry.placementId.toLowerCase()));
  const hasQueryBoundLauncher = placements.some(
    ({ placement }) =>
      isApplicationLauncherPlacement(placement) && typeof placement.queryId === "string",
  );
  const permittedApplicationsRead = hasQueryBoundLauncher
    ? await loadPermittedApplicationsAtAddress(
        session,
        address.tenantShortName,
        address.organizationShortName,
      )
    : undefined;
  const permittedApplicationKeys =
    permittedApplicationsRead?.kind === "available"
      ? permittedApplicationsRead.applications.map((application) => application.key)
      : undefined;

  const pageSubjectRecordTypeId =
    subjectType === undefined ? undefined : String(subjectType.recordTypeId);
  const { recordTypeByPlacement, dataPlacementsByRecordType, editFormDataPlacementIds } =
    projectPlacementRecordTypes({
      allPlacements,
      pageDefinition,
      pageSubjectRecordTypeId,
      context,
      editFormPlacementIds,
    });

  const { refreshPlacementsByBinding, flowsById, selectedReadTypesByFlow } =
    projectFlowBindingTargets({
      application,
      context,
      allPlacements,
      recordTypeByPlacement,
      pageSubjectRecordTypeId,
      editFormPlacementIds,
      dataPlacementsByRecordType,
      editFormDataPlacementIds,
    });

  const data: Record<string, PageDataState> = {};
  // Set when the record a detail or public page addresses cannot be shown to this viewer: it is
  // missing, malformed, of another type or organisation, or not readable. The page then does not
  // exist for them.
  let subjectUnreadable = false;
  for (const { placementId, placement } of placements)
    if (fieldControl(placement) === "date_time")
      data[placementId] = {
        status: "ready",
        values: { kind: "date_time_input", ...dateTimeZones },
      };
  const bindings: Record<string, PlacementFlowBinding[]> = {};
  const referenceChoiceInputs: Array<ApplicationPageModel["referenceChoiceInputs"][number]> = [];
  const referenceChoiceFirstPages = new Map<string, ReferenceChoiceFirstPage>();
  // Placement reads are independent: each reads under its own protected request and writes only
  // its own placement entry, so they run concurrently and are assembled by placement identity.
  const markSubjectUnreadable = (): void => {
    subjectUnreadable = true;
  };
  const adoptSubjectRead = (read: PageSubjectReadResult): void => {
    subjectRead ??= Promise.resolve(read);
  };
  const placementReaderInput = {
    application,
    recordTypeByPlacement,
    bindings,
    pageDefinition,
    pageSubjectRecordTypeId,
    selectedReadTypesByFlow,
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
    allowedPermissions,
    linkTiles,
    queryNotices,
    boardContinuation,
    permittedApplicationKeys,
    permittedApplicationsRead,
    queries,
    readCalendarSettings,
    tables,
    tableContinuation,
    adoptSubjectRead,
    markSubjectUnreadable,
  };
  await readConcurrently(placements, (entry) => readPlacement(placementReaderInput, entry));

  // A Group-owned create form needs an explicit owner from the viewer's current
  // memberships. Every Group returned here is eligible for initial Group ownership;
  // the Record writer still locks and rechecks the selected membership at save time.
  const ownershipByRecordType = new Map(
    context.releaseSet.modules.flatMap((module) =>
      module.content.recordTypes.map(
        (recordType) =>
          [String(recordType.recordTypeId).toLowerCase(), recordType.ownershipMode] as const,
      ),
    ),
  );
  const createsGroupRecord = (flowId: string): boolean => {
    const visited = new Set<string>();
    const visitFlow = (id: string): boolean => {
      if (visited.has(id.toLowerCase())) return false;
      visited.add(id.toLowerCase());
      const flow = flowsById.get(id.toLowerCase());
      if (flow === undefined) return false;
      const visitTasks = (tasks: readonly FlowTask[]): boolean =>
        tasks.some((task) => {
          const properties = "properties" in task ? task.properties : undefined;
          const recordType = properties?.record_type;
          if (
            task.type === "record.save" &&
            properties !== undefined &&
            !Object.hasOwn(properties, "record") &&
            isRecord(recordType) &&
            recordType.kind === "literal" &&
            isRecord(recordType.literal) &&
            recordType.literal.type === "text" &&
            typeof recordType.literal.value === "string" &&
            ownershipByRecordType.get(recordType.literal.value.toLowerCase()) === "group"
          )
            return true;
          if (
            task.type === "run_flow" &&
            visitFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId))
          )
            return true;
          return flowTaskChildLists(task).some((child) => visitTasks(child.tasks));
        });
      return visitTasks(flow.tasks) || visitTasks(flow.errors) || visitTasks(flow.finally);
    };
    return visitFlow(flowId);
  };
  const groupCreateBindings = placements.flatMap(({ placementId, placement }) => {
    const block = placement.block;
    if (
      !isRecord(block) ||
      typeof block.blockId !== "string" ||
      !sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      return [];
    return (bindings[placementId] ?? [])
      .filter((binding) => binding.event === "form_submit" && createsGroupRecord(binding.flowId))
      .map((binding) => ({ formId: placementId, binding }));
  });
  if (groupCreateBindings.length > 0) {
    if (
      groupCreateBindings.some(
        ({ binding }) => !binding.callerInputs.includes("selected_owner_group_id"),
      )
    )
      return { kind: "temporarily_unavailable" };
    const choices = await humanOrganizationRequests(dependencies.identityAuthorityId).run(
      session,
      selection,
      async (transaction, scope) => {
        return {
          accessVersion: scope.accessVersion,
          groups: await readCurrentRecordOwnerGroupsAfterAuthorization(transaction),
        };
      },
    );
    if (choices.kind !== "available") return choices;
    if (choices.value.accessVersion !== page.accessVersion)
      return { kind: "temporarily_unavailable" };
    for (const formId of new Set(groupCreateBindings.map(({ formId }) => formId)))
      data[formId] = {
        status: "ready",
        values: { kind: "form", ownerGroups: choices.value.groups },
      };
  }

  // A detail or form page offers its subject to the flows it starts; a public page never does.
  const subjectRow =
    (selectedForProjection === undefined ||
      pageDefinition.type === "guided_form" ||
      [...editFormPlacementIds].some((placementId) =>
        selectedForProjection.has(placementId.toLowerCase()),
      )) &&
    subjectType !== undefined &&
    pageDefinition.type !== "public" &&
    subjectId.success
      ? await readSubject(String(subjectType.recordTypeId), subjectId.data)
      : undefined;
  const subject =
    subjectRow?.kind === "read" && subjectRow.row.revision !== undefined
      ? { recordId: String(subjectRow.row.recordId), revision: subjectRow.row.revision }
      : undefined;

  let guidedForm: ApplicationPageModel["guidedForm"];
  if (pageDefinition.type === "guided_form") {
    const subjectCandidate = first(parameters[pageSubjectParameter]);
    if (subjectCandidate !== undefined) {
      if (subjectRow?.kind === "temporarily_unavailable")
        return { kind: "temporarily_unavailable" };
      if (subjectRow?.kind !== "read" || subject === undefined) return { kind: "unavailable" };
    }
    const recordType = getGuidedFormRecordType(pageDefinition, context.releaseSet.modules);
    if (recordType === undefined) return { kind: "unavailable" };
    const shells = context.releaseSet.application.content.shells;
    const declaredStepFields = getGuidedFormStepFields(pageDefinition, recordType, shells);
    const visiblePlacementIds = getGuidedFormVisiblePlacementIds(page, shells);
    const stepFields = getGuidedFormStepFields(pageDefinition, recordType, shells, page);
    const flowId = getGuidedFormFlowId(page, application.content.flowBindings, shells);
    if (
      declaredStepFields === undefined ||
      visiblePlacementIds === undefined ||
      stepFields === undefined ||
      declaredStepFields.some((step) =>
        step.fields.some(
          (field) => field.required && !visiblePlacementIds.has(field.placementId.toLowerCase()),
        ),
      ) ||
      flowId === undefined
    )
      return { kind: "unavailable" };
    const draftScope = guidedFormDraftScope(
      String(pageDefinition.pageId),
      flowId,
      subject?.recordId,
    );
    const openedDraft = await openGuidedFormDraft(
      guidedFormDependencies(),
      session,
      selection,
      draftScope,
      guidedFormInitialValues(
        stepFields,
        subjectRow?.kind === "read" ? subjectRow.row.values : undefined,
      ),
    );
    if (openedDraft.kind !== "available") return openedDraft;
    const values = visibleGuidedFormValues(openedDraft.draft, stepFields);
    const computedStepId = computeGuidedFormStepId(stepFields, openedDraft.draft.validation);
    if (computedStepId === undefined) return { kind: "unavailable" };
    const activeStepId = earlierGuidedStepId(stepFields, computedStepId, first(parameters.step));
    Object.assign(data, guidedFormInputData(page, recordType, values, dateTimeZones));
    guidedForm = {
      draftId: String(openedDraft.draft.draftId),
      revision: openedDraft.draft.revision,
      flowId,
      activeStepId,
      computedStepId,
      values,
      validation: visibleGuidedFormValidation(openedDraft.draft.validation, stepFields),
    };
  }

  // Detail and ordinary form edit surfaces project their fields from the authorized subject read.
  // Guided-form fields instead come from the person's revisioned draft above.
  const editFormBaselines: Record<string, Record<string, JsonValue>> = {};
  const subjectRecordType = context.releaseSet.modules
    .flatMap((module) => module.content.recordTypes)
    .find(
      (recordType) =>
        subjectType !== undefined &&
        sameId(String(recordType.recordTypeId), String(subjectType.recordTypeId)),
    );
  if (pageDefinition.type !== "guided_form") {
    for (const { placementId, placement } of placements) {
      if (!editFormPlacementIds.has(placementId)) continue;
      const block = placement.block;
      if (
        !isRecord(block) ||
        typeof block.blockId !== "string" ||
        !sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
      )
        continue;
      const editBinding = bindings[placementId]?.some(
        (binding) => binding.event === "form_submit" && binding.callerInputs.includes("record"),
      );
      if (!editBinding) continue;
      if (subjectRow?.kind !== "read" || subject === undefined || subjectRecordType === undefined) {
        if (subjectRow === undefined || subjectRow.kind === "refused") subjectUnreadable = true;
        data[placementId] = { status: "disabled", reason: "Record unavailable" };
        continue;
      }
      const fields = placements.filter((entry) => {
        if (entry.formId !== placementId || entry.placementId === placementId) return false;
        return isEditFieldPlacement(entry.placement);
      });
      const baseline: Record<string, JsonValue> = {};
      const projected: Record<string, PageDataState> = {};
      let complete = true;
      for (const entry of fields) {
        let projectedField:
          Readonly<{ key: string; value: JsonValue; data: PageDataState }> | undefined;
        if (isUnboundReferenceChoicePlacement(entry.placement)) {
          const firstPage = referenceChoiceFirstPages.get(entry.placementId);
          const definition =
            firstPage === undefined
              ? undefined
              : subjectRecordType.fields.find(
                  (candidate) => candidate.key === firstPage.field.fieldKey,
                );
          const valueKey =
            definition === undefined
              ? undefined
              : Object.keys(subjectRow.row.values).find((key) =>
                  sameId(key, String(definition.fieldId)),
                );
          const parsedValueFieldId =
            valueKey === undefined ? undefined : fieldIdSchema.safeParse(valueKey);
          projectedField = await projectSelectedReferenceChoiceEditField({
            firstPage,
            field: definition,
            stored:
              parsedValueFieldId !== undefined && parsedValueFieldId.success
                ? subjectRow.row.values[parsedValueFieldId.data]
                : undefined,
            service: referenceChoices,
            session,
            selection,
          });
        } else {
          projectedField = projectEditField(
            entry.placement,
            subjectRecordType,
            subjectRow.row.values,
            dateTimeZones,
          );
        }
        if (projectedField === undefined || Object.hasOwn(baseline, projectedField.key)) {
          complete = false;
          break;
        }
        baseline[projectedField.key] = projectedField.value;
        projected[entry.placementId] = projectedField.data;
      }
      if (!complete) {
        data[placementId] = { status: "disabled", reason: "Record unavailable" };
        continue;
      }
      Object.assign(data, projected);
      data[placementId] = { status: "ready", values: { kind: "form" } };
      editFormBaselines[placementId] = baseline;
    }
  }

  if (subjectUnreadable) return { kind: "unavailable" };
  if (typeof page.accessVersion !== "number" || !Number.isSafeInteger(page.accessVersion))
    throw new Error("APPLICATION_PAGE_ACCESS_VERSION_UNAVAILABLE");
  const permittedKeys = new Set(address.application.pageKeys);
  const applicationShellId =
    "shellId" in pageDefinition.composition ? pageDefinition.composition.shellId : undefined;
  const applicationShell =
    applicationShellId === undefined
      ? undefined
      : application.content.shells.find((candidate) =>
          sameId(candidate.shellId, applicationShellId),
        );
  if (applicationShellId !== undefined && applicationShell === undefined)
    throw new Error(
      `Compiled page '${pageDefinition.key}' references missing shell '${applicationShellId}'`,
    );
  const model: ApplicationPageModel = {
    page,
    pageId: pageDefinition.pageId,
    pageName: pageDefinition.name,
    shells: application.content.shells,
    ...(applicationShell === undefined ? {} : { applicationShell }),
    applicationName: address.application.name,
    applicationHomePageKey: address.application.homePageKey,
    searchEnabled: application.content.search?.enabled === true,
    availableApplications: address.read.applications.map((candidate) => ({
      key: candidate.key,
      name: candidate.name,
      homePageKey: candidate.homePageKey,
    })),
    theme: application.content.theme,
    navigation: navigation.value,
    ...(bodyContentAvailable === undefined ? {} : { bodyContentAvailable }),
    accessVersion: page.accessVersion,
    webMcpTools: projectPageWebMcpTools({
      page,
      ...(guidedForm === undefined ? {} : { activeStepId: guidedForm.activeStepId }),
      bindings,
      applicationBindings: application.content.flowBindings,
      toolBundle: application.toolBundle,
      applicationRootId: String(application.rootId),
      applicationKey: address.application.key,
      permittedApplications: address.read.applications.map((candidate) => ({
        applicationRootId: candidate.applicationRootId,
        key: candidate.key,
      })),
    }),
    data,
    bindings,
    refreshPlacementsByBinding,
    editFormBaselines,
    referenceChoiceInputs,
    ...(guidedForm === undefined ? {} : { guidedForm }),
    pages: application.content.pages
      .filter((candidate) => permittedKeys.has(candidate.key))
      .map((candidate) => ({ pageId: candidate.pageId, key: candidate.key })),
    ...(subject === undefined ? {} : { subject }),
    ...(adoptionTarget !== undefined &&
    adoptionTarget.currentReleaseRevision > context.applicationReleaseRevision
      ? {
          adoption: {
            offeredReleaseRevision: adoptionTarget.currentReleaseRevision,
            offeredReleaseVersion: adoptionTarget.currentReleaseVersion,
            installedReleaseRevision: context.applicationReleaseRevision,
          },
        }
      : {}),
    invocation: {
      tenantShortName: address.tenantShortName,
      organizationShortName: address.organizationShortName,
      applicationKey: address.application.key,
      pageKey: address.pageKey,
      installationRevision: context.applicationReleaseRevision,
      releaseKey: [
        application.releaseVersion,
        application.contentFingerprint,
        application.resolutionFingerprint,
      ].join(":"),
    },
  };
  return { kind: "available", model };
};
