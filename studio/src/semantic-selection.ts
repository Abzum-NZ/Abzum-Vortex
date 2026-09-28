import type {
  ApplicationDraftV2,
  ApplicationRootId,
  ContainedComponentId,
  FlowId,
  PageId,
  ShellId,
} from "@vortex/contracts";

/**
 * The selected authored application item shared by Studio workspace surfaces.
 * Ids come from the Application draft contract; adapter-local node ids and layout
 * coordinates are deliberately absent.
 */
export type StudioSemanticSelection =
  | Readonly<{ kind: "application"; applicationRootId: ApplicationRootId }>
  | Readonly<{ kind: "page"; pageId: PageId }>
  | Readonly<{ kind: "shell"; shellId: ShellId }>
  | Readonly<{ kind: "navigation"; navigationItemId: ContainedComponentId }>
  | Readonly<{ kind: "flow"; flowId: FlowId }>
  | Readonly<{ kind: "placement"; placementId: ContainedComponentId }>;

type PlacementOwner =
  | Readonly<{ kind: "page"; pageId: PageId }>
  | Readonly<{ kind: "shell"; shellId: ShellId }>;

type PlacementSlotIdentitySource = Readonly<{ placements: Readonly<Record<string, unknown>> }>;

type SelectionIndex = Readonly<{
  applicationRootId: ApplicationRootId;
  pageIds: ReadonlySet<string>;
  shellIds: ReadonlySet<string>;
  navigationItemIds: ReadonlySet<string>;
  flowIds: ReadonlySet<string>;
  placementOwners: ReadonlyMap<string, PlacementOwner>;
}>;

export type StudioSemanticSelectionListener = (
  selection: StudioSemanticSelection | null,
) => void;

