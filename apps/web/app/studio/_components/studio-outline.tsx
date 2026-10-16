"use client";
import { Button } from "@vortex/ui/components/button";
import { studioSemanticSelectionKey, type StudioSemanticOutlineNode } from "@vortex/ui/studio";

/** The workspace outline: a tree of the application's pages, layouts, menu entries and flows by their business names. */
export function StudioOutline({ node, selectedKey, choose, disabled = false }: {
  node: StudioSemanticOutlineNode;
  selectedKey: string;
  choose: (node: StudioSemanticOutlineNode) => void;
  disabled?: boolean;
}) {
  return <li className="space-y-1">
    {node.selection === null ? <span className="block break-words text-sm text-muted-foreground" title={node.label}>{node.label}</span>
      : <Button type="button" variant="outline" size="sm" disabled={disabled} title={node.label}
        className="h-auto w-full justify-start whitespace-normal py-1 text-left"
        aria-pressed={selectedKey === studioSemanticSelectionKey(node.selection)} onClick={() => choose(node)}>
        <span className="min-w-0 break-words">{node.label}</span>
      </Button>}
    {node.children.length > 0 && <ul className="space-y-1 border-l border-border pl-3">
      {node.children.map((child) => <StudioOutline key={child.key} node={child} selectedKey={selectedKey} choose={choose} disabled={disabled} />)}
    </ul>}
  </li>;
}
