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

export type StudioSemanticPlacementOwner = Extract<
  StudioSemanticSelection,
  { kind: "page" | "shell" }
>;

export type StudioSemanticSelectionTraversalNode =
  | Readonly<{
      kind: "application";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "application" }>;
    }>
  | Readonly<{
      kind: "section";
      section: "navigation" | "flows" | "shells" | "pages";
      label: string;
    }>
  | Readonly<{
      kind: "navigation";
      itemType: "heading" | "page" | "external";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "navigation" }>;
    }>
  | Readonly<{
      kind: "flow";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "flow" }>;
    }>
  | Readonly<{
      kind: "shell";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "shell" }>;
    }>
  | Readonly<{
      kind: "page";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "page" }>;
    }>
  | Readonly<{ kind: "guided_step"; stepAlias: string; label: string }>
  | Readonly<{ kind: "slot"; slotAlias: string; label: string }>
  | Readonly<{
      kind: "placement";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "placement" }>;
      owner: StudioSemanticPlacementOwner;
    }>;

export type StudioSemanticSelectionTraversalEvent = Readonly<{
  phase: "enter" | "exit";
  node: StudioSemanticSelectionTraversalNode;
}>;

export type StudioSemanticSelectionTraversalListener = (
  event: StudioSemanticSelectionTraversalEvent,
) => void;

type SourcePlacementSlot = ApplicationSourceDocumentV2["body"]["shells"][number]["layout"];

