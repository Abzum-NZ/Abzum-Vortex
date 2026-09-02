import type {
  ApplicationContent,
  ModuleContent,
  VersionImpact,
  VersionImpactReason,
} from "@vortex/contracts";
import {
  versionImpactComponentKinds,
  versionImpactProperties,
  versionImpactReasonCodes,
} from "@vortex/contracts";
import { canonicalJson } from "./canonical-json";
import { refuseVersionImpact } from "./version-impact-error";

type RecordValue = Record<string, unknown>;
type ComponentKind = VersionImpactReason["location"]["componentKind"];
type Property = VersionImpactReason["location"]["property"];
type ReasonCode = VersionImpactReason["code"];

const impactRank = { patch: 0, minor: 1, major: 2 } as const;
const componentKindRank = new Map(
  versionImpactComponentKinds.map((value, index) => [value, index]),
);
const propertyRank = new Map(versionImpactProperties.map((value, index) => [value, index]));
const reasonCodeRank = new Map(versionImpactReasonCodes.map((value, index) => [value, index]));
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const asRecord = (value: unknown): RecordValue => value as RecordValue;
const same = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
};
const asComponentId = (
  value: unknown,
): VersionImpactReason["location"]["componentId"] | undefined =>
  typeof value === "string" ? (value as VersionImpactReason["location"]["componentId"]) : undefined;

const makeReason = (
  impact: VersionImpact,
  code: ReasonCode,
  componentKind: ComponentKind,
  property: Property,
  componentId?: unknown,
): VersionImpactReason => ({
  impact,
  code,
  location: {
    componentKind,
    property,
    ...(asComponentId(componentId) === undefined
      ? {}
      : { componentId: asComponentId(componentId)! }),
  },
});

const pushChange = (
  reasons: VersionImpactReason[],
  previous: unknown,
  candidate: unknown,
  impact: VersionImpact,
  code: ReasonCode,
  componentKind: ComponentKind,
  property: Property,
  componentId?: unknown,
): void => {
  if (!same(previous, candidate))
    reasons.push(makeReason(impact, code, componentKind, property, componentId));
};

const setDifference = (left: unknown[], right: unknown[]): unknown[] => {
  const rightKeys = new Set(right.map(canonicalJson));
  return left.filter((entry) => !rightKeys.has(canonicalJson(entry)));
};

const compareSet = (
  reasons: VersionImpactReason[],
  previous: unknown[],
  candidate: unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
  addImpact: VersionImpact = "minor",
  removeImpact: VersionImpact = "major",
): void => {
  if (setDifference(candidate, previous).length > 0)
    reasons.push(
      makeReason(
        addImpact,
        addImpact === "minor" ? "component_added" : "existing_behavior_changed",
        componentKind,
        property,
        componentId,
      ),
    );
  if (setDifference(previous, candidate).length > 0)
    reasons.push(
      makeReason(
        removeImpact,
        removeImpact === "major" ? "component_removed" : "constraint_widened",
        componentKind,
        property,
        componentId,
      ),
    );
};

const comparePresentationSet = (
  reasons: VersionImpactReason[],
  previous: unknown[],
  candidate: unknown[],
  componentKind: ComponentKind,
  componentId: unknown,
  property: Property,
): void => {
  compareSet(reasons, previous, candidate, componentKind, componentId, property);
  if (
    setDifference(previous, candidate).length === 0 &&
    setDifference(candidate, previous).length === 0 &&
    !same(previous, candidate)
  )
    reasons.push(makeReason("patch", "presentation_changed", componentKind, "order", componentId));
};

const compareBound = (
  reasons: VersionImpactReason[],
  previous: unknown,
  candidate: unknown,
  direction: "minimum" | "maximum",
  componentKind: ComponentKind,
  componentId: unknown,
): void => {
  if (same(previous, candidate)) return;
  const previousNumber = typeof previous === "number" ? previous : undefined;
  const candidateNumber = typeof candidate === "number" ? candidate : undefined;
  const widened =
    direction === "minimum"
      ? candidateNumber === undefined ||
        (previousNumber !== undefined && candidateNumber < previousNumber)
      : candidateNumber === undefined ||
        (previousNumber !== undefined && candidateNumber > previousNumber);
  reasons.push(
    makeReason(
      widened ? "minor" : "major",
      widened ? "constraint_widened" : "constraint_narrowed",
      componentKind,
      "constraint",
      componentId,
    ),
  );
};