export interface StudioSemanticSelectionStore {
  /** Returns the current semantic identity, or `null` when the editor cleared selection. */
  getSelection(): StudioSemanticSelection | null;
  /** Selects an identity present in the current draft; returns false for a stale identity. */
  select(selection: StudioSemanticSelection | null): boolean;
  /** Reconciles identities against the latest draft without retaining or advancing its revision. */
  reconcile(draft: ApplicationDraftV2): StudioSemanticSelection | null;
  /** Subscribes to shared selection changes. Read the initial value with `getSelection`. */
  subscribe(listener: StudioSemanticSelectionListener): () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPlacementSlot = (value: unknown): value is PlacementSlotIdentitySource =>
  isRecord(value) && isRecord(value.placements) && "order" in value;

const selectionForOwner = (owner: PlacementOwner): StudioSemanticSelection =>
  owner.kind === "page"
    ? Object.freeze({ kind: "page", pageId: owner.pageId })
    : Object.freeze({ kind: "shell", shellId: owner.shellId });

const applicationSelection = (applicationRootId: ApplicationRootId): StudioSemanticSelection =>
  Object.freeze({ kind: "application", applicationRootId });

const normalizeSelection = (
  selection: StudioSemanticSelection | null,
): StudioSemanticSelection | null | undefined => {
  if (selection === null) return null;
  switch (selection.kind) {
    case "application":
      return Object.freeze({ kind: "application", applicationRootId: selection.applicationRootId });
    case "page":
      return Object.freeze({ kind: "page", pageId: selection.pageId });
    case "shell":
      return Object.freeze({ kind: "shell", shellId: selection.shellId });
    case "navigation":
      return Object.freeze({ kind: "navigation", navigationItemId: selection.navigationItemId });
    case "flow":
      return Object.freeze({ kind: "flow", flowId: selection.flowId });
    case "placement":
      return Object.freeze({ kind: "placement", placementId: selection.placementId });
    default:
      return undefined;
  }
};

const selectionKey = (selection: StudioSemanticSelection | null): string | null => {
  if (selection === null) return null;
  switch (selection.kind) {
    case "application":
      return `application:${selection.applicationRootId}`;
    case "page":
      return `page:${selection.pageId}`;
    case "shell":
      return `shell:${selection.shellId}`;
    case "navigation":
      return `navigation:${selection.navigationItemId}`;
    case "flow":
      return `flow:${selection.flowId}`;
    case "placement":
      return `placement:${selection.placementId}`;
  }
};

const containsSelection = (
  index: SelectionIndex,
  selection: StudioSemanticSelection,
): boolean => {
  switch (selection.kind) {
    case "application":
      return selection.applicationRootId === index.applicationRootId;
    case "page":
      return index.pageIds.has(selection.pageId);
    case "shell":
      return index.shellIds.has(selection.shellId);
    case "navigation":
      return index.navigationItemIds.has(selection.navigationItemId);
    case "flow":
      return index.flowIds.has(selection.flowId);
    case "placement":
      return index.placementOwners.has(selection.placementId);
  }
};

const indexDraft = (draft: ApplicationDraftV2): SelectionIndex => {
  const pageIds = new Set<string>();
  const shellIds = new Set<string>();
  const navigationItemIds = new Set<string>();
  const flowIds = new Set<string>();
  const placementOwners = new Map<string, PlacementOwner>();

  const collectNavigation = (
    items: readonly ApplicationDraftV2["content"]["navigation"][number][],
  ): void => {
    for (const item of items) {
      navigationItemIds.add(item.id);
      if (item.type === "heading") collectNavigation(item.children);
    }
  };

  const collectPlacementSlot = (slot: PlacementSlotIdentitySource, owner: PlacementOwner): void => {
    for (const [placementId, rawPlacement] of Object.entries(slot.placements)) {
      placementOwners.set(placementId, owner);
      if (!isRecord(rawPlacement) || !isRecord(rawPlacement.slots)) continue;
      for (const nestedSlot of Object.values(rawPlacement.slots))
        visitCompositionSlots(nestedSlot, owner);
    }
  };

  const visitCompositionSlots = (value: unknown, owner: PlacementOwner): void => {
    if (Array.isArray(value)) {
      for (const child of value) visitCompositionSlots(child, owner);
      return;
    }
    if (!isRecord(value)) return;
    if (isPlacementSlot(value)) {
      collectPlacementSlot(value, owner);
      return;
    }
    for (const child of Object.values(value)) visitCompositionSlots(child, owner);
  };

  collectNavigation(draft.content.navigation);
  for (const flow of draft.content.flows) flowIds.add(flow.id);
  for (const shell of draft.content.shells) {
    shellIds.add(shell.shellId);
    visitCompositionSlots(shell.layout, { kind: "shell", shellId: shell.shellId });
  }
  for (const page of draft.content.pages) {
    pageIds.add(page.pageId);
    visitCompositionSlots(page.composition, { kind: "page", pageId: page.pageId });
  }

  return {
    applicationRootId: draft.envelope.rootId,
    pageIds,
    shellIds,
    navigationItemIds,
    flowIds,
    placementOwners,
  };
};

/**
 * Creates private, in-memory selection state keyed by authored identities.
 * The shared editor workspace and its revisioned draft operations belong to
 * [#545](https://github.com/Abzum-NZ/Abzum-Vortex/issues/545).
 */
export const createStudioSemanticSelectionStore = (
  initialDraft: ApplicationDraftV2,
): StudioSemanticSelectionStore => {
  let index = indexDraft(initialDraft);
  let selection: StudioSemanticSelection | null = applicationSelection(index.applicationRootId);
  const listeners = new Set<StudioSemanticSelectionListener>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener(selection);
  };

  return Object.freeze({
    getSelection: () => selection,
    select: (next: StudioSemanticSelection | null): boolean => {
      const normalized = normalizeSelection(next);
      if (normalized === undefined) return false;
      if (normalized !== null && !containsSelection(index, normalized)) return false;
      if (selectionKey(selection) === selectionKey(normalized)) return true;
      selection = normalized;
      notify();
      return true;
    },
    reconcile: (latestDraft: ApplicationDraftV2): StudioSemanticSelection | null => {
      const previousIndex = index;
      index = indexDraft(latestDraft);

      let next = selection;
      if (previousIndex.applicationRootId !== index.applicationRootId) {
        next = applicationSelection(index.applicationRootId);
      } else if (selection !== null && !containsSelection(index, selection)) {
        if (selection.kind === "placement") {
          const formerOwner = previousIndex.placementOwners.get(selection.placementId);
          const ownerSelection = formerOwner === undefined ? undefined : selectionForOwner(formerOwner);
          next =
            ownerSelection !== undefined && containsSelection(index, ownerSelection)
              ? ownerSelection
              : applicationSelection(index.applicationRootId);
        } else {
          next = applicationSelection(index.applicationRootId);
        }
      }

      if (selectionKey(selection) !== selectionKey(next)) {
        selection = next;
        notify();
      }
      return selection;
    },
    subscribe: (listener: StudioSemanticSelectionListener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
};
