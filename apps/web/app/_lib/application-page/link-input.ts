import "server-only";

import {
  createProtectedQueryService,
  createHumanOrganizationRequestService,
  createRecordChoiceReader,
  recordChoicePageSizes,
  recordLinkLabelKey,
  type RecordChoice,
  type RecordChoiceCommand,
  type RecordLinkResolver,
  type InstalledRuntimeContext,
  readRecordTypeVisibleFieldIds,
  delegableRoleIds,
  flowPlansOf,
  createFlowQueryReader,
  runFieldOptionsFlow,
  type OptionFilterKey,
  type RecordChoiceAdmission,
} from "@vortex/platform/server";
import {
  isRecord,
  queryIdSchema,
  recordsTableContractOrLog,
  recordIdSchema,
  sameId,
  type BlockPropertyValueContract,
  type IdentitySession,
  type JsonValue,
  recordChoicePageSchema,
  optionsSourceNarrowing,
  compiledPageShellId,
  type PageDefinition,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import { requestDependencies } from "./installed-context";
import {
  prepareRuntimePreviewChoices,
  type RuntimePreviewDemandResult,
} from "../runtime-preview-demand";
import {
  collectPlacements,
  first,
  isLinkInputPlacement,
  linkInputTargets,
  placementOptionFilter,
  projectedUseAvailability,
} from "./placement-helpers";
import { projectOptionsPage, type OptionsAddress } from "./options-projection";
import type { PageDataState, SearchParameters } from "./types";
import { withContributedFormPlacements, withContributedPlacements } from "./contributed-placements";

/** What a viewer may see of a linked record's title. */
const titleOf = (
  links: Awaited<ReturnType<RecordLinkResolver>>,
  reference: Readonly<{ recordTypeId: string; recordId: string }>,
): string | undefined => {
  const label = links?.get(recordLinkLabelKey(reference));
  return label === undefined
    ? undefined
    : label.kind === "restricted"
      ? "Restricted record"
      : label.label;
};

const linkValue = (
  state: PageDataState | undefined,
): Readonly<{ recordTypeId: string; recordId: string }> | undefined => {
  if (state?.status !== "ready" || !isRecord(state.values) || state.values.kind !== "link_input")
    return undefined;
  const value = state.values.value;
  return isRecord(value) &&
    typeof value.recordTypeId === "string" &&
    typeof value.recordId === "string"
    ? { recordTypeId: value.recordTypeId, recordId: value.recordId }
    : undefined;
};

/**
 * Gives every projected link input value its title, read in one batch under the viewer's access.
 * Returns the link inputs left without a title: the linked record is not one the viewer may read,
 * or the titles could not be read (the read already logged its cause).
 */
export const titleLinkInputs = async (
  projected: Record<string, PageDataState>,
  resolveRecordLinks: RecordLinkResolver,
): Promise<ReadonlySet<string>> => {
  const linked = Object.entries(projected).flatMap(([placementId, state]) => {
    const reference = linkValue(state);
    return reference === undefined ? [] : [{ placementId, state, reference }];
  });
  const untitled = new Set<string>();
  if (linked.length === 0) return untitled;
  const links = await resolveRecordLinks(linked.map((entry) => entry.reference));
  for (const { placementId, state, reference } of linked) {
    const title = links === undefined ? undefined : titleOf(links, reference);
    const values = state.status === "ready" ? state.values : undefined;
    if (title === undefined || !isRecord(values)) untitled.add(placementId);
    else projected[placementId] = { status: "ready", values: { ...values, title } };
  }
  return untitled;
};

/**
 * Starts a link field with the record its page address names under the page parameter the control
 * publishes (it reads and writes that one name). The record shows only when the viewer may read
 * its title; any other value starts the field empty and is logged.
 */
export const projectInitialLinkInputs = async (
  input: Readonly<{
    session: IdentitySession;
    context: InstalledRuntimeContext;
    placements: ReturnType<typeof collectPlacements>;
    parameters: SearchParameters;
    data: Record<string, PageDataState>;
    resolveRecordLinks: RecordLinkResolver;
    log: (
      placementId: string,
      reason: "link_initial_value_invalid" | "link_initial_value_unavailable",
    ) => void;
  }>,
): Promise<RuntimePreviewDemandResult> => {
  const starts = input.placements.flatMap((placement) => {
    const parameter = placement.settings.publishes_parameter;
    if (!isRecord(parameter) || parameter.kind !== "text" || typeof parameter.value !== "string")
      return [];
    const raw = first(input.parameters[parameter.value]);
    if (raw === undefined) return [];
    const recordId = recordIdSchema.safeParse(raw);
    const targets = linkInputTargets(placement.settings);
    if (!recordId.success || targets.length !== 1) {
      input.log(placement.placementId, "link_initial_value_invalid");
      return [];
    }
    return [
      {
        placementId: placement.placementId,
        reference: { recordTypeId: targets[0]!.recordTypeId, recordId: recordId.data },
      },
    ];
  });
  if (starts.length === 0) return { kind: "ready" };
  const demand = await prepareRuntimePreviewChoices(
    input.session,
    input.context,
    starts.map((start) => start.reference.recordTypeId),
  );
  if (demand.kind !== "ready") return demand;
  const links = await input.resolveRecordLinks(starts.map((start) => start.reference));
  for (const { placementId, reference } of starts) {
    const label = links?.get(recordLinkLabelKey(reference));
    if (label === undefined || label.kind === "restricted") {
      input.log(placementId, "link_initial_value_unavailable");
      continue;
    }
    input.data[placementId] = {
      status: "ready",
      values: { kind: "link_input", value: reference, title: label.label },
    };
  }
  return { kind: "ready" };
};

/** A single-target link field of the installed release, with its resolved target and dependency. */
type InstalledLinkField = Readonly<{
  moduleRootId: string;
  recordTypeId: string;
  sourceRecordTypeId: string;
  /** The declared dependency on another link field of the same record type, if any. */
  dependency?: LinkDependency;
  /** The declared query whose rows are the choices, with the form field key each input reads. */
  sourceQuery?: Readonly<{
    moduleRootId: string;
    queryId: string;
    inputKeys: Readonly<Record<string, string>>;
  }>;
}>;

const installedLinkField = (
  context: InstalledRuntimeContext,
  fieldId: string,
): InstalledLinkField | undefined => {
  for (const module of context.releaseSet.modules)
    for (const recordType of module.content.recordTypes)
      for (const field of recordType.fields)
        if (sameId(String(field.fieldId), fieldId)) {
          if (field.type !== "link" || field.settings.target.state !== "resolved") return undefined;
          const declared = optionsSourceNarrowing(field.settings.optionsSource);
          const parent =
            declared === undefined
              ? undefined
              : recordType.fields.find((candidate) =>
                  sameId(String(candidate.fieldId), String(declared.parentFieldId)),
                );
          const parentTarget =
            parent?.type === "link" && parent.settings.target.state === "resolved"
              ? parent.settings.target
              : undefined;
          const source = field.settings.optionsSource;
          const queryModule =
            source.kind === "query" && source.queryId !== undefined
              ? context.releaseSet.modules.find((candidate) =>
                  candidate.content.queries.some((query) =>
                    sameId(String(query.queryId), String(source.queryId)),
                  ),
                )
              : undefined;
          const sourceQuery =
            source.kind === "query" && source.queryId !== undefined && queryModule !== undefined
              ? {
                  moduleRootId: String(queryModule.rootId),
                  queryId: String(source.queryId),
                  inputKeys: Object.fromEntries(
                    Object.entries(source.inputs ?? {}).map(([name, inputFieldId]) => [
                      name,
                      recordType.fields.find((candidate) =>
                        sameId(String(candidate.fieldId), String(inputFieldId)),
                      )?.key ?? "",
                    ]),
                  ),
                }
              : undefined;
          return {
            sourceRecordTypeId: String(recordType.recordTypeId),
            moduleRootId: String(field.settings.target.moduleRootId),
            recordTypeId: String(field.settings.target.recordTypeId),
            ...(sourceQuery === undefined ? {} : { sourceQuery }),
            ...(declared === undefined
              ? {}
              : {
                  dependency: {
                    parentFieldId: String(declared.parentFieldId),
                    filterFieldId: String(declared.filterFieldId),
                    parentTarget:
                      parentTarget === undefined
                        ? undefined
                        : {
                            moduleRootId: String(parentTarget.moduleRootId),
                            recordTypeId: String(parentTarget.recordTypeId),
                          },
                  },
                }),
          };
        }
  return undefined;
};

/** The addressed page's installed picker targets and dependency parents for preview preparation. */
export const previewLinkChoiceTypeIds = (
  context: InstalledRuntimeContext,
  page: PageDefinition,
): readonly string[] => {
  let raw: Readonly<Record<string, unknown>> = withContributedPlacements(
    { composition: page.composition },
    context,
    page,
  );
  const plans = flowPlansOf(context.releaseSet);
  for (const [tableId, forms] of plans.rowFormsByTable) {
    const table = collectPlacements(raw).find((placement) =>
      sameId(placement.placementId, tableId),
    );
    const queryId = table?.vortex.queryId;
    if (typeof queryId !== "string") continue;
    for (const module of context.releaseSet.modules) {
      const query = module.content.queries.find((candidate) =>
        sameId(String(candidate.queryId), queryId),
      );
      if (query?.recordType.state !== "resolved") continue;
      for (const formId of forms)
        raw = withContributedFormPlacements(raw, context, query.recordType, formId);
    }
  }
  const shellId = compiledPageShellId(page.composition);
  const shell = context.releaseSet.application.content.shells.find(
    (item) => shellId !== null && sameId(String(item.shellId), shellId),
  );
  const placements = [
    ...collectPlacements(raw),
    ...(shell === undefined ? [] : collectPlacements({ composition: shell.layout })),
  ];
  const types = new Set<string>();
  for (const placement of placements) {
    if (!isLinkInputPlacement(placement)) continue;
    for (const target of linkInputTargets(placement.settings)) types.add(target.recordTypeId);
    let fieldId = isRecord(placement.settings.field) ? placement.settings.field.fieldId : undefined;
    const seen = new Set<string>();
    while (typeof fieldId === "string" && !seen.has(fieldId.toLowerCase())) {
      seen.add(fieldId.toLowerCase());
      const field = installedLinkField(context, fieldId);
      if (field === undefined) break;
      types.add(field.recordTypeId);
      if (field.dependency?.parentTarget !== undefined)
        types.add(field.dependency.parentTarget.recordTypeId);
      fieldId = field.dependency?.parentFieldId;
    }
  }
  return [...types];
};

/** Finds the projected parent control of a dependent link input from the installed field. */
const projectedLinkParentControl = (
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
  placementId: string,
):
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "parent"; placementId: string; recordTypeId: string }>
  | Readonly<{ kind: "unavailable" }> => {
  const placements = collectPlacements(page);
  const child = placements.find((placement) => sameId(placement.placementId, placementId));
  if (child === undefined) return { kind: "unavailable" };
  const field = isRecord(child.settings.field) ? child.settings.field.fieldId : undefined;
  const dependency =
    typeof field === "string" ? installedLinkField(context, field)?.dependency : undefined;
  if (dependency === undefined) return { kind: "none" };
  if (dependency.parentTarget === undefined) return { kind: "unavailable" };
  const parents = placements.filter((placement) => {
    const parentField = isRecord(placement.settings.field)
      ? placement.settings.field.fieldId
      : undefined;
    return (
      typeof parentField === "string" &&
      sameId(parentField, dependency.parentFieldId) &&
      (child.formId === undefined
        ? placement.formId === undefined
        : placement.formId !== undefined && sameId(placement.formId, child.formId))
    );
  });
  return parents.length === 1
    ? {
        kind: "parent",
        placementId: parents[0]!.placementId,
        recordTypeId: dependency.parentTarget.recordTypeId,
      }
    : { kind: "unavailable" };
};

