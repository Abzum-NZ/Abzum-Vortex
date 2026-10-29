import type { ApplicationContent } from "../application-contracts";
import type { VersionImpactReason } from "../version-impact";
import {
  type RecordValue,
  asRecord,
  same,
  makeReason,
  pushChange,
  compareSet,
  compareBound,
  compareKeyed,
  finaliseReasons,
} from "./shared";
import {
  compareAction,
  compareSimpleComponent,
  compareFlow,
  compareEvent,
} from "./module-contents";
import { comparePermissions, flattenNavigation } from "./permission-contents";

/**
 * The definition-wide comparison every Application release shares. Shells, pages, placements and
 * the theme carry their own current-contract comparison in compareApplicationContents.
 */
export const compareApplicationSharedContent = (
  previousContent: ApplicationContent,
  candidateContent: ApplicationContent,
): VersionImpactReason[] => {
  const reasons: VersionImpactReason[] = [];
  const previous = asRecord(previousContent);
  const candidate = asRecord(candidateContent);
  pushChange(
    reasons,
    previous.search,
    candidate.search,
    "major",
    "presentation_changed",
    "application",
    "configuration",
  );
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
      compareSimpleComponent(reasons, "module_binding", right.moduleRootId, left, right),
    () => "major",
  );
  compareNavigation(
    reasons,
    previous.navigation as RecordValue[],
    candidate.navigation as RecordValue[],
  );
  compareKeyed(
    reasons,
    previous.roles as RecordValue[],
    candidate.roles as RecordValue[],
    "roleId",
    "role",
    (left, right) => compareRole(reasons, left, right),
  );
  // An Application declares no fields of its own, so no field is new to its permissions.
  comparePermissions(
    reasons,
    previous.permissions as RecordValue[],
    candidate.permissions as RecordValue[],
    new Set(),
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
  compareKeyed(
    reasons,
    previous.flows as RecordValue[],
    candidate.flows as RecordValue[],
    "id",
    "flow",
    (left, right) => compareFlow(reasons, left, right),
  );
  compareKeyed(
    reasons,
    (previous.experiences as RecordValue[] | undefined) ?? [],
    (candidate.experiences as RecordValue[] | undefined) ?? [],
    "state",
    "application",
    (left, right) =>
      pushChange(
        reasons,
        left.pageId,
        right.pageId,
        "patch",
        "presentation_changed",
        "application",
        "configuration",
        right.state,
      ),
    () => "patch",
    (item) => item.state,
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
    pushChange(
      reasons,
      left.icon,
      right.icon,
      "patch",
      "presentation_changed",
      "navigation_item",
      "icon",
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
  // A role that gains permissions lets its holders do more, which existing installations can take
  // as they are (minor); a role that loses one narrows what they could do (major).
  const before = new Set((previous.permissionKeys as unknown[]).map(String));
  const after = new Set((candidate.permissionKeys as unknown[]).map(String));
  if ([...before].some((key) => !after.has(key)))
    reasons.push(makeReason("major", "permission_changed", "role", "permission", id));
  else if ([...after].some((key) => !before.has(key)))
    reasons.push(makeReason("minor", "component_added", "role", "permission", id));
};

/**
 * Permissions compare by identity. A field policy's readable and changeable fields compare as sets,
 * and any change other than a field added in this same release (in `addedFieldIds`) joining a
 * policy is major. A field the candidate adds joining a policy removes or narrows nothing, so the
 * release is minor; it still changes that permission's authority and advances its continuity, so
 * every installed role holding it needs acceptance before the wider field access applies.
 */

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

const compareInterfaceShape = (
  reasons: VersionImpactReason[],
  interfaceId: unknown,
  previous: unknown,
  candidate: unknown,
  direction: "input" | "output",
): void => {
  const before = asRecord(previous);
  const after = asRecord(candidate);
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  for (const key of afterKeys)
    if (!(key in before)) {
      const descriptor = asRecord(after[key]);
      const impact = direction === "input" && descriptor.required === true ? "major" : "minor";
      reasons.push(
        makeReason(
          impact,
          impact === "major" ? "public_contract_changed" : "constraint_widened",
          "interface",
          "configuration",
          interfaceId,
        ),
      );
    }
  if (beforeKeys.some((key) => !(key in after)))
    reasons.push(
      makeReason("major", "constraint_narrowed", "interface", "configuration", interfaceId),
    );
  for (const key of beforeKeys)
    if (key in after && !same(before[key], after[key]))
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
  compareInterfaceShape(reasons, interfaceId, previous.inputShape, candidate.inputShape, "input");
  compareInterfaceShape(
    reasons,
    interfaceId,
    previous.outputShape,
    candidate.outputShape,
    "output",
  );
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
    "method",
    "path",
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
