import {
  readSourceItem,
  reservedItemPropKeys,
  sourcePageRootSlots,
  type ApplicationRootId,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
  type SourcePageData,
} from "@vortex/platform/schema";

/**
 * The editable Application source, its permanent Definition root identity and the block catalogue
 * whose releases decide which props of a placed item are child slots.
 */
export type StudioApplicationSelectionDraft = Readonly<{
  rootId: ApplicationRootId;
  source: ApplicationSourceDocument;
  catalogue: ImmutablePlatformBlockCatalogue;
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
  | Readonly<{ kind: "placement"; placementAlias: string }>
  /** A Module the Application owns or uses, by its key; the Data tab shows it. */
  | Readonly<{ kind: "module"; moduleKey: string }>
  /** A record type of an owned or used Module, by the Module key and its permanent key. */
  | Readonly<{ kind: "record_type"; moduleKey: string; recordKey: string }>
  /** A field of a record type, by its permanent key. */
  | Readonly<{ kind: "field"; moduleKey: string; recordKey: string; fieldKey: string }>
  /** A query of an owned or used Module, by its key. */
  | Readonly<{ kind: "query"; moduleKey: string; queryKey: string }>;

/** The Data tab's kinds of selection: Modules and what they hold. */
export type StudioDataSelection = Extract<StudioSemanticSelection, { kind: "module" | "record_type" | "field" | "query" }>;

/** Whether a selection is one the Data tab shows. */
export const isStudioDataSelection = (selection: StudioSemanticSelection | null): selection is StudioDataSelection =>
  selection !== null && (selection.kind === "module" || selection.kind === "record_type" ||
    selection.kind === "field" || selection.kind === "query");

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
      /** The placed block's release and plain authored settings, so a surface can name the item. */
      block: Readonly<{ block_id: string; release_version: string }>;
      settings: Readonly<Record<string, unknown>>;
    }>;

export type StudioSemanticSelectionTraversalEvent = Readonly<{
  phase: "enter" | "exit";
  node: StudioSemanticSelectionTraversalNode;
}>;

export type StudioSemanticSelectionTraversalListener = (
  event: StudioSemanticSelectionTraversalEvent,
) => void;

