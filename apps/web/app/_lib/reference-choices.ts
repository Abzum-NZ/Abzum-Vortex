import "server-only";

import {
  CHOICE_INPUT_BLOCK_RELEASE_1_1_0,
  CHOICE_INPUT_BLOCK_RELEASE_1_2_0,
  FORM_CONTAINER_BLOCK_RELEASE,
  builderKeySchema,
  jsonValueSchema,
  referenceChoiceSelectionEvidenceMapSchema,
  type ApplicationContentV2,
  type BlockPropertyValueV2Contract,
  type JsonValue,
  type ModuleDefinitionConsumerReadResultV3,
  type ReferenceChoiceSelectionEvidence,
  type ReferenceChoiceSelectionEvidenceMap,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  createReferenceChoiceService,
  recordReferenceChoiceCommandSchema,
  resolveReferenceChoiceSelection,
  type RecordReferenceChoiceCommand,
  type ReferenceChoiceOption,
} from "@vortex/query";

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

type ChoicePlacementSettings = Readonly<{
  fieldKey: string;
  queryId: string;
  labelFieldId: string;
  releaseVersion: "1.1.0" | "1.2.0";
  dependency?: Readonly<{ key: string; fromField: string }>;
}>;

export type ReferenceChoiceFormField = Readonly<{
  fieldKey: string;
  command: RecordReferenceChoiceCommand;
  releaseVersion: "1.1.0" | "1.2.0";
  dependency?: Readonly<{ key: string; fromField: string }>;
}>;

export type ReferenceChoiceFormFieldIndex = ReadonlyMap<string, ReferenceChoiceFormField>;

export type ProjectedReferenceChoiceForm = Readonly<{
  fields: ReferenceChoiceFormFieldIndex;
  placements: ReadonlyMap<string, ReferenceChoiceFormField>;
}>;

const blockOf = (placement: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(placement) || !isRecord(placement.block)) return undefined;
  return placement.block;
};

const settingsOf = (
  placement: unknown,
): Readonly<Record<string, BlockPropertyValueV2Contract>> | undefined => {
  if (!isRecord(placement) || !isRecord(placement.settings)) return undefined;
  return placement.settings as Readonly<Record<string, BlockPropertyValueV2Contract>>;
};

/** True only for the immutable choice-input release that declares a query source. */
export const hasReferenceChoiceSource = (placement: unknown): boolean => {
  const block = blockOf(placement);
  const settings = settingsOf(placement);
  return (
    block !== undefined &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, CHOICE_INPUT_BLOCK_RELEASE_1_1_0.blockId) &&
    (block.releaseVersion === CHOICE_INPUT_BLOCK_RELEASE_1_1_0.releaseVersion ||
      block.releaseVersion === CHOICE_INPUT_BLOCK_RELEASE_1_2_0.releaseVersion) &&
    settings !== undefined &&
    Object.hasOwn(settings, "choice_source")
  );
};

const placementSettings = (placement: unknown): ChoicePlacementSettings | undefined => {
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
  const releaseVersion = blockOf(placement)?.releaseVersion as "1.1.0" | "1.2.0";
  let dependency: ChoicePlacementSettings["dependency"];
  if (releaseVersion === "1.2.0" && source.properties.input !== undefined) {
    const input = source.properties.input;
    if (input.kind !== "group" || Object.keys(input.properties).length !== 2 ||
        input.properties.key?.kind !== "text" || input.properties.from_field?.kind !== "text")
      return undefined;
    const key = builderKeySchema.safeParse(input.properties.key.value);
    const from = builderKeySchema.safeParse(input.properties.from_field.value);
    if (!key.success || !from.success) return undefined;
    dependency = { key: key.data, fromField: from.data };
  }
  return fieldKey.success
    ? {
        fieldKey: fieldKey.data,
        queryId: source.properties.query.queryId,
        labelFieldId: source.properties.label_field.fieldId,
        releaseVersion,
        ...(dependency === undefined ? {} : { dependency }),
      }
    : undefined;
};

const queryCommand = (
  settings: ChoicePlacementSettings,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
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
  placement: unknown,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
): ReferenceChoiceFormField | undefined => {
  const settings = placementSettings(placement);
  if (settings === undefined) return undefined;
  const command = queryCommand(settings, modules);
  if (command === undefined) return undefined;
  if (settings.dependency !== undefined) {
    const input = command.source.query.inputs[0];
    if (command.source.query.inputs.length !== 1 || input?.required !== true ||
        input.type !== "text" || input.key !== settings.dependency.key) return undefined;
  }
  return {
    fieldKey: settings.fieldKey,
    command,
    releaseVersion: settings.releaseVersion,
    ...(settings.dependency === undefined ? {} : { dependency: settings.dependency }),
  };
};

