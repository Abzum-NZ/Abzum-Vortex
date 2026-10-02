import "server-only";

import {
  readCurrentOrganizationRuntimeSettingsAfterAuthorization,
  readCurrentRecordOwnerGroupsAfterAuthorization,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import {
  createHumanInstalledRuntimeContextLoader,
  type InstalledRuntimeContext,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/app";
import {
  arrangeDataset,
  protectedQueryCommandSchema,
  protectedQuerySummaryCommandSchema,
  createProtectedQueryService,
  createReferenceChoiceService,
  projectReferenceChoiceInputValues,
  type ProtectedQueryRow,
  type ProtectedQuerySummaryAggregateResult,
  type ReferenceChoiceInputValues,
} from "@vortex/query";
import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  applicationLauncherQueryRowsToListValues,
  type ApplicationLauncherQueryRow,
  type DisplayCellValue,
} from "@vortex/ui";
import {
  createPageSubjectReader,
  createRecordsTableQueryResolver,
  createQueryNoticeQueryResolver,
  createStoredNavigationProjectionService,
  createStoredPageCapabilityService,
  projectRecordDetailData,
  type PageSubjectReadResult,
  type PrivateFormDraftFieldValidation,
  type ProjectedNavigation,
} from "@vortex/page";
import {
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  BOARD_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  CALENDAR_BLOCK_RELEASE,
  QUERY_NOTICE_BLOCK_RELEASE,
  calendarBlockSourceIsSupported,
  calendarMappingSchema,
  flowTaskChildLists,
  exactDecimalTextV2Schema,
  jsonValueSchema,
  readRecordDetailContract,
  recordIdSchema,
  readRecordsTableContract,
  richTextDocumentV2Schema,
  moneyValueV2Schema,
  timestampSchema,
  organizationRuntimeSettingsSchema,
  type ApplicationShellV2,
  type BlockPropertyValueV2Contract,
  type BoardColumnContinuationRequest,
  type CalendarMapping,
  type FlowTask,
  type IdentitySession,
  type JsonValue,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type ReferenceChoiceSelectionEvidence,
} from "@vortex/contracts";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { readApplicationReleaseAdoption } from "./application-release-adoption";
import { getQueryContinuationKey } from "./query-continuation-key";
import { projectBoardPlacement } from "./board-placement";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import {
  computeGuidedFormStepId,
  getGuidedFormFlowId,
  getGuidedFormRecordType,
  getGuidedFormStepFields,
  getGuidedFormVisiblePlacementIds,
  guidedFormDraftScope,
  guidedFormInitialValues,
  guidedFormInputData,
  earlierGuidedStepId,
  openGuidedFormDraft,
  visibleGuidedFormValues,
  visibleGuidedFormValidation,
} from "./guided-form-steps";
import { humanOrganizationRequestDependencies, humanOrganizationRequests } from "./server-composition";
import {
  hasReferenceChoiceSource,
  projectedReferenceChoiceForm,
  resolveReferenceChoiceOption,
  type ProjectedReferenceChoiceForm,
  type ReferenceChoiceFormField,
} from "./reference-choices";

/**
 * Composes the one server model of an installed application page: the permission-filtered page,
 * the viewer's menu, the theme and the persisted data every data placement reads. Everything comes
 * from the verified human request and the exact installed release; the browser supplies only the
 * address and the page's own query string. Nothing here decides permission: the stored page and
 * navigation services, the Query engine and the flow endpoint each keep their own Access decision.
 */

export type PageDataState = Readonly<Record<string, unknown>>;

/** One flow binding a placement holds, described only by identities and the caller inputs it takes. */
export type PlacementFlowBinding = Readonly<{
  bindingId: string;
  eventId: string;
  event: string;
  flowId: string;
  /** The names of the caller inputs the bound flow declares; the surface may fill only these. */
  callerInputs: readonly string[];
  /** The installed record type of this placement's selected row or enclosing form context. */
  recordTypeId?: string;
  /** Caller inputs consumed by a declared `record.read_fields` task in this exact flow. */
  selectedReadInputs?: readonly Readonly<{
    callerInputName: string;
    recordTypeId: string;
  }>[];
}>;

export type ApplicationPageModel = Readonly<{
  page: Readonly<Record<string, unknown>>;
  pageId: string;
  shells: readonly ApplicationShellV2[];
  theme: InstalledRuntimeContext["releaseSet"]["application"]["content"]["theme"];
  navigation: ProjectedNavigation;
  /** Ready display data per data placement, by stable placement identity. */
  data: Readonly<Record<string, PageDataState>>;
  /** Each placement's flow bindings, by stable placement identity. */
  bindings: Readonly<Record<string, readonly PlacementFlowBinding[]>>;
  /** Data placements to re-read after a write from each installed flow binding. */
  refreshPlacementsByBinding: Readonly<Record<string, readonly string[]>>;
  /** Displayed values of readable edit fields, used only to omit unchanged fields on submit. */
  editFormBaselines: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
  /** Dynamic reference-choice placements within the viewer's projected page. */
  referenceChoiceInputs: readonly Readonly<{
    placementId: string;
    formId: string;
    fieldKey: string;
  }>[];
  guidedForm?: Readonly<{
    draftId: string;
    revision: number;
    flowId: string;
    activeStepId: string;
    computedStepId: string;
    values: Readonly<Record<string, JsonValue>>;
    validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>;
  }>;
  /** Permitted pages of this application, so a menu or navigate intent can be turned into an address. */
  pages: readonly Readonly<{ pageId: string; key: string }>[];
  /**
   * The record a detail or form page is about, when its address names one the viewer could read,
   * with the revision the viewer was shown. Flows started on the page carry it as evidence for
   * their record tasks and named actions; the protected record paths decide what it may do.
   */
  subject?: Readonly<{ recordId: string; revision: number }>;
  /**
   * The deliberate adoption offer, present only for a caller who may manage installations and
   * only when the application root publishes a release newer than the installed one. Its presence
   * is a rendering hint; the adoption action re-checks everything on the server.
   */
  adoption?: Readonly<{
    offeredReleaseRevision: number;
    offeredReleaseVersion: string;
    installedReleaseRevision: number;
  }>;
  invocation: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    applicationKey: string;
    pageKey: string;
    installationRevision: number;
    releaseKey: string;
  }>;
}>;

export type ApplicationPageResult =
  | Readonly<{ kind: "available"; model: ApplicationPageModel }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ApplicationPagePlacementReadResult =
  | Readonly<{
      kind: "available";
      data: Readonly<Record<string, PageDataState>>;
      editFormBaselines: Readonly<
        Record<string, Readonly<Record<string, JsonValue>> | null>
      >;
      subject: ApplicationPageModel["subject"] | null;
    }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ApplicationPageLoaderAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
}>;

type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

type BoardContinuationTarget = Readonly<{
  placementId: string;
  request: BoardColumnContinuationRequest;
}>;

/**
 * The page address parameter that carries a detail page's subject record id, the same name the
 * component event vocabulary uses for a record identity. It is only a candidate: the record read
 * path decides whether the viewer may read that record.
 */
const pageSubjectParameter = "record_id";

const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const isBoardPlacement = (placement: unknown): boolean => {
  if (!isRecord(placement) || !isRecord(placement.block)) return false;
  return (
    typeof placement.block.blockId === "string" &&
    sameId(placement.block.blockId, BOARD_BLOCK_RELEASE.blockId) &&
    placement.block.releaseVersion === BOARD_BLOCK_RELEASE.releaseVersion
  );
};

const projectedUseAvailability = (placement: unknown): "available" | "unavailable" | "invalid" => {
  if (!isRecord(placement)) return "invalid";
  const hasAvailability = Object.hasOwn(placement, "availability");
  const hasReason = Object.hasOwn(placement, "unavailableReason");
  if (!hasAvailability && !hasReason) return "available";
  if (
    hasAvailability &&
    hasReason &&
    placement.availability === "unavailable" &&
    placement.unavailableReason === "operation_unavailable"
  )
    return "unavailable";
  return "invalid";
};

const isEditFieldPlacement = (placement: Readonly<Record<string, unknown>>): boolean => {
  const block = placement.block;
  return (
    isRecord(block) &&
    typeof block.blockId === "string" &&
    (sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) ||
      Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
        sameId(release.blockId, block.blockId as string),
      ))
  );
};

type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];
type ModuleField = ModuleRelease["content"]["recordTypes"][number]["fields"][number];
type PermissionEntry = InstalledRuntimeContext["permissionRegistration"]["entries"][number];
type DateTimeZones = { personTimeZone?: string; organizationTimeZone?: string };

type InstalledFlow =
  InstalledRuntimeContext["releaseSet"]["application"]["content"]["flows"][number];