const compareKeyed = (
  reasons: VersionImpactReason[],
  previous: RecordValue[],
  candidate: RecordValue[],
  identity: string,
  componentKind: ComponentKind,
  compareExisting: (previousItem: RecordValue, candidateItem: RecordValue) => void,
  additionImpact: (item: RecordValue) => VersionImpact = () => "minor",
  locationId: (item: RecordValue) => unknown = (item) => item[identity],
): void => {
  const previousById = new Map(previous.map((item) => [String(item[identity]), item]));
  const candidateById = new Map(candidate.map((item) => [String(item[identity]), item]));
  for (const [key, item] of candidateById)
    if (!previousById.has(key)) {
      const impact = additionImpact(item);
      reasons.push(
        makeReason(
          impact,
          impact === "major" ? "required_component_added" : "component_added",
          componentKind,
          "definition",
          locationId(item),
        ),
      );
    }
  for (const [key, item] of previousById)
    if (!candidateById.has(key))
      reasons.push(
        makeReason("major", "component_removed", componentKind, "definition", locationId(item)),
      );
  for (const [key, previousItem] of previousById) {
    const candidateItem = candidateById.get(key);
    if (candidateItem) compareExisting(previousItem, candidateItem);
  }
};

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
      compareBound(reasons, before.minimum, after.minimum, "minimum", "field", fieldId);
      compareBound(reasons, before.maximum, after.maximum, "maximum", "field", fieldId);
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
      compareBound(reasons, before.minimum, after.minimum, "minimum", "field", fieldId);
      compareBound(reasons, before.maximum, after.maximum, "maximum", "field", fieldId);
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
    case "link_to_person":
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
    (left, right) =>
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
    () => "minor",
    () => candidate.fieldId,
  );
  const beforeOrder = before.map((option) => option.value);
  const afterOrder = after.map((option) => option.value);
  if (same([...beforeOrder].sort(), [...afterOrder].sort()) && !same(beforeOrder, afterOrder))
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
    (left, right) =>
      pushChange(
        reasons,
        left,
        right,
        "major",
        "storage_contract_changed",
        "field",
        "storage",
        candidate.fieldId,
      ),
    (item) => (item.required === true ? "major" : "minor"),
    () => candidate.fieldId,
  );
  const beforeOrder = (before.columns as RecordValue[]).map((column) => column.key);
  const afterOrder = (after.columns as RecordValue[]).map((column) => column.key);
  if (same([...beforeOrder].sort(), [...afterOrder].sort()) && !same(beforeOrder, afterOrder))
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

const compareAction = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.actionId;
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
  for (const key of ["subjectRecordTypeId", "permissionKey", "sharing", "precondition", "effects"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "permissionKey" || key === "sharing"
        ? "permission_changed"
        : "existing_behavior_changed",
      "action",
      key === "permissionKey" || key === "sharing" ? "permission" : "behavior",
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
    for (const key of ["minimumLength", "minimum"])
      compareBound(reasons, before[key], after[key], "minimum", "action_input", actionId);
    for (const key of ["maximumLength", "maximum"])
      compareBound(reasons, before[key], after[key], "maximum", "action_input", actionId);
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
};

const compareSimpleComponent = (
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
  comparePermissions(
    reasons,
    previous.permissions as RecordValue[],
    candidate.permissions as RecordValue[],
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
    previous.rules as RecordValue[],
    candidate.rules as RecordValue[],
    "ruleId",
    "rule",
    (left, right) => compareSimpleComponent(reasons, "rule", right.ruleId, left, right),
    () => "major",
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

const compareEvent = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.eventId;
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

const compareSharingCondition = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.conditionId;
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "sharing_condition",
    "key",
    id,
  );
  for (const key of [
    "sourceRecordTypeId",
    "publishedRevision",
    "contractFingerprint",
    "parameters",
    "condition",
    "declaredFieldIds",
  ])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      "public_contract_changed",
      "sharing_condition",
      "behavior",
      id,
    );
  const previousTests = previous.publicationTests as RecordValue[];
  const candidateTests = candidate.publicationTests as RecordValue[];
  const testSemantics = (tests: RecordValue[]) =>
    sorted(
      tests.map((test) => ({
        parameters: test.parameters,
        fieldValues: test.fieldValues,
        expected: test.expected,
      })),
    );
  if (!same(testSemantics(previousTests), testSemantics(candidateTests)))
    reasons.push(
      makeReason("major", "existing_behavior_changed", "sharing_condition", "behavior", id),
    );
  else
    pushChange(
      reasons,
      previousTests,
      candidateTests,
      "patch",
      "definition_text_changed",
      "sharing_condition",
      "configuration",
      id,
    );
};

