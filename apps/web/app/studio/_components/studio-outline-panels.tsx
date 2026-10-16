"use client";
import { useMemo, useState, type ReactNode } from "react";
import type { StudioSemanticOutline, StudioSemanticOutlineNode } from "@vortex/ui/studio";
import { StudioPanelShell, StudioSearchBox } from "./studio-frame";
import { StudioOutline } from "./studio-outline";

/**
 * The rail panels drawn from the one semantic outline of the draft: Structure (the application, its
 * layouts and pages), Outline (the blocks of what the canvas shows), Menu and Flows. Each is a view of
 * the same tree, so a selection made in any of them is the workspace's one selection.
 */

type Choose = (node: StudioSemanticOutlineNode) => void;

const sectionOf = (outline: StudioSemanticOutline, section: string): StudioSemanticOutlineNode | undefined =>
  outline.children.find((child) => child.key === JSON.stringify([outline.key, "section", section]));

const findNode = (node: StudioSemanticOutlineNode, key: string): StudioSemanticOutlineNode | undefined => {
  if (node.key === key) return node;
  for (const child of node.children) {
    const found = findNode(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Keeps the nodes whose label matches, with the branches that lead to them. */
const filterNodes = (nodes: readonly StudioSemanticOutlineNode[], query: string): readonly StudioSemanticOutlineNode[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return nodes;
  return nodes.flatMap((node) => {
    if (node.label.toLocaleLowerCase().includes(needle)) return [node];
    const children = filterNodes(node.children, needle);
    return children.length === 0 ? [] : [{ ...node, children }];
  });
};

const withoutChildren = (node: StudioSemanticOutlineNode): StudioSemanticOutlineNode => ({ ...node, children: [] });

function OutlineList({ nodes, selectedKey, choose, disabled, empty }: Readonly<{
  nodes: readonly StudioSemanticOutlineNode[]; selectedKey: string; choose: Choose; disabled: boolean; empty: string;
}>) {
  if (nodes.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return <ul className="list-none space-y-1">
    {nodes.map((node) => <StudioOutline key={node.key} node={node} selectedKey={selectedKey} choose={choose} disabled={disabled} />)}
  </ul>;
}

type PanelProps = Readonly<{
  outline: StudioSemanticOutline; selectedKey: string; choose: Choose; disabled: boolean; hidden: boolean;
}>;

export function StudioStructurePanel({ outline, selectedKey, choose, disabled, hidden }: PanelProps) {
  const [query, setQuery] = useState("");
  // The application, its layouts and its pages; their blocks are in the Outline tab.
  const tree = useMemo(() => {
    const shells = sectionOf(outline, "shells");
    const pages = sectionOf(outline, "pages");
    const sections = [shells, pages].flatMap((section) => section === undefined ? []
      : [{ ...section, children: section.children.map(withoutChildren) }]);
    return [{ ...outline, children: filterNodes(sections, query) }];
  }, [outline, query]);
  return <StudioPanelShell title="Structure" description="The application, its layouts and its pages." hidden={hidden}>
    <StudioSearchBox value={query} onChange={setQuery} placeholder="Find a page or layout" label="Find a page or layout" />
    <OutlineList nodes={tree} selectedKey={selectedKey} choose={choose} disabled={disabled} empty="Nothing matches." />
  </StudioPanelShell>;
}

export function StudioBlockOutlinePanel({ outline, selectedKey, choose, disabled, hidden, ownerKey }: PanelProps & Readonly<{
  /** The page or layout the canvas shows, whose blocks are listed. */
  ownerKey: string | undefined;
}>) {
  const [query, setQuery] = useState("");
  const owner = ownerKey === undefined ? undefined : findNode(outline, ownerKey);
  const blocks = useMemo(() => filterNodes(owner?.children ?? [], query), [owner, query]);
  return <StudioPanelShell title="Outline" hidden={hidden}
    description={owner === undefined ? "The blocks of the page you are working on." : `The blocks of ${owner.label}.`}>
    {owner === undefined
      ? <p className="text-sm text-muted-foreground">Choose a page or layout in Structure to see its blocks here.</p>
      : <>
        <StudioSearchBox value={query} onChange={setQuery} placeholder="Find a block" label="Find a block" />
        <OutlineList nodes={blocks} selectedKey={selectedKey} choose={choose} disabled={disabled}
          empty={query.length > 0 ? "No block matches." : "This has no blocks yet."} />
      </>}
  </StudioPanelShell>;
}

export function StudioMenuPanel({ outline, selectedKey, choose, disabled, hidden }: PanelProps) {
  const navigation = sectionOf(outline, "navigation");
  return <StudioPanelShell title="Menu" description="The application's navigation, as people see it." hidden={hidden}>
    <OutlineList nodes={navigation?.children ?? []} selectedKey={selectedKey} choose={choose} disabled={disabled}
      empty="This application has no menu entries yet." />
    <ComingNextNote>Adding, moving and renaming menu entries here comes next. Until then the menu changes with the application's pages.</ComingNextNote>
  </StudioPanelShell>;
}

export function StudioFlowsPanel({ outline, selectedKey, choose, disabled, hidden }: PanelProps) {
  const [query, setQuery] = useState("");
  const flows = useMemo(() => filterNodes(sectionOf(outline, "flows")?.children ?? [], query), [outline, query]);
  return <StudioPanelShell title="Flows" description="Open a flow to arrange its steps on the canvas." hidden={hidden}>
    <StudioSearchBox value={query} onChange={setQuery} placeholder="Find a flow" label="Find a flow" />
    <OutlineList nodes={flows} selectedKey={selectedKey} choose={choose} disabled={disabled}
      empty={query.length > 0 ? "No flow matches." : "This application has no flows yet."} />
  </StudioPanelShell>;
}

function ComingNextNote({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">{children}</p>;
}

/** A rail tab whose editor is not built yet says so plainly, and what to use meanwhile. */
export function StudioComingNextPanel({ title, description, hidden, children }: Readonly<{
  title: string; description: string; hidden: boolean; children: ReactNode;
}>) {
  return <StudioPanelShell title={title} description={description} hidden={hidden}>
    <p className="text-sm font-medium">Coming next</p>
    <ComingNextNote>{children}</ComingNextNote>
  </StudioPanelShell>;
}
