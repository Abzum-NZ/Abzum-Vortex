import type { ModuleContent } from "../module-contracts";
import type { VersionImpactReason } from "../version-impact";
import { canonicalJson, compareCanonicalStrings } from "../canonical-json-definition";
import {
  type RecordValue,
  type ComponentKind,
  compareUnknownText,
  asRecord,
  same,
  makeReason,
  pushChange,
  compareSet,
  comparePresentationSet,
  compareBound,
  compareKeyed,
  compareOrderedEntries,
  finaliseReasons,
  sorted,
} from "./shared";
import { compareSharingCondition, comparePermissions } from "./permission-contents";
import { currencyConfiguration } from "./normalisation";

const compareFieldSettings = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const fieldId = candidate.fieldId;
  if (previous.type !== candidate.type) {
    reasons.push(makeReason("major", "storage_contract_changed", "field", "storage", fieldId));
    return;
  }
  const before = asRecord(previous.settings);
  const after = asRecord(candidate.settings);
  switch (candidate.type) {
    case "text":
    case "long_text":
      compareBound(reasons, before.maxLength, after.maxLength, "maximum", "field", fieldId);
      pushChange(
        reasons,
        before.format,
        after.format,
        "major",
        "constraint_narrowed",
        "field",
        "constraint",
        fieldId,
      );
      break;
    case "formatted_text":
      comparePresentationSet(
        reasons,
        (before.allowedBlocks as unknown[]) ?? [],
        (after.allowedBlocks as unknown[]) ?? [],
        "field",
        fieldId,
        "constraint",
      );
      compareBound(reasons, before.maxLength, after.maxLength, "maximum", "field", fieldId);
      break;
    case "whole_number":
      compareBound(reasons, before.minimum, after.minimum, "minimum", "field", fieldId);
      compareBound(reasons, before.maximum, after.maximum, "maximum", "field", fieldId);
      pushChange(
        reasons,
        before.step,
        after.step,
        "major",
        "constraint_narrowed",
        "field",
        "constraint",
        fieldId,
      );
      break;
    case "decimal_number":
      compareBound(reasons, before.minimum, after.minimum, "minimum", "field", fieldId, true);
      compareBound(reasons, before.maximum, after.maximum, "maximum", "field", fieldId, true);
      for (const key of ["digitsBeforeDecimal", "decimalPlaces"])
        pushChange(
          reasons,
          before[key],
          after[key],
          "major",
          "storage_contract_changed",
          "field",
          "storage",
          fieldId,
        );
      break;
    case "money":
      compareBound(reasons, before.minimum, after.minimum, "minimum", "field", fieldId, true);
      compareBound(reasons, before.maximum, after.maximum, "maximum", "field", fieldId, true);
      if (!same(currencyConfiguration(before), currencyConfiguration(after)))
        reasons.push(makeReason("major", "storage_contract_changed", "field", "storage", fieldId));
      break;
    case "date":
      compareDateBound(reasons, before.earliest, after.earliest, "minimum", fieldId);
      compareDateBound(reasons, before.latest, after.latest, "maximum", fieldId);
      break;
    case "choice":
    case "several_choices":
      compareOptions(reasons, previous, candidate);
      if (candidate.type === "several_choices")
        compareBound(
          reasons,
          before.maximumSelections,
          after.maximumSelections,
          "maximum",
          "field",
          fieldId,
        );
      break;
    case "web_address":
      compareSet(
        reasons,
        (before.allowedSchemes as unknown[]) ?? [],
        (after.allowedSchemes as unknown[]) ?? [],
        "field",
        fieldId,
        "constraint",
      );
      break;
    case "table":
      compareTableSettings(reasons, previous, candidate);
      break;
    case "attachment":
      comparePresentationSet(
        reasons,
        before.allowedKinds as unknown[],
        after.allowedKinds as unknown[],
        "field",
        fieldId,
        "constraint",
      );
      comparePresentationSet(
        reasons,
        (before.allowedExtensions as unknown[]) ?? [],
        (after.allowedExtensions as unknown[]) ?? [],
        "field",
        fieldId,
        "constraint",
      );
      compareBound(reasons, before.maxFileSizeMb, after.maxFileSizeMb, "maximum", "field", fieldId);
      compareBound(reasons, before.maxFiles, after.maxFiles, "maximum", "field", fieldId);
      pushChange(
        reasons,
        before.multiple,
        after.multiple,
        "major",
        "storage_contract_changed",
        "field",
        "storage",
        fieldId,
      );
      break;
    case "yes_no":
    case "email_address":
      break;
    case "date_time":
    case "phone_number":
      pushChange(
        reasons,
        before,
        after,
        "patch",
        "presentation_changed",
        "field",
        "configuration",
        fieldId,
      );
      break;
    case "reference_number":
    case "link":
    case "calculation":
    case "total":
      pushChange(
        reasons,
        before,
        after,
        "major",
        "storage_contract_changed",
        "field",
        "storage",
        fieldId,
      );
      break;
    case "link_to_one_of_several":
      comparePresentationSet(
        reasons,
        before.targets as unknown[],
        after.targets as unknown[],
        "field",
        fieldId,
        "constraint",
      );
      pushChange(
        reasons,
        before.onParentDelete,
        after.onParentDelete,
        "major",
        "existing_behavior_changed",
        "field",
        "behavior",
        fieldId,
      );
      break;
  }
};