type SelectionIndex = Readonly<{
  applicationRootId: ApplicationRootId;
  pageAliases: ReadonlySet<string>;
  shellAliases: ReadonlySet<string>;
  navigationItemAliases: ReadonlySet<string>;
  flowAliases: ReadonlySet<string>;
  placementOwners: ReadonlyMap<string, StudioSemanticPlacementOwner>;
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

const applicationSelection = (
  applicationRootId: ApplicationRootId,
): Extract<StudioSemanticSelection, { kind: "application" }> =>
  Object.freeze({ kind: "application", applicationRootId });

const authoredLabel = (value: string | undefined, fallback: string): string => {
  const label = value?.trim();
  return label ? label : fallback;
};

const readableKey = (value: string | undefined, fallback: string): string => {
  const key = value?.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  if (!key) return fallback;
  return key[0]!.toUpperCase() + key.slice(1);
};

/**
 * Walks the authored Application once in display order, exposing only safe labels,
 * semantic selections, and owner context. Studio surfaces share this walk so the
 * outline and selection store cannot develop different identity or ordering rules.
 */
export const traverseStudioSemanticSelectionDraft = (
  draft: StudioApplicationSelectionDraft,
  listener: StudioSemanticSelectionTraversalListener,
): void => {
  const visit = (
    node: StudioSemanticSelectionTraversalNode,
    children?: () => void,
  ): void => {
    listener(Object.freeze({ phase: "enter", node }));
    children?.();
    listener(Object.freeze({ phase: "exit", node }));
  };

  const placementSlot = (
    slot: SourcePlacementSlot,
    owner: StudioSemanticPlacementOwner,
    slotAlias: string,
    label: string,
  ): void => {
    visit(Object.freeze({ kind: "slot", slotAlias, label }), () => {
      for (const placementAlias of slot.order.desktop) {
        const placement = slot.placements[placementAlias];
        if (placement === undefined) continue;
        const selection = Object.freeze({ kind: "placement", placementAlias } as const);
        visit(
          Object.freeze({
            kind: "placement",
            label: `Placement ${readableKey(placementAlias, "item")}`,
            selection,
            owner,
          }),
          () => {
            for (const [slotKey, childSlot] of Object.entries(placement.slots))
              placementSlot(childSlot, owner, slotKey, readableKey(slotKey, "Content"));
          },
        );
      }
    });
  };

  const shellForAlias = (alias: string) =>
    draft.source.body.shells.find((shell) => shell.id === alias);

  const pageSlots = (
    slots: Readonly<Record<string, SourcePlacementSlot>>,
    shellAlias: string,
    owner: StudioSemanticPlacementOwner,
  ): void => {
    const shell = shellForAlias(shellAlias);
    const visited = new Set<string>();
    for (const contentSlot of shell?.content_slots ?? []) {
      const slot = slots[contentSlot.id];
      if (slot === undefined) continue;
      visited.add(contentSlot.id);
      placementSlot(slot, owner, contentSlot.id, authoredLabel(contentSlot.label, "Content"));
    }
    for (const [slotAlias, slot] of Object.entries(slots)) {
      if (visited.has(slotAlias)) continue;
      placementSlot(slot, owner, slotAlias, readableKey(slotAlias, "Content"));
    }
  };

  const navigation = (
    items: readonly ApplicationSourceDocumentV2["body"]["navigation"][number][],
  ): void => {
    for (const item of items) {
      const selection = Object.freeze({
        kind: "navigation",
        navigationItemAlias: item.id,
      } as const);
      const fallback =
        item.type === "heading"
          ? "Navigation heading"
          : item.type === "page"
            ? "Page link"
            : "External link";
      visit(
        Object.freeze({
          kind: "navigation",
          itemType: item.type,
          label: authoredLabel(item.label, fallback),
          selection,
        }),
        item.type === "heading" ? () => navigation(item.children) : undefined,
      );
    }
  };

  const rootSelection = applicationSelection(draft.rootId);
  visit(
    Object.freeze({
      kind: "application",
      label: authoredLabel(draft.source.body.name, "Application"),
      selection: rootSelection,
    }),
    () => {
      visit(Object.freeze({ kind: "section", section: "navigation", label: "Navigation" }), () =>
        navigation(draft.source.body.navigation),
      );
      visit(Object.freeze({ kind: "section", section: "shells", label: "Shells" }), () => {
        for (const shell of draft.source.body.shells) {
          const owner = Object.freeze({ kind: "shell", shellAlias: shell.id } as const);
          const selection = owner;
          visit(
            Object.freeze({
              kind: "shell",
              label: authoredLabel(shell.name, "Shell"),
              selection,
            }),
            () => placementSlot(shell.layout, owner, "layout", "Layout"),
          );
        }
      });
      visit(Object.freeze({ kind: "section", section: "pages", label: "Pages" }), () => {
        for (const page of draft.source.body.pages) {
          const pageOwner = Object.freeze({ kind: "page", pageAlias: page.id } as const);
          visit(
            Object.freeze({
              kind: "page",
              label: authoredLabel(page.name, "Page"),
              selection: pageOwner,
            }),
            () => {
              if (page.type === "guided_form") {
                const composition = page.composition;
                for (const step of page.steps) {
                  visit(
                    Object.freeze({
                      kind: "guided_step",
                      stepAlias: step.id,
                      label: authoredLabel(step.name, "Step"),
                    }),
                    () => {
                      if (composition.shell_kind === "default") {
                        const stepSlot = composition.step_content[step.id];
                        if (stepSlot === undefined) return;
                        placementSlot(stepSlot, pageOwner, "main", "Main");
                      } else {
                        const stepSlots = composition.step_content[step.id];
                        if (stepSlots === undefined) return;
                        pageSlots(stepSlots, composition.shell, pageOwner);
                      }
                    },
                  );
                }
              } else {
                const composition = page.composition;
                if (composition.shell_kind === "default")
                  placementSlot(composition.main, pageOwner, "main", "Main");
                else pageSlots(composition.content, composition.shell, pageOwner);
              }
            },
          );
        }
      });
      visit(Object.freeze({ kind: "section", section: "flows", label: "Flows" }), () => {
        for (const flow of draft.source.body.flows) {
          const selection = Object.freeze({ kind: "flow", flowAlias: flow.id } as const);
          visit(
            Object.freeze({
              kind: "flow",
              label: readableKey(flow.key, "Flow"),
              selection,
            }),
          );
        }
      });
    },
  );
};

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

/** A stable key for authored selection identities, independent of labels and positions. */
export const studioSemanticSelectionKey = (selection: StudioSemanticSelection): string => {
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

const selectionKey = (selection: StudioSemanticSelection | null): string | null =>
  selection === null ? null : studioSemanticSelectionKey(selection);

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
  const placementOwners = new Map<string, StudioSemanticPlacementOwner>();

  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase !== "enter") return;
    switch (node.kind) {
      case "navigation":
        navigationItemAliases.add(node.selection.navigationItemAlias);
        break;
      case "flow":
        flowAliases.add(node.selection.flowAlias);
        break;
      case "shell":
        shellAliases.add(node.selection.shellAlias);
        break;
      case "page":
        pageAliases.add(node.selection.pageAlias);
        break;
      case "placement":
        placementOwners.set(node.selection.placementAlias, node.owner);
        break;
    }
  });

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
          const ownerSelection = previousIndex.placementOwners.get(selection.placementAlias);
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

export {
  projectStudioSemanticOutline,
  type StudioSemanticOutline,
  type StudioSemanticOutlineNode,
} from "./semantic-outline";
