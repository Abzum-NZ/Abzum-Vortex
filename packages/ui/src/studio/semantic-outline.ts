import {
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  type ApplicationSourceDocument,
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
    draft.source.body.pages.map((page) => [
      page.id,
      sourcePageItems(page.composition).some(
        (item) =>
          item.props.vortex.block.block_id ===
          PLATFORM_BLOCK_RELEASE_IDENTITIES.BOARD_BLOCK_RELEASE.blockId,
      )
        ? "panel-left"
        : pageKindIcons[page.type],
    ]),
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

  const frozen = root === undefined ? undefined : freezeOutlineNode(root);
  return frozen as StudioSemanticOutline;
};
