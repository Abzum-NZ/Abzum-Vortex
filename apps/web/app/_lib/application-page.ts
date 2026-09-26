import "server-only";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import {
  createAppTelemetryCollector,
  createHumanInstalledRuntimeContextLoader,
  createOperationsAlertSink,
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
  createRecordsTableQueryResolver,
  createStoredNavigationProjectionService,
  createStoredPageCapabilityService,
  projectRecordDetailData,
  type ProjectedNavigation,
} from "@vortex/page";
import {
  readRecordDetailContract,
  readRecordsTableContract,
  type ApplicationShellV2,
  type BlockPropertyValueV2Contract,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { readApplicationReleaseAdoption } from "./application-release-adoption";
import { getQueryContinuationKey } from "./query-continuation-key";

/**
 * Composes the one server model of an installed application page: the permission-filtered page,
 * the viewer's menu, the theme and the persisted data every data placement reads. Everything comes
 * from the verified human request and the exact installed release; the browser supplies only the
 * address and the page's own query string. Nothing here decides permission: the stored page and
 * navigation services, the Query engine and the flow endpoint each keep their own Access decision.
 */

const telemetry = createAppTelemetryCollector({ downstream: createOperationsAlertSink() });

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
  /** Permitted pages of this application, so a menu or navigate intent can be turned into an address. */
  pages: readonly Readonly<{ pageId: string; key: string }>[];
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

const first = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

/** Every placement of the projected page with its stable identity, in document order. */
const collectPlacements = (
  projected: Readonly<Record<string, unknown>>,
): Array<Readonly<{ placementId: string; placement: Record<string, unknown> }>> => {
  const found: Array<{ placementId: string; placement: Record<string, unknown> }> = [];
  const visit = (slot: unknown): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      found.push({ placementId, placement: candidate });
      if (isRecord(candidate.slots)) for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  const composition = projected.composition;
  if (!isRecord(composition)) return found;
  if ("main" in composition) visit(composition.main);
  else if (isRecord(composition.stepContent))
    for (const root of Object.values(composition.stepContent)) visit(root);
  return found;
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
  const { authorityId } = getIdentityAuthorityConfiguration();
  const continuationKey = getQueryContinuationKey();
  const dependencies: HumanOrganizationRequestDependencies = {
    identityAuthorityId: authorityId,
    telemetry,
  };
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
  };

  // The installed context is read once, under the person's own verified request scope.
  const requests = createHumanOrganizationRequestService(dependencies);
  const loaded = await requests.run(session, selection, async (transaction, scope) => {
    if (scope.applicationRootId === undefined) throw new Error("APPLICATION_SCOPE_UNAVAILABLE");
    return createHumanInstalledRuntimeContextLoader({
      activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
      releaseSetReader: createDatabaseApplicationBoundReleaseSetService(
        installedReleaseCatalogue,
        transaction,
      ),
      scope: { organizationId: scope.organizationId, applicationRootId: scope.applicationRootId },
    }).load();
  });
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

  const data: Record<string, PageDataState> = {};
  const bindings: Record<string, PlacementFlowBinding[]> = {};
  for (const { placementId, placement } of collectPlacements(page)) {
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
    const detailContract = tableContract === undefined ? readRecordDetailContract(settings) : undefined;
    if (tableContract === undefined && detailContract === undefined) continue;

    const queryId = typeof placement.queryId === "string" ? placement.queryId : undefined;
    const bound = queryId === undefined ? undefined : findModuleQuery(context, queryId);
    if (queryId === undefined || bound === undefined) {
      data[placementId] = { status: "error" };
      continue;
    }
    const inputType = (input: string): string | undefined =>
      bound.query.inputs.find((declared) => declared.key === input)?.type;
    const fieldLabels = fieldLabelsOf(bound.module);

    if (tableContract !== undefined) {
      const pageParameters: Record<string, JsonValue> = {};
      for (const parameter of tableContract.parameters) {
        const raw = parameter.pageParameter === undefined ? undefined : first(parameters[parameter.pageParameter]);
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
      if (resolved.kind === "unavailable") data[placementId] = { status: "error" };
      else if (resolved.kind === "refused")
        data[placementId] = { status: "refused", reason: "not_permitted" };
      else if (resolved.display.status === "empty") data[placementId] = { status: "empty" };
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
      data[placementId] = { status: "refused", reason: "not_permitted" };
      continue;
    }
    const result = await queries.run(session, selection, command.data);
    if (result.kind === "temporarily_unavailable") data[placementId] = { status: "error" };
    else if (result.kind !== "available" || result.value.outcome !== "completed")
      data[placementId] = { status: "refused", reason: "not_permitted" };
    else {
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
      pages: application.content.pages
        .filter((candidate) => permittedKeys.has(candidate.key))
        .map((candidate) => ({ pageId: candidate.pageId, key: candidate.key })),
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
