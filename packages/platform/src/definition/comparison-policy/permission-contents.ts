import type { VersionImpactReason } from "../version-impact";
import {
  type RecordValue,
  asRecord,
  same,
  makeReason,
  pushChange,
  compareKeyed,
  sorted,
} from "./shared";

export const compareSharingCondition = (
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
  for (const key of ["sourceRecordTypeId", "parameters", "condition", "declaredFieldIds"])
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

export const flattenNavigation = (items: RecordValue[]): RecordValue[] =>
  items.flatMap((item) => [
    item,
    ...flattenNavigation((item.children as RecordValue[] | undefined) ?? []),
  ]);

export const comparePermissions = (
  reasons: VersionImpactReason[],
  previous: RecordValue[],
  candidate: RecordValue[],
  addedFieldIds: ReadonlySet<string>,
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
    const leftPolicy = left.fieldPolicy === undefined ? undefined : asRecord(left.fieldPolicy);
    const rightPolicy = right.fieldPolicy === undefined ? undefined : asRecord(right.fieldPolicy);
    if (leftPolicy === undefined || rightPolicy === undefined)
      pushChange(
        reasons,
        leftPolicy,
        rightPolicy,
        "major",
        "permission_changed",
        "permission",
        "permission",
        id,
      );
    else
      for (const key of ["readableFieldIds", "changeableFieldIds"]) {
        const before = new Set((leftPolicy[key] as unknown[]).map(String));
        const after = new Set((rightPolicy[key] as unknown[]).map(String));
        const added = [...after].filter((fieldId) => !before.has(fieldId));
        if (
          [...before].some((fieldId) => !after.has(fieldId)) ||
          added.some((fieldId) => !addedFieldIds.has(fieldId))
        )
          reasons.push(makeReason("major", "permission_changed", "permission", "permission", id));
        else if (added.length > 0)
          reasons.push(makeReason("minor", "component_added", "permission", "permission", id));
      }
    for (const key of [
      "recordTypeId",
      "actionKind",
      "namedAction",
      "administrative",
      "recordScope",
    ])
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