/**
 * The record type a Records table's link picker on `fieldId` may offer, for one purpose. A filter
 * needs the field declared by the table's Column filters feature; an edit needs it declared by the
 * enabled Inline editing or Row editing feature, which names the event that saves the change. Either
 * way it must be a single-target link field of the installed release with a resolved target.
 */
const tableLinkFieldTarget = (
  context: InstalledRuntimeContext,
  settings: Readonly<Record<string, unknown>>,
  fieldId: string,
  purpose: "filter" | "edit",
): InstalledLinkField | undefined => {
  const contract = recordsTableContractOrLog(
    settings as Readonly<Record<string, BlockPropertyValueContract>>,
    "link input",
  );
  if (contract === undefined) return undefined;
  const declared =
    purpose === "filter"
      ? [contract.features.columnFilters.enabled ? contract.features.columnFilters.fields : []]
      : [contract.features.inlineEdit, contract.features.rowEdit].map((feature) =>
          feature.enabled && feature.eventId !== undefined ? feature.fields : [],
        );
  if (!declared.some((fields) => fields.some((field) => sameId(field, fieldId)))) return undefined;
  return installedLinkField(context, fieldId);
};

/** A link field's declared dependency, resolved against the installed release. */
type LinkDependency = Readonly<{
  parentFieldId: string;
  filterFieldId: string;
  parentTarget: Readonly<{ moduleRootId: string; recordTypeId: string }> | undefined;
}>;

