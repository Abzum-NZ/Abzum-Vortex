import "server-only";

import {
  builderKeySchema,
  jsonValueSchema,
  referenceChoiceSelectionEvidenceMapSchema,
  type ApplicationContent,
  type BlockPropertyValueContract,
  type JsonValue,
  type ModuleDefinitionConsumerReadResult,
  type ReferenceChoiceSelectionEvidence,
  type ReferenceChoiceSelectionEvidenceMap,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  isRecord,
  sameId,
  itemPropSlots,
  walkPageComposition,
  walkPlacementData,
  walkPlacements,
  type PlacementVisitor,
  type VisitedPlacement,
} from "@vortex/platform/schema";
import {
  CHOICE_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  placementSettings as typedPlacementSettings,
} from "@vortex/platform/server";
import type { createReferenceChoiceService } from "@vortex/platform/server";
import {
  recordReferenceChoiceCommandSchema,
  resolveReferenceChoiceSelection,
  type RecordReferenceChoiceCommand,
  type ReferenceChoiceOption,
} from "@vortex/platform/server";

type ChoicePlacementSettings = Readonly<{
  fieldKey: string;
  queryId: string;
  labelFieldId: string;
}>;

type ReferenceChoiceFormField = Readonly<{
  fieldKey: string;
  command: RecordReferenceChoiceCommand;
}>;

type ReferenceChoiceFormFieldIndex = ReadonlyMap<string, ReferenceChoiceFormField>;

export type ProjectedReferenceChoiceForm = Readonly<{
  fields: ReferenceChoiceFormFieldIndex;
  placements: ReadonlyMap<string, ReferenceChoiceFormField>;
}>;

/** The parts of a placed item a choice source is read from: its Vortex metadata and its props. */
type PlacedParts = Readonly<{ vortex: Record<string, unknown>; props: Record<string, unknown> }>;

const blockOf = (placement: PlacedParts): Record<string, unknown> | undefined =>
  isRecord(placement.vortex.block) ? placement.vortex.block : undefined;

/** The placement's typed settings, read by its block release's declaration. */
const settingsOf = (placement: PlacedParts): Readonly<Record<string, BlockPropertyValueContract>> =>
  typedPlacementSettings(placement.props);

/** True only for the immutable choice-input release that declares a query source. */
export const hasReferenceChoiceSource = (placement: PlacedParts): boolean => {
  const block = blockOf(placement);
  const settings = settingsOf(placement);
  return (
    block !== undefined &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, CHOICE_INPUT_BLOCK_RELEASE.blockId) &&
    block.releaseVersion === CHOICE_INPUT_BLOCK_RELEASE.releaseVersion &&
    Object.hasOwn(settings, "choice_source")
  );
};

const placementSettings = (placement: PlacedParts): ChoicePlacementSettings | undefined => {
  if (!hasReferenceChoiceSource(placement)) return undefined;
  const settings = settingsOf(placement);
  const name = settings?.name;
  const source = settings?.choice_source;
  if (
    name?.kind !== "text" ||
    source?.kind !== "group" ||
    source.properties.query?.kind !== "query_reference" ||
    source.properties.label_field?.kind !== "field_reference"
  )
    return undefined;
  const fieldKey = builderKeySchema.safeParse(name.value);
  return fieldKey.success
    ? {
        fieldKey: fieldKey.data,
        queryId: source.properties.query.queryId,
        labelFieldId: source.properties.label_field.fieldId,
      }
    : undefined;
};

const queryCommand = (
  settings: ChoicePlacementSettings,
  modules: readonly ModuleDefinitionConsumerReadResult[],
): RecordReferenceChoiceCommand | undefined => {
  const matches = modules.flatMap((module) =>
    module.content.queries
      .filter((query) => sameId(String(query.queryId), settings.queryId))
      .map((query) => ({ module, query })),
  );
  if (matches.length !== 1) return undefined;
  const { module, query } = matches[0]!;
  if (query.recordType.state !== "resolved") return undefined;
  const parsed = recordReferenceChoiceCommandSchema.safeParse({
    kind: "record_reference",
    allowedRecordTypes: [query.recordType],
    source: {
      moduleRootId: module.rootId,
      moduleReleaseVersion: module.releaseVersion,
      query,
    },
    labelFieldId: settings.labelFieldId,
    pageSize: 50,
  });
  return parsed.success ? parsed.data : undefined;
};

