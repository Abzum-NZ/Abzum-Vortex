import "server-only";

import type { HumanOrganizationRequestDependencies } from "@vortex/access";
import {
  createHumanInstalledRuntimeContextLoader,
  type InstalledRuntimeContext,
  type PermittedApplication,
  type PermittedApplicationsRead,
} from "@vortex/app";
import {
  protectedQueryCommandSchema,
  createProtectedQueryService,
  type ProtectedQueryRow,
} from "@vortex/query";
import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  applicationLauncherQueryRowsToListValues,
  type ApplicationLauncherQueryRow,
} from "@vortex/ui";
import {
  createPageSubjectReader,
  createRecordsTableQueryResolver,
  createStoredNavigationProjectionService,
  createStoredPageCapabilityService,
  projectRecordDetailData,
  type PageSubjectReadResult,
  type ProjectedNavigation,
} from "@vortex/page";
import {
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
  readRecordDetailContract,
  recordIdSchema,
  readRecordsTableContract,
  richTextDocumentV2Schema,
  type ApplicationShellV2,
  type BlockPropertyValueV2Contract,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { readApplicationReleaseAdoption } from "./application-release-adoption";
import { getQueryContinuationKey } from "./query-continuation-key";
import { loadPermittedApplicationsAtAddress } from "./organization-context";
import { humanOrganizationRequestDependencies, humanOrganizationRequests } from "./server-composition";

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
  /** Displayed values of readable edit fields, used only to omit unchanged fields on submit. */
  editFormBaselines: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
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
    installationRevision: number;
    releaseKey: string;
  }>;
}>;

export type ApplicationPageResult =
  | Readonly<{ kind: "available"; model: ApplicationPageModel }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type SearchParameters = Readonly<Record<string, string | readonly string[] | undefined>>;

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

/** A form field may show only a value the page subject read returned for its own record type. */
const projectEditField = (
  placement: Readonly<Record<string, unknown>>,
  recordType: InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number],
  values: Readonly<Record<string, JsonValue>>,
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
    value: displayed,
    data: { status: "ready", values: { kind, value: displayed } },
  };
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

type ModuleRelease = InstalledRuntimeContext["releaseSet"]["modules"][number];
type ModuleQuery = ModuleRelease["content"]["queries"][number];

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
    | "detail_command_invalid"
    | "detail_query_unavailable"
    | "detail_query_refused"
    | "launcher_query_invalid"
    | "launcher_query_unavailable"
    | "launcher_query_refused",
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

/**
 * The installed release's theme for one application the viewer may open, so a page shown in place
 * of an addressed page (its not-found experience) renders in that application's own theme. It
 * reads under the person's own request scope like the page itself; when the read does not settle
 * the caller keeps the platform default rather than failing the page.
 */
export const loadApplicationTheme = async (
  session: IdentitySession,
  address: Readonly<{
    read: Extract<PermittedApplicationsRead, { kind: "available" }>;
    application: PermittedApplication;
  }>,
): Promise<ApplicationPageModel["theme"] | undefined> => {
  try {
    const loaded = await loadInstalledContext(session, requestDependencies(), {
      organizationId: address.read.organizationId,
      applicationRootId: address.application.applicationRootId,
    });
    return loaded.kind === "available"
      ? loaded.value.releaseSet.application.content.theme
      : undefined;
  } catch {
    return undefined;
  }
};

