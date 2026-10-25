import type { ApplicationContent } from "../application-contracts";
import type { VersionImpactReason } from "../version-impact";
import { placementBlockRelease, placementSettings } from "../application-composition-catalogue";
import { releaseSettingDeclarations } from "../application-composition/platform-block-release";
import type { BlockPropertySchemaContract } from "../application-composition/block-property-schema";
import {
  type RecordValue,
  compareUnknownText,
  asRecord,
  same,
  makeReason,
  pushChange,
  compareSet,
  compareKeyed,
  compareOrderedEntries,
  presentationListEntry,
  presentationOnlyValue,
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
  item: RecordValue;
  vortex: RecordValue;
  settings: RecordValue;
  declarations: readonly BlockPropertySchemaContract[];
  parent: string;
  order: Record<"desktop" | "tablet" | "phone", number>;
  publicPage: boolean;
  guidedStep: boolean;
  pageId?: string;
};

/** The child slots of one compiled item: exactly the slots its `vortex.slotOrders` orders. */
const itemSlots = (item: RecordValue): [string, RecordValue[]][] => {
  const props = asRecord(item.props);
  return Object.keys(asRecord(asRecord(props.vortex).slotOrders)).map(
    (key): [string, RecordValue[]] => [key, props[key] as RecordValue[]],
  );
};

const placementSubtreeIsOptionalPresentation = (item: RecordValue): boolean => {
  const props = asRecord(item.props);
  const vortex = asRecord(props.vortex);
  const release = placementBlockRelease(vortex.block);
  const declarations = releaseSettingDeclarations(release);
  return (
    vortex.viewPermissionKey === undefined &&
    vortex.usePermissionKey === undefined &&
    vortex.visibilityCondition === undefined &&
    vortex.queryId === undefined &&
    // Flow bindings for interactive entries are compared with their owning placements.
    Object.entries(placementSettings(props)).every(([key, value]) => {
      const declaration = declarations.find((property) => property.key === key);
      if (declaration === undefined) throw new Error(`Block release has no setting '${key}'`);
      return presentationOnlyValue(value, declaration);
    }) &&
    itemSlots(item).every(([, children]) =>
      children.every((child) => placementSubtreeIsOptionalPresentation(asRecord(child))),
    )
  );
};

const pageIsCompatibleAddition = (page: RecordValue): boolean =>
  page.type !== "public" && page.replacementOfPageId === undefined;

const collectPlacementSlot = (
  itemsValue: unknown,
  orderValue: unknown,
  parent: string,
  flags: Pick<PlacementContext, "publicPage" | "guidedStep"> & { pageId?: string },
  result: Map<string, PlacementContext>,
): void => {
  const items = itemsValue as RecordValue[];
  const order = asRecord(orderValue);
  for (const [index, itemValue] of items.entries()) {
    const item = asRecord(itemValue);
    const props = asRecord(item.props);
    const vortex = asRecord(props.vortex);
    const placementId = String(props.id);
    result.set(placementId, {
      item,
      vortex,
      settings: placementSettings(props),
      declarations: releaseSettingDeclarations(placementBlockRelease(vortex.block)),
      parent,
      order: {
        desktop: index,
        tablet: (order.tablet as unknown[]).indexOf(placementId),
        phone: (order.phone as unknown[]).indexOf(placementId),
      },
      ...flags,
    });
    for (const [slotKey, children] of itemSlots(item))
      collectPlacementSlot(
        children,
        asRecord(vortex.slotOrders)[slotKey],
        `${parent}/placement:${placementId}/slot:${slotKey}`,
        flags,
        result,
      );
  }
};

/** The root vortex metadata of compiled page data. */
const dataVortex = (data: unknown): RecordValue =>
  asRecord(asRecord(asRecord(asRecord(data).root).props).vortex);