/** Resolves one trusted placement's source against the exact installed Module releases. */
export const referenceChoiceFieldForPlacement = (
  placement: PlacedParts,
  modules: readonly ModuleDefinitionConsumerReadResult[],
): ReferenceChoiceFormField | undefined => {
  const settings = placementSettings(placement);
  if (settings === undefined) return undefined;
  const command = queryCommand(settings, modules);
  if (command === undefined) return undefined;
  return { fieldKey: settings.fieldKey, command };
};

const formPlacementsOnPage = (
  page: unknown,
  targetFormId: string,
  modules: readonly ModuleDefinitionConsumerReadResult[],
): Readonly<{ fields: readonly ReferenceChoiceFormField[]; invalid: boolean }> => {
  const found: ReferenceChoiceFormField[] = [];
  let invalid = false;
  walkPageComposition(
    isRecord(page) ? page.composition : undefined,
    (placement, formId: string | undefined) => {
      const { placementId } = placement;
      const block = blockOf(placement);
      const isForm =
        typeof block?.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
      const owner = isForm ? placementId : formId;
      if (
        owner !== undefined &&
        sameId(owner, targetFormId) &&
        hasReferenceChoiceSource(placement)
      ) {
        const field = referenceChoiceFieldForPlacement(placement, modules);
        if (field === undefined) invalid = true;
        else found.push(field);
      }
      return owner;
    },
  );
  return { fields: found, invalid };
};