export const compareApplicationContents = (
  previousContent: ApplicationContent,
  candidateContent: ApplicationContent,
): VersionImpactReason[] => {
  const reasons: VersionImpactReason[] = [];
  const previous = asRecord(previousContent);
  const candidate = asRecord(candidateContent);
  for (const key of ["name", "description", "icon"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "patch",
      key === "icon" ? "presentation_changed" : "definition_text_changed",
      "application",
      key === "description" ? "description" : "name",
    );
  compareKeyed(
    reasons,
    previous.moduleBindings as RecordValue[],
    candidate.moduleBindings as RecordValue[],
    "moduleRootId",
    "module_binding",
    (left, right) =>
      compareSimpleComponent(
        reasons,
        "module_binding",
        right.moduleRootId,
        left,
        right,
        [],
        "purpose",
      ),
    () => "major",
  );
  compareNavigation(
    reasons,
    previous.navigation as RecordValue[],
    candidate.navigation as RecordValue[],
  );
  compareKeyed(
    reasons,
    previous.pages as RecordValue[],
    candidate.pages as RecordValue[],
    "pageId",
    "page",
    (left, right) => comparePage(reasons, left, right),
    (item) =>
      item.type === "public" || item.standardPageReplacement !== undefined ? "major" : "minor",
  );
  compareKeyed(
    reasons,
    previous.roles as RecordValue[],
    candidate.roles as RecordValue[],
    "roleId",
    "role",
    (left, right) => compareRole(reasons, left, right),
  );
  comparePermissions(
    reasons,
    previous.permissions as RecordValue[],
    candidate.permissions as RecordValue[],
  );
  compareKeyed(
    reasons,
    previous.queries as RecordValue[],
    candidate.queries as RecordValue[],
    "queryId",
    "query",
    (left, right) => compareSimpleComponent(reasons, "query", right.queryId, left, right),
  );
  compareKeyed(
    reasons,
    previous.blockRegistrations as RecordValue[],
    candidate.blockRegistrations as RecordValue[],
    "blockId",
    "block_registration",
    (left, right) =>
      compareSimpleComponent(reasons, "block_registration", right.blockId, left, right, [
        "name",
        "icon",
        "paletteGroup",
      ]),
  );
  compareKeyed(
    reasons,
    previous.pipelines as RecordValue[],
    candidate.pipelines as RecordValue[],
    "pipelineId",
    "pipeline",
    (left, right) => comparePipeline(reasons, left, right),
    () => "major",
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
    previous.rules as RecordValue[],
    candidate.rules as RecordValue[],
    "ruleId",
    "rule",
    (left, right) => compareSimpleComponent(reasons, "rule", right.ruleId, left, right),
    () => "major",
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
    previous.workflows as RecordValue[],
    candidate.workflows as RecordValue[],
    "workflowId",
    "workflow",
    (left, right) => compareWorkflow(reasons, left, right),
    () => "major",
  );
  compareKeyed(
    reasons,
    previous.connectionBindings as RecordValue[],
    candidate.connectionBindings as RecordValue[],
    "bindingId",
    "connection_binding",
    (left, right) =>
      compareSimpleComponent(reasons, "connection_binding", right.bindingId, left, right),
    () => "major",
  );
  compareKeyed(
    reasons,
    previous.interfaces as RecordValue[],
    candidate.interfaces as RecordValue[],
    "interfaceId",
    "interface",
    (left, right) => compareInterface(reasons, left, right),
    (definition) =>
      (definition.operations as RecordValue[]).every(isPrivateInterfaceOperation)
        ? "minor"
        : "major",
  );
  compareKeyed(
    reasons,
    previous.publicAddresses as RecordValue[],
    candidate.publicAddresses as RecordValue[],
    "addressId",
    "public_address",
    (left, right) =>
      compareSimpleComponent(reasons, "public_address", right.addressId, left, right),
    () => "major",
  );
  pushChange(
    reasons,
    previous.theme,
    candidate.theme,
    "patch",
    "presentation_changed",
    "theme",
    "theme",
  );
  pushChange(
    reasons,
    previous.homePageId,
    candidate.homePageId,
    "patch",
    "presentation_changed",
    "application",
    "configuration",
  );
  return finaliseReasons(reasons);
};

const flattenNavigation = (items: RecordValue[]): RecordValue[] =>
  items.flatMap((item) => [
    item,
    ...flattenNavigation((item.children as RecordValue[] | undefined) ?? []),
  ]);

const navigationParents = (
  items: RecordValue[],
  parentId = "root",
  result = new Map<string, { parentId: string; order: number }>(),
): Map<string, { parentId: string; order: number }> => {
  items.forEach((item, order) => {
    result.set(String(item.id), { parentId, order });
    navigationParents((item.children as RecordValue[] | undefined) ?? [], String(item.id), result);
  });
  return result;
};

const compareNavigation = (
  reasons: VersionImpactReason[],
  previousItems: RecordValue[],
  candidateItems: RecordValue[],
): void => {
  const previous = flattenNavigation(previousItems);
  const candidate = flattenNavigation(candidateItems);
  compareKeyed(reasons, previous, candidate, "id", "navigation_item", (left, right) => {
    const id = right.id;
    pushChange(
      reasons,
      left.label,
      right.label,
      "patch",
      "presentation_changed",
      "navigation_item",
      "name",
      id,
    );
    for (const key of ["type", "pageId", "address", "permissionKey"])
      pushChange(
        reasons,
        left[key],
        right[key],
        "major",
        key === "permissionKey" ? "permission_changed" : "existing_behavior_changed",
        "navigation_item",
        key === "permissionKey" ? "permission" : "behavior",
        id,
      );
  });
  const previousPositions = navigationParents(previousItems);
  const candidatePositions = navigationParents(candidateItems);
  for (const [id, previousPosition] of previousPositions) {
    const candidatePosition = candidatePositions.get(id);
    if (!candidatePosition) continue;
    if (candidatePosition.parentId !== previousPosition.parentId)
      reasons.push(
        makeReason("major", "existing_behavior_changed", "navigation_item", "behavior", id),
      );
    else if (candidatePosition.order !== previousPosition.order)
      reasons.push(makeReason("patch", "presentation_changed", "navigation_item", "order", id));
  }
};

const pageBlocks = (page: RecordValue): RecordValue[] => {
  if (Array.isArray(page.blocks)) return page.blocks as RecordValue[];
  if (Array.isArray(page.steps))
    return (page.steps as RecordValue[]).flatMap((step) => step.blocks as RecordValue[]);
  return [];
};

const comparePage = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.pageId;
  for (const key of ["name"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "patch",
      "presentation_changed",
      "page",
      "name",
      id,
    );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "page",
    "key",
    id,
  );
  for (const key of [
    "type",
    "accessPermissionKey",
    "recordType",
    "queryId",
    "commitActionKey",
    "publicFieldIds",
    "publicActionKey",
    "rateLimitPerMinute",
    "calendarMapping",
    "standardPageReplacement",
  ])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "accessPermissionKey" || key === "publicFieldIds" || key === "publicActionKey"
        ? "permission_changed"
        : "existing_behavior_changed",
      "page",
      key === "accessPermissionKey" ? "permission" : "behavior",
      id,
    );
  for (const key of ["states", "arrangements"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "patch",
      "presentation_changed",
      "page",
      "configuration",
      id,
    );
  comparePageLayout(reasons, id, previous.layout, candidate.layout);
  compareKeyed(
    reasons,
    pageBlocks(previous),
    pageBlocks(candidate),
    "placementId",
    "page_block",
    (left, right) => comparePageBlock(reasons, left, right),
    () => (candidate.type === "guided_form" ? "major" : "minor"),
  );
  if (Array.isArray(previous.steps) || Array.isArray(candidate.steps)) {
    const before = (previous.steps as RecordValue[] | undefined) ?? [];
    const after = (candidate.steps as RecordValue[] | undefined) ?? [];
    const beforeIds = before.map((step) => step.id);
    const afterIds = after.map((step) => step.id);
    if (!same([...beforeIds].sort(), [...afterIds].sort()))
      reasons.push(makeReason("major", "existing_behavior_changed", "page", "behavior", id));
    else if (!same(beforeIds, afterIds))
      reasons.push(makeReason("patch", "presentation_changed", "page", "order", id));
    for (const step of after) {
      const old = before.find((entry) => entry.id === step.id);
      if (old)
        pushChange(
          reasons,
          old.summary,
          step.summary,
          "major",
          "existing_behavior_changed",
          "page",
          "behavior",
          id,
        );
      if (old)
        pushChange(
          reasons,
          old.name,
          step.name,
          "patch",
          "presentation_changed",
          "page",
          "name",
          id,
        );
    }
  }
};