const compareDateBound = (
  reasons: VersionImpactReason[],
  previous: unknown,
  candidate: unknown,
  direction: "minimum" | "maximum",
  fieldId: unknown,
  componentKind: ComponentKind = "field",
): void => {
  if (same(previous, candidate)) return;
  const widened =
    direction === "minimum"
      ? candidate === undefined ||
        (typeof previous === "string" &&
          typeof candidate === "string" &&
          Date.parse(candidate) < Date.parse(previous))
      : candidate === undefined ||
        (typeof previous === "string" &&
          typeof candidate === "string" &&
          Date.parse(candidate) > Date.parse(previous));
  reasons.push(
    makeReason(
      widened ? "minor" : "major",
      widened ? "constraint_widened" : "constraint_narrowed",
      componentKind,
      "constraint",
      fieldId,
    ),
  );
};

const compareOptions = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const before = asRecord(previous.settings).options as RecordValue[];
  const after = asRecord(candidate.settings).options as RecordValue[];
  compareKeyed(
    reasons,
    before,
    after,
    "value",
    "field",
    (left, right) => (
      pushChange(
        reasons,
        left.label,
        right.label,
        "patch",
        "presentation_changed",
        "field",
        "name",
        candidate.fieldId,
      ),
      pushChange(
        reasons,
        left.requiredPermissionId,
        right.requiredPermissionId,
        "major",
        "permission_changed",
        "field",
        "permission",
        candidate.fieldId,
      )
    ),
    () => "minor",
    () => candidate.fieldId,
  );
  const beforeOrder = before.map((option) => option.value);
  const afterOrder = after.map((option) => option.value);
  if (
    same([...beforeOrder].sort(compareUnknownText), [...afterOrder].sort(compareUnknownText)) &&
    !same(beforeOrder, afterOrder)
  )
    reasons.push(makeReason("patch", "presentation_changed", "field", "order", candidate.fieldId));
};

const compareTableSettings = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const before = asRecord(previous.settings);
  const after = asRecord(candidate.settings);
  compareBound(
    reasons,
    before.minimumRows,
    after.minimumRows,
    "minimum",
    "field",
    candidate.fieldId,
  );
  compareBound(
    reasons,
    before.maximumRows,
    after.maximumRows,
    "maximum",
    "field",
    candidate.fieldId,
  );
  compareKeyed(
    reasons,
    before.columns as RecordValue[],
    after.columns as RecordValue[],
    "key",
    "field",
    (left, right) => {
      if (left.settings === undefined || right.settings === undefined) {
        pushChange(
          reasons,
          left,
          right,
          "major",
          "existing_behavior_changed",
          "field",
          "constraint",
          candidate.fieldId,
        );
        return;
      }
      if (left.required !== right.required)
        reasons.push(
          makeReason(
            right.required === true ? "major" : "minor",
            right.required === true ? "constraint_narrowed" : "constraint_widened",
            "field",
            "required",
            candidate.fieldId,
          ),
        );
      compareFieldSettings(
        reasons,
        { ...left, fieldId: candidate.fieldId },
        { ...right, fieldId: candidate.fieldId },
      );
    },
    (item) => (item.required === true ? "major" : "minor"),
    () => candidate.fieldId,
  );
  const beforeOrder = (before.columns as RecordValue[]).map((column) => column.key);
  const afterOrder = (after.columns as RecordValue[]).map((column) => column.key);
  if (
    same([...beforeOrder].sort(compareUnknownText), [...afterOrder].sort(compareUnknownText)) &&
    !same(beforeOrder, afterOrder)
  )
    reasons.push(makeReason("patch", "presentation_changed", "field", "order", candidate.fieldId));
};

