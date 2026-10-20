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
} from "@vortex/platform/server";
import {
  isRecord,
  readRecordsTableContract,
  recordIdSchema,
  sameId,
  type BlockPropertyValueContract,
  type IdentitySession,
} from "@vortex/platform/schema";
import { getQueryContinuationKey } from "../query-continuation-key";
import { prepareRuntimePreviewChoices } from "../runtime-preview-demand";
import {
  collectPlacements,
  first,
  isLinkInputPlacement,
  linkInputTargets,
  projectedUseAvailability,
} from "./placement-helpers";
import { projectReferenceChoicePage, type ReferenceChoiceAddress } from "./reference-choice";
import type { PageDataState, SearchParameters } from "./types";
import { decideRecordTypeFieldIds } from "./form-field-access";

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
): Promise<void> => {
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
  if (starts.length === 0) return;
  if (
    !(await prepareRuntimePreviewChoices(
      input.session,
      input.context,
      starts.map((start) => start.reference.recordTypeId),
    ))
  )
    throw new Error("PREVIEW_INITIAL_LINK_DEMAND_UNAVAILABLE");
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
};

/**
 * The record type a Records table's link filter on `fieldId` may name: the field must be one the
 * table's Column filters feature declares, and a single-target link field of the installed release.
 */
const linkFilterTarget = (
  context: InstalledRuntimeContext,
  settings: Readonly<Record<string, unknown>>,
  fieldId: string,
):
  | Readonly<{ moduleRootId: string; recordTypeId: string; sourceRecordTypeId: string }>
  | undefined => {
  const contract = readRecordsTableContract(
    settings as Readonly<Record<string, BlockPropertyValueContract>>,
  );
  const columnFilters = contract?.features.columnFilters;
  if (
    columnFilters === undefined ||
    !columnFilters.enabled ||
    !columnFilters.fields.some((field) => sameId(field, fieldId))
  )
    return undefined;
  for (const module of context.releaseSet.modules)
    for (const recordType of module.content.recordTypes)
      for (const field of recordType.fields)
        if (sameId(String(field.fieldId), fieldId))
          return field.type === "link" && field.settings.target.state === "resolved"
            ? {
                sourceRecordTypeId: String(recordType.recordTypeId),
                moduleRootId: String(field.settings.target.moduleRootId),
                recordTypeId: String(field.settings.target.recordTypeId),
              }
            : undefined;
  return undefined;
};

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
    /** For a Records table's link filter: the declared filter field whose targets are offered. */
    fieldId?: string;
    installationRevision: number;
    releaseKey: string;
    subjectRecordId?: string;
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
  if (request.fieldId !== undefined) {
    // A Records table's link filter offers the target records of one declared filter field.
    const filtered = linkFilterTarget(context, placement.settings, request.fieldId);
    if (filtered === undefined) return { kind: "refused", cause: "field_not_a_link_filter" };
    if (projectedUseAvailability(placement) !== "available")
      return { kind: "refused", cause: "placement_unavailable" };
    const readable = await createHumanOrganizationRequestService(dependencies).run(
      session,
      selection,
      (transaction, scope) =>
        decideRecordTypeFieldIds(transaction, scope, context, filtered.sourceRecordTypeId, "read"),
    );
    if (readable.kind === "temporarily_unavailable") return readable;
    if (readable.kind !== "available" || !readable.value.has(request.fieldId.toLowerCase()))
      return { kind: "refused", cause: "filter_field_withheld" };
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
  if (
    !(await prepareRuntimePreviewChoices(
      session,
      context,
      targets.map((target) => target.recordTypeId),
    ))
  )
    return { kind: "temporarily_unavailable" };

  const queries = createProtectedQueryService({
    ...dependencies,
    continuationKey: getQueryContinuationKey(),
  });
  const read = await createRecordChoiceReader(queries).read(session, selection, {
    targets,
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