const comparePageLayout = (
  reasons: VersionImpactReason[],
  pageId: unknown,
  previous: unknown,
  candidate: unknown,
): void => {
  const before = asRecord(previous);
  const after = asRecord(candidate);
  for (const device of ["desktop", "phone"] as const) {
    const beforeDevice = asRecord(before[device]);
    const afterDevice = asRecord(after[device]);
    if (!same(beforeDevice.componentOrder, afterDevice.componentOrder))
      reasons.push(makeReason("patch", "presentation_changed", "page", "order", pageId));
    const beforePresentation = { ...beforeDevice };
    const afterPresentation = { ...afterDevice };
    delete beforePresentation.componentOrder;
    delete afterPresentation.componentOrder;
    pushChange(
      reasons,
      beforePresentation,
      afterPresentation,
      "patch",
      "presentation_changed",
      "page",
      "configuration",
      pageId,
    );
  }
};

const comparePageBlock = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.placementId;
  pushChange(
    reasons,
    previous.desktop,
    candidate.desktop,
    "patch",
    "presentation_changed",
    "page_block",
    "configuration",
    id,
  );
  const previousPhone = asRecord(previous.phone);
  const candidatePhone = asRecord(candidate.phone);
  if (
    previousPhone.behaviour !== candidatePhone.behaviour &&
    (previousPhone.behaviour === "hide" || candidatePhone.behaviour === "hide")
  )
    reasons.push(makeReason("major", "permission_changed", "page_block", "visibility", id));
  else
    pushChange(
      reasons,
      previous.phone,
      candidate.phone,
      "patch",
      "presentation_changed",
      "page_block",
      "configuration",
      id,
    );
  const ignored = new Set(["placementId", "desktop", "phone"]);
  const before = Object.fromEntries(Object.entries(previous).filter(([key]) => !ignored.has(key)));
  const after = Object.fromEntries(Object.entries(candidate).filter(([key]) => !ignored.has(key)));
  pushChange(
    reasons,
    before,
    after,
    "major",
    "existing_behavior_changed",
    "page_block",
    "behavior",
    id,
  );
};

