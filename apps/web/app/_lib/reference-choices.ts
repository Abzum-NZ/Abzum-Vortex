import "server-only";

import {
  CHOICE_INPUT_BLOCK_RELEASE_1_1_0,
  CHOICE_INPUT_BLOCK_RELEASE_1_2_0,
  FORM_CONTAINER_BLOCK_RELEASE,
  builderKeySchema,
  jsonValueSchema,
  recordIdSchema,
  referenceChoiceSelectionEvidenceMapSchema,
  type ApplicationContentV2,
  type BlockPropertyValueV2Contract,
  type JsonValue,
  type ModuleDefinitionConsumerReadResultV3,
  type ReferenceChoiceSelectionEvidence,
  type ReferenceChoiceSelectionEvidenceMap,
  flowTaskChildLists,
  type FlowTask,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  createReferenceChoiceService,
  recordReferenceChoiceCommandSchema,
  resolveReferenceChoiceSelection,
  type RecordReferenceChoiceCommand,
  type OrganizationAccountReferenceChoiceCommand,
  type ReferenceChoiceOption,
} from "@vortex/query";

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

type QueryChoicePlacementSettings = Readonly<{
  sourceKind: "query";
  fieldKey: string;
  queryId: string;
  labelFieldId: string;
  releaseVersion: "1.1.0" | "1.2.0" | "1.3.0";
  dependency?: Readonly<{ key: string; fromField: string }>;
}>;

type PersonChoicePlacementSettings = Readonly<{
  sourceKind: "person";
  fieldKey: string;
  fieldId: string;
  releaseVersion: "1.3.0";
}>;
type ChoicePlacementSettings = QueryChoicePlacementSettings | PersonChoicePlacementSettings;

type PersonPurposeContext = Readonly<{
  application: ApplicationContentV2;
  pageId: string;
  pageRecordTypeId: string;
  installationRevision: number;
  releaseKey: string;
  subject: Readonly<{ recordId: string; concurrencyNumber: number }>;
}>;

type ReferenceChoiceCommand = RecordReferenceChoiceCommand | OrganizationAccountReferenceChoiceCommand;

export type ReferenceChoiceFormField = Readonly<{
  fieldKey: string;
  command: ReferenceChoiceCommand;
  sourceKind: "query" | "person";
  releaseVersion: "1.1.0" | "1.2.0" | "1.3.0";
  personFieldId?: string;
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

/** True only for a supported immutable Choice release with a server-backed source. */
export const hasReferenceChoiceSource = (placement: unknown): boolean => {
  const block = blockOf(placement);
  const settings = settingsOf(placement);
  const releaseVersion = block?.releaseVersion;
  return (
    block !== undefined &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, CHOICE_INPUT_BLOCK_RELEASE_1_1_0.blockId) &&
    (releaseVersion === CHOICE_INPUT_BLOCK_RELEASE_1_1_0.releaseVersion ||
      releaseVersion === CHOICE_INPUT_BLOCK_RELEASE_1_2_0.releaseVersion ||
      releaseVersion === "1.3.0") &&
    settings !== undefined &&
    (Object.hasOwn(settings, "choice_source") || Object.hasOwn(settings, "person_choice_source"))
  );
};

const placementSettings = (placement: unknown): ChoicePlacementSettings | undefined => {
  if (!hasReferenceChoiceSource(placement)) return undefined;
  const settings = settingsOf(placement);
  const name = settings?.name;
  const fieldKey = builderKeySchema.safeParse(name?.value);
  if (name?.kind !== "text" || !fieldKey.success) return undefined;
  const releaseVersion = blockOf(placement)?.releaseVersion;
  if (Object.hasOwn(settings ?? {}, "person_choice_source")) {
    const source = settings?.person_choice_source;
    if (releaseVersion !== "1.3.0" || Object.hasOwn(settings ?? {}, "choice_source") ||
        source?.kind !== "group" || source.properties.field?.kind !== "field_reference")
      return undefined;
    return {
      sourceKind: "person",
      fieldKey: fieldKey.data,
      fieldId: source.properties.field.fieldId,
      releaseVersion: "1.3.0",
    };
  }
  const source = settings?.choice_source;
  if (source?.kind !== "group" ||
      source.properties.query?.kind !== "query_reference" ||
      source.properties.label_field?.kind !== "field_reference") return undefined;
  if (releaseVersion !== "1.1.0" && releaseVersion !== "1.2.0" && releaseVersion !== "1.3.0")
    return undefined;
  let dependency: QueryChoicePlacementSettings["dependency"];
  if ((releaseVersion === "1.2.0" || releaseVersion === "1.3.0") &&
      source.properties.input !== undefined) {
    const input = source.properties.input;
    if (input.kind !== "group" || Object.keys(input.properties).length !== 2 ||
        input.properties.key?.kind !== "text" || input.properties.from_field?.kind !== "text")
      return undefined;
    const key = builderKeySchema.safeParse(input.properties.key.value);
    const from = builderKeySchema.safeParse(input.properties.from_field.value);
    if (!key.success || !from.success) return undefined;
    dependency = { key: key.data, fromField: from.data };
  }
  return {
    sourceKind: "query",
    fieldKey: fieldKey.data,
    queryId: source.properties.query.queryId,
    labelFieldId: source.properties.label_field.fieldId,
    releaseVersion,
    ...(dependency === undefined ? {} : { dependency }),
  };
};