const compareField = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.fieldId;
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "field",
    "key",
    id,
  );
  for (const key of ["label", "helpText", "searchPriority"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "patch",
      key === "helpText" ? "definition_text_changed" : "presentation_changed",
      "field",
      key === "helpText" ? "description" : "name",
      id,
    );
  if (previous.required !== candidate.required)
    reasons.push(
      makeReason(
        candidate.required === true ? "major" : "minor",
        candidate.required === true ? "constraint_narrowed" : "constraint_widened",
        "field",
        "required",
        id,
      ),
    );
  for (const [key, wideningValue] of [
    ["unique", false],
    ["filterable", true],
    ["sortable", true],
  ] as const)
    if (previous[key] !== candidate[key]) {
      const widened = candidate[key] === wideningValue;
      reasons.push(
        makeReason(
          widened ? "minor" : "major",
          widened ? "constraint_widened" : "constraint_narrowed",
          "field",
          "constraint",
          id,
        ),
      );
    }
  for (const key of ["default", "personalData", "publicDisplay"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "publicDisplay" ? "public_contract_changed" : "existing_behavior_changed",
      "field",
      key === "publicDisplay" ? "visibility" : "behavior",
      id,
    );
  compareFieldSettings(reasons, previous, candidate);
};

export const compareAction = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.actionId;
  const normalizedPermissions = (action: RecordValue): string[] =>
    (action.permissionKeys === undefined
      ? [String(action.permissionKey)]
      : (action.permissionKeys as unknown[]).map(String)
    ).sort(compareCanonicalStrings);
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "action",
    "key",
    id,
  );
  pushChange(
    reasons,
    previous.label,
    candidate.label,
    "patch",
    "presentation_changed",
    "action",
    "name",
    id,
  );
  pushChange(
    reasons,
    normalizedPermissions(previous),
    normalizedPermissions(candidate),
    "major",
    "permission_changed",
    "action",
    "permission",
    id,
  );
  for (const key of [
    "subjectRecordTypeId",
    "sharing",
    "precondition",
    "tasks",
    "setsChoiceFieldId",
    "setsChoiceOption",
  ])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "sharing" ? "permission_changed" : "existing_behavior_changed",
      "action",
      key === "sharing" ? "permission" : "behavior",
      id,
    );
  compareKeyed(
    reasons,
    previous.inputs as RecordValue[],
    candidate.inputs as RecordValue[],
    "key",
    "action_input",
    (left, right) => compareActionInput(reasons, id, left, right),
    (item) => (item.required === true ? "major" : "minor"),
    () => id,
  );
  const previousOrder = (previous.inputs as RecordValue[]).map((input) => input.key);
  const candidateOrder = (candidate.inputs as RecordValue[]).map((input) => input.key);
  if (same(sorted(previousOrder), sorted(candidateOrder)) && !same(previousOrder, candidateOrder))
    reasons.push(makeReason("patch", "presentation_changed", "action", "order", id));
};

