import type { StudioApplicationSelectionDraft, StudioSemanticSelection } from "./semantic-selection";
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
  selection: StudioSemanticSelection | null;
  children: MutableOutlineNode[];
};

const freezeOutlineNode = (node: MutableOutlineNode): StudioSemanticOutlineNode =>
  Object.freeze({
    key: node.key,
    kind: node.kind,
    label: node.label,
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

/** Projects one authored Application draft into an immutable, alias-selected Studio outline. */
export const projectStudioSemanticOutline = (
  draft: StudioApplicationSelectionDraft,
): StudioSemanticOutline => {
  let root: MutableOutlineNode | undefined;
  const stack: MutableOutlineNode[] = [];

  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase === "enter") {
      const parent = stack.at(-1);
      const outlineNode: MutableOutlineNode = {
        key: outlineKey(node, parent?.key),
        kind: node.kind,
        label: node.label,
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
