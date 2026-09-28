import type { ApplicationRootId, ApplicationSourceDocumentV2 } from "@vortex/contracts";

/** The editable Application source and its permanent Definition root identity. */
export type StudioApplicationSelectionDraft = Readonly<{
  rootId: ApplicationRootId;
  source: ApplicationSourceDocumentV2;
}>;

/**
 * The selected authored application item shared by Studio workspace surfaces.
 * Item aliases come from the current Application source. Puck and React Flow node
 * ids, canonical compilation ids, and layout coordinates are deliberately absent.
 */
export type StudioSemanticSelection =
  | Readonly<{ kind: "application"; applicationRootId: ApplicationRootId }>
  | Readonly<{ kind: "page"; pageAlias: string }>
  | Readonly<{ kind: "shell"; shellAlias: string }>
  | Readonly<{ kind: "navigation"; navigationItemAlias: string }>
  | Readonly<{ kind: "flow"; flowAlias: string }>
  | Readonly<{ kind: "placement"; placementAlias: string }>;

type PlacementOwner =
  | Readonly<{ kind: "page"; pageAlias: string }>
  | Readonly<{ kind: "shell"; shellAlias: string }>;

type SourcePlacementSlot = ApplicationSourceDocumentV2["body"]["shells"][number]["layout"];

type SelectionIndex = Readonly<{
  applicationRootId: ApplicationRootId;
  pageAliases: ReadonlySet<string>;
  shellAliases: ReadonlySet<string>;
  navigationItemAliases: ReadonlySet<string>;
  flowAliases: ReadonlySet<string>;
  placementOwners: ReadonlyMap<string, PlacementOwner>;
}>;

export type StudioSemanticSelectionListener = (
  selection: StudioSemanticSelection | null,
) => void;

export interface StudioSemanticSelectionStore {
  /** Returns the current semantic identity, or `null` when the editor cleared selection. */
  getSelection(): StudioSemanticSelection | null;
  /** Selects an identity present in the current source; selecting a page also switches pages. */
  select(selection: StudioSemanticSelection | null): boolean;
  /** Reconciles identities against the latest source without retaining or advancing its revision. */
  reconcile(draft: StudioApplicationSelectionDraft): StudioSemanticSelection | null;
  /** Subscribes to shared selection changes. Read the initial value with `getSelection`. */
  subscribe(listener: StudioSemanticSelectionListener): () => void;
}

const selectionForOwner = (owner: PlacementOwner): StudioSemanticSelection =>
  owner.kind === "page"
    ? Object.freeze({ kind: "page", pageAlias: owner.pageAlias })
    : Object.freeze({ kind: "shell", shellAlias: owner.shellAlias });

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
      return Object.freeze({ kind: "page", pageAlias: selection.pageAlias });
    case "shell":
      return Object.freeze({ kind: "shell", shellAlias: selection.shellAlias });
    case "navigation":
      return Object.freeze({ kind: "navigation", navigationItemAlias: selection.navigationItemAlias });
    case "flow":
      return Object.freeze({ kind: "flow", flowAlias: selection.flowAlias });
    case "placement":
      return Object.freeze({ kind: "placement", placementAlias: selection.placementAlias });
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
      return `page:${selection.pageAlias}`;
    case "shell":
      return `shell:${selection.shellAlias}`;
    case "navigation":
      return `navigation:${selection.navigationItemAlias}`;
    case "flow":
      return `flow:${selection.flowAlias}`;
    case "placement":
      return `placement:${selection.placementAlias}`;
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
      return index.pageAliases.has(selection.pageAlias);
    case "shell":
      return index.shellAliases.has(selection.shellAlias);
    case "navigation":
      return index.navigationItemAliases.has(selection.navigationItemAlias);
    case "flow":
      return index.flowAliases.has(selection.flowAlias);
    case "placement":
      return index.placementOwners.has(selection.placementAlias);
  }
};

const indexDraft = (draft: StudioApplicationSelectionDraft): SelectionIndex => {
  const pageAliases = new Set<string>();
  const shellAliases = new Set<string>();
  const navigationItemAliases = new Set<string>();
  const flowAliases = new Set<string>();
  const placementOwners = new Map<string, PlacementOwner>();

  const collectNavigation = (
    items: readonly ApplicationSourceDocumentV2["body"]["navigation"][number][],
  ): void => {
    for (const item of items) {
      navigationItemAliases.add(item.id);
      if (item.type === "heading") collectNavigation(item.children);
    }
  };

  const collectPlacementSlot = (slot: SourcePlacementSlot, owner: PlacementOwner): void => {
    for (const [placementAlias, placement] of Object.entries(slot.placements)) {
      placementOwners.set(placementAlias, owner);
      for (const childSlot of Object.values(placement.slots))
        collectPlacementSlot(childSlot, owner);
    }
  };

  collectNavigation(draft.source.body.navigation);
  for (const flow of draft.source.body.flows) flowAliases.add(flow.id);
  for (const shell of draft.source.body.shells) {
    shellAliases.add(shell.id);
    collectPlacementSlot(shell.layout, { kind: "shell", shellAlias: shell.id });
  }
  for (const page of draft.source.body.pages) {
    pageAliases.add(page.id);
    const owner = { kind: "page", pageAlias: page.id } as const;
    const composition = page.composition;
    if ("step_content" in composition) {
      if (composition.shell_kind === "default") {
        for (const slot of Object.values(composition.step_content))
          collectPlacementSlot(slot, owner);
      } else {
        for (const slots of Object.values(composition.step_content))
          for (const slot of Object.values(slots)) collectPlacementSlot(slot, owner);
      }
    } else if (composition.shell_kind === "default") {
      collectPlacementSlot(composition.main, owner);
    } else {
      for (const slot of Object.values(composition.content)) collectPlacementSlot(slot, owner);
    }
  }

  return {
    applicationRootId: draft.rootId,
    pageAliases,
    shellAliases,
    navigationItemAliases,
    flowAliases,
    placementOwners,
  };
};

/**
 * Creates private, in-memory selection state keyed by authored identities.
 * The shared editor workspace and its revisioned draft operations belong to
 * [#545](https://github.com/Abzum-NZ/Abzum-Vortex/issues/545).
 */
export const createStudioSemanticSelectionStore = (
  initialDraft: StudioApplicationSelectionDraft,
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
    reconcile: (latestDraft: StudioApplicationSelectionDraft): StudioSemanticSelection | null => {
      const previousIndex = index;
      index = indexDraft(latestDraft);

      let next = selection;
      if (previousIndex.applicationRootId !== index.applicationRootId) {
        next = applicationSelection(index.applicationRootId);
      } else if (selection !== null && !containsSelection(index, selection)) {
        if (selection.kind === "placement") {
          const formerOwner = previousIndex.placementOwners.get(selection.placementAlias);
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