const compareActionInput = (
  reasons: VersionImpactReason[],
  actionId: unknown,
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  pushChange(
    reasons,
    previous.label,
    candidate.label,
    "patch",
    "presentation_changed",
    "action_input",
    "name",
    actionId,
  );
  if (previous.required !== candidate.required)
    reasons.push(
      makeReason(
        candidate.required === true ? "major" : "minor",
        candidate.required === true ? "constraint_narrowed" : "constraint_widened",
        "action_input",
        "required",
        actionId,
      ),
    );
  pushChange(
    reasons,
    previous.type,
    candidate.type,
    "major",
    "public_contract_changed",
    "action_input",
    "configuration",
    actionId,
  );
  if (previous.type === candidate.type && !same(previous.validation, candidate.validation)) {
    const before = asRecord(previous.validation ?? {});
    const after = asRecord(candidate.validation ?? {});
    const exact = candidate.type === "decimal_number" || candidate.type === "money";
    for (const key of ["minimumLength", "minimum"])
      compareBound(reasons, before[key], after[key], "minimum", "action_input", actionId, exact);
    for (const key of ["maximumLength", "maximum"])
      compareBound(reasons, before[key], after[key], "maximum", "action_input", actionId, exact);
    if (candidate.type === "date" || candidate.type === "date_time") {
      compareDateBound(
        reasons,
        before.earliest,
        after.earliest,
        "minimum",
        actionId,
        "action_input",
      );
      compareDateBound(reasons, before.latest, after.latest, "maximum", actionId, "action_input");
    }
    if (!same(before.choices, after.choices)) {
      const widened = after.choices === undefined;
      reasons.push(
        makeReason(
          widened ? "minor" : "major",
          widened ? "constraint_widened" : "constraint_narrowed",
          "action_input",
          "constraint",
          actionId,
        ),
      );
    }
    if (!same(before.pattern, after.pattern)) {
      const widened = after.pattern === undefined;
      reasons.push(
        makeReason(
          widened ? "minor" : "major",
          widened ? "constraint_widened" : "constraint_narrowed",
          "action_input",
          "constraint",
          actionId,
        ),
      );
    }
  }
  if (candidate.type === "record_reference" && previous.type === "record_reference")
    compareSet(
      reasons,
      previous.recordTypes as unknown[],
      candidate.recordTypes as unknown[],
      "action_input",
      actionId,
      "constraint",
    );
  if (candidate.type === "formatted_text" && previous.type === "formatted_text") {
    const before = asRecord(previous.validation ?? {});
    const after = asRecord(candidate.validation ?? {});
    comparePresentationSet(
      reasons,
      (before.allowedBlocks as unknown[]) ?? [],
      (after.allowedBlocks as unknown[]) ?? [],
      "action_input",
      actionId,
      "constraint",
    );
  }
};

const compareRecordType = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.recordTypeId;
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "record_type",
    "key",
    id,
  );
  for (const key of ["singularLabel", "pluralLabel"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "patch",
      "presentation_changed",
      "record_type",
      "name",
      id,
    );
  pushChange(
    reasons,
    previous.titleFieldId,
    candidate.titleFieldId,
    "major",
    "existing_behavior_changed",
    "record_type",
    "behavior",
    id,
  );
  for (const key of ["storageContractId", "storageScope"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      "storage_contract_changed",
      "record_type",
      "storage",
      id,
    );
  for (const key of ["ownershipMode", "ownershipRelationshipId"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      "ownership_changed",
      "record_type",
      "ownership",
      id,
    );
  compareSet(
    reasons,
    previous.standardActions as unknown[],
    candidate.standardActions as unknown[],
    "record_type",
    id,
    "behavior",
  );
  compareSet(
    reasons,
    previous.customActionIds as unknown[],
    candidate.customActionIds as unknown[],
    "record_type",
    id,
    "behavior",
  );
  compareKeyed(
    reasons,
    previous.fields as RecordValue[],
    candidate.fields as RecordValue[],
    "fieldId",
    "field",
    (left, right) => compareField(reasons, left, right),
    (item) => (item.required === true ? "major" : "minor"),
  );
  compareKeyed(
    reasons,
    previous.relationships as RecordValue[],
    candidate.relationships as RecordValue[],
    "relationshipId",
    "relationship",
    (left, right) =>
      pushChange(
        reasons,
        left,
        right,
        "major",
        "existing_behavior_changed",
        "relationship",
        "behavior",
        right.relationshipId,
      ),
  );
  // A new pipeline limits the moves a save accepts; removing one, or a transition, narrows them too.
  compareKeyed(
    reasons,
    previous.pipelines as RecordValue[],
    candidate.pipelines as RecordValue[],
    "pipelineId",
    "pipeline",
    (left, right) => comparePipeline(reasons, left, right),
    () => "major",
  );
};

const comparePipeline = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.pipelineId;
  pushChange(
    reasons,
    previous.name,
    candidate.name,
    "patch",
    "presentation_changed",
    "pipeline",
    "name",
    id,
  );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "pipeline",
    "key",
    id,
  );
  pushChange(
    reasons,
    previous.stageFieldId,
    candidate.stageFieldId,
    "major",
    "existing_behavior_changed",
    "pipeline",
    "behavior",
    id,
  );
  compareSet(
    reasons,
    previous.transitions as unknown[],
    candidate.transitions as unknown[],
    "pipeline",
    id,
    "behavior",
  );
  compareKeyed(
    reasons,
    previous.stages as RecordValue[],
    candidate.stages as RecordValue[],
    "option",
    "pipeline_stage",
    (left, right) =>
      pushChange(
        reasons,
        left.tone,
        right.tone,
        "patch",
        "presentation_changed",
        "pipeline_stage",
        "name",
        id,
      ),
    () => "minor",
    () => id,
  );
  const beforeOrder = (previous.stages as RecordValue[]).map((stage) => stage.option);
  const afterOrder = (candidate.stages as RecordValue[]).map((stage) => stage.option);
  if (
    same([...beforeOrder].sort(compareUnknownText), [...afterOrder].sort(compareUnknownText)) &&
    !same(beforeOrder, afterOrder)
  )
    reasons.push(makeReason("patch", "presentation_changed", "pipeline", "order", id));
};

