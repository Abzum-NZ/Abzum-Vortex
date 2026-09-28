import type { StudioApplicationSelectionDraft, StudioSemanticSelection } from "./semantic-selection";
import {
  traverseStudioSemanticSelectionDraft,
  type StudioSemanticSelectionTraversalNode,
} from "./semantic-selection";

export type StudioSemanticOutlineNode = Readonly<{
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
  kind: StudioSemanticSelectionTraversalNode["kind"];
  label: string;
  selection: StudioSemanticSelection | null;
  children: MutableOutlineNode[];
};

const freezeOutlineNode = (node: MutableOutlineNode): StudioSemanticOutlineNode =>
  Object.freeze({
    kind: node.kind,
    label: node.label,
    selection: node.selection,
    children: Object.freeze(node.children.map(freezeOutlineNode)),
  });

/** Projects one authored Application draft into an immutable, alias-selected Studio outline. */
export const projectStudioSemanticOutline = (
  draft: StudioApplicationSelectionDraft,
): StudioSemanticOutline => {
  let root: MutableOutlineNode | undefined;
  const stack: MutableOutlineNode[] = [];

  traverseStudioSemanticSelectionDraft(draft, ({ phase, node }) => {
    if (phase === "enter") {
      const outlineNode: MutableOutlineNode = {
        kind: node.kind,
        label: node.label,
        selection: "selection" in node ? node.selection : null,
        children: [],
      };
      const parent = stack.at(-1);
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
