import { cache } from "react";
import {
  placementBlockRelease,
  placementSettings,
  DRAWER_BLOCK_RELEASE,
  type InstalledRuntimeContext,
  type HumanOrganizationRequestDependencies,
  createHumanInstalledPageBundleContextLoader,
  createStoredPageCapabilityService,
  createStoredNavigationProjectionService,
  type PageSubjectReadResult,
  type RecordLinkResolver,
  pageSubjectFieldIds,
  applyChoiceOptionGates,
  pageSubjectType,
  planChoiceOptionGates,
  type DateTimeZones,
  isTablePlacement,
  fieldControl,
  formFieldOf,
} from "@vortex/platform/server";
import { runtimeContextSelection, runtimePreviewOf } from "@vortex/platform/server";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  recordIdSchema,
  sameId,
  isRecord,
  compiledPageShellId,
  recordsTableParameterPlacement,
} from "@vortex/platform/schema";
import { createPlacementReadServices } from "./placement-services";
import { prepareRuntimePreviewPage } from "../runtime-preview-demand";
import { beginStudioPreviewRead } from "../studio-preview-work";
import { readApplicationReleaseAdoption } from "../application-release-adoption";
import { getQueryContinuationKey } from "../query-continuation-key";
import { loadPermittedApplicationsAtAddress } from "../organization-context";
import {} from "@vortex/platform/server";
import {
  humanOrganizationRequestDependencies,
  humanOrganizationRequests,
} from "../server-composition";
import type {
  ApplicationPageLoaderAddress,
  SearchParameters,
  BoardReadTarget,
  TableContinuationTarget,
  ApplicationPageInternalResult,
  PageDataState,
  PlacementFlowBinding,
  ApplicationPageModel,
  PlacementReadModel,
  PageLoadOptions,
} from "./types";
import {
  first,
  pageSubjectParameter,
  projectedBodyContentAvailable,
  collectPlacements,
  isBoardPlacement,
  projectedUseAvailability,
  isEditFieldPlacement,
  isLinkInputPlacement,
} from "./placement-helpers";
import {
  isApplicationLauncherPlacement,
  logPlacementFailure,
  controlSelectedRecordType,
  pageQueryBindingContext,
  placementParameterDependencies,
  resolvedQueryRecordTypeId,
} from "@vortex/platform/server";
import { projectAttachmentInputs } from "./attachment-inputs";
import { projectCreateFormDefaults, projectEditForms } from "./edit-form-projection";
import { readFieldAccess } from "./field-access-read";
import { projectGroupCreateForms } from "./group-create-forms";
import { projectGuidedForm } from "./guided-form-projection";
import { startStreamedPlacementReads } from "./streamed-placements";
import { projectInitialLinkInputs } from "./link-input";
import {
  projectPlacementBindings,
  projectPlacementRecordTypes,
  projectFlowBindingTargets,
} from "./flow-bindings";
import { pageGridLayoutRequest, readPageGridLayouts } from "./grid-layouts";
import {
  isStreamablePlacement,
  readPlacement,
  type PlacementReaderInput,
} from "./placement-reader";
import { projectPageWebMcpTools } from "./webmcp-projection";
import { platformPermissionSource } from "../platform-permission-source";
import {
  availableContributedActions,
  contributedActionPreviews,
  contributedFieldIdsOf,
  omitUnreadableContributedFields,
  pageHasContributions,
  withContributedActionButtons,
  withContributedPlacements,
} from "./contributed-placements";
import { applyFormFieldAccess, decideFormPolicy } from "./form-field-access";

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
 * access twice. The next request reads again, so no access decision outlives its request. React's
 * `cache` keys on the number of arguments as well as their values, so every caller passes all six
 * (the selected placements are required, `undefined` for a whole page; `navigation` says whether
 * the caller shows the menu): a call with fewer would miss the shared read and project the page and
 * the menu a second time.
 */