export const compareSimpleComponent = (
  reasons: VersionImpactReason[],
  componentKind: ComponentKind,
  componentId: unknown,
  previous: RecordValue,
  candidate: RecordValue,
  displayKeys: readonly string[] = [],
  keyProperty = "key",
): void => {
  for (const key of displayKeys)
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "patch",
      key === "description" ? "definition_text_changed" : "presentation_changed",
      componentKind,
      key === "description" ? "description" : "name",
      componentId,
    );
  if (keyProperty in previous || keyProperty in candidate)
    pushChange(
      reasons,
      previous[keyProperty],
      candidate[keyProperty],
      "major",
      "component_key_changed",
      componentKind,
      "key",
      componentId,
    );
  const ignored = new Set([...displayKeys, keyProperty]);
  const previousBehavior = Object.fromEntries(
    Object.entries(previous).filter(([key]) => !ignored.has(key)),
  );
  const candidateBehavior = Object.fromEntries(
    Object.entries(candidate).filter(([key]) => !ignored.has(key)),
  );
  pushChange(
    reasons,
    previousBehavior,
    candidateBehavior,
    "major",
    "existing_behavior_changed",
    componentKind,
    "behavior",
    componentId,
  );
};

/**
 * A flow is compared as one component. Its description and labels are text for builders; every
 * other part of it is behaviour, so a change to any of them is a major change until the flow
 * version-impact policy classifies task by task.
 */
export const compareFlow = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const flowId = candidate.id;
  pushChange(
    reasons,
    previous.description,
    candidate.description,
    "patch",
    "definition_text_changed",
    "flow",
    "description",
    flowId,
  );
  pushChange(
    reasons,
    previous.labels,
    candidate.labels,
    "patch",
    "presentation_changed",
    "flow",
    "configuration",
    flowId,
  );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "flow",
    "key",
    flowId,
  );
  for (const key of [
    "namespace",
    "execution",
    "runAs",
    "invocationPermissionId",
    "recordInput",
    "inputs",
    "variables",
    "triggers",
    "outputs",
    "retry",
    "timeout",
    "concurrency",
  ] as const)
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      "existing_behavior_changed",
      "flow",
      "behavior",
      flowId,
    );
  // Rewording what a flow tells the person (a message's text, title or tone) is presentation;
  // any other change to its steps changes what it does.
  for (const key of ["tasks", "errors", "finally"] as const) {
    if (canonicalJson(previous[key] ?? null) === canonicalJson(candidate[key] ?? null)) continue;
    const reworded =
      canonicalJson(withoutMessageWording(previous[key] ?? null)) ===
      canonicalJson(withoutMessageWording(candidate[key] ?? null));
    reasons.push(
      reworded
        ? makeReason("patch", "presentation_changed", "flow", "configuration", flowId)
        : makeReason("major", "existing_behavior_changed", "flow", "behavior", flowId),
    );
  }
};

