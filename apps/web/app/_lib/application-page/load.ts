import { cache } from "react";
import {
  placementBlockRelease,
  type InstalledRuntimeContext,
  type HumanOrganizationRequestDependencies,
  createHumanInstalledPageBundleContextLoader,
  createStoredPageCapabilityService,
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  decideOrganizationAccessBatch,
  createStoredNavigationProjectionService,
  type PageSubjectReadResult,
  type ProtectedQueryRow,
  type RecordLinkResolver,
  readCurrentRecordOwnerGroupsAfterAuthorization,
  pageSubjectFieldIds,
} from "@vortex/platform/server";
import {
  FORM_CONTAINER_BLOCK_RELEASE,
  runtimeContextSelection,
  runtimeDatabasePoolSize,
  runtimePreviewOf,
} from "@vortex/platform/server";
import {
  describeFailure,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  organizationRuntimeSettingsSchema,
  type OrganizationAccessDeclaration,
  recordIdSchema,
  type JsonValue,
  sameId,
  isRecord,
  compiledPageShellId,
  recordsTableParameterPlacement,
} from "@vortex/platform/schema";
import { createPlacementReadServices } from "./placement-services";
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
  PageLoadOptions,
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
  isLinkInputPlacement,
} from "./placement-helpers";
import {
  isApplicationLauncherPlacement,
  logPlacementFailure,
  pageQueryBindingContext,
  placementParameterDependencies,
  resolvedQueryRecordTypeId,
} from "@vortex/platform/server";
import {
  applicationLauncherQueryRowsToListValues,
  parseBoardPayload,
  parseDisplayData,
} from "@vortex/ui";
import { projectAttachmentInputs } from "./attachment-inputs";
import { projectEditField } from "./reference-choice";
import { projectInitialLinkInputs, titleLinkInputs } from "./link-input";
import {
  projectPlacementBindings,
  projectPlacementRecordTypes,
  projectFlowBindingTargets,
} from "./flow-bindings";
import { readPageGridLayouts } from "./grid-layouts";
import {
  isStreamablePlacement,
  readPlacement,
  type PlacementReaderInput,
} from "./placement-reader";
import { projectPageWebMcpTools } from "./webmcp-projection";
import { platformPermissionSource } from "../platform-permission-source";
import {
  applyFormFieldAccess,
  decideFormFieldAccess,
  flowCreatedRecordTypeIds,
  formFieldOf,
  readCreatableFieldIds,
} from "./form-field-access";

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
        scope: {
          organizationId: scope.organizationId,
          organizationAccountId: scope.organizationAccountId,
          applicationRootId: scope.applicationRootId,
          ...(scope.previewInstallationId === undefined
            ? {}
            : { previewInstallationId: scope.previewInstallationId }),
        },
      }).load();
    },
  );

/**
 * The viewer's projection of one page and of the application menu, read once per server render:
 * the application frame layout and the page of one request share them instead of deciding the same
 * access twice. The next request reads again, so no access decision outlives its request.
 */
