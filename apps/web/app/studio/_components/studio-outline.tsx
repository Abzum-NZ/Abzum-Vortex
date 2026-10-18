"use client";
import { Badge } from "@vortex/ui/components/badge";
import { studioSemanticSelectionKey, type StudioSemanticOutlineNode } from "@vortex/ui/studio";
import { StudioNavTree, type StudioNavNode } from "./studio-nav-tree";

/** Both semantic navigators use the same keyboard tree and selection. */
export function StudioOutline({
  nodes,
  selectedKey,
  choose,
  disabled = false,
  homePageKey,
  searching = false,
  label = "Outline tree",
}: Readonly<{
  nodes: readonly StudioSemanticOutlineNode[];
  selectedKey: string;
  choose: (node: StudioSemanticOutlineNode) => void;
  disabled?: boolean;
  homePageKey?: string | undefined;
  searching?: boolean;
  label?: string;
}>) {
  const project = (node: StudioSemanticOutlineNode): StudioNavNode => ({
    key: node.key,
    label: node.label,
    icon:
      node.selection?.kind === "shell"
        ? "grid"
        : node.selection?.kind === "page"
          ? "panel-left"
          : "blocks",
    selected: node.selection !== null && selectedKey === studioSemanticSelectionKey(node.selection),
    meta:
      node.selection !== null && studioSemanticSelectionKey(node.selection) === homePageKey ? (
        <Badge variant="secondary">Home</Badge>
      ) : undefined,
    onSelect: () => choose(node),
    children: node.children.map(project),
  });
  return (
    <StudioNavTree
      nodes={nodes.map(project)}
      label={label}
      disabled={disabled}
      expandAll={searching}
    />
  );
}
