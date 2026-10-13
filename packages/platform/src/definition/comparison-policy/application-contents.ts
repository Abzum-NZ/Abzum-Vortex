import type { ApplicationContent, VersionImpactReason } from "../../schema";
import {
  type RecordValue,
  compareUnknownText,
  asRecord,
  same,
  makeReason,
  pushChange,
  compareSet,
  compareKeyed,
  finaliseReasons,
  sorted,
} from "./shared";
import { compareSimpleComponent } from "./module-contents";
import { compareApplicationSharedContent } from "./application-shared-contents";
import {
  blockDependencyIdentity,
  normaliseApplicationSharedContent,
  assertUnique,
  assertUniqueValues,
  assertUnambiguousApplicationSharedContent,
} from "./normalisation";

type PlacementContext = {
  placement: RecordValue;
  parent: string;
  order: Record<"desktop" | "tablet" | "phone", number>;
  publicPage: boolean;
  guidedStep: boolean;
  pageId?: string;
};

const presentationPropertyValue = (value: unknown): boolean => {
  const property = asRecord(value);
  switch (property.kind) {
    case "text":
    case "number":
    case "boolean":
    case "choice":
    case "rich_text":
    case "url":
    case "asset_reference":
    case "icon":
    case "theme_token":
      return true;
    case "group":
      return Object.values(asRecord(property.properties)).every(presentationPropertyValue);
    case "list":
      return (property.items as unknown[]).every(presentationPropertyValue);
    default:
      return false;
  }
};

const placementSubtreeIsOptionalPresentation = (placement: RecordValue): boolean =>
  placement.viewPermissionKey === undefined &&
  placement.usePermissionKey === undefined &&
  placement.visibilityCondition === undefined &&
  placement.queryId === undefined &&
  Object.values(asRecord(placement.settings)).every(presentationPropertyValue) &&
  Object.values(asRecord(placement.slots)).every((slot) =>
    Object.values(asRecord(asRecord(slot).placements)).every((child) =>
      placementSubtreeIsOptionalPresentation(asRecord(child)),
    ),
  );

const pageIsCompatibleAddition = (page: RecordValue): boolean =>
  page.type !== "public" && page.replacementOfPageId === undefined;

const collectPlacementSlot = (
  slotValue: unknown,
  parent: string,
  flags: Pick<PlacementContext, "publicPage" | "guidedStep"> & { pageId?: string },
  result: Map<string, PlacementContext>,
): void => {
  const slot = asRecord(slotValue);
  const placements = asRecord(slot.placements);
  const order = asRecord(slot.order);
  for (const [placementId, placementValue] of Object.entries(placements)) {
    const placement = asRecord(placementValue);
    result.set(placementId, {
      placement,
      parent,
      order: {
        desktop: (order.desktop as unknown[]).indexOf(placementId),
        tablet: (order.tablet as unknown[]).indexOf(placementId),
        phone: (order.phone as unknown[]).indexOf(placementId),
      },
      ...flags,
    });
    for (const [slotKey, childSlot] of Object.entries(asRecord(placement.slots)))
      collectPlacementSlot(
        childSlot,
        `${parent}/placement:${placementId}/slot:${slotKey}`,
        flags,
        result,
      );
  }
};

const collectPlacements = (contentValue: ApplicationContent): Map<string, PlacementContext> => {
  const content = asRecord(contentValue);
  const result = new Map<string, PlacementContext>();
  const shells = content.shells as RecordValue[];
  const shellConsumers = new Map<string, { publicPage: boolean; guidedStep: boolean }>();
  for (const page of content.pages as RecordValue[]) {
    const composition = asRecord(page.composition);
    if (composition.shellKind !== "application") continue;
    const shellId = String(composition.shellId);
    const current = shellConsumers.get(shellId) ?? { publicPage: false, guidedStep: false };
    shellConsumers.set(shellId, {
      publicPage: current.publicPage || page.type === "public",
      guidedStep: current.guidedStep || page.type === "guided_form",
    });
  }
  for (const shell of shells) {
    const consumers = shellConsumers.get(String(shell.shellId)) ?? {
      publicPage: false,
      guidedStep: false,
    };
    collectPlacementSlot(shell.layout, `shell:${String(shell.shellId)}:root`, consumers, result);
  }
  for (const page of content.pages as RecordValue[]) {
    const pageId = String(page.pageId);
    const composition = asRecord(page.composition);
    const publicPage = page.type === "public";
    const guidedStep = page.type === "guided_form";
    if ("stepContent" in composition) {
      for (const [stepId, stepValue] of Object.entries(asRecord(composition.stepContent))) {
        if (composition.shellKind === "default")
          collectPlacementSlot(
            stepValue,
            `page:${pageId}/step:${stepId}/default`,
            { publicPage, guidedStep, pageId },
            result,
          );
        else
          for (const [slotId, slot] of Object.entries(asRecord(stepValue)))
            collectPlacementSlot(
              slot,
              `page:${pageId}/step:${stepId}/shell:${String(composition.shellId)}/slot:${slotId}`,
              { publicPage, guidedStep, pageId },
              result,
            );
      }
    } else if (composition.shellKind === "default")
      collectPlacementSlot(
        composition.main,
        `page:${pageId}/default`,
        { publicPage, guidedStep, pageId },
        result,
      );
    else
      for (const [slotId, slot] of Object.entries(asRecord(composition.content)))
        collectPlacementSlot(
          slot,
          `page:${pageId}/shell:${String(composition.shellId)}/slot:${slotId}`,
          { publicPage, guidedStep, pageId },
          result,
        );
  }
  return result;
};