export const readPageProjections = cache(
  (
    session: IdentitySession,
    context: InstalledRuntimeContext,
    pageId: string,
    subjectRecordId: string | undefined,
  ) => {
    const dependencies = requestDependencies();
    const selection: OrganizationSelectionCandidate = runtimeContextSelection(context);
    const projectedPageRead = createStoredPageCapabilityService({
      ...dependencies,
      context,
      permissions: platformPermissionSource,
      selection: { pageId, ...(subjectRecordId === undefined ? {} : { subjectRecordId }) },
    }).project(session, selection);
    const navigationRead = createStoredNavigationProjectionService({
      ...dependencies,
      context,
      permissions: platformPermissionSource,
    }).project(session, selection);
    // A failure is rethrown where its result is consulted, never left unobserved meanwhile, and
    // every reader joins both reads before it returns on any path (early returns included).
    void projectedPageRead.catch(() => undefined);
    void navigationRead.catch(() => undefined);
    return { projectedPageRead, navigationRead };
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
  options?: PageLoadOptions,
): Promise<ApplicationPageInternalResult> => {
  const startedReads: Promise<unknown>[] = [];
  try {
    return await loadApplicationPageJoined(
      startedReads,
      session,
      address,
      parameters,
      selectedPlacementIds,
      boardContinuation,
      expectedInstallationRevision,
      tableContinuation,
      options,
    );
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
  options?: PageLoadOptions,
): Promise<ApplicationPageInternalResult> => {
  if (boardContinuation !== undefined && tableContinuation !== undefined)
    return { kind: "unavailable" };
  const dependencies = requestDependencies();
  const initialContinuationKey =
    expectedInstallationRevision === undefined ? getQueryContinuationKey() : undefined;
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
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
    selectedPlacementIds === undefined && runtimePreviewOf(context) === undefined
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
  // The adoption read, the page projection and the navigation projection are independent reads of
  // the same installed context, each under its own HUMAN request; they run together and their
  // results are still consulted in the original order.
  const { projectedPageRead, navigationRead } = readPageProjections(
    session,
    context,
    pageDefinition.pageId,
    conditionSubjectId,
  );
  startedReads.push(projectedPageRead, navigationRead);
  const adoptionTarget = await adoptionRead;
  const projectedPage = await projectedPageRead;
  if (projectedPage.kind !== "available") return projectedPage;
  // An undefined projection is the page refused for this viewer: never an empty page.
  if (projectedPage.value === undefined) return { kind: "unavailable" };
  // Field policy and gated choices edit the projection. Pages without field inputs keep the
  // authoritative objects shared with the frame, so RSC can reference them instead of repeating
  // their settings. A field-bearing page gets its own copy before any policy edits.
  const projectedPlacements = collectPlacements(projectedPage.value);
  const editsProjection =
    pageDefinition.type === "form" ||
    projectedPlacements.some(
      (placement) => isEditFieldPlacement(placement) || fieldControl(placement) !== undefined,
    );
  const page = editsProjection ? structuredClone(projectedPage.value) : projectedPage.value;
  const bodyContentAvailable =
    pageDefinition.type === "guided_form"
      ? undefined
      : projectedBodyContentAvailable(pageDefinition, application.content.shells, page);
  // A draft preview of an application with no record types leads its builder to the Data tab
  // from the empty home page; an installed application never does.
  const firstRecordTypeHref =
    bodyContentAvailable === false &&
    address.pageKey === address.application.homePageKey &&
    runtimePreviewOf(context) !== undefined &&
    context.releaseSet.modules.every((module) => module.content.recordTypes.length === 0)
      ? `/studio/${encodeURIComponent(context.organizationId)}/${encodeURIComponent(context.applicationRootId)}?tab=data`
      : undefined;
  let allPlacements = editsProjection ? collectPlacements(page) : projectedPlacements;
  if (boardContinuation !== undefined) {
    const targets = allPlacements.filter(({ placementId }) =>
      sameId(placementId, boardContinuation.placementId),
    );
    const target = targets[0];
    if (
      target === undefined ||
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
    const target = targets[0];
    if (
      target === undefined ||
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
  for (const placement of allPlacements) {
    const control = fieldControl(placement);
    if (control === "date_time") needsDateTimeZones = true;
    if (control !== "choice" && control !== "several_choices") continue;
    const source = fieldForPlacement(placement, context.releaseSet.modules);
    const options = placement.settings.options;
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

  const services = createPlacementReadServices({
    session,
    selection,
    dependencies,
    continuationKey,
    tenantShortName: address.tenantShortName,
    organizationShortName: address.organizationShortName,
  });
  const {
    queries,
    referenceChoices,
    tables,
    queryNotices,
    linkTiles,
    readCalendarSettings,
    subjects,
    readConcurrently,
  } = services;

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
  const requestedSubjectFieldIds =
    pageDefinition.type === "detail" || pageDefinition.type === "public"
      ? pageSubjectFieldIds(
          allPlacements.filter(
            ({ placementId }) =>
              selectedPlacementIds === undefined ||
              selectedPlacementIds.has(placementId.toLowerCase()),
          ),
        ).filter(
          (fieldId) =>
            pageDefinition.type !== "public" ||
            pageDefinition.publicFieldIds.some((allowed) => sameId(String(allowed), fieldId)),
        )
      : undefined;
  const readSubject = (recordTypeId: string, recordId: string): Promise<PageSubjectReadResult> =>
    (subjectRead ??= subjects.read(session, selection, {
      recordTypeId,
      recordId,
      ...(requestedSubjectFieldIds === undefined
        ? {}
        : { requestedFieldIds: requestedSubjectFieldIds }),
    }));
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
    allPlacements.flatMap(({ placementId, vortex }) => {
      const block = vortex.block;
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
  // The forms of a form page show each field as the viewer's field policy allows: decided once,
  // before any placement is read, so a field left out is never read or sent.
  const formRecordType =
    pageDefinition.type === "form" && subjectType !== undefined
      ? context.releaseSet.modules
          .flatMap((module) => module.content.recordTypes)
          .find((recordType) =>
            sameId(String(recordType.recordTypeId), String(subjectType.recordTypeId)),
          )
      : undefined;
  let refusedForms: ReadonlyMap<string, string> = new Map();
  let createFormIds: readonly string[] = [];
  if (formRecordType !== undefined) {
    const recordTypeId = String(formRecordType.recordTypeId);
    const editForms = new Map<string, ProtectedQueryRow>();
    if (editFormPlacementIds.size > 0 && subjectId.success) {
      const read = await readSubject(recordTypeId, subjectId.data);
      if (read.kind === "read")
        for (const formId of editFormPlacementIds) editForms.set(formId, read.row);
    }
    createFormIds = allPlacements.flatMap(({ placementId, vortex }) => {
      const block = vortex.block;
      return isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId) &&
        !editFormPlacementIds.has(placementId) &&
        application.content.flowBindings.some(
          (binding) =>
            sameId(binding.controlId, placementId) &&
            binding.event === "form_submit" &&
            flowCreatedRecordTypeIds(application.content.flows, String(binding.flow.flowId)).has(
              recordTypeId.toLowerCase(),
            ),
        )
        ? [placementId]
        : [];
    });
    const createForms = new Map<string, ReadonlySet<string> | undefined>();
    if (createFormIds.length > 0) {
      const creatable = await readCreatableFieldIds(session, selection, context, recordTypeId);
      if (creatable.kind !== "available") return creatable;
      for (const formId of createFormIds) createForms.set(formId, creatable.fieldIds);
    }
    const access = decideFormFieldAccess({
      placements: allPlacements,
      recordType: formRecordType,
      editForms,
      createForms,
    });
    applyFormFieldAccess(page, access);
    allPlacements = collectPlacements(page);
    refusedForms = access.refused;
  }
  // A form baseline is valid only when every shown field was projected. A selected field also
  // needs its owning form's subject read, even though only the requested field is returned.
  const selectedForProjection =
    selectedPlacementIds === undefined ? undefined : new Set(selectedPlacementIds);
  if (selectedForProjection !== undefined)
    for (const placement of allPlacements) {
      const { placementId, formId } = placement;
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
            isEditFieldPlacement(entry)
          )
            selectedForProjection.add(entry.placementId.toLowerCase());
      }
    }
  const placements =
    selectedForProjection === undefined
      ? allPlacements
      : allPlacements.filter((entry) => selectedForProjection.has(entry.placementId.toLowerCase()));
  // The person's grid layouts and field policy decide which columns each grid reads, so they are
  // read (once, for every grid of the page) before any grid reads its rows.
  const gridLayoutsRead = readPageGridLayouts(
    session,
    dependencies,
    selection,
    context,
    String(pageDefinition.pageId),
    placements.filter(isTablePlacement).flatMap(({ placementId, vortex }) => {
      const recordTypeId =
        typeof vortex.queryId === "string"
          ? resolvedQueryRecordTypeId(context, vortex.queryId)
          : undefined;
      return recordTypeId === undefined ? [] : [{ placementId, recordTypeId }];
    }),
  );
  startedReads.push(gridLayoutsRead);
  const hasQueryBoundLauncher = placements.some(
    (placement) =>
      isApplicationLauncherPlacement(placement) && typeof placement.vortex.queryId === "string",
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

  const { refreshPlacementsByBinding, selectedReadTypesByFlow } = projectFlowBindingTargets({
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
  for (const placement of placements)
    if (fieldControl(placement) === "date_time")
      data[placement.placementId] = {
        status: "ready",
        values: { kind: "date_time_input", ...dateTimeZones },
      };
  const bindings: Record<string, PlacementFlowBinding[]> = {};
  const referenceChoiceInputs: Array<ApplicationPageModel["referenceChoiceInputs"][number]> = [];
  // Placement reads are independent: each reads under its own protected request and writes only
  // its own placement entry, so they run concurrently and are assembled by placement identity.
  const markSubjectUnreadable = (): void => {
    subjectUnreadable = true;
  };
  const adoptSubjectRead = (read: PageSubjectReadResult): void => {
    subjectRead ??= Promise.resolve(read);
  };
  const resolveRecordLinks: RecordLinkResolver = services.recordLinkResolver(context);
  const gridLayouts = await gridLayoutsRead;
  // Every query input of the page's blocks resolves from the same server-side facts: what the page
  // declares, its address, the subject read above and the viewer. A relative date reads the
  // organisation's time zone once, only when one asks for it.
  const bindingContext = pageQueryBindingContext({
    context,
    pageDefinition,
    parameters,
    readSubject:
      subjectType === undefined
        ? undefined
        : () =>
            subjectId.success
              ? readSubject(String(subjectType.recordTypeId), subjectId.data)
              : Promise.resolve({ kind: "refused" }),
    subjectRecordTypeId: subjectType === undefined ? undefined : String(subjectType.recordTypeId),
    readTimeZone: async () => {
      try {
        const read = await readCalendarSettings();
        return read.kind === "available" ? read.value.settings?.timeZone : undefined;
      } catch (error) {
        console.error(`[page] organisation time zone unavailable: ${describeFailure(error)}`);
        return undefined;
      }
    },
  });
  const placementReaderInput: PlacementReaderInput = {
    context,
    session,
    selection,
    address,
    pageDefinition,
    accessVersion: typeof page.accessVersion === "number" ? page.accessVersion : undefined,
    subjectType,
    subjectId: subjectId.success ? subjectId.data : undefined,
    parameters,
    bindings: bindingContext,
    data,
    services: {
      queries,
      linkTiles,
      queryNotices,
      tables,
      resolveRecordLinks,
      readCalendarSettings,
      readSubject,
      launcherValues: applicationLauncherQueryRowsToListValues,
      boardData: (values) => parseDisplayData({ status: "ready", values }, parseBoardPayload),
    },
    permittedApplicationKeys,
    permittedApplicationsUnavailable: permittedApplicationsRead?.kind === "temporarily_unavailable",
    ...(boardContinuation === undefined ? {} : { boardContinuation }),
    ...(tableContinuation === undefined ? {} : { tableContinuation }),
    gridLayouts,
    markSubjectUnreadable,
    page,
    pageSubjectRecordTypeId,
    referenceChoiceInputs,
    referenceChoices,
    dependencies,
    adoptSubjectRead,
  };
  const flowBindingInput = {
    application,
    recordTypeByPlacement,
    bindings,
    pageDefinition,
    pageSubjectRecordTypeId,
    selectedReadTypesByFlow,
  };
  for (const entry of placements) projectPlacementBindings(flowBindingInput, entry);
  // A page load may stream the placements that only show their own query's rows: the frame, the
  // title and every other placement are decided and sent first, each streamed placement shows its
  // loading state until its own read settles. A placement reread by id is always read in full.
  const streamed =
    options?.streamPlacementReads === true && selectedPlacementIds === undefined
      ? placements.filter(isStreamablePlacement)
      : [];
  const streamedIds = new Set(streamed.map((entry) => entry.placementId));
  await readConcurrently(
    placements.filter((entry) => !streamedIds.has(entry.placementId)),
    (entry) => readPlacement(placementReaderInput, entry),
  );

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
  const createsGroupRecord = (flowId: string): boolean =>
    [...flowCreatedRecordTypeIds(application.content.flows, flowId)].some(
      (recordTypeId) => ownershipByRecordType.get(recordTypeId) === "group",
    );
  const groupCreateBindings = placements.flatMap(({ placementId, vortex }) => {
    const block = vortex.block;
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
    const stepData = {
      ...guidedFormInputData(page, recordType, values, dateTimeZones),
    } as Record<string, PageDataState>;
    // A linked record shows by its title, read under the viewer's access.
    if ((await titleLinkInputs(stepData, resolveRecordLinks)).size > 0)
      return { kind: "unavailable" };
    Object.assign(data, stepData);
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
  const unshown = new Set<string>();
  if (pageDefinition.type !== "guided_form") {
    for (const { placementId, vortex } of placements) {
      if (!editFormPlacementIds.has(placementId)) continue;
      const block = vortex.block;
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
        // A form may carry the page record to an action and ask separate questions. Only
        // inputs that actually name its record fields receive stored values and field policy.
        return isEditFieldPlacement(entry) && formFieldOf(entry, subjectRecordType) !== undefined;
      });
      const baseline: Record<string, JsonValue> = {};
      const projected: Record<string, PageDataState> = {};
      const baselineKeys = new Map<string, string>();
      for (const entry of fields) {
        const projectedField = projectEditField(
          entry,
          subjectRecordType,
          subjectRow.row.values,
          dateTimeZones,
        );
        // A field whose stored value this form cannot show is left out of it, with the cause
        // logged; the save then leaves that value as it is.
        if (projectedField === undefined || Object.hasOwn(baseline, projectedField.key)) {
          logPlacementFailure(address, entry.placementId, "edit_field_unprojected");
          unshown.add(entry.placementId.toLowerCase());
          continue;
        }
        baseline[projectedField.key] = projectedField.value;
        baselineKeys.set(entry.placementId, projectedField.key);
        projected[entry.placementId] = projectedField.data;
      }
      // A linked record shows by its title, read under the viewer's access in one batched read; a
      // link whose record the viewer may not read is left out of the form, with the cause logged.
      for (const untitled of await titleLinkInputs(projected, resolveRecordLinks)) {
        logPlacementFailure(address, untitled, "link_titles_unavailable");
        unshown.add(untitled.toLowerCase());
        delete projected[untitled];
        const key = baselineKeys.get(untitled);
        if (key !== undefined) delete baseline[key];
      }
      Object.assign(data, projected);
      data[placementId] = { status: "ready", values: { kind: "form" } };
      editFormBaselines[placementId] = baseline;
    }
  }
  // A create form starts each field at its definition's default, the value the save stores when
  // the field is left as it is, so the person sees what will be saved.
  if (formRecordType !== undefined)
    for (const entry of placements) {
      if (
        entry.formId === undefined ||
        !createFormIds.some((formId) => sameId(formId, entry.formId!)) ||
        !isEditFieldPlacement(entry)
      )
        continue;
      const field = formFieldOf(entry, formRecordType);
      if (field?.default === undefined) continue;
      const projected = projectEditField(
        entry,
        formRecordType,
        { [String(field.fieldId)]: field.default as JsonValue },
        dateTimeZones,
      );
      if (projected === undefined) {
        logPlacementFailure(address, entry.placementId, "create_field_default_unprojected");
        continue;
      }
      data[entry.placementId] = projected.data;
    }
  const linkInputs = placements.filter(isLinkInputPlacement);
  // A new record's link field may start with the record its page address names.
  if (pageDefinition.type !== "guided_form")
    await projectInitialLinkInputs({
      placements: linkInputs.filter(
        (entry) => entry.formId === undefined || !Object.hasOwn(editFormBaselines, entry.formId),
      ),
      parameters,
      data,
      resolveRecordLinks,
      log: (placementId, reason) => logPlacementFailure(address, placementId, reason),
    });
  if (unshown.size > 0) {
    applyFormFieldAccess(page, { omitted: unshown, readOnly: new Set(), refused: new Map() });
    for (const placementId of Object.keys(data))
      if (unshown.has(placementId.toLowerCase())) delete data[placementId];
    for (let index = referenceChoiceInputs.length - 1; index >= 0; index -= 1)
      if (unshown.has(referenceChoiceInputs[index]!.placementId.toLowerCase()))
        referenceChoiceInputs.splice(index, 1);
  }
  // A form whose required field the viewer cannot fill in is refused, naming that field.
  for (const { placementId } of placements) {
    const reason = refusedForms.get(placementId.toLowerCase());
    if (reason !== undefined) data[placementId] = { status: "disabled", reason };
  }

  await projectAttachmentInputs({
    placements,
    context,
    address,
    session,
    data,
    ...((subjectRecordType ?? formRecordType) === undefined
      ? {}
      : { recordTypeId: String((subjectRecordType ?? formRecordType)!.recordTypeId) }),
    ...(subject === undefined ? {} : { recordId: subject.recordId }),
  });
  if (subjectUnreadable) return { kind: "unavailable" };
  if (typeof page.accessVersion !== "number" || !Number.isSafeInteger(page.accessVersion))
    throw new Error("APPLICATION_PAGE_ACCESS_VERSION_UNAVAILABLE");
  // Every refusal this loader can make has been made: only now do the streamed reads start, so a
  // page that is not shown never leaves a read running. A failed read shows its placement's error
  // state and is logged with its cause; it never fails the page or goes unobserved.
  const streamedData: Record<string, Promise<PageDataState>> = {};
  const streamedSlots = new Array<() => void>();
  const streamedLimit = runtimeDatabasePoolSize();
  let streamedRunning = 0;
  const nextStreamedSlot = (): Promise<void> =>
    streamedRunning < streamedLimit
      ? ((streamedRunning += 1), Promise.resolve())
      : new Promise<void>((resolve) => streamedSlots.push(resolve));
  const releaseStreamedSlot = (): void => {
    const next = streamedSlots.shift();
    if (next === undefined) streamedRunning -= 1;
    else next();
  };
  for (const entry of streamed) {
    const own: Record<string, PageDataState> = {};
    streamedData[entry.placementId] = nextStreamedSlot()
      .then(() => readPlacement({ ...placementReaderInput, data: own }, entry))
      .then(() => {
        const state = own[entry.placementId];
        if (state === undefined) throw new Error("PLACEMENT_DATA_NOT_PRODUCED");
        return state;
      })
      .catch((error: unknown): PageDataState => {
        logPlacementFailure(
          address,
          entry.placementId,
          "placement_read_failed",
          describeFailure(error),
        );
        // A defect in data the platform produced is surfaced in development; production degrades
        // to the placement's error state.
        if (process.env.NODE_ENV !== "production") throw error;
        return { status: "error" };
      })
      .finally(releaseStreamedSlot);
    data[entry.placementId] = { status: "loading" };
  }
  const permittedKeys = new Set(address.application.pageKeys);
  const applicationShellId = compiledPageShellId(pageDefinition.composition) ?? undefined;
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
    theme: application.content.theme,
    navigation: navigation.value,
    ...(bodyContentAvailable === undefined ? {} : { bodyContentAvailable }),
    ...(firstRecordTypeHref === undefined ? {} : { firstRecordTypeHref }),
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
    ...(streamed.length === 0 ? {} : { streamedData }),
    tableAddress: Object.fromEntries(
      Object.entries(parameters).flatMap(([name, value]) => {
        const text = first(value);
        return recordsTableParameterPlacement(name) !== undefined && text !== undefined
          ? [[name, text]]
          : [];
      }),
    ),
    bindings,
    refreshPlacementsByBinding,
    pageParameters: {
      tableIds: allPlacements.filter(isTablePlacement).map((placement) => placement.placementId),
      controlKinds: Object.fromEntries(
        allPlacements
          .filter(({ placementId }) => bindingContext.controls.has(placementId.toLowerCase()))
          .map((placement) => [
            placement.placementId,
            placementBlockRelease(placement.vortex.block).key.split(".").at(-1)!,
          ]),
      ),
      dependents: placementParameterDependencies(allPlacements, bindingContext),
      controls: Object.fromEntries(
        allPlacements.flatMap(({ placementId }) => {
          const name = bindingContext.controls.get(placementId.toLowerCase());
          return name === undefined ? [] : [[placementId, name] as const];
        }),
      ),
    },
    editFormBaselines,
    referenceChoiceInputs,
    linkInputPlacementIds: linkInputs.map((entry) => entry.placementId),
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
  return {
    kind: "available",
    model,
    shells: application.content.shells,
    ...(applicationShell === undefined ? {} : { applicationShell }),
  };
};