/** One unbound record Choice in this exact Form is the only permitted parent shape. */
const validDependencies = (fields: ReferenceChoiceFormFieldIndex): boolean => {
  for (const field of fields.values()) {
    if (field.dependency === undefined) continue;
    const parent = fields.get(field.dependency.fromField);
    if (parent === undefined || parent === field || parent.dependency !== undefined ||
        parent.command.source.query.inputs.length !== 0) return false;
  }
  return true;
};

/** The caller must have re-resolved this option through the current parent's protected Query. */
export const bindReferenceChoiceField = (
  fields: ReferenceChoiceFormFieldIndex,
  field: ReferenceChoiceFormField,
  parentChoice: ReferenceChoiceOption,
): ReferenceChoiceFormField | undefined => {
  const dependency = field.dependency;
  if (dependency === undefined || !validDependencies(fields) ||
      !fields.has(dependency.fromField) || !("recordId" in parentChoice.value)) return undefined;
  return {
    ...field,
    command: {
      ...field.command,
      boundInput: { key: dependency.key, value: parentChoice.value.recordId },
    },
  };
};

const formPlacementsOnPage = (
  page: unknown,
  targetFormId: string,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
): Readonly<{ fields: readonly ReferenceChoiceFormField[]; invalid: boolean }> => {
  const found: ReferenceChoiceFormField[] = [];
  let invalid = false;
  const visitSlot = (slot: unknown, formId?: string): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, placement] of Object.entries(slot.placements)) {
      const block = blockOf(placement);
      const isForm =
        typeof block?.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
      const owner = isForm ? placementId : formId;
      if (owner !== undefined && sameId(owner, targetFormId) && hasReferenceChoiceSource(placement)) {
        const field = referenceChoiceFieldForPlacement(placement, modules);
        if (field === undefined) invalid = true;
        else found.push(field);
      }
      if (isRecord(placement) && isRecord(placement.slots))
        for (const child of Object.values(placement.slots)) visitSlot(child, owner);
    }
  };

  if (!isRecord(page) || !isRecord(page.composition)) return { fields: found, invalid };
  const composition = page.composition;
  if ("main" in composition) visitSlot(composition.main);
  if (isRecord(composition.content))
    for (const slot of Object.values(composition.content)) visitSlot(slot);
  if (isRecord(composition.stepContent))
    for (const slot of Object.values(composition.stepContent)) visitSlot(slot);
  return { fields: found, invalid };
};

/** A form ID is usable only when one authored Form placement has that identity in the release. */
export const applicationHasAuthoredForm = (
  application: ApplicationContentV2,
  formId: string,
): boolean => {
  let matches = 0;
  const visitSlot = (slot: unknown): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, placement] of Object.entries(slot.placements)) {
      const block = blockOf(placement);
      if (
        sameId(placementId, formId) &&
        typeof block?.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
      )
        matches += 1;
      if (isRecord(placement) && isRecord(placement.slots))
        for (const child of Object.values(placement.slots)) visitSlot(child);
    }
  };

  for (const page of application.pages) {
    const composition = page.composition;
    if (!isRecord(composition)) continue;
    if ("main" in composition) visitSlot(composition.main);
    if ("content" in composition && isRecord(composition.content))
      for (const slot of Object.values(composition.content)) visitSlot(slot);
    if ("stepContent" in composition && isRecord(composition.stepContent))
      for (const slot of Object.values(composition.stepContent)) visitSlot(slot);
  }
  for (const shell of application.shells) visitSlot(shell.layout);
  return matches === 1;
};

/** Finds the exact form's choice inputs across the active Application release. */
export const referenceChoiceFieldsForForm = (
  application: ApplicationContentV2,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
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
    const result = formPlacementsOnPage({ composition: { main: shell.layout } }, formId, modules);
    if (result.invalid) return undefined;
    fields.push(...result.fields);
  }
  const index = new Map<string, ReferenceChoiceFormField>();
  for (const field of fields) {
    if (index.has(field.fieldKey)) return undefined;
    index.set(field.fieldKey, field);
  }
  return validDependencies(index) ? index : undefined;
};