type SelectionIndex = Readonly<{
  applicationRootId: ApplicationRootId;
  pageAliases: ReadonlySet<string>;
  shellAliases: ReadonlySet<string>;
  navigationItemAliases: ReadonlySet<string>;
  flowAliases: ReadonlySet<string>;
  placementOwners: ReadonlyMap<string, StudioSemanticPlacementOwner>;
  /** Owned Module keys, and the keys of their record types, fields and queries. */
  dataKeys: ReadonlySet<string>;
  /** Used Module keys: their owner defines what they hold, so any of their items may be selected. */
  usedModuleKeys: ReadonlySet<string>;
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

/**
 * The item's child slots as its block release declares them (read by `readSourceItem`), with the
 * items placed in each; every other prop but `id` and `vortex` is a plain setting. An item whose
 * release the catalogue does not hold has no slots.
 */
const itemPropsByRole = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem) => {
  const { block_id: blockId, release_version: releaseVersion } = item.props.vortex.block;
  const release = catalogue.releases.find(
    (candidate) => candidate.blockId === blockId && candidate.releaseVersion === releaseVersion,
  );
  const slots: [string, SourceItem[]][] = [];
  if (release !== undefined)
    for (const [key, slot] of readSourceItem(item, release).slots)
      if (slot.items !== undefined) slots.push([key, slot.items]);
  const slotKeys = new Set(slots.map(([key]) => key));
  const settings = Object.fromEntries(
    Object.entries(item.props).filter(
      ([key]) => !reservedItemPropKeys.has(key) && !slotKeys.has(key),
    ),
  );
  return { slots, settings };
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
    items: readonly SourceItem[],
    owner: StudioSemanticPlacementOwner,
    slotAlias: string,
    label: string,
  ): void => {
    visit(Object.freeze({ kind: "slot", slotAlias, label }), () => {
      for (const item of items) {
        const placementAlias = item.props.id;
        const { slots, settings } = itemPropsByRole(draft.catalogue, item);
        const selection = Object.freeze({ kind: "placement", placementAlias } as const);
        visit(
          Object.freeze({
            kind: "placement",
            label: `Item ${readableKey(placementAlias, "item")}`,
            selection,
            owner,
            block: Object.freeze({
              block_id: String(item.props.vortex.block.block_id),
              release_version: String(item.props.vortex.block.release_version),
            }),
            settings,
          }),
          () => {
            for (const [slotKey, childSlot] of slots)
              placementSlot(childSlot, owner, slotKey, readableKey(slotKey, "Content"));
          },
        );
      }
    });
  };

  const shellForAlias = (alias: string) =>
    draft.source.body.shells.find((shell) => shell.id === alias);

  /** One page's (or one guided step's) data: the default frame's content or each shell slot. */
  const pageData = (data: SourcePageData, owner: StudioSemanticPlacementOwner): void => {
    const shellAlias = data.root.props.vortex.shell;
    if (shellAlias === null) {
      placementSlot(data.content, owner, "main", "Main");
      return;
    }
    const slots = Object.fromEntries(sourcePageRootSlots(data));
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
    items: readonly ApplicationSourceDocument["body"]["navigation"][number][],
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
      visit(Object.freeze({ kind: "section", section: "shells", label: "Layouts" }), () => {
        for (const shell of draft.source.body.shells) {
          const owner = Object.freeze({ kind: "shell", shellAlias: shell.id } as const);
          const selection = owner;
          visit(
            Object.freeze({
              kind: "shell",
              label: authoredLabel(shell.name, "Layout"),
              selection,
            }),
            () => placementSlot(shell.layout.content, owner, "layout", "Layout"),
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
                      const stepData = composition.step_content[step.id];
                      if (stepData !== undefined) pageData(stepData, pageOwner);
                    },
                  );
                }
              } else pageData(page.composition, pageOwner);
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
    case "module":
      return Object.freeze({ kind: "module", moduleKey: selection.moduleKey });
    case "record_type":
      return Object.freeze({ kind: "record_type", moduleKey: selection.moduleKey, recordKey: selection.recordKey });
    case "field":
      return Object.freeze({ kind: "field", moduleKey: selection.moduleKey, recordKey: selection.recordKey, fieldKey: selection.fieldKey });
    case "query":
      return Object.freeze({ kind: "query", moduleKey: selection.moduleKey, queryKey: selection.queryKey });
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
    case "module":
      return `module:${selection.moduleKey}`;
    case "record_type":
      return `record_type:${selection.moduleKey}:${selection.recordKey}`;
    case "field":
      return `field:${selection.moduleKey}:${selection.recordKey}.${selection.fieldKey}`;
    case "query":
      return `query:${selection.moduleKey}:${selection.queryKey}`;
  }
};

/** The item that holds a Data selection: a field's record type, a record type's or query's Module. */
const dataParent = (selection: StudioSemanticSelection): StudioSemanticSelection | undefined => {
  switch (selection.kind) {
    case "field": return { kind: "record_type", moduleKey: selection.moduleKey, recordKey: selection.recordKey };
    case "record_type": case "query": return { kind: "module", moduleKey: selection.moduleKey };
    default: return undefined;
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
    case "module":
    case "record_type":
    case "field":
    case "query":
      return index.usedModuleKeys.has(selection.moduleKey) || index.dataKeys.has(studioSemanticSelectionKey(selection));
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

  const dataKeys = new Set<string>();
  for (const module of draft.source.body.modules) {
    const moduleKey = module.key;
    dataKeys.add(studioSemanticSelectionKey({ kind: "module", moduleKey }));
    for (const record of module.record_types) {
      dataKeys.add(studioSemanticSelectionKey({ kind: "record_type", moduleKey, recordKey: record.key }));
      for (const field of record.fields)
        dataKeys.add(studioSemanticSelectionKey({ kind: "field", moduleKey, recordKey: record.key, fieldKey: field.key }));
    }
    for (const query of module.queries) dataKeys.add(studioSemanticSelectionKey({ kind: "query", moduleKey, queryKey: query.key }));
  }

  return {
    dataKeys,
    usedModuleKeys: new Set(draft.source.body.uses.map((use) => use.module)),
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
          // A Data item that left the draft selects what held it, when that is still there.
          let parent = dataParent(selection);
          while (parent !== undefined && !containsSelection(index, parent)) parent = dataParent(parent);
          next = parent ?? applicationSelection(index.applicationRootId);
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
  type StudioPlacementDescriber,
  type StudioSemanticOutline,
  type StudioSemanticOutlineNode,
} from "./semantic-outline";