type RecordChoicePageResult =
  | Readonly<{
      kind: "completed";
      /** The records a link field offers. */
      choices?: readonly RecordChoice[];
      /** The options a choice field offers. */
      options?: readonly Readonly<{ key: string; label: string }>[];
      nextContinuationToken?: string;
    }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "refused"; cause: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type RecordChoicePageRequest = Readonly<{
  placementId: string;
  /** For a Records table's link picker: the declared field whose targets are offered. */
  fieldId?: string;
  /** Present exactly with `fieldId`: filtering by the records, or editing a cell. */
  purpose?: "filter" | "edit";
  installationRevision: number;
  releaseKey: string;
  subjectRecordId?: string;
  /** For a dependent link field: the record chosen in the field it depends on, in the editor's draft. */
  parentRecordId?: string;
  /** For a field whose options a flow works out: the form's draft, by field key. */
  draft?: Readonly<Record<string, JsonValue>>;
  search?: string;
  pageSize?: number;
  continuationToken?: string;
}>;

type ProjectedChoicePage = Extract<
  Awaited<ReturnType<typeof projectOptionsPage>>,
  { kind: "available" }
>;

/** Derives the same installed targets and dependent narrowing for a picker or its exact recheck. */
const prepareLinkChoiceDescriptor = async (
  session: IdentitySession,
  projected: Pick<ProjectedChoicePage, "context" | "selection" | "page">,
  request: Pick<
    RecordChoicePageRequest,
    "placementId" | "fieldId" | "purpose" | "parentRecordId" | "draft"
  >,
  requests: ReturnType<typeof createHumanOrganizationRequestService>,
  queries: ReturnType<typeof createProtectedQueryService>,
  prepareDemand: typeof prepareRuntimePreviewChoices = prepareRuntimePreviewChoices,
): Promise<
  | Readonly<{
      kind: "ready";
      targets: RecordChoiceCommand["targets"];
      narrowedBy?: RecordChoiceCommand["narrowedBy"];
      sourceQuery?: RecordChoiceCommand["sourceQuery"];
      optionFilter?: OptionFilterKey;
    }>
  | Extract<RecordChoicePageResult, { kind: "refused" | "temporarily_unavailable" }>