const comparePlacements = (
  reasons: VersionImpactReason[],
  previousContent: ApplicationContent,
  candidateContent: ApplicationContent,
): void => {
  const previous = collectPlacements(previousContent);
  const candidate = collectPlacements(candidateContent);
  const previousPageIds = new Set(
    (asRecord(previousContent).pages as RecordValue[]).map((page) => String(page.pageId)),
  );
  const compatibleAddedPageIds = new Set(
    (asRecord(candidateContent).pages as RecordValue[])
      .filter((page) => !previousPageIds.has(String(page.pageId)) && pageIsCompatibleAddition(page))
      .map((page) => String(page.pageId)),
  );
  for (const [id, current] of candidate)
    if (!previous.has(id)) {
      if (current.pageId !== undefined && compatibleAddedPageIds.has(current.pageId)) continue;
      const presentationOnly =
        !current.publicPage &&
        !current.guidedStep &&
        placementSubtreeIsOptionalPresentation(current.placement);
      reasons.push(
        makeReason(
          presentationOnly ? "minor" : "major",
          presentationOnly ? "component_added" : "required_component_added",
          "block_placement",
          "definition",
          id,
        ),
      );
    }
  for (const [id] of previous)
    if (!candidate.has(id))
      reasons.push(makeReason("major", "component_removed", "block_placement", "definition", id));
  for (const [id, before] of previous) {
    const after = candidate.get(id);
    if (after === undefined) continue;
    if (before.parent !== after.parent)
      reasons.push(makeReason("major", "ownership_changed", "block_placement", "ownership", id));
    else
      pushChange(
        reasons,
        before.order,
        after.order,
        "patch",
        "meaningful_order_changed",
        "block_placement",
        "order",
        id,
      );
    pushChange(
      reasons,
      before.placement.responsive,
      after.placement.responsive,
      "patch",
      "presentation_changed",
      "block_placement",
      "configuration",
      id,
    );
    pushChange(
      reasons,
      before.placement.themeOverrides,
      after.placement.themeOverrides,
      "patch",
      "presentation_changed",
      "block_placement",
      "theme",
      id,
    );
    for (const key of ["viewPermissionKey", "usePermissionKey"])
      pushChange(
        reasons,
        before.placement[key],
        after.placement[key],
        "major",
        "permission_changed",
        "block_placement",
        "permission",
        id,
      );
    pushChange(
      reasons,
      before.placement.visibilityCondition,
      after.placement.visibilityCondition,
      "major",
      "permission_changed",
      "block_placement",
      "visibility",
      id,
    );
    pushChange(
      reasons,
      before.placement.queryId,
      after.placement.queryId,
      "major",
      "existing_behavior_changed",
      "block_placement",
      "behavior",
      id,
    );
    for (const key of ["block", "settings"])
      pushChange(
        reasons,
        before.placement[key],
        after.placement[key],
        "major",
        "existing_behavior_changed",
        "block_placement",
        "behavior",
        id,
      );
  }
};

const compareShellContentSlot = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.slotId;
  pushChange(
    reasons,
    previous.label,
    candidate.label,
    "patch",
    "presentation_changed",
    "shell_content_slot",
    "name",
    id,
  );
  for (const key of ["key", "parentPlacementId", "parentSlotKey"])
    pushChange(
      reasons,
      previous[key],
      candidate[key],
      "major",
      key === "key" ? "component_key_changed" : "ownership_changed",
      "shell_content_slot",
      key === "key" ? "key" : "ownership",
      id,
    );
  if (previous.required !== candidate.required)
    reasons.push(
      makeReason(
        candidate.required === true ? "major" : "minor",
        candidate.required === true ? "constraint_narrowed" : "constraint_widened",
        "shell_content_slot",
        "required",
        id,
      ),
    );
  compareSet(
    reasons,
    previous.allowedChildCategories as unknown[],
    candidate.allowedChildCategories as unknown[],
    "shell_content_slot",
    id,
    "constraint",
    "minor",
    "major",
  );
};