const queryCommand = (
  settings: QueryChoicePlacementSettings,
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
    source: { moduleRootId: module.rootId, moduleReleaseVersion: module.releaseVersion, query },
    labelFieldId: settings.labelFieldId,
    pageSize: 50,
  });
  return parsed.success ? parsed.data : undefined;
};

const nestedFlowTasks = (tasks: readonly FlowTask[]): readonly FlowTask[] =>
  tasks.flatMap((task) => [task, ...flowTaskChildLists(task).flatMap((child) => nestedFlowTasks(child.tasks))]);

const personPurpose = (
  settings: PersonChoicePlacementSettings,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
  placementId: string,
  formId: string,
  context: PersonPurposeContext | undefined,
): OrganizationAccountReferenceChoiceCommand["purpose"] | undefined => {
  if (context === undefined) return undefined;
  const pageMatches = context.application.pages.filter((page) =>
    sameId(String(page.pageId), context.pageId),
  );
  const page = pageMatches[0];
  const subjectRecordId = recordIdSchema.safeParse(context.subject.recordId);
  if (
    pageMatches.length !== 1 ||
    page === undefined ||
    (page.type !== "detail" && page.type !== "form") ||
    page.recordType.state !== "resolved" ||
    !sameId(String(page.recordType.recordTypeId), context.pageRecordTypeId) ||
    !subjectRecordId.success ||
    !Number.isSafeInteger(context.subject.concurrencyNumber) ||
    context.subject.concurrencyNumber < 1 ||
    context.subject.concurrencyNumber >= Number.MAX_SAFE_INTEGER
  ) return undefined;
  const fieldMatches = modules.flatMap((module) => module.content.recordTypes
    .filter((recordType) => sameId(String(recordType.recordTypeId), context.pageRecordTypeId))
    .flatMap((recordType) => recordType.fields
      .filter((field) => sameId(String(field.fieldId), settings.fieldId) && field.type === "link_to_person")
      .map((field) => ({ module, recordType, field }))));
  if (fieldMatches.length !== 1) return undefined;
  const { field } = fieldMatches[0]!;
  if (field.settings.audience !== "application_accounts" || field.settings.applicationRootIdRequired !== true)
    return undefined;

  const bindings = context.application.flowBindings.filter((binding) =>
    sameId(String(binding.controlId), formId) && binding.event === "form_submit");
  if (bindings.length !== 1) return undefined;
  const binding = bindings[0]!;
  const flowMatches = context.application.flows.filter((flow) =>
    sameId(String(flow.id), String(binding.flow.flowId)));
  if (flowMatches.length !== 1) return undefined;
  const flow = flowMatches[0]!;
  const boundInput = binding.flow.inputs[settings.fieldKey];
  const declaration = flow.inputs[settings.fieldKey];
  if (boundInput?.kind !== "caller" || boundInput.name !== settings.fieldKey ||
      declaration?.type !== "organization_account_reference" || declaration.required !== true)
    return undefined;

  const operationCalls = nestedFlowTasks(flow.tasks)
    .filter((task) => task.type === "operation.call");
  const otherOperationCalls = nestedFlowTasks([...flow.errors, ...flow.finally])
    .some((task) => task.type === "operation.call");
  if (operationCalls.length !== 1 || otherOperationCalls) return undefined;
  const call = operationCalls[0]!;
  if (call.type !== "operation.call") return undefined;
  const operation = call.properties.operation;
  const callInputs = call.properties.inputs;
  if (operation?.kind !== "literal" || operation.literal.type !== "text" ||
      typeof operation.literal.value !== "string") return undefined;
  if (callInputs !== undefined) {
    if (!isRecord(callInputs)) return undefined;
    const callInput = callInputs[settings.fieldKey];
    if (!isRecord(callInput) || callInput.kind !== "reference" || !isRecord(callInput.reference) ||
        callInput.reference.source !== "input" || callInput.reference.name !== settings.fieldKey)
      return undefined;
  }

  const actionMatches = modules.flatMap((module) => module.content.actions
    .filter((action) => action.key === operation.literal.value &&
      sameId(String(action.subjectRecordTypeId), context.pageRecordTypeId))
    .map((action) => ({ module, action })));
  if (actionMatches.length !== 1) return undefined;
  const { module, action } = actionMatches[0]!;
  const actionInputs = action.inputs.filter((input) => input.key === settings.fieldKey &&
    input.type === "organization_account_reference");
  if (actionInputs.length !== 1) return undefined;
  const fieldWrites = action.tasks.flatMap((task) => {
    if (task.type !== "record.set_fields") return [];
    const value = task.properties.values[settings.fieldId];
    return value === undefined ? [] : [value];
  });
  const fieldWrite = fieldWrites[0];
  if (fieldWrites.length !== 1 || fieldWrite?.kind !== "reference" ||
      fieldWrite.reference.source !== "input" || fieldWrite.reference.name !== settings.fieldKey)
    return undefined;

  return {
    kind: "named_action_person_field",
    ownerKind: "module",
    ownerId: String(module.rootId),
    releaseRevision: module.releaseRevision,
    actionId: String(action.actionId),
    recordTypeId: context.pageRecordTypeId,
    recordId: context.subject.recordId,
    expectedConcurrencyNumber: context.subject.concurrencyNumber,
    inputKey: settings.fieldKey,
    fieldId: settings.fieldId,
    installationRevision: context.installationRevision,
    releaseKey: context.releaseKey,
    pageId: context.pageId,
    formId,
    placementId,
  };
};