const compareRole = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.roleId;
  pushChange(
    reasons,
    previous.name,
    candidate.name,
    "patch",
    "presentation_changed",
    "role",
    "name",
    id,
  );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "role",
    "key",
    id,
  );
  pushChange(
    reasons,
    previous.homePageId,
    candidate.homePageId,
    "major",
    "existing_behavior_changed",
    "role",
    "behavior",
    id,
  );
  pushChange(
    reasons,
    previous.permissionKeys,
    candidate.permissionKeys,
    "major",
    "permission_changed",
    "role",
    "permission",
    id,
  );
};

const comparePermissions = (
  reasons: VersionImpactReason[],
  previous: RecordValue[],
  candidate: RecordValue[],
): void => {
  compareKeyed(reasons, previous, candidate, "permissionId", "permission", (left, right) => {
    const id = right.permissionId;
    for (const key of ["label", "description"])
      pushChange(
        reasons,
        left[key],
        right[key],
        "patch",
        key === "description" ? "definition_text_changed" : "presentation_changed",
        "permission",
        key === "description" ? "description" : "name",
        id,
      );
    pushChange(
      reasons,
      left.key,
      right.key,
      "major",
      "component_key_changed",
      "permission",
      "key",
      id,
    );
    for (const key of ["recordTypeId", "actionKind", "namedAction", "administrative"])
      pushChange(
        reasons,
        left[key],
        right[key],
        "major",
        "permission_changed",
        "permission",
        "permission",
        id,
      );
  });
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
  for (const key of ["recordType", "stageFieldId", "transitions", "timeTargets"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      "existing_behavior_changed",
      "pipeline",
      "behavior",
      id,
    );
  compareKeyed(
    reasons,
    previous.stages as RecordValue[],
    candidate.stages as RecordValue[],
    "key",
    "pipeline_stage",
    (left, right) => compareSimpleComponent(reasons, "pipeline_stage", id, left, right, ["label"]),
    () => "major",
    () => id,
  );
  const beforeOrder = (previous.stages as RecordValue[]).map((stage) => stage.key);
  const afterOrder = (candidate.stages as RecordValue[]).map((stage) => stage.key);
  if (same([...beforeOrder].sort(), [...afterOrder].sort()) && !same(beforeOrder, afterOrder))
    reasons.push(makeReason("patch", "presentation_changed", "pipeline", "order", id));
};

const compareWorkflow = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.workflowId;
  pushChange(
    reasons,
    previous.name,
    candidate.name,
    "patch",
    "presentation_changed",
    "workflow",
    "name",
    id,
  );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "workflow",
    "key",
    id,
  );
  for (const key of ["trigger", "runAs", "edges", "maximumNestingDepth"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      "existing_behavior_changed",
      "workflow",
      "behavior",
      id,
    );
  compareKeyed(
    reasons,
    previous.nodes as RecordValue[],
    candidate.nodes as RecordValue[],
    "nodeId",
    "workflow_node",
    (left, right) => compareSimpleComponent(reasons, "workflow_node", right.nodeId, left, right),
  );
};

const compareInterface = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.interfaceId;
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "interface",
    "key",
    id,
  );
  pushChange(
    reasons,
    previous.version,
    candidate.version,
    "patch",
    "definition_text_changed",
    "interface",
    "configuration",
    id,
  );
  if (previous.state !== candidate.state)
    reasons.push(
      makeReason(
        previous.state === "supported" && candidate.state === "deprecated" ? "patch" : "major",
        previous.state === "supported" && candidate.state === "deprecated"
          ? "definition_text_changed"
          : "public_contract_changed",
        "interface",
        previous.state === "supported" && candidate.state === "deprecated"
          ? "configuration"
          : "visibility",
        id,
      ),
    );
  compareKeyed(
    reasons,
    previous.operations as RecordValue[],
    candidate.operations as RecordValue[],
    "operationId",
    "interface",
    (left, right) => compareInterfaceOperation(reasons, id, left, right),
    (operation) => (isPrivateInterfaceOperation(operation) ? "minor" : "major"),
    () => id,
  );
};

const isPrivateInterfaceOperation = (operation: RecordValue): boolean =>
  operation.visibility === "organization_private" &&
  operation.authentication === "organization_token";

const compareStringShape = (
  reasons: VersionImpactReason[],
  interfaceId: unknown,
  previous: unknown,
  candidate: unknown,
): void => {
  const before = asRecord(previous);
  const after = asRecord(candidate);
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (afterKeys.some((key) => !(key in before)))
    reasons.push(
      makeReason("minor", "constraint_widened", "interface", "configuration", interfaceId),
    );
  if (beforeKeys.some((key) => !(key in after)))
    reasons.push(
      makeReason("major", "constraint_narrowed", "interface", "configuration", interfaceId),
    );
  for (const key of beforeKeys)
    if (key in after && before[key] !== after[key])
      reasons.push(
        makeReason("major", "public_contract_changed", "interface", "configuration", interfaceId),
      );
};