/** The record-reference inputs that the installed flow uses for selected-field reads. */
const selectedReadInputTypes = (flow: InstalledFlow): ReadonlyMap<string, string> => {
  const inputTypes = new Map<string, string | null>();
  const visit = (tasks: readonly FlowTask[]): void => {
    for (const task of tasks) {
      if (task.type === "record.read_fields") {
        const properties = "properties" in task ? task.properties : undefined;
        const recordType = properties?.record_type;
        const recordTypeId =
          isRecord(recordType) &&
          recordType.kind === "literal" &&
          isRecord(recordType.literal) &&
          recordType.literal.type === "text" &&
          typeof recordType.literal.value === "string"
            ? recordType.literal.value
            : undefined;
        const record = properties?.record;
        const reference =
          isRecord(record) && record.kind === "reference" ? record.reference : undefined;
        const inputName =
          isRecord(reference) &&
          reference.source === "input" &&
          typeof reference.name === "string"
            ? reference.name
            : undefined;
        const declaration = inputName === undefined ? undefined : flow.inputs[inputName];
        if (
          inputName !== undefined &&
          recordTypeId !== undefined &&
          declaration?.type === "record_reference" &&
          declaration.recordTypeIds?.length === 1 &&
          sameId(declaration.recordTypeIds[0]!, recordTypeId)
        ) {
          const previous = inputTypes.get(inputName);
          inputTypes.set(
            inputName,
            previous === undefined || (previous !== null && sameId(previous, recordTypeId))
              ? recordTypeId
              : null,
          );
        }
      }
      for (const child of flowTaskChildLists(task)) visit(child.tasks);
    }
  };
  visit([...flow.tasks, ...flow.errors, ...flow.finally]);
  return new Map(
    [...inputTypes].flatMap(([inputName, recordTypeId]) =>
      recordTypeId === null ? [] : [[inputName, recordTypeId] as const],
    ),
  );
};

const fieldForPlacement = (
  placement: Readonly<Record<string, unknown>>,
  modules: InstalledRuntimeContext["releaseSet"]["modules"],
): Readonly<{ module: ModuleRelease; field: ModuleField }> | undefined => {
  const settings = placement.settings;
  if (!isRecord(settings) || !isRecord(settings.field)) return undefined;
  const reference = settings.field;
  if (reference.kind !== "field_reference" || typeof reference.fieldId !== "string")
    return undefined;
  for (const module of modules)
    for (const recordType of module.content.recordTypes) {
      const field = recordType.fields.find((candidate) =>
        sameId(String(candidate.fieldId), reference.fieldId as string),
      );
      if (field !== undefined) return { module, field };
    }
  return undefined;
};

const fieldControl = (placement: Readonly<Record<string, unknown>>): string | undefined => {
  const settings = placement.settings;
  const block = placement.block;
  return isRecord(settings) && isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) &&
    isRecord(settings.control) && settings.control.kind === "choice" &&
    typeof settings.control.value === "string"
    ? settings.control.value
    : undefined;
};

/** Every placement of the projected page with its stable identity, in document order. */
const collectPlacements = (
  projected: Readonly<Record<string, unknown>>,
): Array<
  Readonly<{ placementId: string; placement: Record<string, unknown>; formId?: string }>
> => {
  const found: Array<{ placementId: string; placement: Record<string, unknown>; formId?: string }> =
    [];
  const visit = (slot: unknown, formId?: string): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const block = candidate.block;
      const owner =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
          ? placementId
          : formId;
      found.push({
        placementId,
        placement: candidate,
        ...(owner === undefined ? {} : { formId: owner }),
      });
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child, owner);
    }
  };
  const composition = projected.composition;
  if (!isRecord(composition)) return found;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const root of Object.values(composition.stepContent)) visit(root);
  return found;
};

export type ReferenceChoicePageResult =
  | Readonly<{ kind: "completed"; values: ReferenceChoiceInputValues }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type ReferenceChoiceAddress = Readonly<{
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
}>;

/** Reprojects the current addressed page under the actor and the exact installed release. */
const projectReferenceChoicePage = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{ installationRevision: number; releaseKey: string }>,
): Promise<
  | Readonly<{
      kind: "available";
      page: Readonly<Record<string, unknown>>;
      context: InstalledRuntimeContext;
      selection: OrganizationSelectionCandidate;
      dependencies: ReturnType<typeof requestDependencies>;
    }>
  | Exclude<ReferenceChoicePageResult, { kind: "completed" }>
> => {
  const dependencies = requestDependencies();
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
  };
  const loaded = await loadInstalledContext(session, dependencies, selection);
  if (loaded.kind !== "available")
    return loaded.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused" };
  const context = loaded.value;
  const application = context.releaseSet.application;
  if (!sameId(context.applicationRootId, address.application.applicationRootId))
    return { kind: "refused" };
  if (
    request.installationRevision !== context.applicationReleaseRevision ||
    request.releaseKey !== [
      application.releaseVersion,
      application.contentFingerprint,
      application.resolutionFingerprint,
    ].join(":")
  )
    return { kind: "reload" };
  const pageDefinition = application.content.pages.find((page) => page.key === address.pageKey);
  if (pageDefinition === undefined) return { kind: "refused" };
  const projected = await createStoredPageCapabilityService({
    ...dependencies,
    context,
    selection: { pageId: pageDefinition.pageId },
  }).project(session, selection);
  if (projected.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  if (projected.kind !== "available" || projected.value === undefined)
    return { kind: "refused" };
  return { kind: "available", page: projected.value, context, selection, dependencies };
};

/** The form submission's fields come only from its current actor-permitted page. */
export const loadProjectedReferenceChoiceForm = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{ installationRevision: number; releaseKey: string; formId: string }>,
): Promise<ProjectedReferenceChoiceForm | undefined> => {
  try {
    const projected = await projectReferenceChoicePage(session, address, request);
    return projected.kind === "available"
      ? projectedReferenceChoiceForm(
          projected.page,
          projected.context.releaseSet.modules,
          request.formId,
        )
      : undefined;
  } catch {
    return undefined;
  }
};