/** Resolves one trusted placement against exact installed Modules and its optional current action. */
export const referenceChoiceFieldForPlacement = (
  placement: unknown,
  modules: readonly ModuleDefinitionConsumerReadResultV3[],
  placementId = "",
  formId = "",
  purposeContext?: PersonPurposeContext,
): ReferenceChoiceFormField | undefined => {
  const settings = placementSettings(placement);
  if (settings === undefined) return undefined;
  if (settings.sourceKind === "person") {
    const purpose = personPurpose(settings, modules, placementId, formId, purposeContext);
    const base = {
      kind: "organization_account_reference" as const,
      pageSize: 50,
      ...(purpose === undefined ? {} : { purpose }),
    };
    return {
      fieldKey: settings.fieldKey,
      command: base,
      sourceKind: "person",
      personFieldId: settings.fieldId,
      releaseVersion: settings.releaseVersion,
    };
  }
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
    sourceKind: "query",
    releaseVersion: settings.releaseVersion,
    ...(settings.dependency === undefined ? {} : { dependency: settings.dependency }),
  };
};

/** One unbound record Choice in this exact Form is the only permitted parent shape. */
const validDependencies = (fields: ReferenceChoiceFormFieldIndex): boolean => {
  for (const field of fields.values()) {
    if (field.dependency === undefined) continue;
    const parent = fields.get(field.dependency.fromField);
    if (parent === undefined || parent === field || parent.sourceKind !== "query" ||
        parent.dependency !== undefined || parent.command.kind !== "record_reference" ||
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
  if (dependency === undefined || field.sourceKind !== "query" ||
      field.command.kind !== "record_reference" || !validDependencies(fields) ||
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
        const field = referenceChoiceFieldForPlacement(placement, modules, placementId, targetFormId);
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
  purposeContext?: PersonPurposeContext,
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
        const field = referenceChoiceFieldForPlacement(
          placement, modules, placementId, formId, purposeContext,
        );
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
  for (const [fieldKey, field] of fields)
    if (
      field.sourceKind === "person" &&
      Object.hasOwn(args.values, fieldKey) &&
      (field.command.kind !== "organization_account_reference" || field.command.purpose === undefined)
    ) return undefined;
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
    if (field.sourceKind === "person") {
      if (
        field.command.kind !== "organization_account_reference" ||
        field.command.purpose === undefined ||
        !isRecord(value) ||
        Object.keys(value).length !== 1 ||
        typeof value.organizationAccountId !== "string"
      ) return undefined;
      resolved[fieldKey] = value.organizationAccountId;
    } else {
      resolved[fieldKey] = value;
    }
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