const compareInterfaceOperation = (
  reasons: VersionImpactReason[],
  interfaceId: unknown,
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  pushChange(
    reasons,
    previous.description,
    candidate.description,
    "patch",
    "definition_text_changed",
    "interface",
    "description",
    interfaceId,
  );
  pushChange(
    reasons,
    previous.key,
    candidate.key,
    "major",
    "component_key_changed",
    "interface",
    "key",
    interfaceId,
  );
  pushChange(
    reasons,
    previous.inputShape,
    candidate.inputShape,
    "major",
    "public_contract_changed",
    "interface",
    "configuration",
    interfaceId,
  );
  compareStringShape(reasons, interfaceId, previous.outputShape, candidate.outputShape);
  compareSet(
    reasons,
    previous.errorCodes as unknown[],
    candidate.errorCodes as unknown[],
    "interface",
    interfaceId,
    "constraint",
  );
  compareBound(
    reasons,
    previous.rateLimitPerMinute,
    candidate.rateLimitPerMinute,
    "maximum",
    "interface",
    interfaceId,
  );
  compareBound(
    reasons,
    previous.maximumRequestBytes,
    candidate.maximumRequestBytes,
    "maximum",
    "interface",
    interfaceId,
  );
  for (const key of [
    "authentication",
    "permissionKey",
    "visibility",
    "duplicateProtection",
    "target",
  ])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "permissionKey" || key === "visibility"
        ? "permission_changed"
        : "public_contract_changed",
      "interface",
      key === "permissionKey" || key === "visibility" ? "visibility" : "configuration",
      interfaceId,
    );
};