export const readPageProjections = cache(
  (
    session: IdentitySession,
    context: InstalledRuntimeContext,
    pageId: string,
    subjectRecordId: string | undefined,
    selectedPlacementIds: ReadonlySet<string> | undefined,
    navigation: boolean,
  ) => {
    const dependencies = requestDependencies();
    const selection: OrganizationSelectionCandidate = runtimeContextSelection(context);
    const definition = context.releaseSet.application.content.pages.find((page) =>
      sameId(page.pageId, pageId),
    );
    if (definition === undefined) throw new Error("PAGE_DEFINITION_MISSING");
    // Projection conditions may read the addressed subject; it must exist before projection.
    const subjectReady = prepareRuntimePreviewPage(
      session,
      context,
      definition,
      subjectRecordId !== undefined,
    );
    const projectedPageRead = subjectReady.then(async (ready) => {
      if (ready.kind !== "ready")
        return {
          kind:
            ready.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "unavailable",
        } as const;
      const projected = await createStoredPageCapabilityService({
        ...dependencies,
        context,
        permissions: platformPermissionSource,
        selection: { pageId, ...(subjectRecordId === undefined ? {} : { subjectRecordId }) },
      }).project(session, selection);
      if (projected.kind !== "available" || projected.value === undefined) return projected;
      const demand = await prepareRuntimePreviewPage(
        session,
        context,
        definition,
        false,
        projected.value,
        selectedPlacementIds,
      );
      if (demand.kind !== "ready")
        return {
          kind:
            demand.kind === "temporarily_unavailable" ? "temporarily_unavailable" : "unavailable",
        } as const;
      return projected;
    });
    // A read of selected placements shows no menu, so it projects none.
    const navigationRead = navigation
      ? subjectReady.then((ready) =>
          ready.kind === "ready"
            ? createStoredNavigationProjectionService({
                ...dependencies,
                context,
                permissions: platformPermissionSource,
              }).project(session, selection)
            : ({
                kind:
                  ready.kind === "temporarily_unavailable"
                    ? "temporarily_unavailable"
                    : "unavailable",
              } as const),
        )
      : undefined;
    // A failure is rethrown where its result is consulted, never left unobserved meanwhile, and
    // every reader joins both reads before it returns on any path (early returns included).
    void projectedPageRead.catch(() => undefined);
    void navigationRead?.catch(() => undefined);
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
  boardReads?: readonly BoardReadTarget[],
  expectedInstallationRevision?: number,
  tableContinuation?: TableContinuationTarget,
  options?: PageLoadOptions,
): Promise<ApplicationPageInternalResult> => {
  const startedReads: Promise<unknown>[] = [];
  // Demand takes its own lease; this one also keeps idle fill paused through the page's row reads.
  const release =
    address.application.previewInstallationId === undefined
      ? undefined
      : beginStudioPreviewRead(
          session,
          address.read.organizationId,
          address.application.applicationRootId,
        );
  try {
    return await loadApplicationPageJoined(
      startedReads,
      session,
      address,
      parameters,
      selectedPlacementIds,
      boardReads,
      expectedInstallationRevision,
      tableContinuation,
      release === undefined ? options : { ...options, streamPlacementReads: false },
    );
  } finally {
    await Promise.allSettled(startedReads);
    release?.();
  }
};

const loadApplicationPageJoined = async (
  startedReads: Promise<unknown>[],
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  selectedPlacementIds?: ReadonlySet<string>,
  boardReads?: readonly BoardReadTarget[],
  expectedInstallationRevision?: number,
  tableContinuation?: TableContinuationTarget,
  options?: PageLoadOptions,
): Promise<ApplicationPageInternalResult> => {
  if (boardReads !== undefined && tableContinuation !== undefined) return { kind: "unavailable" };
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
    selectedPlacementIds,
    selectedPlacementIds === undefined,
  );
  startedReads.push(projectedPageRead);
  if (navigationRead !== undefined) startedReads.push(navigationRead);
  const adoptionTarget = await adoptionRead;
  const projectedPage = await projectedPageRead;
  if (projectedPage.kind !== "available") return projectedPage;
  // An undefined projection is the page refused for this viewer: never an empty page.
  if (projectedPage.value === undefined) return { kind: "unavailable" };
  // Field policy and gated choices edit the projection. Pages without field inputs keep the
  // authoritative objects shared with the frame, so RSC can reference them instead of repeating
  // their settings. A field-bearing page gets its own copy before any policy edits.
  // The fields other installed Modules contributed to the page's record are placed on it before
  // any field policy is decided; the result is already a private copy when something was placed.
  const contributedPage = withContributedPlacements(projectedPage.value, context, pageDefinition);
  const projectedPlacements = collectPlacements(contributedPage);
  const editsProjection =
    contributedPage !== projectedPage.value ||
    pageHasContributions(context, pageDefinition) ||
    pageDefinition.type === "form" ||
    projectedPlacements.some(
      (placement) => isEditFieldPlacement(placement) || fieldControl(placement) !== undefined,
    );
  const page =
    contributedPage !== projectedPage.value
      ? contributedPage
      : editsProjection
        ? structuredClone(projectedPage.value)
        : projectedPage.value;
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
  for (const boardRead of boardReads ?? []) {
    const targets = allPlacements.filter(({ placementId }) =>
      sameId(placementId, boardRead.placementId),
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
  let needsDateTimeZones = false;
  for (const placement of allPlacements)
    if (fieldControl(placement) === "date_time") needsDateTimeZones = true;
  const choicePlan = planChoiceOptionGates(allPlacements, context);
  if (choicePlan === undefined) return { kind: "temporarily_unavailable" };

  // The page subject: the one record the page's own address names, of the page's declared record
  // type, read once through the record read path under the viewer's own authority. Nothing here
  // comes from the browser except the id.
  const subjectType = pageSubjectType(pageDefinition);
  const subjectId = recordIdSchema.safeParse(first(parameters[pageSubjectParameter]));

  let dateTimeZones: DateTimeZones = {};
  let allowedPermissions: ReadonlySet<string> = new Set();
  if (needsDateTimeZones || choicePlan.permissions.size > 0) {
    const authorized = await readFieldAccess({
      session,
      dependencies,
      selection,
      needsDateTimeZones,
      choicePlan,
      choiceSubject:
        subjectType !== undefined && subjectId.success
          ? { recordTypeId: String(subjectType.recordTypeId), recordId: subjectId.data }
          : undefined,
    });
    if (authorized.kind !== "available") return authorized;
    if (page.accessVersion !== authorized.value.accessVersion)
      return { kind: "temporarily_unavailable" };
    dateTimeZones = authorized.value.zones;
    allowedPermissions = authorized.value.allowed;
  }

  const navigation = navigationRead === undefined ? undefined : await navigationRead;
  if (navigation !== undefined && navigation.kind !== "available") return navigation;

  const services = createPlacementReadServices({
    session,
    selection,
    dependencies,
    continuationKey,
    tenantShortName: address.tenantShortName,
    organizationShortName: address.organizationShortName,
  });
  const { referenceChoices, subjects, readConcurrently } = services;

  if (
    pageDefinition.type === "guided_form" &&
    first(parameters[pageSubjectParameter]) !== undefined &&
    !subjectId.success
  )
    return { kind: "unavailable" };
  const subjectRecordType = context.releaseSet.modules
    .flatMap((module) => module.content.recordTypes)
    .find(
      (recordType) =>
        subjectType !== undefined &&
        sameId(String(recordType.recordTypeId), String(subjectType.recordTypeId)),
    );
  let subjectRead: Promise<PageSubjectReadResult> | undefined;
  const requestedSubjectFieldIds =
    pageDefinition.type === "detail" || pageDefinition.type === "public"
      ? [
          ...new Set([
            ...pageSubjectFieldIds(allPlacements),
            // A field refresh still needs its form's complete visible baseline. Named controls
            // consume the same field that form projection resolves, even without a field reference.
            ...allPlacements.filter(isEditFieldPlacement).flatMap((placement) => {
              const field =
                subjectRecordType === undefined
                  ? undefined
                  : formFieldOf(placement, subjectRecordType);
              return field === undefined ? [] : [String(field.fieldId).toLowerCase()];
            }),
          ]),
        ].filter(
          (fieldId) =>
            pageDefinition.type !== "public" ||
            pageDefinition.publicFieldIds.some((allowed) => sameId(String(allowed), fieldId)),
        )
      : undefined;
  // The one subject read of a detail page also previews the actions other installed Modules
  // contributed to its record type, so their buttons need no second read of the record.
  const subjectActions =
    pageDefinition.type === "detail"
      ? contributedActionPreviews(context, pageDefinition)
      : undefined;
  const readSubject = (recordTypeId: string, recordId: string): Promise<PageSubjectReadResult> =>
    (subjectRead ??= subjects.read(session, selection, {
      recordTypeId,
      recordId,
      ...(requestedSubjectFieldIds === undefined
        ? {}
        : { requestedFieldIds: requestedSubjectFieldIds }),
      ...(subjectActions === undefined ? {} : { actions: subjectActions }),
    }));
  // A detail address always names one readable record, even if its authored placements do not
  // include a record-detail block. Other-org and unreadable IDs have the same outcome as absence.
  if (pageDefinition.type === "detail") {
    if (!subjectId.success || subjectType === undefined) return { kind: "unavailable" };
    const addressedSubject = await readSubject(String(subjectType.recordTypeId), subjectId.data);
    if (addressedSubject.kind === "temporarily_unavailable")
      return { kind: "temporarily_unavailable" };
    if (addressedSubject.kind !== "read") return { kind: "unavailable" };
    // A contributed field the viewer's permissions do not let them read is left out of the detail,
    // not shown as restricted: the person has no relationship to a field they cannot know exists.
    const contributedIds = contributedFieldIdsOf(context, pageDefinition);
    if (contributedIds.size > 0) {
      omitUnreadableContributedFields(
        page,
        contributedIds,
        new Set(Object.keys(addressedSubject.row.values).map((key) => key.toLowerCase())),
      );
      allPlacements = collectPlacements(page);
    }
    // A contributed action the viewer may run on this record gets its button, decided by the
    // same preview the named action path uses when the person runs it.
    const availableActions = availableContributedActions(addressedSubject.actionAvailability);
    if (withContributedActionButtons(page, context, pageDefinition, availableActions))
      allPlacements = collectPlacements(page);
  }

  if (
    selectedPlacementIds !== undefined &&
    [...selectedPlacementIds].some(
      (requestedId) => !allPlacements.some((entry) => sameId(entry.placementId, requestedId)),
    )
  )
    return { kind: "unavailable" };
  const formPolicy = await decideFormPolicy({
    session,
    selection,
    context,
    page,
    pageDefinition,
    subjectType,
    subjectId: subjectId.success ? subjectId.data : undefined,
    allPlacements,
    readSubject,
  });
  if (formPolicy.kind === "refused") return formPolicy.result;
  const { editFormPlacementIds, formRecordType, createFormIds, refusedForms } = formPolicy;
  allPlacements = formPolicy.allPlacements;
  // The gated options leave the page payload the form renders, after the subject is known: an option
  // the record already holds stays offered, so a restricted viewer keeps the field and its value.
  // A pipeline's stage field keeps only the stages its record may move to.
  if (
    choicePlan.permissions.size > 0 ||
    choicePlan.gates.some((gate) => gate.pipeline !== undefined)
  ) {
    const heldSubject =
      subjectType !== undefined &&
      subjectId.success &&
      pageDefinition.type !== "public" &&
      choicePlan.gates.some((gate) => sameId(gate.recordTypeId, String(subjectType.recordTypeId)))
        ? await readSubject(String(subjectType.recordTypeId), subjectId.data)
        : undefined;
    applyChoiceOptionGates(choicePlan, allowedPermissions, (gate) => {
      if (heldSubject?.kind !== "read") return new Set();
      const held = Object.entries(heldSubject.row.values).find(([key]) =>
        sameId(key, gate.fieldId),
      )?.[1];
      return new Set(
        typeof held === "string"
          ? [held]
          : Array.isArray(held)
            ? held.filter((value): value is string => typeof value === "string")
            : [],
      );
    });
    allPlacements = collectPlacements(page);
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
    String(pageDefinition.pageId),
    placements.filter(isTablePlacement).flatMap(({ placementId, vortex }) => {
      const recordTypeId =
        typeof vortex.queryId === "string"
          ? resolvedQueryRecordTypeId(context, vortex.queryId)
          : undefined;
      return recordTypeId === undefined
        ? []
        : [pageGridLayoutRequest(pageDefinition, placementId, recordTypeId, parameters)];
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
    readViewerTeams: services.readViewerTeams,
    readTimeZone: services.readTimeZone,
  });
  const pageSubjectRecordTypeId =
    subjectType === undefined ? undefined : String(subjectType.recordTypeId);
  const { recordTypeByPlacement, dataPlacementsByRecordType, editFormDataPlacementIds } =
    projectPlacementRecordTypes({
      allPlacements,
      pageDefinition,
      pageSubjectRecordTypeId,
      context,
      editFormPlacementIds,
      selectedRecordType: (control) => controlSelectedRecordType(bindingContext, control),
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

  const refreshWhileByPlacement: ApplicationPageModel["refreshWhileByPlacement"] =
    Object.fromEntries(
      [...recordTypeByPlacement].flatMap(([placementId, recordTypeId]) => {
        const recordType = context.releaseSet.modules
          .flatMap((module) => module.content.recordTypes)
          .find((type) => sameId(String(type.recordTypeId), recordTypeId));
        const policy = recordType?.systemProjection?.refreshWhile;
        return policy === undefined ? [] : [[placementId, policy]];
      }),
    );

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
    services: services.placementServices(resolveRecordLinks, readSubject),
    permittedApplicationKeys,
    permittedApplicationsUnavailable: permittedApplicationsRead?.kind === "temporarily_unavailable",
    ...(boardReads === undefined ? {} : { boardReads }),
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
  const groupCreateRefusal = await projectGroupCreateForms({
    context,
    placements,
    bindings,
    dependencies,
    session,
    selection,
    accessVersion: page.accessVersion,
    data,
  });
  if (groupCreateRefusal !== undefined) return groupCreateRefusal;

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
    const guided = await projectGuidedForm({
      context,
      pageDefinition,
      page,
      parameters,
      session,
      selection,
      subjectRow,
      subject,
      dateTimeZones,
      resolveRecordLinks,
      data,
    });
    if (guided.kind === "refused") return guided.result;
    guidedForm = guided.guidedForm;
  }

  const editForms = await projectEditForms({
    address,
    placements,
    isGuidedForm: pageDefinition.type === "guided_form",
    editFormPlacementIds,
    bindings,
    subjectRow,
    hasSubject: subject !== undefined,
    subjectRecordType,
    dateTimeZones,
    resolveRecordLinks,
    data,
  });
  const { editFormBaselines, unshown } = editForms;
  if (editForms.subjectUnreadable) subjectUnreadable = true;
  projectCreateFormDefaults({
    address,
    placements,
    formRecordType,
    createFormIds,
    dateTimeZones,
    data,
  });
  const linkInputs = placements.filter(isLinkInputPlacement);
  // A new record's link field may start with the record its page address names.
  if (pageDefinition.type !== "guided_form") {
    const initialLinks = await projectInitialLinkInputs({
      session,
      context,
      placements: linkInputs.filter(
        (entry) => entry.formId === undefined || !Object.hasOwn(editFormBaselines, entry.formId),
      ),
      parameters,
      data,
      resolveRecordLinks,
      log: (placementId, reason) => logPlacementFailure(address, placementId, reason),
    });
    if (initialLinks.kind !== "ready")
      return {
        kind:
          initialLinks.kind === "temporarily_unavailable"
            ? "temporarily_unavailable"
            : "unavailable",
      };
  }
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
  const streamedData = startStreamedPlacementReads({
    streamed,
    placementReaderInput,
    address,
    data,
  });
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
  const model: PlacementReadModel = {
    page,
    pageId: pageDefinition.pageId,
    pageName: pageDefinition.name,
    theme: application.content.theme,
    ...(bodyContentAvailable === undefined ? {} : { bodyContentAvailable }),
    ...(firstRecordTypeHref === undefined ? {} : { firstRecordTypeHref }),
    accessVersion: page.accessVersion,
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
    refreshWhileByPlacement,
    pageParameters: {
      drawers: Object.fromEntries(
        allPlacements.flatMap((placement) => {
          const block = placement.vortex.block;
          if (!isRecord(block) || !sameId(String(block.blockId), DRAWER_BLOCK_RELEASE.blockId))
            return [];
          const source = placementSettings(placement.props).open_with;
          const control =
            source?.kind === "text"
              ? allPlacements.find((candidate) => sameId(candidate.placementId, source.value))
              : undefined;
          return control === undefined ? [] : [[placement.placementId, control.placementId]];
        }),
      ),
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
  if (navigation === undefined)
    return {
      kind: "placements",
      model,
      ...(applicationShell === undefined ? {} : { applicationShell }),
    };
  return {
    kind: "available",
    model: {
      ...model,
      navigation: navigation.value,
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
    },
    shells: application.content.shells,
    ...(applicationShell === undefined ? {} : { applicationShell }),
  };
};