/** A form field may show only a value the page subject read returned for its own record type. */
const projectEditField = (
  placement: Readonly<Record<string, unknown>>,
  recordType: InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number],
  values: Readonly<Record<string, JsonValue>>,
  dateTimeZones: DateTimeZones,
): Readonly<{ key: string; value: JsonValue; data: PageDataState }> | undefined => {
  const settings = placement.settings;
  const block = placement.block;
  if (!isRecord(settings) || !isRecord(block) || typeof block.blockId !== "string")
    return undefined;
  const blockId = block.blockId;
  const fieldSetting = settings.field;
  const nameSetting = settings.name;
  const field = recordType.fields.find((candidate) =>
    isRecord(fieldSetting) &&
    fieldSetting.kind === "field_reference" &&
    typeof fieldSetting.fieldId === "string"
      ? sameId(String(candidate.fieldId), fieldSetting.fieldId)
      : isRecord(nameSetting) &&
        nameSetting.kind === "text" &&
        typeof nameSetting.value === "string" &&
        candidate.key === nameSetting.value,
  );
  if (field === undefined) return undefined;
  const fieldId = String(field.fieldId);
  const valueKey = Object.keys(values).find((key) => sameId(key, fieldId));
  if (valueKey === undefined) return undefined;
  const stored = values[valueKey]!;
  const control = sameId(blockId, FIELD_INPUT_BLOCK_RELEASE.blockId)
    ? isRecord(settings.control) && settings.control.kind === "choice"
      ? settings.control.value
      : undefined
    : Object.entries(FIELD_INPUT_CONTROL_RELEASES).find(([, release]) =>
        sameId(release.blockId, blockId),
      )?.[0];
  let kind: string;
  let displayed: JsonValue = stored;
  switch (control) {
    case "text":
      if (stored !== null && typeof stored !== "string") return undefined;
      kind = "text_input";
      displayed = stored ?? "";
      break;
    case "number":
      if (stored !== null && (typeof stored !== "number" || !Number.isFinite(stored)))
        return undefined;
      if (
        stored !== null &&
        isRecord(settings.integer) &&
        settings.integer.kind === "boolean" &&
        settings.integer.value === true &&
        !Number.isInteger(stored)
      )
        return undefined;
      kind = "number_input";
      break;
    case "boolean":
      if (typeof stored !== "boolean") return undefined;
      kind = "boolean_input";
      break;
    case "date":
      if (stored !== null) {
        if (typeof stored !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stored)) return undefined;
        const date = new Date(`${stored}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== stored)
          return undefined;
      }
      kind = "date_input";
      break;
    case "date_time":
      if (
        stored !== null &&
        !(typeof stored === "string" && timestampSchema.safeParse(stored).success)
      )
        return undefined;
      kind = "date_time_input";
      break;
    case "choice":
      if (stored !== null && typeof stored !== "string") return undefined;
      if (stored !== null) {
        const options = settings.options;
        if (
          !isRecord(options) ||
          options.kind !== "list" ||
          !Array.isArray(options.items) ||
          !options.items.some(
            (item) =>
              isRecord(item) &&
              isRecord(item.properties) &&
              isRecord(item.properties.key) &&
              item.properties.key.value === stored,
          )
        )
          return undefined;
      }
      kind = "choice_input";
      break;
    case "several_choices": {
      const selected = stored === null ? [] : stored;
      if (
        !Array.isArray(selected) ||
        selected.length > 200 ||
        !selected.every((choice) => typeof choice === "string") ||
        new Set(selected).size !== selected.length
      )
        return undefined;
      const options = settings.options;
      if (
        !isRecord(options) ||
        options.kind !== "list" ||
        !Array.isArray(options.items)
      )
        return undefined;
      const optionItems: unknown[] = options.items;
      if (
        !selected.every((choice) =>
          optionItems.some(
            (item) =>
              isRecord(item) &&
              isRecord(item.properties) &&
              isRecord(item.properties.key) &&
              item.properties.key.value === choice,
          ),
        )
      )
        return undefined;
      const maximumSelections = settings.maximum_selections;
      if (
        isRecord(maximumSelections) &&
        maximumSelections.kind === "number" &&
        typeof maximumSelections.value === "number" &&
        selected.length > maximumSelections.value
      )
        return undefined;
      displayed = selected;
      kind = "several_choices_input";
      break;
    }
    case "link":
      if (
        stored !== null &&
        (!isRecord(stored) ||
          typeof stored.recordTypeId !== "string" ||
          typeof stored.recordId !== "string")
      )
        return undefined;
      if (stored !== null && isRecord(stored)) {
        const targets = settings.record_types;
        if (
          !isRecord(targets) ||
          targets.kind !== "list" ||
          !Array.isArray(targets.items) ||
          !targets.items.some(
            (item) =>
              isRecord(item) &&
              item.kind === "record_type_reference" &&
              isRecord(item.recordType) &&
              item.recordType.state === "resolved" &&
              item.recordType.recordTypeId === stored.recordTypeId,
          )
        )
          return undefined;
      }
      kind = "link_input";
      break;
    case "rich_text":
      if (stored !== null && !richTextDocumentV2Schema.safeParse(stored).success) return undefined;
      kind = "rich_text_input";
      break;
    default:
      return undefined;
  }
  return {
    key: field.key,
    value:
      kind === "text_input" &&
      stored === null &&
      isRecord(settings.input_type) &&
      settings.input_type.value === "email"
        ? null
        : displayed,
    data: {
      status: "ready",
      values: { kind, value: displayed, ...(kind === "date_time_input" ? dateTimeZones : {}) },
    },
  };
};

/** Rechecks one dynamic choice request against the viewer's current installed page and authority. */
export const loadReferenceChoicePage = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{
    placementId: string;
    installationRevision: number;
    releaseKey: string;
    search?: string;
    continuationToken?: string;
    selectedKey?: string;
    selectedEvidence?: ReferenceChoiceSelectionEvidence;
  }>,
): Promise<ReferenceChoicePageResult> => {
  try {
    const projected = await projectReferenceChoicePage(session, address, request);
    if (projected.kind !== "available") return projected;
    const { dependencies, selection, context } = projected;
    const continuationKey = getQueryContinuationKey();
    const placement = collectPlacements(projected.page).find(
      (entry) => entry.placementId === request.placementId && entry.formId !== undefined,
    );
    if (placement === undefined || placement.formId === undefined)
      return { kind: "refused" };
    const form = projectedReferenceChoiceForm(
      projected.page,
      context.releaseSet.modules,
      placement.formId,
    );
    const field = form?.placements.get(request.placementId);
    if (field === undefined) return { kind: "refused" };

    const service = createReferenceChoiceService({ ...dependencies, continuationKey });
    const result = await service.run(session, selection, {
      ...field.command,
      ...(request.search === undefined || request.search.trim() === ""
        ? {}
        : { search: request.search }),
      ...(request.continuationToken === undefined
        ? {}
        : { continuationToken: request.continuationToken }),
    });
    if (result.kind === "temporarily_unavailable")
      return { kind: "temporarily_unavailable" };
    if (result.kind !== "available" || result.value.outcome !== "completed")
      return { kind: "refused" };

    const pageChoices = result.value.choices;
    let selectedChoice = request.selectedKey === undefined
      ? undefined
      : pageChoices.find((choice) => choice.key === request.selectedKey);
    let selectedEvidenceOverride: Readonly<Record<string, ReferenceChoiceSelectionEvidence>> = {};
    if (
      selectedChoice === undefined &&
      request.selectedKey !== undefined &&
      request.selectedEvidence !== undefined
    ) {
      selectedChoice = await resolveReferenceChoiceOption({
        service,
        session,
        selection,
        field,
        key: request.selectedKey,
        evidence: request.selectedEvidence,
      });
      if (selectedChoice !== undefined)
        selectedEvidenceOverride = { [selectedChoice.key]: request.selectedEvidence };
    }
    const choices =
      selectedChoice === undefined || pageChoices.some((choice) => choice.key === selectedChoice?.key)
        ? pageChoices
        : [selectedChoice, ...pageChoices];
    return {
      kind: "completed",
      values: projectReferenceChoiceInputValues(
        choices,
        selectedChoice?.key ?? null,
        undefined,
        {
          ...(request.search === undefined ? {} : { search: request.search }),
          ...(request.continuationToken === undefined
            ? {}
            : { continuationToken: request.continuationToken }),
          ...(result.value.nextContinuationToken === undefined
            ? {}
            : { nextContinuationToken: result.value.nextContinuationToken }),
          ...(Object.keys(selectedEvidenceOverride).length === 0
            ? {}
            : { optionEvidenceOverrides: selectedEvidenceOverride }),
        },
      ),
    };
  } catch {
    return { kind: "temporarily_unavailable" };
  }
};

/**
 * A query-string value typed to the declared input it fills. A value the type cannot hold is
 * dropped, so the Query engine refuses the request instead of receiving a guess.
 */
const coerceInput = (raw: string, type: string): JsonValue | undefined => {
  switch (type) {
    case "number": {
      const value = Number(raw);
      return raw.trim() !== "" && Number.isFinite(value) ? value : undefined;
    }
    case "boolean":
      return raw === "true" ? true : raw === "false" ? false : undefined;
    default:
      return raw;
  }
};

/** Structured Notice-query inputs are plain JSON; the Query service validates their declared type. */
const noticeQueryInput = (raw: string, type: string): JsonValue | undefined => {
  if (
    type === "formatted_text" || type === "money" ||
    type === "record_reference" || type === "organization_account_reference"
  ) {
    try {
      const parsed = jsonValueSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  return coerceInput(raw, type);
};

type ModuleQuery = ModuleRelease["content"]["queries"][number];

const summaryAggregateLabel = (alias: string): string =>
  alias
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());

/** Projects one already-authorised Query aggregate into the closed summary cell contract. */
const summaryAggregateCellValue = (
  aggregate: ModuleQuery["aggregates"][number],
  field: ModuleField | undefined,
  result: ProtectedQuerySummaryAggregateResult,
): DisplayCellValue | Readonly<{ kind: "unavailable" }> | undefined => {
  if (result.outcome === "refused") return { kind: "unavailable" };
  if (aggregate.operation === "count")
    return typeof result.value === "number" && Number.isSafeInteger(result.value)
      ? { kind: "number", value: result.value }
      : undefined;
  if (result.value === null || result.valueCount === 0) return { kind: "empty" };
  if (field === undefined) return undefined;

  switch (field.type) {
    case "text":
      return (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
        typeof result.value === "string"
        ? { kind: "text", text: result.value }
        : undefined;
    case "yes_no":
      return (aggregate.operation === "minimum" || aggregate.operation === "maximum") &&
        typeof result.value === "boolean"
        ? { kind: "boolean", value: result.value }
        : undefined;
    case "whole_number": {
      if (typeof result.value === "number" && Number.isSafeInteger(result.value))
        return { kind: "number", value: result.value };
      const exactValue = exactDecimalTextV2Schema.safeParse(result.value);
      return exactValue.success ? { kind: "text", text: exactValue.data } : undefined;
    }
    case "decimal_number": {
      const exactValue = exactDecimalTextV2Schema.safeParse(result.value);
      return exactValue.success ? { kind: "text", text: exactValue.data } : undefined;
    }
    case "money": {
      const moneyValue = moneyValueV2Schema.safeParse(result.value);
      return moneyValue.success
        ? { kind: "text", text: `${moneyValue.data.currency} ${moneyValue.data.amount}` }
        : undefined;
    }
    case "date":
    case "date_time":
      return typeof result.value === "string"
        ? { kind: "date", iso: result.value }
        : undefined;
    default:
      return undefined;
  }
};

const MAXIMUM_LAUNCHER_QUERY_ROWS = 10_000;

const findModuleQuery = (
  context: InstalledRuntimeContext,
  queryId: string,
): Readonly<{ module: ModuleRelease; query: ModuleQuery }> | undefined => {
  for (const module of context.releaseSet.modules) {
    const query = module.content.queries.find((candidate) => sameId(candidate.queryId, queryId));
    if (query !== undefined) return { module, query };
  }
  return undefined;
};

const resolvedQueryRecordTypeId = (
  context: InstalledRuntimeContext,
  queryId: string,
): string | undefined => {
  const recordType = findModuleQuery(context, queryId)?.query.recordType;
  return recordType?.state === "resolved" ? String(recordType.recordTypeId) : undefined;
};

const fieldLabelsOf = (module: ModuleRelease): Record<string, string> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field.label] as const),
    ),
  );

const isApplicationLauncherPlacement = (placement: unknown): boolean => {
  if (!isRecord(placement) || !isRecord(placement.block)) return false;
  return (
    typeof placement.block.blockId === "string" &&
    sameId(placement.block.blockId, APPLICATION_LAUNCHER_BLOCK_RELEASE.blockId)
  );
};

const launcherCellKey = (
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>,
  settingKey: string,
  fallback: string,
): string => {
  const value = settings[settingKey];
  return isRecord(value) && value.kind === "text" && typeof value.value === "string"
    ? value.value
    : fallback;
};

const fieldChoiceLabelsOf = (
  module: ModuleRelease,
  allowedPermissions: ReadonlySet<string>,
): Record<string, readonly Readonly<{ value: string; label: string }>[]> =>
  Object.fromEntries(
    module.content.recordTypes.flatMap((recordType) =>
      recordType.fields.flatMap((field) => {
        if (field.type !== "several_choices") return [];
        const labels = field.settings.options.flatMap((option) => {
          const permissionId = option.requiredPermissionId;
          const permissionKey =
            permissionId === undefined
              ? undefined
              : `${String(module.rootId).toLowerCase()}:${String(permissionId).toLowerCase()}`;
          return permissionKey === undefined || allowedPermissions.has(permissionKey)
            ? [{ value: option.value, label: option.label }]
            : [];
        });
        return [[String(field.fieldId).toLowerCase(), labels] as const];
      }),
    ),
  );

/**
 * Logs one data placement that could not be loaded, server side only: the application, page and
 * placement identities that are already in the address, and a fixed reason code. Never a message,
 * value, row, query input or secret, so the log names the failing step without leaking data.
 */
const logPlacementFailure = (
  address: Readonly<{ application: PermittedApplication; pageKey: string }>,
  placementId: string,
  reason:
    | "read_model_not_served"
    | "query_not_bound"
    | "subject_not_addressed"
    | "subject_unavailable"
    | "subject_refused"
    | "detail_record_type_unavailable"
    | "detail_command_invalid"
    | "detail_query_unavailable"
    | "detail_query_refused"
    | "launcher_query_invalid"
    | "launcher_query_unavailable"
    | "launcher_query_refused"
    | "calendar_settings_invalid"
    | "calendar_time_zone_unavailable"
    | "calendar_query_invalid"
    | "calendar_query_unavailable"
    | "calendar_query_refused"
    | "calendar_arrangement_refused"
    | "summary_query_invalid"
    | "summary_query_unavailable"
    | "summary_query_refused"
    | "summary_dataset_limit_exceeded"
    | "summary_result_invalid",
): void => {
  console.error(
    `[page] data placement not loaded: application=${address.application.key} page=${address.pageKey} placement=${placementId} reason=${reason}`,
  );
};

const requestState = (
  placementId: string,
  parameters: SearchParameters,
): Readonly<{
  sort: { fieldId: string; direction: "ascending" | "descending" } | null;
  filters: { fieldId: string; value: string }[];
  search: string | null;
}> => {
  const sortText = first(parameters[`sort.${placementId}`]);
  const separator = sortText?.lastIndexOf(":") ?? -1;
  const direction = sortText?.slice(separator + 1);
  const sort: { fieldId: string; direction: "ascending" | "descending" } | null =
    sortText !== undefined && separator > 0 && direction === "ascending"
      ? { fieldId: sortText.slice(0, separator), direction: "ascending" }
      : sortText !== undefined && separator > 0 && direction === "descending"
        ? { fieldId: sortText.slice(0, separator), direction: "descending" }
        : null;
  const filterPrefix = `filter.${placementId}.`;
  const filters = Object.entries(parameters).flatMap(([name, value]) => {
    const text = first(value);
    return name.startsWith(filterPrefix) && text !== undefined
      ? [{ fieldId: name.slice(filterPrefix.length), value: text }]
      : [];
  });
  return { sort, filters, search: first(parameters[`search.${placementId}`]) ?? null };
};

type CalendarView = "month" | "week" | "agenda";

type CalendarPlacementContract = Readonly<{
  calendarMapping: CalendarMapping;
  itemTitleFieldId: string;
  defaultView: CalendarView;
}>;

const calendarFieldReference = (value: BlockPropertyValueV2Contract | undefined): string | undefined =>
  value?.kind === "field_reference" ? value.fieldId : undefined;

const calendarChoice = (value: BlockPropertyValueV2Contract | undefined): string | undefined =>
  value?.kind === "choice" ? value.value : undefined;

/** Reads the one calendar placement's declared field mapping from its validated settings. */
const readCalendarPlacementContract = (
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>,
): CalendarPlacementContract | undefined => {
  const group = settings.calendar_mapping;
  if (group?.kind !== "group") return undefined;
  const properties = group.properties;
  const kind = calendarChoice(properties.kind);
  const startFieldId = calendarFieldReference(properties.start_field);
  const endFieldId = calendarFieldReference(properties.end_field);
  const durationFieldId = calendarFieldReference(properties.duration_field);
  const durationUnit = calendarChoice(properties.duration_unit);
  if (startFieldId === undefined) return undefined;
  const mappingCandidate =
    kind === "start_end" &&
    endFieldId !== undefined &&
    durationFieldId === undefined &&
    durationUnit === undefined
      ? { kind, startFieldId, endFieldId }
      : kind === "start_duration" &&
          endFieldId === undefined &&
          durationFieldId !== undefined &&
          durationUnit !== undefined
        ? { kind, startFieldId, durationFieldId, durationUnit }
        : undefined;
  const mapping = calendarMappingSchema.safeParse(mappingCandidate);
  const itemTitleFieldId = calendarFieldReference(settings.item_title_field);
  if (!mapping.success || itemTitleFieldId === undefined) return undefined;
  const configuredView = calendarChoice(settings.default_view);
  const defaultView: CalendarView =
    configuredView === "week" || configuredView === "agenda" ? configuredView : "month";
  return { calendarMapping: mapping.data, itemTitleFieldId, defaultView };
};

const calendarDateIsValid = (candidate: string | undefined): candidate is string => {
  if (candidate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  const [year, month, day] = candidate.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    year >= 1 &&
    year <= 9999 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const calendarUtcDate = (year: number, month: number, day: number): Date => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const calendarIsoDate = (date: Date): string =>
  `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const calendarAddDays = (date: string, count: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return calendarIsoDate(calendarUtcDate(year, month - 1, day + count));
};

const calendarToday = (timeZone: string): string => {
  const values = new Map(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

const calendarLocalDate = (instant: number, timeZone: string): string => {
  const values = new Map(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
};

/** First instant of an organisation-local day, including offset changes around daylight saving. */
const calendarStartOfDay = (date: string, timeZone: string): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const estimate = calendarUtcDate(year, month - 1, day).getTime();
  let lower = estimate - 48 * 60 * 60 * 1_000;
  let upper = estimate + 48 * 60 * 60 * 1_000;
  if (calendarLocalDate(lower, timeZone) >= date) return new Date(lower).toISOString();
  if (calendarLocalDate(upper, timeZone) < date) return new Date(upper).toISOString();
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (calendarLocalDate(middle, timeZone) >= date) upper = middle;
    else lower = middle;
  }
  return new Date(upper).toISOString();
};

const calendarPeriod = (
  view: CalendarView,
  date: string,
): Readonly<{ startDate: string; endDate: string }> => {
  if (view === "agenda") return { startDate: date, endDate: calendarAddDays(date, 30) };
  if (view === "week") {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    const mondayOffset = (calendarUtcDate(year, month - 1, day).getUTCDay() + 6) % 7;
    const startDate = calendarAddDays(date, -mondayOffset);
    return { startDate, endDate: calendarAddDays(startDate, 7) };
  }
  const [year, month] = date.split("-").map(Number) as [number, number];
  const startDate = calendarIsoDate(calendarUtcDate(year, month - 1, 1));
  const endDate = calendarAddDays(startDate, calendarUtcDate(year, month, 0).getUTCDate());
  return { startDate, endDate };
};

const calendarWindowFilter = (
  mapping: CalendarMapping,
  dateFieldType: "date" | "date_time",
  window: Readonly<{ startDate: string; endDate: string }>,
  timeZone: string,
): JsonValue => {
  const startValue =
    dateFieldType === "date" ? window.startDate : calendarStartOfDay(window.startDate, timeZone);
  const endValue =
    dateFieldType === "date" ? window.endDate : calendarStartOfDay(window.endDate, timeZone);
  const compare = (
    fieldId: string,
    operator: "less_than" | "greater_than_or_equal",
    value: string,
  ): JsonValue => ({
    kind: "comparison",
    operator,
    left: { source: "field", fieldId: fieldId.toLowerCase() },
    right: { source: "value", value },
  });
  const conditions =
    mapping.kind === "start_end"
      ? [
          compare(mapping.startFieldId, "less_than", endValue),
          compare(mapping.endFieldId, "greater_than_or_equal", startValue),
        ]
      : [
          compare(mapping.startFieldId, "greater_than_or_equal", startValue),
          compare(mapping.startFieldId, "less_than", endValue),
        ];
  return { kind: "all", conditions };
};

const calendarTitle = (value: JsonValue | undefined, field: { type: string; settings?: unknown }): string => {
  if (typeof value === "string") {
    if (field.type === "choice" && isRecord(field.settings) && Array.isArray(field.settings.options)) {
      const option = field.settings.options.find(
        (candidate) => isRecord(candidate) && candidate.value === value,
      );
      if (isRecord(option) && typeof option.label === "string") return option.label;
    }
    return value.slice(0, 200);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .flatMap((entry) => {
        if (typeof entry !== "string") return [];
        if (
          field.type !== "several_choices" ||
          !isRecord(field.settings) ||
          !Array.isArray(field.settings.options)
        )
          return [entry];
        const option = field.settings.options.find(
          (candidate) => isRecord(candidate) && candidate.value === entry,
        );
        return [isRecord(option) && typeof option.label === "string" ? option.label : entry];
      })
      .join(", ")
      .slice(0, 200);
  if (field.type === "formatted_text" && isRecord(value)) {
    const textParts: string[] = [];
    const collect = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(collect);
      } else if (isRecord(candidate)) {
        if (typeof candidate.text === "string") textParts.push(candidate.text);
        else Object.values(candidate).forEach(collect);
      }
    };
    collect(value);
    return textParts.join("").slice(0, 200);
  }
  return "";
};

const requestDependencies = (): HumanOrganizationRequestDependencies =>
  humanOrganizationRequestDependencies();

/** The exact installed runtime context, read once under the person's own verified request scope. */
const loadInstalledContext = (
  session: IdentitySession,
  dependencies: HumanOrganizationRequestDependencies,
  selection: OrganizationSelectionCandidate,
) =>
  humanOrganizationRequests(dependencies.identityAuthorityId).run(
    session,
    selection,
    async (transaction, scope) => {
      if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
      return createHumanInstalledRuntimeContextLoader({
        activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
        releaseSetReader: createDatabaseApplicationBoundReleaseSetService(
          installedReleaseCatalogue,
          transaction,
        ),
        scope: { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
      }).load();
    },
  );

const loadApplicationPageInternal = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  selectedPlacementIds?: ReadonlySet<string>,
  boardContinuation?: BoardContinuationTarget,
): Promise<ApplicationPageResult> => {
  const dependencies = requestDependencies();
  const continuationKey = getQueryContinuationKey();
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
  };

  // The installed context is read once, under the person's own verified request scope.
  const loaded = await loadInstalledContext(session, dependencies, selection);
  if (loaded.kind !== "available") return loaded;
  const context = loaded.value;
  const application = context.releaseSet.application;

  // The offered release is read under the viewer's own application scope. A refusal or an absent
  // target reads as "nothing to adopt"; publishing a release alone never changes this page.
  const adoptionTarget =
    selectedPlacementIds === undefined
      ? await readApplicationReleaseAdoption(session, {
          organizationId: context.organizationId,
          applicationRootId: context.applicationRootId,
        })
      : undefined;

  const pageDefinition = application.content.pages.find((page) => page.key === address.pageKey);
  if (pageDefinition === undefined) return { kind: "unavailable" };

  const pageService = createStoredPageCapabilityService({
    ...dependencies,
    context,
    selection: { pageId: pageDefinition.pageId },
  });
  const projectedPage = await pageService.project(session, selection);
  if (projectedPage.kind !== "available") return projectedPage;
  // An undefined projection is the page refused for this viewer: never an empty page.
  if (projectedPage.value === undefined) return { kind: "unavailable" };
  // The page capability projection is authoritative, but its derived choice settings still
  // contain every declared option. Work on a copy so gated options never reach the browser.
  const page = structuredClone(projectedPage.value);
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
      const detail = readRecordDetailContract(
        settings as Readonly<Record<string, BlockPropertyValueV2Contract>>,
      );
      return detail?.fields.map((field) => field.field.toLowerCase()) ?? [];
    }),
  );
  for (const module of context.releaseSet.modules)
    for (const recordType of module.content.recordTypes)
      for (const field of recordType.fields) {
        if (
          !displayedFieldIds.has(String(field.fieldId).toLowerCase()) ||
          field.type !== "several_choices"
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
        const allowed: string[] = [];
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
          const decision = await runOrganizationAccessOperation(
            transaction,
            scope,
            declaration,
            async () => true,
          );
          if (decision.outcome === "completed") allowed.push(key);
        }
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

  const navigation = await createStoredNavigationProjectionService({
    ...dependencies,
    context,
  }).project(session, selection);
  if (navigation.kind !== "available") return navigation;

  const queries = createProtectedQueryService({ ...dependencies, continuationKey });
  const referenceChoices = createReferenceChoiceService({ ...dependencies, continuationKey });
  const tables = createRecordsTableQueryResolver(queries);
  const queryNotices = createQueryNoticeQueryResolver(queries);
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
        (isEditFieldPlacement(placement) &&
          selectedForProjection.has(placementId.toLowerCase()))
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
  const recordTypeByPlacement = new Map<string, string>();
  const dataPlacementsByRecordType = new Map<string, string[]>();
  const editFormDataPlacementIds = new Map<string, string[]>();
  const addDataPlacement = (recordTypeId: string, placementId: string): void => {
    const key = recordTypeId.toLowerCase();
    const current = dataPlacementsByRecordType.get(key) ?? [];
    if (!current.some((candidate) => sameId(candidate, placementId)))
      dataPlacementsByRecordType.set(key, [...current, placementId]);
  };
  for (const { placementId, placement } of allPlacements) {
    if (placement.readModel !== undefined) continue;
    const block = placement.block;
    if (
      pageSubjectRecordTypeId !== undefined &&
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      recordTypeByPlacement.set(placementId.toLowerCase(), pageSubjectRecordTypeId);

    const settings = placement.settings as Readonly<Record<string, BlockPropertyValueV2Contract>>;
    const tableContract = readRecordsTableContract(settings);
    const detailContract =
      tableContract === undefined ? readRecordDetailContract(settings) : undefined;
    const isBoardBlock = isBoardPlacement(placement);
    const isQueryNoticeBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, QUERY_NOTICE_BLOCK_RELEASE.blockId) &&
      block.releaseVersion === QUERY_NOTICE_BLOCK_RELEASE.releaseVersion;
    if (
      tableContract === undefined && detailContract === undefined &&
      !isBoardBlock && !isQueryNoticeBlock
    ) continue;

    const queryId = typeof placement.queryId === "string" ? placement.queryId : undefined;
    const recordTypeId =
      queryId === undefined
        ? detailContract === undefined || pageDefinition.type === "form"
          ? undefined
          : pageSubjectRecordTypeId
        : resolvedQueryRecordTypeId(context, queryId);
    if (recordTypeId === undefined) continue;
    recordTypeByPlacement.set(placementId.toLowerCase(), recordTypeId);
    addDataPlacement(recordTypeId, placementId);
  }
  if (pageSubjectRecordTypeId !== undefined) {
    for (const formId of editFormPlacementIds) {
      const formDataPlacementIds = [formId];
      for (const { placementId, placement, formId: ownerFormId } of allPlacements) {
        if (ownerFormId === undefined || !sameId(ownerFormId, formId)) continue;
        if (!isEditFieldPlacement(placement)) continue;
        recordTypeByPlacement.set(placementId.toLowerCase(), pageSubjectRecordTypeId);
        formDataPlacementIds.push(placementId);
      }
      editFormDataPlacementIds.set(formId.toLowerCase(), formDataPlacementIds);
    }
  }

  const refreshPlacementsByBinding: Record<string, readonly string[]> = {};
  const flowsById = new Map(
    application.content.flows.map((flow) => [String(flow.id).toLowerCase(), flow] as const),
  );
  const selectedReadTypesByFlow = new Map<string, ReadonlyMap<string, string>>();
  const ambiguousSelectedReadFlowIds = new Set<string>();
  for (const flow of [
    ...application.content.flows,
    ...context.releaseSet.modules.flatMap((module) => module.content.flows),
  ]) {
    const flowId = String(flow.id).toLowerCase();
    if (ambiguousSelectedReadFlowIds.has(flowId)) continue;
    if (selectedReadTypesByFlow.has(flowId)) {
      selectedReadTypesByFlow.delete(flowId);
      ambiguousSelectedReadFlowIds.add(flowId);
      continue;
    }
    selectedReadTypesByFlow.set(flowId, selectedReadInputTypes(flow));
  }
  const actionRecordTypes = new Map(
    [
      ...application.content.actions,
      ...context.releaseSet.modules.flatMap((module) => module.content.actions),
    ].map((action) => [String(action.key).toLowerCase(), String(action.subjectRecordTypeId)] as const),
  );
  const flowWrittenRecordTypes = (flowId: string): readonly string[] => {
    const types = new Set<string>();
    const visited = new Set<string>();
    const literal = (task: FlowTask, name: string): string | undefined => {
      const properties = "properties" in task ? task.properties : undefined;
      const value = properties?.[name];
      return isRecord(value) && value.kind === "literal" && isRecord(value.literal) &&
        value.literal.type === "text" && typeof value.literal.value === "string"
        ? value.literal.value
        : undefined;
    };
    const visitFlow = (id: string): void => {
      const key = id.toLowerCase();
      if (visited.has(key)) return;
      visited.add(key);
      const flow = flowsById.get(key);
      if (flow === undefined) return;
      const visitTasks = (tasks: readonly FlowTask[]): void => {
        for (const task of tasks) {
          if (task.type === "run_flow")
            visitFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId));
          if (
            [
              "record.save",
              "record.create",
              "record.set_fields",
              "record.delete",
              "record.restore",
              "record.changes",
            ].includes(task.type)
          ) {
            const recordType = literal(task, "record_type");
            if (recordType !== undefined) types.add(recordType);
          } else if (task.type === "operation.call") {
            const operation = literal(task, "operation");
            const recordType =
              operation === undefined ? undefined : actionRecordTypes.get(operation.toLowerCase());
            if (recordType !== undefined) types.add(recordType);
          }
          for (const child of flowTaskChildLists(task)) visitTasks(child.tasks);
        }
      };
      visitTasks(flow.tasks);
      visitTasks(flow.errors);
      visitTasks(flow.finally);
    };
    visitFlow(flowId);
    return [...types];
  };
  for (const { placementId, formId } of allPlacements) {
    const held = application.content.flowBindings.filter((binding) =>
      sameId(String(binding.controlId), placementId),
    );
    if (held.length === 0) continue;
    const sourceRecordTypeId =
      recordTypeByPlacement.get(placementId.toLowerCase()) ??
      (formId === undefined ? undefined : recordTypeByPlacement.get(formId.toLowerCase())) ??
      pageSubjectRecordTypeId;
    const editFormId =
      editFormPlacementIds.has(placementId)
        ? placementId
        : formId !== undefined && editFormPlacementIds.has(formId)
          ? formId
          : undefined;
    for (const binding of held) {
      const writtenTypes = flowWrittenRecordTypes(String(binding.flow.flowId));
      const targetTypes =
        writtenTypes.length > 0
          ? writtenTypes
          : sourceRecordTypeId === undefined
            ? []
            : [sourceRecordTypeId];
      const queryTargets = targetTypes.flatMap((recordTypeId) =>
        dataPlacementsByRecordType.get(recordTypeId.toLowerCase()) ?? [],
      );
      const formTargets =
        editFormId === undefined ||
        pageSubjectRecordTypeId === undefined ||
        !targetTypes.some((recordTypeId) => sameId(recordTypeId, pageSubjectRecordTypeId))
          ? []
          : (editFormDataPlacementIds.get(editFormId.toLowerCase()) ?? []);
      const targets = [...new Set([...queryTargets, ...formTargets])];
      if (targets.length > 0) refreshPlacementsByBinding[String(binding.bindingId)] = targets;
    }
  }

  const data: Record<string, PageDataState> = {};
  for (const { placementId, placement } of placements)
    if (fieldControl(placement) === "date_time")
      data[placementId] = {
        status: "ready",
        values: { kind: "date_time_input", ...dateTimeZones },
      };
  const bindings: Record<string, PlacementFlowBinding[]> = {};
  const referenceChoiceInputs: Array<{ placementId: string; formId: string; fieldKey: string }> = [];
  for (const { placementId, placement, formId } of placements) {
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

    const block = placement.block;
    const isCalendarBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, CALENDAR_BLOCK_RELEASE.blockId);
    const isQueryNoticeBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, QUERY_NOTICE_BLOCK_RELEASE.blockId);
    const isSummaryValuesBlock =
      isRecord(block) &&
      typeof block.blockId === "string" &&
      sameId(block.blockId, SUMMARY_VALUES_BLOCK_RELEASE.blockId);
    const settings = placement.settings as Readonly<Record<string, BlockPropertyValueV2Contract>>;
    const calendarContract = isCalendarBlock ? readCalendarPlacementContract(settings) : undefined;
    const isBoardBlock = isBoardPlacement(placement);
    const tableContract = readRecordsTableContract(settings);
    const detailContract =
      tableContract === undefined ? readRecordDetailContract(settings) : undefined;
    if (hasReferenceChoiceSource(placement)) {
      const form = formId === undefined
        ? undefined
        : projectedReferenceChoiceForm(page, context.releaseSet.modules, formId);
      const field = form?.placements.get(placementId);
      if (field === undefined || formId === undefined) {
        data[placementId] = { status: "disabled", reason: "Choices unavailable" };
        continue;
      }
      referenceChoiceInputs.push({ placementId, formId, fieldKey: field.fieldKey });
      const result = await referenceChoices.run(session, selection, field.command);
      if (result.kind !== "available" || result.value.outcome !== "completed") {
        data[placementId] = { status: "disabled", reason: "Choices unavailable" };
        continue;
      }
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
      continue;
    }
    // A placement still bound to a legacy read model has no reader on this page: system record
    // types are read through the query path. It must never fall through to an empty display.
    if (placement.readModel !== undefined) {
      logPlacementFailure(address, placementId, "read_model_not_served");
      data[placementId] = { status: "error" };
      continue;
    }
    if (isCalendarBlock && calendarContract === undefined) {
      logPlacementFailure(address, placementId, "calendar_settings_invalid");
      data[placementId] = { status: "refused", reason: "not_permitted" };
      continue;
    }
    const queryId = typeof placement.queryId === "string" ? placement.queryId : undefined;
    const queryBoundLauncher = isApplicationLauncherPlacement(placement) && queryId !== undefined;
    const queryBoundSummary = isSummaryValuesBlock && queryId !== undefined;
    const queryBoundBoard = isBoardBlock && queryId !== undefined;
    if (
      tableContract === undefined &&
      detailContract === undefined &&
      !isCalendarBlock &&
      !isQueryNoticeBlock &&
      !queryBoundLauncher &&
      !queryBoundSummary &&
      !queryBoundBoard
    ) continue;
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
        continue;
      }
      if (!subjectId.success) {
        logPlacementFailure(address, placementId, "subject_not_addressed");
        data[placementId] = { status: "refused", reason: "not_found" };
        continue;
      }
      const subjectModule = context.releaseSet.modules.find((module) =>
        sameId(String(module.rootId), String(subjectType.moduleRootId)),
      );
      const subject = await readSubject(String(subjectType.recordTypeId), subjectId.data);
      if (subject.kind === "temporarily_unavailable") {
        logPlacementFailure(address, placementId, "subject_unavailable");
        data[placementId] = { status: "error" };
        continue;
      }
      if (subject.kind === "refused") {
        logPlacementFailure(address, placementId, "subject_refused");
        data[placementId] = { status: "refused", reason: "not_found" };
        continue;
      }
      const display = projectRecordDetailData(
        {
          settings,
          ...(subjectModule === undefined
            ? {}
            : {
                fieldLabels: fieldLabelsOf(subjectModule),
                fieldChoiceLabels: fieldChoiceLabelsOf(subjectModule, allowedPermissions),
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
      continue;
    }

    const bound = queryId === undefined ? undefined : findModuleQuery(context, queryId);
    if (queryId === undefined || bound === undefined) {
      logPlacementFailure(address, placementId, "query_not_bound");
      data[placementId] = { status: "error" };
      continue;
    }
    const inputType = (input: string): string | undefined =>
      bound.query.inputs.find((declared) => declared.key === input)?.type;
    const fieldLabels = fieldLabelsOf(bound.module);

    if (isQueryNoticeBlock) {
      if (!isRecord(block) || block.releaseVersion !== QUERY_NOTICE_BLOCK_RELEASE.releaseVersion) {
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
      }
      const inputValues: Record<string, JsonValue> = {};
      let invalidInput = false;
      for (const declared of bound.query.inputs) {
        const raw = first(parameters[declared.key]);
        const value = raw === undefined ? undefined : noticeQueryInput(raw, declared.type);
        if (raw !== undefined && value === undefined) invalidInput = true;
        if (value !== undefined) inputValues[declared.key] = value;
      }
      if (invalidInput) {
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
      }
      data[placementId] = await queryNotices.resolve(
        session, selection, context, queryId, settings, inputValues,
      );
      continue;
    }

    if (queryBoundBoard) {
      const continuation =
        boardContinuation !== undefined && sameId(boardContinuation.placementId, placementId)
          ? boardContinuation.request
          : undefined;
      data[placementId] = await projectBoardPlacement({
        context,
        session,
        selection,
        placement: placement as unknown as Parameters<typeof projectBoardPlacement>[0]["placement"],
        parameters,
        queries,
        ...(continuation === undefined ? {} : { continuation }),
      });
      continue;
    }

    if (queryBoundLauncher) {
      if (permittedApplicationKeys === undefined) {
        data[placementId] =
          permittedApplicationsRead?.kind === "temporarily_unavailable"
            ? { status: "error" }
            : { status: "refused", reason: "not_permitted" };
        continue;
      }
      const target = bound.query.recordType;
      if (target.state !== "resolved") {
        logPlacementFailure(address, placementId, "launcher_query_invalid");
        data[placementId] = { status: "error" };
        continue;
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
        continue;
      }
      const inputValues: Record<string, JsonValue> = {};
      for (const declared of bound.query.inputs) {
        const raw = first(parameters[declared.key]);
        const value = raw === undefined ? undefined : coerceInput(raw, declared.type);
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
        continue;
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
        continue;
      }

      const fieldKeys = new Map(
        targetRecordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field.key] as const),
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
      continue;
    }

    if (queryBoundSummary) {
      const inputValues: Record<string, JsonValue> = {};
      for (const declared of bound.query.inputs) {
        const raw = first(parameters[declared.key]);
        const value = raw === undefined ? undefined : coerceInput(raw, declared.type);
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
        continue;
      }

      let summaryResult: Awaited<ReturnType<typeof queries.summarise>>;
      try {
        summaryResult = await queries.summarise(session, selection, command.data);
      } catch {
        summaryResult = { kind: "temporarily_unavailable" };
      }
      if (summaryResult.kind === "temporarily_unavailable") {
        logPlacementFailure(address, placementId, "summary_query_unavailable");
        data[placementId] = { status: "error" };
        continue;
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
        );
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
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
        continue;
      }

      const recordTypeReference = bound.query.recordType;
      const summaryRecordType =
        recordTypeReference.state === "resolved"
          ? context.releaseSet.modules
              .find((module) => sameId(String(module.rootId), String(recordTypeReference.moduleRootId)))
              ?.content.recordTypes.find((recordType) =>
                sameId(String(recordType.recordTypeId), String(recordTypeReference.recordTypeId)),
              )
          : undefined;
      const fieldById = new Map(
        (summaryRecordType?.fields ?? []).map((field) => [String(field.fieldId).toLowerCase(), field]),
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
      continue;
    }

    if (isCalendarBlock && calendarContract !== undefined) {
      let organizationSettings: Awaited<ReturnType<typeof readCalendarSettings>>;
      try {
        organizationSettings = await readCalendarSettings();
      } catch {
        logPlacementFailure(address, placementId, "calendar_time_zone_unavailable");
        data[placementId] = { status: "error" };
        continue;
      }
      if (
        organizationSettings.kind !== "available" ||
        organizationSettings.value.accessVersion !== page.accessVersion ||
        organizationSettings.value.settings === undefined
      ) {
        logPlacementFailure(
          address,
          placementId,
          organizationSettings.kind === "unavailable"
            ? "calendar_settings_invalid"
            : "calendar_time_zone_unavailable",
        );
        data[placementId] =
          organizationSettings.kind === "unavailable"
            ? { status: "refused", reason: "not_permitted" }
            : { status: "error" };
        continue;
      }
      const timeZone = organizationSettings.value.settings.timeZone;
      const recordTypeReference = bound.query.recordType;
      const recordType =
        recordTypeReference.state === "resolved"
          ? bound.module.content.recordTypes.find((candidate) =>
              sameId(String(candidate.recordTypeId), String(recordTypeReference.recordTypeId)),
            )
          : undefined;
      const fieldById = new Map(
        (recordType?.fields ?? []).map((field) => [String(field.fieldId).toLowerCase(), field]),
      );
      const mapping = calendarContract.calendarMapping;
      const startField = fieldById.get(mapping.startFieldId.toLowerCase());
      const endField =
        mapping.kind === "start_end" ? fieldById.get(mapping.endFieldId.toLowerCase()) : undefined;
      const durationField =
        mapping.kind === "start_duration"
          ? fieldById.get(mapping.durationFieldId.toLowerCase())
          : undefined;
      const titleField = fieldById.get(calendarContract.itemTitleFieldId.toLowerCase());
      const selected = new Set(bound.query.selectedFieldIds.map((fieldId) => fieldId.toLowerCase()));
      const dateFieldType = startField?.type;
      const filterableDateFields =
        mapping.kind === "start_end"
          ? [startField, endField]
          : [startField];
      const mappingValid =
        recordType !== undefined &&
        (dateFieldType === "date" || dateFieldType === "date_time") &&
        filterableDateFields.every((field) => field?.filterable === true) &&
        (mapping.kind !== "start_end" || endField?.type === dateFieldType) &&
        (mapping.kind !== "start_duration" ||
          ((dateFieldType === "date_time" ||
            (dateFieldType === "date" && mapping.durationUnit === "days")) &&
            durationField?.type === "whole_number")) &&
        titleField !== undefined &&
        calendarBlockSourceIsSupported(bound.query, titleField.type);
      const requestedFieldIds = [
        mapping.startFieldId,
        ...(mapping.kind === "start_end" ? [mapping.endFieldId] : [mapping.durationFieldId]),
        calendarContract.itemTitleFieldId,
      ];
      if (
        !mappingValid ||
        !requestedFieldIds.every((fieldId) => selected.has(fieldId.toLowerCase()))
      ) {
        logPlacementFailure(address, placementId, "calendar_settings_invalid");
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
      }

      const rawView = first(parameters[`view.${placementId}`]);
      const view: CalendarView =
        rawView === "week" || rawView === "agenda" || rawView === "month"
          ? rawView
          : calendarContract.defaultView;
      const rawDate = first(parameters[`date.${placementId}`]);
      const candidateDate = calendarDateIsValid(rawDate) ? rawDate : calendarToday(timeZone);
      const candidateWindow = calendarPeriod(view, candidateDate);
      const date =
        calendarDateIsValid(candidateWindow.startDate) &&
        calendarDateIsValid(candidateWindow.endDate)
          ? candidateDate
          : calendarToday(timeZone);
      const window = calendarPeriod(view, date);
      const filterableFieldIds =
        mapping.kind === "start_end"
          ? [mapping.startFieldId, mapping.endFieldId].map((fieldId) => fieldId.toLowerCase())
          : [mapping.startFieldId.toLowerCase()];
      const command = protectedQueryCommandSchema.safeParse({
        moduleRootId: bound.module.rootId,
        queryId: bound.query.queryId,
        inputValues: {},
        requestedFieldIds: [...new Set(requestedFieldIds.map((fieldId) => fieldId.toLowerCase()))],
        requestedSystemFieldKeys: [],
        sort: [],
        filter: calendarWindowFilter(mapping, dateFieldType as "date" | "date_time", window, timeZone),
        sortableFieldIds: [],
        filterableFieldIds,
        searchableFieldIds: [],
        pageSize: bound.query.pageSize,
      });
      if (!command.success) {
        logPlacementFailure(address, placementId, "calendar_query_invalid");
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
      }

      let queryResult: Awaited<ReturnType<typeof queries.run>>;
      try {
        queryResult = await queries.run(session, selection, command.data);
      } catch {
        queryResult = { kind: "temporarily_unavailable" as const };
      }
      if (queryResult.kind === "temporarily_unavailable") {
        logPlacementFailure(address, placementId, "calendar_query_unavailable");
        data[placementId] = { status: "error" };
        continue;
      }
      if (queryResult.kind !== "available" || queryResult.value.outcome !== "completed") {
        logPlacementFailure(address, placementId, "calendar_query_refused");
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
      }

      const fieldIds = [...new Set(requestedFieldIds.map((fieldId) => fieldId.toLowerCase()))];
      const arranged = arrangeDataset({
        dataset: {
          plan: {
            moduleRootId: queryResult.value.moduleRootId,
            moduleReleaseVersion: queryResult.value.moduleReleaseVersion,
            queryId: queryResult.value.queryId,
          },
          fields: fieldIds.flatMap((fieldId) => {
            const field = fieldById.get(fieldId);
            return field === undefined ? [] : [{ fieldId, type: field.type }];
          }),
          rows: queryResult.value.rows,
        },
        descriptor: {
          type: "calendar",
          declaredFieldIds: fieldIds,
          calendarMapping: mapping,
          timeZone,
        },
      });
      if (arranged.outcome !== "completed" || arranged.arrangement !== "calendar") {
        logPlacementFailure(address, placementId, "calendar_arrangement_refused");
        data[placementId] = { status: "refused", reason: "not_permitted" };
        continue;
      }

      const items = arranged.items.map((item) => {
        const titleValue = Object.entries(item.values).find(([key]) =>
          sameId(key, calendarContract.itemTitleFieldId),
        )?.[1];
        return {
          recordId: item.recordId,
          start: item.start,
          end: item.end,
          title: calendarTitle(titleValue, titleField),
        };
      });
      const truncated = queryResult.value.nextContinuationToken !== undefined;
      data[placementId] = {
        status: "ready",
        values: {
          kind: "calendar",
          view,
          date,
          windowStart: window.startDate,
          windowEnd: window.endDate,
          timeZone,
          endExclusive: mapping.kind === "start_duration",
          truncated,
          items,
        },
      };
      continue;
    }

    if (tableContract !== undefined) {
      const pageParameters: Record<string, JsonValue> = {};
      for (const parameter of tableContract.parameters) {
        const raw =
          parameter.pageParameter === undefined
            ? undefined
            : first(parameters[parameter.pageParameter]);
        const type = inputType(parameter.input);
        const value = raw === undefined || type === undefined ? undefined : coerceInput(raw, type);
        if (parameter.pageParameter !== undefined && value !== undefined)
          pageParameters[parameter.pageParameter] = value;
      }
      const state = requestState(placementId, parameters);
      const resolved = await tables.resolve(session, selection, {
        moduleRootId: bound.module.rootId,
        queryId: bound.query.queryId,
        settings,
        pageParameters,
        fieldLabels,
        sort: state.sort,
        filters: state.filters,
        search: state.search,
      });
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
      continue;
    }

    const queryRecordType = bound.query.recordType;
    const detailModule = queryRecordType.state === "resolved"
      ? context.releaseSet.modules.find((module) =>
          sameId(String(module.rootId), String(queryRecordType.moduleRootId)),
        )
      : undefined;
    if (detailModule === undefined) {
      logPlacementFailure(address, placementId, "detail_record_type_unavailable");
      data[placementId] = { status: "error" };
      continue;
    }

    // A Record detail reads only the inputs its bound query declares, from the page's own query
    // string; the Query engine validates each against the declared type and refuses the rest.
    const inputValues: Record<string, JsonValue> = {};
    for (const declared of bound.query.inputs) {
      const raw = first(parameters[declared.key]);
      const value = raw === undefined ? undefined : coerceInput(raw, declared.type);
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
      continue;
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
      const display = projectRecordDetailData(
        {
          settings,
          fieldLabels: fieldLabelsOf(detailModule),
          fieldChoiceLabels: fieldChoiceLabelsOf(detailModule, allowedPermissions),
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
  }

  // A Group-owned create form needs an explicit owner from the viewer's current
  // memberships. Every Group returned here is eligible for initial Group ownership;
  // the Record writer still locks and rechecks the selected membership at save time.
  const ownershipByRecordType = new Map(
    context.releaseSet.modules.flatMap((module) =>
      module.content.recordTypes.map((recordType) =>
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
      const visitTasks = (tasks: readonly FlowTask[]): boolean => tasks.some((task) => {
        const properties = "properties" in task ? task.properties : undefined;
        const recordType = properties?.record_type;
        if (task.type === "record.save" && properties !== undefined &&
            !Object.hasOwn(properties, "record") && isRecord(recordType) &&
            recordType.kind === "literal" && isRecord(recordType.literal) &&
            recordType.literal.type === "text" &&
            typeof recordType.literal.value === "string" &&
            ownershipByRecordType.get(recordType.literal.value.toLowerCase()) === "group")
          return true;
        if (task.type === "run_flow" &&
            visitFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId)))
          return true;
        return flowTaskChildLists(task).some((child) => visitTasks(child.tasks));
      });
      return visitTasks(flow.tasks) || visitTasks(flow.errors) || visitTasks(flow.finally);
    };
    return visitFlow(flowId);
  };
  const groupCreateBindings = placements.flatMap(({ placementId, placement }) => {
    const block = placement.block;
    if (!isRecord(block) || typeof block.blockId !== "string" ||
        !sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)) return [];
    return (bindings[placementId] ?? [])
      .filter((binding) => binding.event === "form_submit" &&
        createsGroupRecord(binding.flowId))
      .map((binding) => ({ formId: placementId, binding }));
  });
  if (groupCreateBindings.length > 0) {
    if (groupCreateBindings.some(({ binding }) =>
      !binding.callerInputs.includes("selected_owner_group_id")))
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
      data[formId] = { status: "ready", values: { kind: "form", ownerGroups: choices.value.groups } };
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
      if (subjectRow?.kind !== "read" || subject === undefined)
        return { kind: "unavailable" };
    }
    const recordType = getGuidedFormRecordType(pageDefinition, context.releaseSet.modules);
    if (recordType === undefined) return { kind: "unavailable" };
    const shells = context.releaseSet.application.content.shells;
    const declaredStepFields = getGuidedFormStepFields(
      pageDefinition,
      recordType,
      shells,
    );
    const visiblePlacementIds = getGuidedFormVisiblePlacementIds(page, shells);
    const stepFields = getGuidedFormStepFields(
      pageDefinition,
      recordType,
      shells,
      page,
    );
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
    const activeStepId = earlierGuidedStepId(
      stepFields,
      computedStepId,
      first(parameters.step),
    );
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
        const field = projectEditField(
          entry.placement,
          subjectRecordType,
          subjectRow.row.values,
          dateTimeZones,
        );
        if (field === undefined || Object.hasOwn(baseline, field.key)) {
          complete = false;
          break;
        }
        baseline[field.key] = field.value;
        projected[entry.placementId] = field.data;
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

  const permittedKeys = new Set(address.application.pageKeys);
  return {
    kind: "available",
    model: {
      page,
      pageId: pageDefinition.pageId,
      shells: application.content.shells,
      theme: application.content.theme,
      navigation: navigation.value,
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
    },
  };
};

export const loadApplicationPage = (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
): Promise<ApplicationPageResult> => loadApplicationPageInternal(session, address, parameters);

/** Loads only the requested placements through the same protected page, Query and Record reads. */
export const loadApplicationPagePlacements = async (
  session: IdentitySession,
  address: ApplicationPageLoaderAddress,
  parameters: SearchParameters,
  placementIds: readonly string[],
  boardContinuation?: BoardContinuationTarget,
): Promise<ApplicationPagePlacementReadResult> => {
  const requestedIds = new Set(placementIds.map((placementId) => placementId.toLowerCase()));
  if (
    boardContinuation !== undefined &&
    (placementIds.length !== 1 || !sameId(placementIds[0] ?? "", boardContinuation.placementId))
  )
    return { kind: "unavailable" };
  const loaded = await loadApplicationPageInternal(
    session,
    address,
    parameters,
    requestedIds,
    boardContinuation,
  );
  if (loaded.kind !== "available") return loaded;

  const loadedData = Object.entries(loaded.model.data);
  const loadedBaselines = Object.entries(loaded.model.editFormBaselines);
  const data: Record<string, PageDataState> = {};
  const editFormBaselines: Record<string, Readonly<Record<string, JsonValue>> | null> = {};
  for (const placementId of requestedIds) {
    const entry = loadedData.find(([candidate]) => sameId(candidate, placementId));
    const displayId = entry?.[0] ?? placementId;
    const baseline = loadedBaselines.find(([candidate]) => sameId(candidate, placementId));
    data[displayId] = entry?.[1] ?? { status: "error" };
    editFormBaselines[displayId] = baseline?.[1] ?? null;
  }
  return { kind: "available", data, editFormBaselines, subject: loaded.model.subject ?? null };
};