> => {
  const { context, selection } = projected;
  const placements = collectPlacements(projected.page);
  const placement = placements.find((entry) => sameId(entry.placementId, request.placementId));
  if (placement === undefined) return { kind: "refused", cause: "placement_not_found" };
  let declaredTargets: readonly Readonly<{ moduleRootId: string; recordTypeId: string }>[];
  /** The parent the viewer chose in a dependent field's draft: it must be a parent link the viewer may read. */
  const dependencyOf = (
    link: LinkDependency,
    readable: ReadonlySet<string>,
  ):
    | Readonly<{ dependency: { link: LinkDependency; parentRecordId: string } }>
    | Extract<RecordChoicePageResult, { kind: "refused" }> => {
    const detail = `child=${request.fieldId ?? placement.placementId} parent=${link.parentFieldId}`;
    if (request.parentRecordId === undefined)
      return { kind: "refused", cause: `dependency_parent_missing ${detail}` };
    if (link.parentTarget === undefined)
      return { kind: "refused", cause: `dependency_parent_not_a_link ${detail}` };
    if (!readable.has(link.parentFieldId.toLowerCase()))
      return { kind: "refused", cause: `dependency_parent_withheld ${detail}` };
    return { dependency: { link, parentRecordId: request.parentRecordId } };
  };
  /** For a dependent field being edited: the parent the viewer chose, which narrows the choices. */
  let dependency: Readonly<{ link: LinkDependency; parentRecordId: string }> | undefined;
  let optionFilter: OptionFilterKey | undefined;
  let sourceQuery: RecordChoiceCommand["sourceQuery"];
  if (request.fieldId !== undefined) {
    // A Records table's link picker offers the target records of one declared field.
    if (request.purpose === undefined) return { kind: "refused", cause: "purpose_missing" };
    const filtered = tableLinkFieldTarget(
      context,
      placement.settings,
      request.fieldId,
      request.purpose,
    );
    if (filtered === undefined)
      return {
        kind: "refused",
        cause:
          request.purpose === "filter" ? "field_not_a_link_filter" : "field_not_inline_editable",
      };
    if (projectedUseAvailability(placement) !== "available")
      return { kind: "refused", cause: "placement_unavailable" };
    const readable = await requests.run(session, selection, (transaction) =>
      readRecordTypeVisibleFieldIds(transaction, filtered.sourceRecordTypeId),
    );
    if (readable.kind === "temporarily_unavailable") return readable;
    if (readable.kind !== "available" || !readable.value.has(request.fieldId.toLowerCase()))
      return { kind: "refused", cause: "link_field_withheld" };
    if (request.purpose === "edit" && filtered.dependency !== undefined) {
      const refused = dependencyOf(filtered.dependency, readable.value);
      if ("cause" in refused) return refused;
      dependency = refused.dependency;
    }
    declaredTargets = [filtered];
  } else {
    if (!isLinkInputPlacement(placement))
      return { kind: "refused", cause: "placement_not_link_input" };
    const form =
      placement.formId === undefined
        ? undefined
        : placements.find((entry) => sameId(entry.placementId, placement.formId!));
    if (
      projectedUseAvailability(placement) !== "available" ||
      (form !== undefined && projectedUseAvailability(form) !== "available")
    )
      return { kind: "refused", cause: "placement_unavailable" };
    declaredTargets = linkInputTargets(placement.settings);
    optionFilter = placementOptionFilter(placement.settings);
    // An automatic field input of a dependent link field narrows its choices by the form's draft
    // of the parent; the dependency is the field's own declaration, never the request's.
    const bound = isRecord(placement.settings.field) ? placement.settings.field.fieldId : undefined;
    const boundField = typeof bound === "string" ? installedLinkField(context, bound) : undefined;
    if (boundField?.sourceQuery !== undefined) {
      const inputValues: Record<string, JsonValue> = {};
      for (const [name, key] of Object.entries(boundField.sourceQuery.inputKeys))
        inputValues[name] = request.draft?.[key] ?? null;
      sourceQuery = {
        moduleRootId: boundField.sourceQuery.moduleRootId,
        queryId: boundField.sourceQuery.queryId,
        inputValues,
      } as RecordChoiceCommand["sourceQuery"];
    }
    if (boundField?.dependency !== undefined) {
      const readable = await requests.run(session, selection, (transaction) =>
        readRecordTypeVisibleFieldIds(transaction, boundField.sourceRecordTypeId),
      );
      if (readable.kind === "temporarily_unavailable") return readable;
      if (readable.kind !== "available") return { kind: "refused", cause: "link_field_withheld" };
      const refused = dependencyOf(boundField.dependency, readable.value);
      if ("cause" in refused) return refused;
      dependency = refused.dependency;
    }
  }

  const targets: RecordChoiceCommand["targets"][number][] = [];
  for (const target of declaredTargets) {
    const module = context.releaseSet.modules.find((candidate) =>
      sameId(String(candidate.rootId), target.moduleRootId),
    );
    const recordType = module?.content.recordTypes.find((candidate) =>
      sameId(String(candidate.recordTypeId), target.recordTypeId),
    );
    if (module === undefined || recordType === undefined)
      return { kind: "refused", cause: "target_not_installed" };
    targets.push({
      moduleRootId: String(module.rootId),
      recordTypeId: String(recordType.recordTypeId),
      titleFieldId: String(recordType.titleFieldId),
      label: recordType.singularLabel,
    });
  }
  if (targets.length === 0) return { kind: "refused", cause: "no_targets" };
  const demand = await prepareDemand(session, context, [
    ...targets.map((target) => target.recordTypeId),
    ...(dependency?.link.parentTarget === undefined
      ? []
      : [dependency.link.parentTarget.recordTypeId]),
  ]);
  if (demand.kind !== "ready")
    return demand.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused", cause: "preview_demand_refused" };

  let narrowedBy: RecordChoiceCommand["narrowedBy"];
  if (dependency !== undefined && dependency.link.parentTarget !== undefined) {
    const parentTarget = dependency.link.parentTarget;
    const parentModule = context.releaseSet.modules.find((candidate) =>
      sameId(String(candidate.rootId), parentTarget.moduleRootId),
    );
    const parentType = parentModule?.content.recordTypes.find((candidate) =>
      sameId(String(candidate.recordTypeId), parentTarget.recordTypeId),
    );
    if (parentModule === undefined || parentType === undefined)
      return { kind: "refused", cause: "dependency_parent_not_installed" };
    // The chosen parent must be a record the viewer may read now; otherwise the picker is refused.
    const parentRead = await queries.run(session, selection, {
      moduleRootId: String(parentModule.rootId),
      queryId: queryIdSchema.parse(String(parentType.recordTypeId)),
      inputValues: {},
      requestedFieldIds: [String(parentType.titleFieldId)],
      requestedSystemFieldKeys: [],
      sort: [],
      sortableFieldIds: [],
      filterableFieldIds: [],
      searchableFieldIds: [],
      pageSize: 1,
      exactRecordIds: [dependency.parentRecordId],
    });
    if (parentRead.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
    if (
      parentRead.kind !== "available" ||
      parentRead.value.outcome !== "completed" ||
      parentRead.value.rows.length !== 1
    )
      return {
        kind: "refused",
        cause: `dependency_parent_unreadable child=${request.fieldId ?? placement.placementId} parent=${dependency.link.parentFieldId}`,
      };
    narrowedBy = {
      fieldId: dependency.link.filterFieldId,
      recordTypeId: parentTarget.recordTypeId,
      recordId: dependency.parentRecordId,
    } as RecordChoiceCommand["narrowedBy"];
  }
  return {
    kind: "ready",
    targets,
    ...(narrowedBy === undefined ? {} : { narrowedBy }),
    ...(sourceQuery === undefined ? {} : { sourceQuery }),
    ...(optionFilter === undefined ? {} : { optionFilter }),
  };
};

/**
 * The decision an option filter adds to a page of choices: only the choices it keeps are offered.
 * It runs in the request transaction the caller holds, so it sees what the picker's read saw.
 */
export const optionFilterAdmission = (
  filter: OptionFilterKey | undefined,
  decide: (recordIds: readonly string[]) => Promise<ReadonlySet<string>>,
): RecordChoiceAdmission | undefined =>
  filter === undefined
    ? undefined
    : async (choices) => {
        if (choices.length === 0) return choices;
        const allowed = await decide(choices.map((choice) => choice.recordId));
        return choices.filter((choice) => allowed.has(choice.recordId.toLowerCase()));
      };

/** Rechecks a selected link using the same picker descriptor and the gate's transaction. */
export const validateProjectedLinkChoice = async (
  bound: Parameters<ReturnType<typeof createRecordChoiceReader>["resolveExactInTransaction"]>[0],
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
  request: Readonly<{
    placementId: string;
    selected: Readonly<{ recordTypeId: string; recordId: string }>;
    parentRecordId?: string;
  }>,
  prepareDemand: typeof prepareRuntimePreviewChoices,
): Promise<boolean> => {
  const dependencies = { ...requestDependencies(), boundRequest: bound };
  const queries = createProtectedQueryService({
    ...dependencies,
    continuationKey: getQueryContinuationKey(),
  });
  const descriptor = await prepareLinkChoiceDescriptor(
    bound.session,
    { context, selection: bound.selection, page },
    request,
    createHumanOrganizationRequestService(dependencies),
    queries,
    prepareDemand,
  );
  if (descriptor.kind !== "ready") return false;
  const result = await createRecordChoiceReader(queries).resolveExactInTransaction(
    bound,
    {
      targets: descriptor.targets,
      pageSize: 1,
      ...(descriptor.narrowedBy === undefined ? {} : { narrowedBy: descriptor.narrowedBy }),
    },
    request.selected,
    optionFilterAdmission(descriptor.optionFilter, (ids) =>
      delegableRoleIds(bound.transaction, ids),
    ),
  );
  return (
    result.kind === "available" &&
    result.value.outcome === "completed" &&
    result.value.choices.some(
      (choice) =>
        sameId(choice.recordTypeId, request.selected.recordTypeId) &&
        sameId(choice.recordId, request.selected.recordId),
    )
  );
};

/** Proves dependency parents before asking the same picker to prove the selected link. */
export const validateProjectedLinkControl = async (
  bound: Parameters<typeof validateProjectedLinkChoice>[0],
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
  placementId: string,
  selected: Readonly<{ recordTypeId: string; recordId: string }>,
  controls: Readonly<Record<string, string>>,
  prepareDemand: typeof prepareRuntimePreviewChoices,
): Promise<boolean> => {
  const active = new Set<string>();
  const prove = async (
    control: string,
    value: Readonly<{ recordTypeId: string; recordId: string }>,
  ): Promise<boolean> => {
    const key = control.toLowerCase();
    if (active.has(key)) {
      console.error("[flows] link control dependency cycle");
      return false;
    }
    active.add(key);
    try {
      const parent = projectedLinkParentControl(context, page, control);
      if (parent.kind === "unavailable") {
        console.error("[flows] link control dependency parent unavailable");
        return false;
      }
      let parentRecordId: string | undefined;
      if (parent.kind === "parent") {
        const matches = Object.entries(controls).filter(([id]) => sameId(id, parent.placementId));
        const parsed = matches.length === 1 ? recordIdSchema.safeParse(matches[0]![1]) : undefined;
        if (parsed === undefined || !parsed.success) {
          console.error("[flows] link control dependency parent missing or invalid");
          return false;
        }
        parentRecordId = parsed.data;
        if (
          !(await prove(parent.placementId, {
            recordTypeId: parent.recordTypeId,
            recordId: parentRecordId,
          }))
        ) {
          console.error("[flows] link control dependency parent not offered");
          return false;
        }
      }
      return validateProjectedLinkChoice(
        bound,
        context,
        page,
        {
          placementId: control,
          selected: value,
          ...(parentRecordId === undefined ? {} : { parentRecordId }),
        },
        prepareDemand,
      );
    } finally {
      active.delete(key);
    }
  };
  return prove(placementId, selected);
};

/** A field of the installed release whose options an options flow works out. */
type OptionsFlowField = Readonly<{
  type: "choice" | "link";
  flowId: string;
  /** The flow's input names, each with the key of the field of the same record type it reads. */
  inputKeys: Readonly<Record<string, string>>;
  /** The link field's single target, for the label of each offered record. */
  target?: Readonly<{ recordTypeId: string; label: string }>;
}>;

/** The options flow a placement bound to a record field declares, when it declares one. */
const placementOptionsFlow = (
  context: InstalledRuntimeContext,
  placement: Readonly<{ settings: Readonly<Record<string, unknown>> }>,
): OptionsFlowField | undefined => {
  const bound = isRecord(placement.settings.field) ? placement.settings.field.fieldId : undefined;
  if (typeof bound !== "string") return undefined;
  for (const module of context.releaseSet.modules)
    for (const recordType of module.content.recordTypes)
      for (const field of recordType.fields) {
        if (!sameId(String(field.fieldId), bound)) continue;
        if (field.type !== "choice" && field.type !== "link") return undefined;
        const source = field.settings.optionsSource;
        if (source.kind !== "flow") return undefined;
        const inputKeys: Record<string, string> = {};
        for (const [name, fieldId] of Object.entries(source.inputs)) {
          const input = recordType.fields.find((candidate) =>
            sameId(String(candidate.fieldId), String(fieldId)),
          );
          if (input === undefined) return undefined;
          inputKeys[name] = input.key;
        }
        const target = field.type === "link" ? field.settings.target : undefined;
        return {
          type: field.type,
          flowId: String(source.flowId),
          inputKeys,
          ...(target?.state === "resolved"
            ? {
                target: {
                  recordTypeId: String(target.recordTypeId),
                  label:
                    module.content.recordTypes.find((candidate) =>
                      sameId(String(candidate.recordTypeId), String(target.recordTypeId)),
                    )?.singularLabel ?? "Record",
                },
              }
            : {}),
        };
      }
  return undefined;
};

/**
 * The keys of the form fields a placement's options are worked out from (its options flow's or
 * declared query's inputs), or undefined when its options read nothing from the form.
 */
export const placementOptionInputKeys = (
  context: InstalledRuntimeContext,
  placement: Readonly<{ settings: Readonly<Record<string, unknown>> }>,
): readonly string[] | undefined => {
  const flow = placementOptionsFlow(context, placement);
  if (flow !== undefined) return Object.values(flow.inputKeys);
  const bound = isRecord(placement.settings.field) ? placement.settings.field.fieldId : undefined;
  const query =
    typeof bound === "string" ? installedLinkField(context, bound)?.sourceQuery : undefined;
  return query === undefined ? undefined : Object.values(query.inputKeys);
};

/** The options of a field whose options a flow works out, searched and paged for one picker. */
const loadFlowOptionsPage = async (
  session: IdentitySession,
  projected: ProjectedChoicePage,
  flow: OptionsFlowField,
  request: RecordChoicePageRequest,
): Promise<RecordChoicePageResult> => {
  const { context, selection, dependencies } = projected;
  const inputs: Record<string, JsonValue> = {};
  for (const [name, key] of Object.entries(flow.inputKeys)) {
    const drafted = request.draft === undefined ? undefined : request.draft[key];
    inputs[name] = drafted ?? null;
  }
  const queryRecords = createFlowQueryReader(
    { ...dependencies, continuationKey: getQueryContinuationKey() },
    {
      organizationId: String(context.organizationId),
      applicationRootId: String(context.applicationRootId),
      modules: context.releaseSet.modules,
    },
  );
  const ran = await runFieldOptionsFlow(
    {
      library: flowPlansOf(context.releaseSet).library,
      queryRecords,
      session,
      selection,
      now: new Date().toISOString(),
      runId: crypto.randomUUID(),
    },
    flow.flowId,
    inputs,
  );
  if (ran.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (ran.kind === "failed") return { kind: "refused", cause: "options_flow_failed " + ran.reason };
  const needle = request.search?.trim().toLowerCase() ?? "";
  const matching = ran.options.filter((option) => option.label.toLowerCase().includes(needle));
  const offset = request.continuationToken === undefined ? 0 : Number(request.continuationToken);
  const size = Math.min(
    request.pageSize ?? recordChoicePageSizes.default,
    recordChoicePageSizes.maximum,
  );
  if (!Number.isSafeInteger(offset) || offset < 0)
    return { kind: "refused", cause: "cursor_invalid" };
  const page = matching.slice(offset, offset + size);
  const next = offset + size < matching.length ? String(offset + size) : undefined;
  if (flow.type === "choice") {
    if (page.some((option) => typeof option.value !== "string"))
      return { kind: "refused", cause: "options_flow_failed a choice option value is not text" };
    return {
      kind: "completed",
      options: page.map((option) => ({ key: option.value as string, label: option.label })),
      ...(next === undefined ? {} : { nextContinuationToken: next }),
    };
  }
  if (flow.target === undefined || page.some((option) => typeof option.value === "string"))
    return { kind: "refused", cause: "options_flow_failed a link option value is not a record" };
  return {
    kind: "completed",
    choices: page.map((option) => {
      const value = option.value as { recordTypeId: string; recordId: string };
      return {
        recordTypeId: value.recordTypeId,
        recordId: value.recordId,
        title: option.label,
        typeLabel: flow.target!.label,
      };
    }),
    ...(next === undefined ? {} : { nextContinuationToken: next }),
  };
};

/**
 * One page of the records a link field on the viewer's current page may point at. The page is
 * projected again under the viewer and the exact installed release, so only a link input the
 * viewer can use on that page is read for, and only its declared record types.
 */
export const loadFieldOptionsPage = async (
  session: IdentitySession,
  address: OptionsAddress,
  request: RecordChoicePageRequest,
): Promise<RecordChoicePageResult> => {
  const projected = await projectOptionsPage(session, address, request);
  if (projected.kind === "reload" || projected.kind === "temporarily_unavailable") return projected;
  if (projected.kind !== "available") return { kind: "refused", cause: "page_not_projected" };
  const { selection, dependencies } = projected;
  if (request.fieldId === undefined) {
    const placement = collectPlacements(projected.page).find((entry) =>
      sameId(entry.placementId, request.placementId),
    );
    const flow =
      placement === undefined ? undefined : placementOptionsFlow(projected.context, placement);
    if (flow !== undefined) {
      if (projectedUseAvailability(placement!) !== "available")
        return { kind: "refused", cause: "placement_unavailable" };
      return loadFlowOptionsPage(session, projected, flow, request);
    }
  }
  const queries = createProtectedQueryService({
    ...dependencies,
    continuationKey: getQueryContinuationKey(),
  });
  const descriptor = await prepareLinkChoiceDescriptor(
    session,
    projected,
    request,
    createHumanOrganizationRequestService(dependencies),
    queries,
  );
  if (descriptor.kind !== "ready") return descriptor;
  const { targets, narrowedBy, sourceQuery } = descriptor;
  const requests = createHumanOrganizationRequestService(dependencies);
  const admission = optionFilterAdmission(descriptor.optionFilter, async (ids) => {
    const decided = await requests.run(session, selection, (transaction) =>
      delegableRoleIds(transaction, ids),
    );
    if (decided.kind !== "available") throw new Error("OPTION_FILTER_UNAVAILABLE");
    return decided.value;
  });
  const read = await createRecordChoiceReader(queries).read(
    session,
    selection,
    {
      targets,
      ...(narrowedBy === undefined ? {} : { narrowedBy }),
      ...(sourceQuery === undefined ? {} : { sourceQuery }),
      ...(request.search === undefined || request.search.trim() === ""
        ? {}
        : { search: request.search }),
      pageSize: Math.min(
        request.pageSize ?? recordChoicePageSizes.default,
        recordChoicePageSizes.maximum,
      ),
      ...(request.continuationToken === undefined
        ? {}
        : { continuationToken: request.continuationToken }),
    },
    admission,
  );
  if (read.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (read.kind !== "available") return { kind: "refused", cause: `request_${read.kind}` };
  if (read.value.outcome !== "completed")
    return { kind: "refused", cause: `query_${read.value.reasonCode}` };
  // The page is checked once against the record choice page contract here, where it is built.
  const page = recordChoicePageSchema.safeParse({
    choices: read.value.choices,
    ...(read.value.nextContinuationToken === undefined
      ? {}
      : { nextContinuationToken: read.value.nextContinuationToken }),
  });
  if (!page.success)
    return {
      kind: "refused",
      cause: `choice_page_invalid ${page.error.issues[0]?.path.map(String).join(".")}`,
    };
  return { kind: "completed", ...page.data };
};