/** The application shell a compiled page uses, or null for the platform default frame. */
const compositionShellId = (composition: RecordValue): string | null => {
  const data =
    composition.stepContent === undefined
      ? composition
      : Object.values(asRecord(composition.stepContent))[0];
  const shellId = dataVortex(data).shellId;
  return typeof shellId === "string" ? shellId : null;
};

/** Collects one compiled page data's zones under the parent the old placement owned them by. */
const collectPageData = (
  dataValue: unknown,
  base: string,
  flags: Pick<PlacementContext, "publicPage" | "guidedStep"> & { pageId?: string },
  result: Map<string, PlacementContext>,
): void => {
  const data = asRecord(dataValue);
  const vortex = dataVortex(data);
  const orders = asRecord(vortex.slotOrders);
  if (typeof vortex.shellId !== "string") {
    collectPlacementSlot(data.content, orders.content, `${base}/default`, flags, result);
    return;
  }
  for (const [slotId, items] of Object.entries(asRecord(asRecord(data.root).props)))
    if (slotId !== "vortex")
      collectPlacementSlot(
        items,
        orders[slotId],
        `${base}/shell:${vortex.shellId}/slot:${slotId}`,
        flags,
        result,
      );
};

const collectPlacements = (contentValue: ApplicationContent): Map<string, PlacementContext> => {
  const content = asRecord(contentValue);
  const result = new Map<string, PlacementContext>();
  const shells = content.shells as RecordValue[];
  const shellConsumers = new Map<string, { publicPage: boolean; guidedStep: boolean }>();
  for (const page of content.pages as RecordValue[]) {
    const shellId = compositionShellId(asRecord(page.composition));
    if (shellId === null) continue;
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
    const layout = asRecord(shell.layout);
    collectPlacementSlot(
      layout.content,
      asRecord(dataVortex(layout).slotOrders).content,
      `shell:${String(shell.shellId)}:root`,
      consumers,
      result,
    );
  }
  for (const page of content.pages as RecordValue[]) {
    const pageId = String(page.pageId);
    const composition = asRecord(page.composition);
    const flags = {
      publicPage: page.type === "public",
      guidedStep: page.type === "guided_form",
      pageId,
    };
    if (composition.stepContent !== undefined)
      for (const [stepId, data] of Object.entries(asRecord(composition.stepContent)))
        collectPageData(data, `page:${pageId}/step:${stepId}`, flags, result);
    else collectPageData(composition, `page:${pageId}`, flags, result);
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
  // A binding on a new control belongs to the new capability. Binding an existing
  // control changes its behaviour; edits and removals remain breaking changes too.
  compareKeyed(
    reasons,
    previousContent.flowBindings as RecordValue[],
    candidateContent.flowBindings as RecordValue[],
    "bindingId",
    "flow_binding",
    (before, after) =>
      compareSimpleComponent(reasons, "flow_binding", after.bindingId, before, after),
    (binding) => {
      const controlId = String(binding.controlId);
      return candidate.has(controlId) && !previous.has(controlId) ? "minor" : "major";
    },
  );
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
      // Public forms and guided steps have an existing interaction contract. Ordinary
      // page additions, including data-bound Boards, add a new capability.
      const breaking = current.publicPage || current.guidedStep;
      reasons.push(
        makeReason(
          breaking ? "major" : "minor",
          breaking ? "required_component_added" : "component_added",
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
      before.vortex.responsive,
      after.vortex.responsive,
      "patch",
      "presentation_changed",
      "block_placement",
      "configuration",
      id,
    );
    for (const key of ["viewPermissionKey", "usePermissionKey"])
      pushChange(
        reasons,
        before.vortex[key],
        after.vortex[key],
        "major",
        "permission_changed",
        "block_placement",
        "permission",
        id,
      );
    pushChange(
      reasons,
      before.vortex.visibilityCondition,
      after.vortex.visibilityCondition,
      "major",
      "permission_changed",
      "block_placement",
      "visibility",
      id,
    );
    pushChange(
      reasons,
      before.vortex.queryId,
      after.vortex.queryId,
      "major",
      "existing_behavior_changed",
      "block_placement",
      "behavior",
      id,
    );
    pushChange(
      reasons,
      before.vortex.block,
      after.vortex.block,
      "major",
      "existing_behavior_changed",
      "block_placement",
      "behavior",
      id,
    );
    for (const key of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
      const declaration =
        after.declarations.find((property) => property.key === key) ??
        before.declarations.find((property) => property.key === key);
      if (declaration === undefined) throw new Error(`Block release has no setting '${key}'`);
      const previousSetting = asRecord(before.settings[key]);
      const candidateSetting = asRecord(after.settings[key]);
      // Display list entries may be appended or have their text edited; other settings and
      // references remain behaviour changes. A list that exists on one side only compares as
      // an empty list on the other, so a whole new list is an append (minor), never a patch.
      const previousItems =
        previousSetting?.kind === "list"
          ? (previousSetting.items as unknown[])
          : previousSetting === undefined
            ? []
            : undefined;
      const candidateItems =
        candidateSetting?.kind === "list"
          ? (candidateSetting.items as unknown[])
          : candidateSetting === undefined
            ? []
            : undefined;
      if (
        previousItems !== undefined &&
        candidateItems !== undefined &&
        (previousSetting !== undefined || candidateSetting !== undefined)
      )
        compareOrderedEntries(
          reasons,
          previousItems,
          candidateItems,
          "block_placement",
          id,
          "behavior",
          (entry) => presentationListEntry(entry, declaration),
          declaration,
        );
      else {
        const presentationOnly = presentationOnlyValue(
          candidateSetting,
          declaration,
          previousSetting,
        );
        pushChange(
          reasons,
          before.settings[key],
          after.settings[key],
          presentationOnly ? "patch" : "major",
          presentationOnly ? "presentation_changed" : "existing_behavior_changed",
          "block_placement",
          presentationOnly ? "configuration" : "behavior",
          id,
        );
      }
    }
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
      const items = asRecord(shell.layout).content as RecordValue[];
      return (shell.contentSlots as RecordValue[]).every((slot) => slot.required === false) &&
        items.every((item) => placementSubtreeIsOptionalPresentation(asRecord(item)))
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
    compositionShellId(previousComposition) === null ||
    compositionShellId(candidateComposition) === null
  )
    return;
  /** The shell content slots one compiled page data fills: its root slot props. */
  const filledSlots = (data: unknown): string[] =>
    Object.keys(asRecord(asRecord(asRecord(data).root).props)).filter((key) => key !== "vortex");
  const compareSlotKeys = (previousValue: unknown, candidateValue: unknown): void =>
    compareSet(
      reasons,
      filledSlots(previousValue),
      filledSlots(candidateValue),
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
  compareSlotKeys(previousComposition, candidateComposition);
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
    { shellId: compositionShellId(beforeComposition) },
    { shellId: compositionShellId(afterComposition) },
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
  // Bringing a released block into use is additive. Its settings affect versioning only when
  // an existing placement changes; dependency removals still compare as breaking changes.
  compareKeyed(
    reasons,
    previous.platformBlockDependencies as RecordValue[],
    candidate.platformBlockDependencies as RecordValue[],
    blockDependencyIdentity,
    "platform_block_dependency",
    (before, after) =>
      compareSimpleComponent(reasons, "platform_block_dependency", after.blockId, before, after),
    () => "minor",
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
  for (const { item, vortex } of collectPlacements(comparisonContent).values()) {
    const props = asRecord(item.props);
    const slotOrders = asRecord(vortex.slotOrders);
    for (const [slotKey, children] of itemSlots(item))
      if (children.length === 0) {
        delete props[slotKey];
        delete slotOrders[slotKey];
      }
  }
  const common = normaliseApplicationSharedContent(comparisonContent);
  const value = asRecord(comparisonContent);
  return {
    ...value,
    moduleBindings: common.moduleBindings,
    navigation: common.navigation,
    roles: common.roles,
    queries: common.queries,
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