/** A flow's steps with every message's wording blanked, to tell rewording from other changes. */
const withoutMessageWording = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutMessageWording);
  if (typeof value !== "object" || value === null) return value;
  const node = value as Record<string, unknown>;
  const copied = Object.fromEntries(
    Object.entries(node).map(([key, child]) => [key, withoutMessageWording(child)]),
  );
  if (node.type === "interface.show_message" && typeof copied.properties === "object")
    copied.properties = Object.fromEntries(
      Object.entries(copied.properties as Record<string, unknown>).filter(
        ([key]) => key !== "message" && key !== "title",
      ),
    );
  return copied;
};

export const compareModuleContents = (
  previousContent: ModuleContent,
  candidateContent: ModuleContent,
): VersionImpactReason[] => {
  const reasons: VersionImpactReason[] = [];
  const previous = asRecord(previousContent);
  const candidate = asRecord(candidateContent);
  pushChange(
    reasons,
    previous.name,
    candidate.name,
    "patch",
    "definition_text_changed",
    "module",
    "name",
  );
  pushChange(
    reasons,
    previous.description,
    candidate.description,
    "patch",
    "definition_text_changed",
    "module",
    "description",
  );
  pushChange(
    reasons,
    previous.ownerApplication,
    candidate.ownerApplication,
    "major",
    "component_key_changed",
    "module",
    "key",
  );
  compareKeyed(
    reasons,
    previous.dependencies as RecordValue[],
    candidate.dependencies as RecordValue[],
    "moduleRootId",
    "dependency",
    (left, right) =>
      pushChange(
        reasons,
        left,
        right,
        "major",
        "dependency_requirement_changed",
        "dependency",
        "version_requirement",
        right.moduleRootId,
      ),
    () => "major",
  );
  compareKeyed(
    reasons,
    previous.recordTypes as RecordValue[],
    candidate.recordTypes as RecordValue[],
    "recordTypeId",
    "record_type",
    (left, right) => compareRecordType(reasons, left, right),
  );
  const fieldIds = (content: RecordValue): Set<string> =>
    new Set(
      (content.recordTypes as RecordValue[]).flatMap((record) =>
        (record.fields as RecordValue[]).map((field) => String(field.fieldId)),
      ),
    );
  const previousFieldIds = fieldIds(previous);
  // The fields this release adds: only they may join a permission or a query additively.
  const addedFieldIds = new Set(
    [...fieldIds(candidate)].filter((fieldId) => !previousFieldIds.has(fieldId)),
  );
  comparePermissions(
    reasons,
    previous.permissions as RecordValue[],
    candidate.permissions as RecordValue[],
    addedFieldIds,
  );
  compareKeyed(
    reasons,
    previous.actions as RecordValue[],
    candidate.actions as RecordValue[],
    "actionId",
    "action",
    (left, right) => compareAction(reasons, left, right),
  );
  compareKeyed(
    reasons,
    previous.events as RecordValue[],
    candidate.events as RecordValue[],
    "eventId",
    "event",
    (left, right) => compareEvent(reasons, left, right),
  );
  compareKeyed(
    reasons,
    previous.flows as RecordValue[],
    candidate.flows as RecordValue[],
    "id",
    "flow",
    (left, right) => compareFlow(reasons, left, right),
  );
  const previousFlows = previous.flows as RecordValue[];
  const candidateFlows = candidate.flows as RecordValue[];
  const commonFlowIds = new Set(
    previousFlows
      .filter((flow) => candidateFlows.some((next) => next.id === flow.id))
      .map((flow) => flow.id),
  );
  pushChange(
    reasons,
    previousFlows.filter((flow) => commonFlowIds.has(flow.id)).map((flow) => flow.id),
    candidateFlows.filter((flow) => commonFlowIds.has(flow.id)).map((flow) => flow.id),
    "major",
    "existing_behavior_changed",
    "flow",
    "behavior",
    undefined,
  );
  compareKeyed(
    reasons,
    previous.sharingConditions as RecordValue[],
    candidate.sharingConditions as RecordValue[],
    "conditionId",
    "sharing_condition",
    (left, right) => compareSharingCondition(reasons, left, right),
  );
  compareKeyed(
    reasons,
    previous.extensionPoints as RecordValue[],
    candidate.extensionPoints as RecordValue[],
    "extensionPointId",
    "extension_point",
    (left, right) => compareExtensionPoint(reasons, left, right),
  );
  compareKeyed(
    reasons,
    (previous.queries as RecordValue[] | undefined) ?? [],
    (candidate.queries as RecordValue[] | undefined) ?? [],
    "queryId",
    "query",
    // Label and description are presentation, and the selected fields are an ordered list of
    // entries: appending a field added in this same release, or reordering, is minor; appending a
    // field that already existed exposes it to every consumer, so it is major. Exposing a private
    // query offers it to the Applications that use the Module: minor; making an exposed query
    // private takes it from them: major. Every other declared part of a published query changes
    // what consumers receive: major.
    (left, right) => {
      const { selectedFieldIds: leftSelected, exposure: leftExposure, ...leftRest } = left;
      const { selectedFieldIds: rightSelected, exposure: rightExposure, ...rightRest } = right;
      pushChange(
        reasons,
        leftExposure,
        rightExposure,
        rightExposure === "exposed" ? "minor" : "major",
        rightExposure === "exposed" ? "component_added" : "existing_behavior_changed",
        "query",
        "behavior",
        right.queryId,
      );
      compareSimpleComponent(reasons, "query", right.queryId, leftRest, rightRest, [
        "label",
        "description",
      ]);
      compareOrderedEntries(
        reasons,
        (leftSelected as unknown[] | undefined) ?? [],
        (rightSelected as unknown[] | undefined) ?? [],
        "query",
        right.queryId,
        "behavior",
        (fieldId) => addedFieldIds.has(String(fieldId)),
      );
    },
  );
  compareKeyed(
    reasons,
    (previous.contributions as RecordValue[] | undefined) ?? [],
    (candidate.contributions as RecordValue[] | undefined) ?? [],
    "contributionId",
    "extension_point",
    (left, right) => compareContribution(reasons, left, right),
  );
  return finaliseReasons(reasons);
};

