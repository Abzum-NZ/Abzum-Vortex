import {
  flowTaskRegistry,
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
  /** A flow of the application (`moduleKey` null) or of one of the Modules it owns. */
  | Readonly<{ kind: "flow"; flowAlias: string; moduleKey: string | null }>
  /** One step of such a flow, by its task id (unique within the flow). */
  | Readonly<{ kind: "flow_step"; flowAlias: string; moduleKey: string | null; taskId: string }>
  | Readonly<{ kind: "placement"; placementAlias: string }>;

type SourceFlowTaskOf = ApplicationSourceDocument["body"]["flows"][number]["tasks"][number];

/** Every authored task of a flow in display order, with its path inside the flow. */
export const studioFlowTaskEntries = (
  flow: Readonly<{ tasks: readonly SourceFlowTaskOf[]; errors?: readonly SourceFlowTaskOf[] | undefined;
    finally?: readonly SourceFlowTaskOf[] | undefined }>,
): Readonly<{ task: SourceFlowTaskOf; path: readonly (string | number)[] }>[] => {
  const entries: { task: SourceFlowTaskOf; path: readonly (string | number)[] }[] = [];
  const walk = (tasks: readonly SourceFlowTaskOf[] | undefined, path: readonly (string | number)[]) => {
    (tasks ?? []).forEach((task, index) => {
      const taskPath = [...path, index];
      entries.push({ task, path: taskPath });
      if ("then" in task) { walk(task.then, [...taskPath, "then"]); walk(task.else, [...taskPath, "else"]); }
      if ("cases" in task) {
        task.cases.forEach((branch, caseIndex) => walk(branch.tasks, [...taskPath, "cases", caseIndex, "tasks"]));
        walk(task.default, [...taskPath, "default"]);
      }
      if ("tasks" in task) walk(task.tasks, [...taskPath, "tasks"]);
      if ("branches" in task) task.branches.forEach((branch, branchIndex) => walk(branch, [...taskPath, "branches", branchIndex]));
    });
  };
  walk(flow.tasks, ["tasks"]);
  walk(flow.errors, ["errors"]);
  walk(flow.finally, ["finally"]);
  return entries;
};

/** The flow a flow or flow-step selection belongs to. */
export const studioFlowOfSelection = (
  selection: StudioSemanticSelection | null,
): Extract<StudioSemanticSelection, { kind: "flow" }> | null =>
  selection?.kind === "flow" ? selection
    : selection?.kind === "flow_step"
      ? Object.freeze({ kind: "flow", flowAlias: selection.flowAlias, moduleKey: selection.moduleKey })
      : null;

const studioWords = (key: string): string => {
  const words = key.trim().replace(/[-_.]+/g, " ").replace(/\s+/g, " ");
  return words === "" ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

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
      kind: "flow_step";
      label: string;
      selection: Extract<StudioSemanticSelection, { kind: "flow_step" }>;
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
  /** Flow selection keys: a flow alias is unique only within its owner. */
  flowKeys: ReadonlySet<string>;
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

/** A flow's name as a person reads it: its authored name label, else its readable key. */
export const studioFlowLabel = (flow: Readonly<{ key: string; labels?: Readonly<Record<string, string>> | undefined }>): string =>
  authoredLabel(flow.labels?.name, readableKey(flow.key, "Flow"));

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
        const owners = [
          { moduleKey: null, flows: draft.source.body.flows },
          ...draft.source.body.modules.map((module) => ({ moduleKey: module.key, flows: module.flows })),
        ];
        for (const owner of owners)
          for (const flow of owner.flows) {
            const selection = Object.freeze({
              kind: "flow", flowAlias: flow.id, moduleKey: owner.moduleKey,
            } as const);
            visit(Object.freeze({ kind: "flow", label: studioFlowLabel(flow), selection }), () => {
              for (const { task } of studioFlowTaskEntries(flow))
                visit(Object.freeze({
                  kind: "flow_step",
                  label: Object.values(flowTaskRegistry).find((entry) => entry.type === task.type)?.title ?? studioWords(task.type),
                  selection: Object.freeze({ kind: "flow_step", flowAlias: flow.id, moduleKey: owner.moduleKey, taskId: task.id } as const),
                }));
            });
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
      return typeof selection.moduleKey === "string" || selection.moduleKey === null
        ? Object.freeze({ kind: "flow", flowAlias: selection.flowAlias, moduleKey: selection.moduleKey })
        : undefined;
    case "flow_step":
      return (typeof selection.moduleKey === "string" || selection.moduleKey === null) && typeof selection.taskId === "string"
        ? Object.freeze({ kind: "flow_step", flowAlias: selection.flowAlias, moduleKey: selection.moduleKey, taskId: selection.taskId })
        : undefined;
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
      return `flow:${selection.moduleKey ?? ""}:${selection.flowAlias}`;
    case "flow_step":
      return `flow_step:${selection.moduleKey ?? ""}:${selection.flowAlias}:${selection.taskId}`;
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
      return index.flowKeys.has(studioSemanticSelectionKey(selection));
    case "flow_step":
      return index.flowKeys.has(studioSemanticSelectionKey(selection));
    case "placement":
      return index.placementOwners.has(selection.placementAlias);
  }
};

const indexDraft = (draft: StudioApplicationSelectionDraft): SelectionIndex => {
  const pageAliases = new Set<string>();
  const shellAliases = new Set<string>();
  const navigationItemAliases = new Set<string>();
  const flowKeys = new Set<string>();
  const placementOwners = new Map<string, StudioSemanticPlacementOwner>();

  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase !== "enter") return;
    switch (node.kind) {
      case "navigation":
        navigationItemAliases.add(node.selection.navigationItemAlias);
        break;
      case "flow":
        flowKeys.add(studioSemanticSelectionKey(node.selection));
        break;
      case "flow_step":
        flowKeys.add(studioSemanticSelectionKey(node.selection));
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
    flowKeys,
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
        } else if (selection.kind === "flow_step") {
          // A removed step leaves its flow selected.
          const flow = studioFlowOfSelection(selection);
          next = flow !== null && containsSelection(index, flow) ? flow : applicationSelection(index.applicationRootId);
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
  type StudioPlacementDescriber,
  type StudioSemanticOutline,
  type StudioSemanticOutlineNode,
} from "./semantic-outline";
