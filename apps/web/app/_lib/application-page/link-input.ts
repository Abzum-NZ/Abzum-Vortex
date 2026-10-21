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
} from "@vortex/platform/server";
import {
  isRecord,
  queryIdSchema,
  readRecordsTableContract,
  recordIdSchema,
  sameId,
  type BlockPropertyValueContract,
  type IdentitySession,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import {
  prepareRuntimePreviewChoices,
  type RuntimePreviewDemandResult,
} from "../runtime-preview-demand";
import {
  collectPlacements,
  first,
  isLinkInputPlacement,
  linkInputTargets,
  projectedUseAvailability,
} from "./placement-helpers";
import { projectReferenceChoicePage, type ReferenceChoiceAddress } from "./reference-choice";
import type { PageDataState, SearchParameters } from "./types";

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
          const declared = field.settings.dependsOn;
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
          return {
            sourceRecordTypeId: String(recordType.recordTypeId),
            moduleRootId: String(field.settings.target.moduleRootId),
            recordTypeId: String(field.settings.target.recordTypeId),
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
  const contract = readRecordsTableContract(
    settings as Readonly<Record<string, BlockPropertyValueContract>>,
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

export type RecordChoicePageResult =
  | Readonly<{
      kind: "completed";
      choices: readonly RecordChoice[];
      nextContinuationToken?: string;
    }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "refused"; cause: string }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/**
 * One page of the records a link field on the viewer's current page may point at. The page is
 * projected again under the viewer and the exact installed release, so only a link input the
 * viewer can use on that page is read for, and only its declared record types.
 */
export const loadRecordChoicePage = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{
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
    search?: string;
    pageSize?: number;
    continuationToken?: string;
  }>,
): Promise<RecordChoicePageResult> => {
  const projected = await projectReferenceChoicePage(session, address, request);
  if (projected.kind === "reload" || projected.kind === "temporarily_unavailable") return projected;
  if (projected.kind !== "available") return { kind: "refused", cause: "page_not_projected" };
  const { context, selection, dependencies } = projected;
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
    const readable = await createHumanOrganizationRequestService(dependencies).run(
      session,
      selection,
      (transaction) => readRecordTypeVisibleFieldIds(transaction, filtered.sourceRecordTypeId),
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
    // An automatic field input of a dependent link field narrows its choices by the form's draft
    // of the parent; the dependency is the field's own declaration, never the request's.
    const bound = isRecord(placement.settings.field) ? placement.settings.field.fieldId : undefined;
    const boundField = typeof bound === "string" ? installedLinkField(context, bound) : undefined;
    if (boundField?.dependency !== undefined) {
      const readable = await createHumanOrganizationRequestService(dependencies).run(
        session,
        selection,
        (transaction) => readRecordTypeVisibleFieldIds(transaction, boundField.sourceRecordTypeId),
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
  const demand = await prepareRuntimePreviewChoices(session, context, [
    ...targets.map((target) => target.recordTypeId),
    ...(dependency?.link.parentTarget === undefined
      ? []
      : [dependency.link.parentTarget.recordTypeId]),
  ]);
  if (demand.kind !== "ready")
    return demand.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused", cause: "preview_demand_refused" };

  const queries = createProtectedQueryService({
    ...dependencies,
    continuationKey: getQueryContinuationKey(),
  });
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
  const read = await createRecordChoiceReader(queries).read(session, selection, {
    targets,
    ...(narrowedBy === undefined ? {} : { narrowedBy }),
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
  });
  if (read.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (read.kind !== "available") return { kind: "refused", cause: `request_${read.kind}` };
  if (read.value.outcome !== "completed")
    return { kind: "refused", cause: `query_${read.value.reasonCode}` };
  return {
    kind: "completed",
    choices: read.value.choices,
    ...(read.value.nextContinuationToken === undefined
      ? {}
      : { nextContinuationToken: read.value.nextContinuationToken }),
  };
};