const compareExtensionPoint = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.extensionPointId;
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "extension_point",
    "key",
    id,
  );
  pushChange(
    reasons,
    previous.recordTypeId,
    candidate.recordTypeId,
    "major",
    "existing_behavior_changed",
    "extension_point",
    "behavior",
    id,
  );
  compareSet(
    reasons,
    previous.accepts as unknown[],
    candidate.accepts as unknown[],
    "extension_point",
    id,
    "behavior",
  );
};

/**
 * One contribution declares that a Module-owned field or action joins a dependency's extension
 * point. Adding a contribution is additive, while retargeting an installed one changes what a
 * consumer receives, so every changed declared part is a major change. The target is compared by
 * its module identity only: a changed version requirement on the same dependency entry is already
 * classified once as a dependency change.
 */
const compareContribution = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.contributionId;
  pushChange(
    reasons,
    asRecord(previous.targetModule).moduleRootId,
    asRecord(candidate.targetModule).moduleRootId,
    "major",
    "public_contract_changed",
    "extension_point",
    "behavior",
    id,
  );
  for (const key of ["targetExtensionPointId", "kind", "recordTypeId", "fieldId", "actionId"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "targetExtensionPointId" || key === "kind"
        ? "existing_behavior_changed"
        : "public_contract_changed",
      "extension_point",
      "behavior",
      id,
    );
};

export const compareEvent = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.eventId;
  pushChange(
    reasons,
    previous.label,
    candidate.label,
    "patch",
    "presentation_changed",
    "event",
    "name",
    id,
  );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "event",
    "key",
    id,
  );
  pushChange(
    reasons,
    previous.recordTypeId,
    candidate.recordTypeId,
    "major",
    "public_contract_changed",
    "event",
    "behavior",
    id,
  );
  compareSet(
    reasons,
    previous.carriedFieldIds as unknown[],
    candidate.carriedFieldIds as unknown[],
    "event",
    id,
    "behavior",
  );
};
