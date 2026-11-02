"use client";
import { useMemo, useState, type ReactNode } from "react";
import type { StudioSemanticOutline, StudioSemanticOutlineNode } from "@vortex/ui/studio";
import { StudioPanelShell, StudioSearchBox, StudioSection } from "./studio-frame";
import { StudioNavEmpty } from "./studio-nav-tree";
import { StudioOutline } from "./studio-outline";
import { StudioLimitRow } from "./studio-limit";

/**
 * The rail panels drawn from the one semantic outline of the draft: Structure (the application, its
 * layouts and pages) and Outline (the blocks of what the canvas shows). Each is a view of
 * the same tree, so a selection made in any of them is the workspace's one selection.
 */

type Choose = (node: StudioSemanticOutlineNode) => void;

const sectionOf = (
  outline: StudioSemanticOutline,
  section: string,
): StudioSemanticOutlineNode | undefined =>
  outline.children.find((child) => child.key === JSON.stringify([outline.key, "section", section]));

const findNode = (
  node: StudioSemanticOutlineNode,
  key: string,
): StudioSemanticOutlineNode | undefined => {
  if (node.key === key) return node;
  for (const child of node.children) {
    const found = findNode(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Keeps the nodes whose label matches, with the branches that lead to them. */
const filterNodes = (
  nodes: readonly StudioSemanticOutlineNode[],
  query: string,
): readonly StudioSemanticOutlineNode[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return nodes;
  return nodes.flatMap((node) => {
    if (node.label.toLocaleLowerCase().includes(needle)) return [node];
    const children = filterNodes(node.children, needle);
    return children.length === 0 ? [] : [{ ...node, children }];
  });
};

/** How many blocks a page or layout holds and how deeply they nest, against the composition limits. */
const measureBlocks = (
  nodes: readonly StudioSemanticOutlineNode[],
  depth = 0,
): Readonly<{ count: number; deepest: number }> => {
  let count = 0;
  let deepest = depth;
  for (const node of nodes) {
    const placed = node.kind === "placement";
    const inner = measureBlocks(node.children, placed ? depth + 1 : depth);
    count += (placed ? 1 : 0) + inner.count;
    deepest = Math.max(deepest, placed ? depth + 1 : depth, inner.deepest);
  }
  return { count, deepest };
};

const withoutChildren = (node: StudioSemanticOutlineNode): StudioSemanticOutlineNode => ({
  ...node,
  children: [],
});

function OutlineList({
  nodes,
  selectedKey,
  choose,
  disabled,
  empty,
}: Readonly<{
  nodes: readonly StudioSemanticOutlineNode[];
  selectedKey: string;
  choose: Choose;
  disabled: boolean;
  empty: string;
}>) {
  if (nodes.length === 0)
    return <StudioNavEmpty title="No blocks" description={empty} icon="blocks" />;
  return (
    <StudioOutline nodes={nodes} selectedKey={selectedKey} choose={choose} disabled={disabled} />
  );
}

type PanelProps = Readonly<{
  outline: StudioSemanticOutline;
  selectedKey: string;
  choose: Choose;
  disabled: boolean;
  hidden: boolean;
}>;

export function StudioStructurePanel({
  outline,
  selectedKey,
  choose,
  disabled,
  hidden,
  homePageKey,
  editor,
  action,
}: PanelProps &
  Readonly<{
    homePageKey: string | undefined;
    editor: ReactNode;
    action: ReactNode;
  }>) {
  const [query, setQuery] = useState("");
  const sections = [
    ["pages", "Pages"],
    ["shells", "Layouts"],
  ] as const;
  return (
    <StudioPanelShell
      title="Structure"
      hidden={hidden}
      action={action}
      search={
        <StudioSearchBox
          value={query}
          onChange={setQuery}
          placeholder="Find a page or layout"
          label="Find a page or layout"
        />
      }
    >
      <StudioOutline
        nodes={[withoutChildren(outline)]}
        label="Application"
        selectedKey={selectedKey}
        choose={choose}
        disabled={disabled}
      />
      {sections.map(([key, title]) => {
        const nodes = filterNodes(
          sectionOf(outline, key)?.children.map(withoutChildren) ?? [],
          query,
        );
        return (
          <StudioSection
            key={key}
            title={title}
            count={nodes.length}
            storageKey={`structure:${key}`}
          >
            <StudioOutline
              nodes={nodes}
              label={title}
              selectedKey={selectedKey}
              choose={choose}
              disabled={disabled}
              homePageKey={homePageKey}
              searching={query !== ""}
            />
            {nodes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {query ? "Nothing matches." : `No ${title.toLowerCase()} yet.`}
              </p>
            )}
          </StudioSection>
        );
      })}
      {editor}
    </StudioPanelShell>
  );
}

export function StudioBlockOutlinePanel({
  outline,
  selectedKey,
  choose,
  disabled,
  hidden,
  ownerKey,
}: PanelProps &
  Readonly<{
    /** The page or layout the canvas shows, whose blocks are listed. */
    ownerKey: string | undefined;
  }>) {
  const [query, setQuery] = useState("");
  const owner = ownerKey === undefined ? undefined : findNode(outline, ownerKey);
  const blocks = useMemo(() => filterNodes(owner?.children ?? [], query), [owner, query]);
  const usage = useMemo(() => measureBlocks(outline.children), [outline]);
  return (
    <StudioPanelShell
      title="Outline"
      hidden={hidden}
      search={
        owner === undefined ? undefined : (
          <StudioSearchBox
            value={query}
            onChange={setQuery}
            placeholder="Find a block"
            label="Find a block"
          />
        )
      }
    >
      {owner === undefined ? (
        <StudioNavEmpty
          title="No page open"
          description="Choose a page or layout in Structure to see its blocks."
          icon="list-tree"
        />
      ) : (
        <>
          <StudioSection title={owner.label} count={blocks.length}>
            <OutlineList
              nodes={blocks}
              selectedKey={selectedKey}
              choose={choose}
              disabled={disabled}
              empty={query.length > 0 ? "No block matches." : "This has no blocks yet."}
            />
          </StudioSection>
          <div className="space-y-1 px-1 pt-2" aria-label="Page limits">
            <StudioLimitRow
              label="Blocks in the application"
              limit="compositionPlacements"
              used={usage.count}
            />
            <StudioLimitRow label="Nesting" limit="compositionDepth" used={usage.deepest} />
          </div>
        </>
      )}
    </StudioPanelShell>
  );
}
