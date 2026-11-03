import {
  flowTaskChildLists,
  type ApplicationSourceDocument,
  type SourceFlowTask,
  type VortexIconName,
} from "@vortex/platform/schema";
import type {
  StudioApplicationSelectionDraft,
  StudioSemanticSelection,
} from "./semantic-selection";
import {
  studioSemanticSelectionKey,
  traverseStudioSemanticSelectionDraft,
  type StudioSemanticSelectionTraversalNode,
} from "./semantic-selection";

export type StudioSemanticOutlineNode = Readonly<{
  /** Stable tree key for rendering; selection remains the shared editor identity. */
  key: string;
  kind: StudioSemanticSelectionTraversalNode["kind"];
  label: string;
  icon: VortexIconName;
  selection: StudioSemanticSelection | null;
  children: readonly StudioSemanticOutlineNode[];
}>;

export type StudioSemanticOutline = StudioSemanticOutlineNode &
  Readonly<{
    kind: "application";
    selection: Extract<StudioSemanticSelection, { kind: "application" }>;
  }>;

type MutableOutlineNode = {
  key: string;
  kind: StudioSemanticSelectionTraversalNode["kind"];
  label: string;
  icon: VortexIconName;
  selection: StudioSemanticSelection | null;
  children: MutableOutlineNode[];
};

const freezeOutlineNode = (node: MutableOutlineNode): StudioSemanticOutlineNode =>
  Object.freeze({
    key: node.key,
    kind: node.kind,
    label: node.label,
    icon: node.icon,
    selection: node.selection,
    children: Object.freeze(node.children.map(freezeOutlineNode)),
  });

const outlineKey = (
  node: StudioSemanticSelectionTraversalNode,
  parentKey: string | undefined,
): string => {
  if ("selection" in node) return studioSemanticSelectionKey(node.selection);
  if (node.kind === "section") return JSON.stringify([parentKey, "section", node.section]);
  if (node.kind === "guided_step")
    return JSON.stringify([parentKey, "guided_step", node.stepAlias]);
  return JSON.stringify([parentKey, "slot", node.slotAlias]);
};

/** The forms flows show: the form each Show form step names, by block name. */
const formsShownByFlows = (source: ApplicationSourceDocument): Set<string> => {
  const shown = new Set<string>();
  const visit = (tasks: readonly SourceFlowTask[]): void => {
    for (const task of tasks) {
      if (task.type === "interface.show_form" && "properties" in task) {
        const form = task.properties.form;
        const named = form?.kind === "literal" ? form.literal.value : undefined;
        if (typeof named === "string") shown.add(named.slice(named.lastIndexOf(":") + 1));
      }
      for (const child of flowTaskChildLists(task as Parameters<typeof flowTaskChildLists>[0]))
        visit(child.tasks as readonly SourceFlowTask[]);
    }
  };
  for (const flow of [
    ...source.body.flows,
    ...source.body.modules.flatMap((module) => module.flows),
  ])
    visit([...flow.tasks, ...flow.errors, ...flow.finally]);
  return shown;
};

/**
 * A page lists the forms its flows show apart from its content, under "Shown by flows": they are
 * hidden on the page, so the group keeps them in reach for editing.
 */
const groupShownForms = (page: MutableOutlineNode, shown: ReadonlySet<string>): void => {
  const moved: MutableOutlineNode[] = [];
  const take = (node: MutableOutlineNode): void => {
    node.children = node.children.filter((child) => {
      if (
        child.kind === "placement" &&
        child.selection?.kind === "placement" &&
        shown.has(child.selection.placementAlias)
      ) {
        moved.push(child);
        return false;
      }
      take(child);
      return true;
    });
  };
  take(page);
  if (moved.length > 0)
    page.children.push({
      key: JSON.stringify([page.key, "slot", "shown_by_flows"]),
      kind: "slot",
      label: "Shown by flows",
      icon: "list-tree",
      selection: null,
      children: moved,
    });
};

/** Names a placed block for a person from its release and settings; `undefined` keeps the generic fallback. */
export type StudioPlacementDescriber = (
  placement: Readonly<{
    block: Readonly<{ block_id: string; release_version: string }>;
    settings: Readonly<Record<string, unknown>>;
  }>,
) => string | undefined;

/**
 * Projects one authored Application draft into an immutable, alias-selected Studio outline.
 * `describePlacement` supplies the business label of a placed block (display name and item label).
 */
export const projectStudioSemanticOutline = (
  draft: StudioApplicationSelectionDraft,
  describePlacement?: StudioPlacementDescriber,
): StudioSemanticOutline => {
  const pageKindIcons = {
    list: "menu",
    detail: "file-text",
    dashboard: "grid",
    form: "sliders-horizontal",
    guided_form: "list-tree",
    public: "eye",
  } satisfies Record<ApplicationSourceDocument["body"]["pages"][number]["type"], VortexIconName>;
  const pageIcons = new Map<string, VortexIconName>(
    draft.source.body.pages.map((page) => [page.id, pageKindIcons[page.type]]),
  );
  let root: MutableOutlineNode | undefined;
  const stack: MutableOutlineNode[] = [];

  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase === "enter") {
      const parent = stack.at(-1);
      const outlineNode: MutableOutlineNode = {
        key: outlineKey(node, parent?.key),
        kind: node.kind,
        label: (node.kind === "placement" ? describePlacement?.(node) : undefined) ?? node.label,
        icon:
          node.kind === "page"
            ? pageIcons.get(node.selection.pageAlias)!
            : node.kind === "shell"
              ? "grid"
              : "blocks",
        selection: "selection" in node ? node.selection : null,
        children: [],
      };
      if (parent === undefined) root = outlineNode;
      else parent.children.push(outlineNode);
      stack.push(outlineNode);
      return;
    }
    stack.pop();
  });

  const shown = formsShownByFlows(draft.source);
  const groupPages = (node: MutableOutlineNode): void => {
    if (node.kind === "page") groupShownForms(node, shown);
    else node.children.forEach(groupPages);
  };
  if (root !== undefined && shown.size > 0) groupPages(root);

  const frozen = root === undefined ? undefined : freezeOutlineNode(root);
  return frozen as StudioSemanticOutline;
};