const compareShells = (
  reasons: VersionImpactReason[],
  previous: RecordValue[],
  candidate: RecordValue[],
): void =>
  compareKeyed(
    reasons,
    previous,
    candidate,
    "shellId",
    "shell",
    (before, after) => {
      const id = after.shellId;
      pushChange(
        reasons,
        before.name,
        after.name,
        "patch",
        "presentation_changed",
        "shell",
        "name",
        id,
      );
      pushChange(
        reasons,
        before.presentation,
        after.presentation,
        "patch",
        "presentation_changed",
        "shell",
        "presentation",
        id,
      );
      pushChange(
        reasons,
        before.key,
        after.key,
        "major",
        "component_key_changed",
        "shell",
        "key",
        id,
      );
      compareKeyed(
        reasons,
        before.contentSlots as RecordValue[],
        after.contentSlots as RecordValue[],
        "slotId",
        "shell_content_slot",
        (left, right) => compareShellContentSlot(reasons, left, right),
        (slot) => (slot.required === true ? "major" : "minor"),
      );
    },
    (shell) => {
      const placements = asRecord(asRecord(shell.layout).placements);
      return (shell.contentSlots as RecordValue[]).every((slot) => slot.required === false) &&
        Object.values(placements).every((placement) =>
          placementSubtreeIsOptionalPresentation(asRecord(placement)),
        )
        ? "minor"
        : "major";
    },
  );

const compareCompositionOwnership = (
  reasons: VersionImpactReason[],
  previousComposition: RecordValue,
  candidateComposition: RecordValue,
  pageId: unknown,
): void => {
  if (
    previousComposition.shellKind !== "application" ||
    candidateComposition.shellKind !== "application"
  )
    return;
  const compareSlotKeys = (previousValue: unknown, candidateValue: unknown): void =>
    compareSet(
      reasons,
      Object.keys(asRecord(previousValue)),
      Object.keys(asRecord(candidateValue)),
      "page",
      pageId,
      "ownership",
      "minor",
      "major",
    );
  if ("stepContent" in previousComposition || "stepContent" in candidateComposition) {
    const previousSteps =
      "stepContent" in previousComposition ? asRecord(previousComposition.stepContent) : {};
    const candidateSteps =
      "stepContent" in candidateComposition ? asRecord(candidateComposition.stepContent) : {};
    compareSet(
      reasons,
      Object.keys(previousSteps),
      Object.keys(candidateSteps),
      "page",
      pageId,
      "ownership",
      "major",
      "major",
    );
    for (const stepId of Object.keys(previousSteps))
      if (Object.prototype.hasOwnProperty.call(candidateSteps, stepId))
        compareSlotKeys(previousSteps[stepId], candidateSteps[stepId]);
    return;
  }
  compareSlotKeys(previousComposition.content, candidateComposition.content);
};