export const finaliseReasons = (reasons: VersionImpactReason[]): VersionImpactReason[] => {
  const unique = new Map(reasons.map((reason) => [canonicalJson(reason), reason]));
  return [...unique.values()].sort((left, right) => {
    const severity = impactRank[right.impact] - impactRank[left.impact];
    if (severity !== 0) return severity;
    const leftLocation = left.location;
    const rightLocation = right.location;
    return (
      (componentKindRank.get(leftLocation.componentKind) ?? Number.MAX_SAFE_INTEGER) -
        (componentKindRank.get(rightLocation.componentKind) ?? Number.MAX_SAFE_INTEGER) ||
      compareText(leftLocation.componentId ?? "", rightLocation.componentId ?? "") ||
      (propertyRank.get(leftLocation.property) ?? Number.MAX_SAFE_INTEGER) -
        (propertyRank.get(rightLocation.property) ?? Number.MAX_SAFE_INTEGER) ||
      (reasonCodeRank.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (reasonCodeRank.get(right.code) ?? Number.MAX_SAFE_INTEGER)
    );
  });
};

const sorted = (values: unknown[], identity?: string): unknown[] =>
  [...values].sort((left, right) => {
    if (identity) {
      const result = compareText(
        String(asRecord(left)[identity]),
        String(asRecord(right)[identity]),
      );
      if (result !== 0) return result;
    }
    return compareText(canonicalJson(left), canonicalJson(right));
  });

const normaliseField = (field: RecordValue): RecordValue => ({
  ...field,
  ...(field.type === "web_address"
    ? {
        settings: {
          ...asRecord(field.settings),
          allowedSchemes: sorted(
            (asRecord(field.settings).allowedSchemes as unknown[] | undefined) ?? ["https"],
          ),
        },
      }
    : {}),
});

const normaliseActionInput = (input: RecordValue): RecordValue => {
  const { validation, ...withoutValidation } = input;
  const hasValidation = validation !== undefined && Object.keys(asRecord(validation)).length > 0;
  return {
    ...withoutValidation,
    ...(hasValidation ? { validation } : {}),
    ...(input.type === "record_reference"
      ? { recordTypes: sorted(input.recordTypes as unknown[]) }
      : {}),
  };
};

const normaliseAction = (action: RecordValue): RecordValue => ({
  ...action,
  inputs: (action.inputs as RecordValue[]).map(normaliseActionInput),
});

const normaliseRecordType = (recordType: RecordValue): RecordValue => ({
  ...recordType,
  fields: sorted((recordType.fields as RecordValue[]).map(normaliseField), "fieldId"),
  relationships: sorted(recordType.relationships as unknown[], "relationshipId"),
  standardActions: sorted(recordType.standardActions as unknown[]),
  customActionIds: sorted(recordType.customActionIds as unknown[]),
});

export const normaliseModuleContent = (content: ModuleContent): ModuleContent => {
  const value = asRecord(content);
  return {
    ...value,
    dependencies: sorted(value.dependencies as unknown[], "moduleRootId"),
    recordTypes: sorted(
      (value.recordTypes as RecordValue[]).map(normaliseRecordType),
      "recordTypeId",
    ),
    permissions: sorted(value.permissions as unknown[], "permissionId"),
    actions: sorted((value.actions as RecordValue[]).map(normaliseAction), "actionId"),
    events: sorted(
      (value.events as RecordValue[]).map((event) => ({
        ...event,
        carriedFieldIds: sorted(event.carriedFieldIds as unknown[]),
      })),
      "eventId",
    ),
    rules: sorted(value.rules as unknown[], "ruleId"),
    sharingConditions: sorted(
      (value.sharingConditions as RecordValue[]).map((condition) => ({
        ...condition,
        declaredFieldIds: sorted(condition.declaredFieldIds as unknown[]),
      })),
      "conditionId",
    ),
    extensionPoints: sorted(
      (value.extensionPoints as RecordValue[]).map((point) => ({
        ...point,
        accepts: sorted(point.accepts as unknown[]),
      })),
      "extensionPointId",
    ),
  } as ModuleContent;
};

const normalisePage = (page: RecordValue): RecordValue => ({
  ...page,
  states: sorted(page.states as unknown[]),
  ...(Array.isArray(page.publicFieldIds)
    ? { publicFieldIds: sorted(page.publicFieldIds as unknown[]) }
    : {}),
  ...(Array.isArray(page.blocks)
    ? { blocks: sorted(page.blocks as unknown[], "placementId") }
    : {}),
  ...(Array.isArray(page.steps)
    ? {
        steps: (page.steps as RecordValue[]).map((step) => ({
          ...step,
          blocks: sorted(step.blocks as unknown[], "placementId"),
        })),
      }
    : {}),
});

export const normaliseApplicationContent = (content: ApplicationContent): ApplicationContent => {
  const value = asRecord(content);
  return {
    ...value,
    moduleBindings: sorted(value.moduleBindings as unknown[], "moduleRootId"),
    pages: sorted((value.pages as RecordValue[]).map(normalisePage), "pageId"),
    roles: sorted(
      (value.roles as RecordValue[]).map((role) => ({
        ...role,
        permissionKeys: sorted(role.permissionKeys as unknown[]),
      })),
      "roleId",
    ),
    queries: sorted(value.queries as unknown[], "queryId"),
    blockRegistrations: sorted(
      (value.blockRegistrations as RecordValue[]).map((block) => ({
        ...block,
        settings: sorted(block.settings as unknown[], "key"),
        allowedChildBlockIds: sorted(block.allowedChildBlockIds as unknown[]),
      })),
      "blockId",
    ),
    permissions: sorted(value.permissions as unknown[], "permissionId"),
    pipelines: sorted(value.pipelines as unknown[], "pipelineId"),
    actions: sorted((value.actions as RecordValue[]).map(normaliseAction), "actionId"),
    rules: sorted(value.rules as unknown[], "ruleId"),
    events: sorted(
      (value.events as RecordValue[]).map((event) => ({
        ...event,
        carriedFieldIds: sorted(event.carriedFieldIds as unknown[]),
      })),
      "eventId",
    ),
    workflows: sorted(
      (value.workflows as RecordValue[]).map((workflow) => ({
        ...workflow,
        nodes: sorted(workflow.nodes as unknown[], "nodeId"),
        edges: sorted(workflow.edges as unknown[]),
      })),
      "workflowId",
    ),
    connectionBindings: sorted(
      (value.connectionBindings as RecordValue[]).map((binding) => ({
        ...binding,
        requiredOperationKeys: sorted(binding.requiredOperationKeys as unknown[]),
      })),
      "bindingId",
    ),
    interfaces: sorted(
      (value.interfaces as RecordValue[]).map((definition) => ({
        ...definition,
        operations: sorted(
          (definition.operations as RecordValue[]).map((operation) => ({
            ...operation,
            errorCodes: sorted(operation.errorCodes as unknown[]),
          })),
          "operationId",
        ),
      })),
      "interfaceId",
    ),
    publicAddresses: sorted(value.publicAddresses as unknown[], "addressId"),
  } as ApplicationContent;
};

const assertUnique = (values: RecordValue[], key: string): void => {
  const identities = values.map((value) => String(value[key]));
  if (new Set(identities).size !== identities.length)
    refuseVersionImpact("ambiguous_component_identity");
};

const assertUniqueValues = (values: unknown[]): void => {
  const identities = values.map(canonicalJson);
  if (new Set(identities).size !== identities.length)
    refuseVersionImpact("ambiguous_component_identity");
};

const assertUniqueWorkflowEdges = (edges: RecordValue[]): void => {
  assertUniqueValues(
    edges.map((edge) => ({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      ...(edge.outcome === undefined ? {} : { outcome: edge.outcome }),
    })),
  );
};

const currencyConfiguration = (settings: RecordValue): RecordValue => ({
  currencyMode: settings.currencyMode,
  ...(settings.currency === undefined ? {} : { currency: settings.currency }),
});

export const assertUnambiguousModuleContent = (content: unknown): void => {
  const value = asRecord(content);
  for (const [collection, key] of [
    ["dependencies", "moduleRootId"],
    ["recordTypes", "recordTypeId"],
    ["permissions", "permissionId"],
    ["actions", "actionId"],
    ["events", "eventId"],
    ["rules", "ruleId"],
    ["sharingConditions", "conditionId"],
    ["extensionPoints", "extensionPointId"],
  ] as const)
    assertUnique(value[collection] as RecordValue[], key);
  assertUnique(value.permissions as RecordValue[], "key");
  for (const recordType of value.recordTypes as RecordValue[]) {
    assertUnique(recordType.fields as RecordValue[], "fieldId");
    assertUnique(recordType.relationships as RecordValue[], "relationshipId");
    assertUniqueValues(recordType.standardActions as unknown[]);
    assertUniqueValues(recordType.customActionIds as unknown[]);
    for (const field of recordType.fields as RecordValue[]) {
      const settings = asRecord(field.settings);
      if (field.type === "choice" || field.type === "several_choices")
        assertUnique(settings.options as RecordValue[], "value");
      if (field.type === "table") assertUnique(settings.columns as RecordValue[], "key");
      if (field.type === "formatted_text") assertUniqueValues(settings.allowedBlocks as unknown[]);
      if (field.type === "web_address" && Array.isArray(settings.allowedSchemes))
        assertUniqueValues(settings.allowedSchemes as unknown[]);
      if (field.type === "link_to_one_of_several")
        assertUniqueValues(settings.targets as unknown[]);
      if (field.type === "attachment") {
        assertUniqueValues(settings.allowedKinds as unknown[]);
        if (Array.isArray(settings.allowedExtensions))
          assertUniqueValues(settings.allowedExtensions as unknown[]);
      }
    }
  }
  for (const action of value.actions as RecordValue[]) {
    assertUnique(action.inputs as RecordValue[], "key");
    for (const input of action.inputs as RecordValue[]) {
      if (input.type === "record_reference") assertUniqueValues(input.recordTypes as unknown[]);
      const validation = input.validation;
      if (
        input.type === "formatted_text" &&
        validation !== undefined &&
        Array.isArray(asRecord(validation).allowedBlocks)
      )
        assertUniqueValues(asRecord(validation).allowedBlocks as unknown[]);
    }
  }
  for (const event of value.events as RecordValue[])
    assertUniqueValues(event.carriedFieldIds as unknown[]);
  for (const condition of value.sharingConditions as RecordValue[])
    assertUniqueValues(condition.declaredFieldIds as unknown[]);
  for (const point of value.extensionPoints as RecordValue[])
    assertUniqueValues(point.accepts as unknown[]);
};

export const assertUnambiguousApplicationContent = (content: unknown): void => {
  const value = asRecord(content);
  for (const [collection, key] of [
    ["moduleBindings", "moduleRootId"],
    ["pages", "pageId"],
    ["roles", "roleId"],
    ["queries", "queryId"],
    ["blockRegistrations", "blockId"],
    ["permissions", "permissionId"],
    ["pipelines", "pipelineId"],
    ["actions", "actionId"],
    ["rules", "ruleId"],
    ["events", "eventId"],
    ["workflows", "workflowId"],
    ["connectionBindings", "bindingId"],
    ["interfaces", "interfaceId"],
    ["publicAddresses", "addressId"],
  ] as const)
    assertUnique(value[collection] as RecordValue[], key);
  assertUnique(value.permissions as RecordValue[], "key");
  assertUnique(flattenNavigation(value.navigation as RecordValue[]), "id");
  for (const page of value.pages as RecordValue[]) {
    assertUnique(pageBlocks(page), "placementId");
    if (Array.isArray(page.steps)) assertUnique(page.steps as RecordValue[], "id");
    assertUniqueValues(page.states as unknown[]);
    if (Array.isArray(page.publicFieldIds)) assertUniqueValues(page.publicFieldIds as unknown[]);
  }
  for (const role of value.roles as RecordValue[])
    assertUniqueValues(role.permissionKeys as unknown[]);
  for (const block of value.blockRegistrations as RecordValue[]) {
    assertUnique(block.settings as RecordValue[], "key");
    assertUniqueValues(block.allowedChildBlockIds as unknown[]);
  }
  for (const pipeline of value.pipelines as RecordValue[])
    assertUnique(pipeline.stages as RecordValue[], "key");
  for (const workflow of value.workflows as RecordValue[]) {
    assertUnique(workflow.nodes as RecordValue[], "nodeId");
    assertUniqueWorkflowEdges(workflow.edges as RecordValue[]);
  }
  for (const binding of value.connectionBindings as RecordValue[])
    assertUniqueValues(binding.requiredOperationKeys as unknown[]);
  for (const definition of value.interfaces as RecordValue[]) {
    assertUnique(definition.operations as RecordValue[], "operationId");
    for (const operation of definition.operations as RecordValue[])
      assertUniqueValues(operation.errorCodes as unknown[]);
  }
  for (const event of value.events as RecordValue[])
    assertUniqueValues(event.carriedFieldIds as unknown[]);
  for (const action of value.actions as RecordValue[]) {
    assertUnique(action.inputs as RecordValue[], "key");
    for (const input of action.inputs as RecordValue[]) {
      if (input.type === "record_reference") assertUniqueValues(input.recordTypes as unknown[]);
      const validation = input.validation;
      if (
        input.type === "formatted_text" &&
        validation !== undefined &&
        Array.isArray(asRecord(validation).allowedBlocks)
      )
        assertUniqueValues(asRecord(validation).allowedBlocks as unknown[]);
    }
  }
};