/** Uses only the visible, usable Form subtree of the viewer's projected addressed page. */
export const projectedReferenceChoiceForm = (
  page: unknown,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
  formId: string,
): ProjectedReferenceChoiceForm | undefined => {
  if (!isRecord(page) || !isRecord(page.composition)) return undefined;
  let matches = 0;
  let target: Record<string, unknown> | undefined;
  const find = (slot: unknown, usable: boolean): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, placement] of Object.entries(slot.placements)) {
      if (!isRecord(placement)) continue;
      const block = blockOf(placement);
      const isForm = typeof block?.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
      const currentlyUsable = usable && placement.availability === undefined;
      if (isForm && sameId(placementId, formId)) {
        matches += 1;
        if (currentlyUsable) target = placement;
      }
      if (isRecord(placement.slots))
        for (const child of Object.values(placement.slots)) find(child, currentlyUsable);
    }
  };
  const composition = page.composition;
  if ("main" in composition) find(composition.main, true);
  if (isRecord(composition.stepContent))
    for (const slot of Object.values(composition.stepContent)) find(slot, true);
  if (matches !== 1 || target === undefined) return undefined;

  const fields = new Map<string, ReferenceChoiceFormField>();
  const placements = new Map<string, ReferenceChoiceFormField>();
  let invalid = false;
  const collect = (slot: unknown, usable: boolean): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, placement] of Object.entries(slot.placements)) {
      if (!isRecord(placement)) continue;
      const block = blockOf(placement);
      if (typeof block?.blockId === "string" &&
          sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)) continue;
      const currentlyUsable = usable && placement.availability === undefined;
      if (!currentlyUsable) continue;
      if (hasReferenceChoiceSource(placement)) {
        const field = referenceChoiceFieldForPlacement(placement, modules);
        if (field === undefined || fields.has(field.fieldKey)) invalid = true;
        else {
          fields.set(field.fieldKey, field);
          placements.set(placementId, field);
        }
      }
      if (isRecord(placement.slots))
        for (const child of Object.values(placement.slots)) collect(child, currentlyUsable);
    }
  };
  if (isRecord(target.slots))
    for (const child of Object.values(target.slots)) collect(child, true);
  return invalid || !validDependencies(fields) ? undefined : { fields, placements };
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
    ...(evidence.continuationToken === undefined
      ? {}
      : { continuationToken: evidence.continuationToken }),
  });
  return result.kind === "available" && result.value.outcome === "completed"
    ? result.value.choices
    : undefined;
};

/** Resolves submitted keys only when the same source page currently offers them to this viewer. */
export const resolveReferenceChoiceFormValues = async (args: Readonly<{
  service: ReferenceChoiceService;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  application: ApplicationContentV2;
  modules: readonly ModuleDefinitionConsumerReadResultV3[];
  formId: string;
  projectedFields: ReferenceChoiceFormFieldIndex;
  values: unknown;
  evidence?: unknown;
}>): Promise<Readonly<Record<string, JsonValue>> | undefined> => {
  if (!isRecord(args.values)) return undefined;
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
  const parents = new Map<string, ReferenceChoiceOption>();
  const ordered = [...fields].sort(([, left], [, right]) =>
    Number(left.dependency !== undefined) - Number(right.dependency !== undefined),
  );
  for (const [fieldKey, field] of ordered) {
    if (!Object.hasOwn(args.values, fieldKey)) continue;
    const submitted = args.values[fieldKey];
    if (submitted === null) {
      if (Object.hasOwn(parsedEvidence.data, fieldKey)) return undefined;
      continue;
    }
    if (typeof submitted !== "string") return undefined;
    const evidence: ReferenceChoiceSelectionEvidence | undefined = parsedEvidence.data[fieldKey];
    if (evidence === undefined) return undefined;
    let currentField = field;
    if (field.dependency !== undefined) {
      const parent = parents.get(field.dependency.fromField);
      if (parent === undefined) return undefined;
      const bound = bindReferenceChoiceField(fields, field, parent);
      if (bound === undefined) return undefined;
      currentField = bound;
    }
    const choices = await choicesForEvidence(
      args.service,
      args.session,
      args.selection,
      currentField,
      evidence,
    );
    if (choices === undefined) return undefined;
    const value = resolveReferenceChoiceSelection(choices, submitted);
    if (value === undefined || value === null) return undefined;
    const selected = choices.find((choice) => choice.key === submitted);
    if (selected === undefined) return undefined;
    if (field.dependency === undefined) parents.set(fieldKey, selected);
    resolved[fieldKey] = value;
  }
  const parsedValues = jsonValueSchema.safeParse(resolved);
  if (!parsedValues.success || !isRecord(parsedValues.data)) return undefined;
  return Object.freeze(parsedValues.data) as Readonly<Record<string, JsonValue>>;
};

/** Rechecks a selected choice while returning another search or continuation page to the client. */
export const resolveReferenceChoiceOption = async (args: Readonly<{
  service: ReferenceChoiceService;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
  field: ReferenceChoiceFormField;
  key: string;
  evidence: ReferenceChoiceSelectionEvidence;
}>): Promise<ReferenceChoiceOption | undefined> => {
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