const comparePage = (
  reasons: VersionImpactReason[],
  previous: RecordValue,
  candidate: RecordValue,
): void => {
  const id = candidate.pageId;
  pushChange(
    reasons,
    previous.name,
    candidate.name,
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
    "replacementOfPageId",
    "queryId",
    "publicFieldIds",
    "publicActionKey",
    "rateLimitPerMinute",
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
  const beforeComposition = asRecord(previous.composition);
  const afterComposition = asRecord(candidate.composition);
  pushChange(
    reasons,
    { shellKind: beforeComposition.shellKind, shellId: beforeComposition.shellId ?? null },
    { shellKind: afterComposition.shellKind, shellId: afterComposition.shellId ?? null },
    "major",
    "ownership_changed",
    "page",
    "ownership",
    id,
  );
  compareCompositionOwnership(reasons, beforeComposition, afterComposition, id);
  if (Array.isArray(previous.steps) || Array.isArray(candidate.steps)) {
    const before = (previous.steps as RecordValue[] | undefined) ?? [];
    const after = (candidate.steps as RecordValue[] | undefined) ?? [];
    const beforeIds = before.map((step) => step.id);
    const afterIds = after.map((step) => step.id);
    if (!same([...beforeIds].sort(compareUnknownText), [...afterIds].sort(compareUnknownText)))
      reasons.push(makeReason("major", "existing_behavior_changed", "page", "behavior", id));
    else if (!same(beforeIds, afterIds))
      reasons.push(makeReason("patch", "meaningful_order_changed", "page", "order", id));
    for (const step of after) {
      const old = before.find((entry) => entry.id === step.id);
      if (old === undefined) continue;
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
      pushChange(reasons, old.name, step.name, "patch", "presentation_changed", "page", "name", id);
    }
  }
};

export const compareApplicationContents = (
  previousContent: ApplicationContent,
  candidateContent: ApplicationContent,
): VersionImpactReason[] => {
  const reasons = compareApplicationSharedContent(previousContent, candidateContent);
  const previous = asRecord(previousContent);
  const candidate = asRecord(candidateContent);
  compareKeyed(
    reasons,
    previous.platformBlockDependencies as RecordValue[],
    candidate.platformBlockDependencies as RecordValue[],
    blockDependencyIdentity,
    "platform_block_dependency",
    (before, after) =>
      compareSimpleComponent(reasons, "platform_block_dependency", after.blockId, before, after),
    () => "major",
    (item) => item.blockId,
  );
  compareShells(reasons, previous.shells as RecordValue[], candidate.shells as RecordValue[]);
  compareKeyed(
    reasons,
    previous.pages as RecordValue[],
    candidate.pages as RecordValue[],
    "pageId",
    "page",
    (before, after) => comparePage(reasons, before, after),
    (page) => (pageIsCompatibleAddition(page) ? "minor" : "major"),
  );
  comparePlacements(reasons, previousContent, candidateContent);
  pushChange(
    reasons,
    previous.theme,
    candidate.theme,
    "patch",
    "presentation_changed",
    "theme",
    "theme",
  );
  return finaliseReasons(reasons);
};

export const normaliseApplicationContent = (content: ApplicationContent): ApplicationContent => {
  const comparisonContent = structuredClone(content);
  // Empty internal containers have no display effect. Children and exposed
  // shell-slot declarations independently carry their meaningful changes.
  for (const { placement } of collectPlacements(comparisonContent).values())
    placement.slots = Object.fromEntries(
      Object.entries(asRecord(placement.slots)).filter(
        ([, slot]) => Object.keys(asRecord(asRecord(slot).placements)).length > 0,
      ),
    );
  const common = normaliseApplicationSharedContent(comparisonContent);
  const value = asRecord(comparisonContent);
  return {
    ...value,
    moduleBindings: common.moduleBindings,
    navigation: common.navigation,
    roles: common.roles,
    queries: common.queries,
    pipelines: common.pipelines,
    permissions: common.permissions,
    actions: common.actions,
    events: common.events,
    connectionBindings: common.connectionBindings,
    interfaces: common.interfaces,
    publicAddresses: common.publicAddresses,
    platformBlockDependencies: sorted(
      value.platformBlockDependencies as unknown[],
      blockDependencyIdentity,
    ),
    shells: sorted(
      (value.shells as RecordValue[]).map((shell) => ({
        ...shell,
        contentSlots: sorted(
          (shell.contentSlots as RecordValue[]).map((slot) => ({
            ...slot,
            allowedChildCategories: sorted(slot.allowedChildCategories as unknown[]),
          })),
          "slotId",
        ),
      })),
      "shellId",
    ),
    pages: sorted(
      (value.pages as RecordValue[]).map((page) => ({
        ...page,
        ...(Array.isArray(page.publicFieldIds)
          ? { publicFieldIds: sorted(page.publicFieldIds as unknown[]) }
          : {}),
      })),
      "pageId",
    ),
  } as ApplicationContent;
};

export const assertUnambiguousApplicationContent = (content: unknown): void => {
  const value = asRecord(content);
  assertUnambiguousApplicationSharedContent(value);
  assertUnique(value.pages as RecordValue[], (page) => String(page.pageId).toLowerCase());
  assertUnique(value.platformBlockDependencies as RecordValue[], blockDependencyIdentity);
  assertUnique(value.shells as RecordValue[], "shellId");
  assertUnique(value.shells as RecordValue[], "key");
  const contentSlots = (value.shells as RecordValue[]).flatMap((shell) => {
    const slots = shell.contentSlots as RecordValue[];
    assertUnique(slots, "key");
    return slots;
  });
  assertUnique(contentSlots, "slotId");
  if (Array.isArray(value.experiences)) assertUnique(value.experiences as RecordValue[], "state");
  for (const page of value.pages as RecordValue[]) {
    if (Array.isArray(page.steps)) assertUnique(page.steps as RecordValue[], "id");
    if (Array.isArray(page.publicFieldIds)) assertUniqueValues(page.publicFieldIds as unknown[]);
  }
};
