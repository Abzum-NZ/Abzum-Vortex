import {
  studioSemanticSelectionKey,
  type StudioSemanticOutlineNode,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";

/** The words a builder sees for each kind of item; aliases and internal kind names never appear. */
export const studioKindLabel = (
  kind: StudioSemanticSelection["kind"] | "section" | "guided_step" | "slot",
): string => {
  switch (kind) {
    case "application":
      return "Application";
    case "page":
      return "Page";
    case "shell":
      return "Layout";
    case "navigation":
      return "Menu entry";
    case "flow":
      return "Flow";
    case "flow_step":
      return "Flow step";
    case "placement":
      return "Item";
    case "section":
      return "Group";
    case "guided_step":
      return "Step";
    case "slot":
      return "Area";
    case "module":
      return "Module";
    case "record_type":
      return "Record type";
    case "field":
      return "Field";
    case "query":
      return "Query";
    case "role":
      return "Role";
  }
};

/** Selection key to business label for every item in the outline. */
export const studioOutlineLabels = (
  node: StudioSemanticOutlineNode,
  into = new Map<string, string>(),
): Map<string, string> => {
  if (node.selection !== null) into.set(studioSemanticSelectionKey(node.selection), node.label);
  for (const child of node.children) studioOutlineLabels(child, into);
  return into;
};

/** The business label of a placed item by its authored name, read from the draft's one outline. */
export const studioPlacementLabel = (
  labels: ReadonlyMap<string, string>,
  placementAlias: string,
): string | undefined =>
  labels.get(studioSemanticSelectionKey({ kind: "placement", placementAlias }));