export const loadApplicationPage = async (
  session: IdentitySession,
  address: Readonly<{
    tenantShortName: string;
    organizationShortName: string;
    read: Extract<PermittedApplicationsRead, { kind: "available" }>;
    application: PermittedApplication;
    pageKey: string;
  }>,
  parameters: SearchParameters,
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
  const adoptionTarget = await readApplicationReleaseAdoption(session, {
    organizationId: context.organizationId,
    applicationRootId: context.applicationRootId,
  });

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
  const page = projectedPage.value;

  const navigation = await createStoredNavigationProjectionService({
    ...dependencies,
    context,
  }).project(session, selection);
  if (navigation.kind !== "available") return navigation;

  const queries = createProtectedQueryService({ ...dependencies, continuationKey });
  const tables = createRecordsTableQueryResolver(queries);
  const subjects = createPageSubjectReader(dependencies);

  // The page subject: the one record the page's own address names, of the page's declared record
  // type, read once through the record read path under the viewer's own authority. Nothing here
  // comes from the browser except the id.
  const subjectType =
    (pageDefinition.type === "detail" ||
      pageDefinition.type === "public" ||
      pageDefinition.type === "form") &&
    pageDefinition.recordType?.state === "resolved"
      ? pageDefinition.recordType
      : undefined;
  const subjectId = recordIdSchema.safeParse(first(parameters[pageSubjectParameter]));
  let subjectRead: Promise<PageSubjectReadResult> | undefined;
  const readSubject = (recordTypeId: string, recordId: string): Promise<PageSubjectReadResult> =>
    (subjectRead ??= subjects.read(session, selection, { recordTypeId, recordId }));

  const placements = collectPlacements(page);
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
  const data: Record<string, PageDataState> = {};
  const bindings: Record<string, PlacementFlowBinding[]> = {};
  for (const { placementId, placement } of placements) {
    const held = application.content.flowBindings.filter((binding) =>
      sameId(binding.controlId, placementId),
    );
    if (held.length > 0)
      bindings[placementId] = held.map((binding) => ({
        bindingId: binding.bindingId,
        eventId: binding.eventId,
        event: binding.event,
        flowId: binding.flow.flowId,
        callerInputs: Object.values(binding.flow.inputs).flatMap((input) =>
          typeof input === "object" && input !== null && input.kind === "caller"
            ? [input.name]
            : [],
        ),
      }));

    const settings = placement.settings as Readonly<Record<string, BlockPropertyValueV2Contract>>;
    const tableContract = readRecordsTableContract(settings);
    const detailContract =
      tableContract === undefined ? readRecordDetailContract(settings) : undefined;
    // A placement still bound to a legacy read model has no reader on this page: system record
    // types are read through the query path. It must never fall through to an empty display.
    if (placement.readModel !== undefined) {
      logPlacementFailure(address, placementId, "read_model_not_served");
      data[placementId] = { status: "error" };
      continue;
    }
    const queryId = typeof placement.queryId === "string" ? placement.queryId : undefined;
    const queryBoundLauncher = isApplicationLauncherPlacement(placement) && queryId !== undefined;
    if (tableContract === undefined && detailContract === undefined && !queryBoundLauncher) continue;
    if (queryBoundLauncher && permittedApplicationsRead?.kind !== "available") {
      data[placementId] =
        permittedApplicationsRead?.kind === "temporarily_unavailable"
          ? { status: "error" }
          : { status: "refused", reason: "not_permitted" };
      continue;
    }

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
          ...(subjectModule === undefined ? {} : { fieldLabels: fieldLabelsOf(subjectModule) }),
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

    if (queryBoundLauncher) {
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
        bound.module.content.recordTypes.flatMap((recordType) =>
          recordType.fields.map((field) => [String(field.fieldId).toLowerCase(), field.key] as const),
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
      const permittedApplicationKeys = permittedApplicationsRead.applications.map(
        (application) => application.key,
      );
      const values = applicationLauncherQueryRowsToListValues(
        launcherRows,
        permittedApplicationKeys,
        launcherCellKey(settings, "name_key", "name"),
        launcherCellKey(settings, "icon_key", "icon"),
      );
      data[placementId] = { status: "ready", values };
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
      const display = projectRecordDetailData({ settings, fieldLabels }, rows);
      data[placementId] =
        display === undefined
          ? { status: "refused", reason: "not_found" }
          : display.status === "empty"
            ? { status: "empty" }
            : { status: "ready", values: display.values };
    }
  }

  // A detail or form page offers its subject to the flows it starts; a public page never does.
  const subjectRow =
    subjectType !== undefined && pageDefinition.type !== "public" && subjectId.success
      ? await readSubject(String(subjectType.recordTypeId), subjectId.data)
      : undefined;
  const subject =
    subjectRow?.kind === "read" && subjectRow.row.revision !== undefined
      ? { recordId: String(subjectRow.row.recordId), revision: subjectRow.row.revision }
      : undefined;

  // An edit form is the form whose installed submit binding takes a page record. Its fields are
  // projected from the same authorized subject read used for the page revision, and only from the
  // form's visible, declared fields on that record type. An incomplete read disables the form.
  const editFormBaselines: Record<string, Record<string, JsonValue>> = {};
  const subjectRecordType = context.releaseSet.modules
    .flatMap((module) => module.content.recordTypes)
    .find(
      (recordType) =>
        subjectType !== undefined &&
        sameId(String(recordType.recordTypeId), String(subjectType.recordTypeId)),
    );
  for (const { placementId, placement } of placements) {
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
      const fieldBlock = entry.placement.block;
      if (!isRecord(fieldBlock) || typeof fieldBlock.blockId !== "string") return false;
      const blockId = fieldBlock.blockId;
      return (
        sameId(blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) ||
        Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
          sameId(release.blockId, blockId),
        )
      );
    });
    const baseline: Record<string, JsonValue> = {};
    const projected: Record<string, PageDataState> = {};
    let complete = true;
    for (const entry of fields) {
      const field = projectEditField(entry.placement, subjectRecordType, subjectRow.row.values);
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
      editFormBaselines,
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