/** A form ID is usable only when one authored Form placement has that identity in the release. */
export const applicationHasAuthoredForm = (
  application: ApplicationContent,
  formId: string,
): boolean => {
  let matches = 0;
  const countForm = (placement: VisitedPlacement): undefined => {
    const { placementId } = placement;
    const block = blockOf(placement);
    if (
      sameId(placementId, formId) &&
      typeof block?.blockId === "string" &&
      sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      matches += 1;
  };

  for (const page of application.pages) walkPageComposition(page.composition, countForm);
  for (const shell of application.shells) walkPlacementData(shell.layout, countForm);
  return matches === 1;
};

/** Finds the exact form's choice inputs across the active Application release. */
const referenceChoiceFieldsForForm = (
  application: ApplicationContent,
  modules: readonly ModuleDefinitionConsumerReadResult[],
  formId: string,
): ReferenceChoiceFormFieldIndex | undefined => {
  if (!applicationHasAuthoredForm(application, formId)) return undefined;
  const fields: ReferenceChoiceFormField[] = [];
  for (const page of application.pages) {
    const result = formPlacementsOnPage(page, formId, modules);
    if (result.invalid) return undefined;
    fields.push(...result.fields);
  }
  for (const shell of application.shells) {
    const result = formPlacementsOnPage({ composition: shell.layout }, formId, modules);
    if (result.invalid) return undefined;
    fields.push(...result.fields);
  }
  const index = new Map<string, ReferenceChoiceFormField>();
  for (const field of fields) {
    if (index.has(field.fieldKey)) return undefined;
    index.set(field.fieldKey, field);
  }
  return index;
};

/** Uses only the visible, usable Form subtree of the viewer's projected addressed page. */
export const projectedReferenceChoiceForm = (
  page: unknown,
  modules: readonly ModuleDefinitionConsumerReadResult[],
  formId: string,
): ProjectedReferenceChoiceForm | undefined => {
  if (!isRecord(page) || !isRecord(page.composition)) return undefined;
  let matches = 0;
  let target: Record<string, unknown> | undefined;
  walkPageComposition(
    page.composition,
    (placement, inherited: Readonly<{ usable: boolean }>) => {
      const { placementId } = placement;
      const block = blockOf(placement);
      const isForm =
        typeof block?.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
      const currentlyUsable = inherited.usable && placement.vortex.availability === undefined;
      if (isForm && sameId(placementId, formId)) {
        matches += 1;
        if (currentlyUsable) target = placement.props;
      }
      return { usable: currentlyUsable };
    },
    { usable: true },
  );
  if (matches !== 1 || target === undefined) return undefined;

  const fields = new Map<string, ReferenceChoiceFormField>();
  const placements = new Map<string, ReferenceChoiceFormField>();
  let invalid = false;
  const collect: PlacementVisitor<boolean> = (placement, usable) => {
    const { placementId } = placement;
    const block = blockOf(placement);
    if (
      typeof block?.blockId === "string" &&
      sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      return false;
    const currentlyUsable = usable && placement.vortex.availability === undefined;
    if (!currentlyUsable) return false;
    if (hasReferenceChoiceSource(placement)) {
      const field = referenceChoiceFieldForPlacement(placement, modules);
      if (field === undefined || fields.has(field.fieldKey)) invalid = true;
      else {
        fields.set(field.fieldKey, field);
        placements.set(placementId, field);
      }
    }
    return currentlyUsable;
  };
  for (const [, child] of itemPropSlots(target)) walkPlacements(child, collect, true);
  return invalid ? undefined : { fields, placements };
};

type ReferenceChoiceService = ReturnType<typeof createReferenceChoiceService>;

const choicesForEvidence = async (
  service: ReferenceChoiceService,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  field: ReferenceChoiceFormField,
  evidence: ReferenceChoiceSelectionEvidence,
) => {
  const result = await service.run(session, selection, {
    ...field.command,
    ...(evidence.search === undefined ? {} : { search: evidence.search }),
    ...(evidence.exactRecordId === undefined ? {} : { exactRecordId: evidence.exactRecordId }),
    ...(evidence.continuationToken === undefined
      ? {}
      : { continuationToken: evidence.continuationToken }),
  });
  return result.kind === "available" && result.value.outcome === "completed"
    ? result.value.choices
    : undefined;
};

/** Resolves submitted keys only when the same source page currently offers them to this viewer. */
export const resolveReferenceChoiceFormValues = async (
  args: Readonly<{
    service: ReferenceChoiceService;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    application: ApplicationContent;
    modules: readonly ModuleDefinitionConsumerReadResult[];
    formId: string;
    projectedFields: ReferenceChoiceFormFieldIndex;
    values: unknown;
    evidence?: unknown;
  }>,
): Promise<Readonly<Record<string, JsonValue>> | undefined> => {
  if (!isRecord(args.values)) return undefined;
  const values = args.values;
  const authoredFields = referenceChoiceFieldsForForm(args.application, args.modules, args.formId);
  if (authoredFields === undefined) return undefined;
  const fields = args.projectedFields;
  for (const fieldKey of Object.keys(args.values))
    if (authoredFields.has(fieldKey) && !fields.has(fieldKey)) return undefined;
  const parsedEvidence =
    args.evidence === undefined
      ? { success: true as const, data: {} as ReferenceChoiceSelectionEvidenceMap }
      : referenceChoiceSelectionEvidenceMapSchema.safeParse(args.evidence);
  if (!parsedEvidence.success) return undefined;
  for (const fieldKey of Object.keys(parsedEvidence.data))
    if (!fields.has(fieldKey) || typeof args.values[fieldKey] !== "string") return undefined;

  const resolved: Record<string, unknown> = { ...args.values };
  // One field's submitted key, rechecked against the page its evidence names. Undefined refuses.
  const resolveField = async (
    fieldKey: string,
    field: ReferenceChoiceFormField,
  ): Promise<unknown> => {
    const submitted = values[fieldKey];
    if (submitted === null) return Object.hasOwn(parsedEvidence.data, fieldKey) ? undefined : null;
    if (typeof submitted !== "string") return undefined;
    const evidence: ReferenceChoiceSelectionEvidence | undefined = parsedEvidence.data[fieldKey];
    if (evidence === undefined) return undefined;
    const choices = await choicesForEvidence(
      args.service,
      args.session,
      args.selection,
      field,
      evidence,
    );
    if (choices === undefined) return undefined;
    const value = resolveReferenceChoiceSelection(choices, submitted);
    return value === undefined || value === null ? undefined : value;
  };
  // Each submitted field is rechecked in its own request, all together.
  const results = await Promise.all(
    [...fields]
      .filter(([fieldKey]) => Object.hasOwn(values, fieldKey))
      .map(async ([fieldKey, field]) => [fieldKey, await resolveField(fieldKey, field)] as const),
  );
  for (const [fieldKey, result] of results) {
    if (result === undefined) return undefined;
    if (result === null) continue;
    resolved[fieldKey] = result;
  }
  const parsedValues = jsonValueSchema.safeParse(resolved);
  if (!parsedValues.success || !isRecord(parsedValues.data)) return undefined;
  return Object.freeze(parsedValues.data) as Readonly<Record<string, JsonValue>>;
};

/** Rechecks a selected choice while returning another search or continuation page to the client. */
export const resolveReferenceChoiceOption = async (
  args: Readonly<{
    service: ReferenceChoiceService;
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    field: ReferenceChoiceFormField;
    key: string;
    evidence: ReferenceChoiceSelectionEvidence;
  }>,
): Promise<ReferenceChoiceOption | undefined> => {
  const choices = await choicesForEvidence(
    args.service,
    args.session,
    args.selection,
    args.field,
    args.evidence,
  );
  if (choices === undefined || resolveReferenceChoiceSelection(choices, args.key) === undefined)
    return undefined;
  return choices.find((candidate) => candidate.key === args.key);
};
