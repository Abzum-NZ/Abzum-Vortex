"use client";
import { useMemo, useState, type ReactNode } from "react";
import type { StudioSemanticOutline, StudioSemanticOutlineNode } from "@vortex/ui/studio";
import { StudioPuckOutline } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { StudioPanelShell, StudioSearchBox, StudioSection } from "./studio-frame";
import { StudioOutline } from "./studio-outline";
import { StudioLimitRow } from "./studio-limit";

/**
 * The rail panels drawn from the one semantic outline of the draft: Structure (the application, its
 * layouts and pages) is Studio's, because Puck knows only the page on the canvas; the Outline tab is
 * Puck's own outline of that data. A selection made in any of them is the workspace's one selection.
 */

type Choose = (node: StudioSemanticOutlineNode) => void;

const sectionOf = (
  outline: StudioSemanticOutline,
  section: string,
): StudioSemanticOutlineNode | undefined =>
  outline.children.find((child) => child.key === JSON.stringify([outline.key, "section", section]));

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

/** How many blocks the draft holds, against the composition limit. */
const countBlocks = (nodes: readonly StudioSemanticOutlineNode[]): number =>
  nodes.reduce(
    (total, node) => total + (node.kind === "placement" ? 1 : 0) + countBlocks(node.children),
    0,
  );

const withoutChildren = (node: StudioSemanticOutlineNode): StudioSemanticOutlineNode => ({
  ...node,
  children: [],
});

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

/** The open page's or layout's node, found by its key. */
const findNode = (
  node: StudioSemanticOutlineNode,
  key: string,
): StudioSemanticOutlineNode | undefined =>
  node.key === key
    ? node
    : node.children.reduce<StudioSemanticOutlineNode | undefined>(
        (found, child) => found ?? findNode(child, key),
        undefined,
      );

/** The blocks of a node, nested ones included, in the order the outline lists them. */
const blocksOf = (node: StudioSemanticOutlineNode): readonly StudioSemanticOutlineNode[] =>
  node.children.flatMap((child) => [
    ...(child.kind === "placement" ? [child] : []),
    ...blocksOf(child),
  ]);

/** The most results the search lists; a longer list asks for a narrower search. */
const SEARCH_RESULTS = 50;

/**
 * The Outline tab: Puck's own outline of the page's blocks, and a search that finds a block by the
 * name the inspector gives it (Puck's rows are named by block type only, so a page of headings reads
 * as a column of "Heading"). Choosing a result selects the block; the outline, the canvas and the
 * inspector follow, as they do for a click on a row.
 */
export function StudioOutlinePanel({
  hidden,
  pageOpen,
  outline,
  ownerKey,
  selectedKey,
  choose,
  levels,
}: Readonly<{
  hidden: boolean;
  /** Whether the canvas holds a page: Puck's outline lists the blocks of the data it holds. */
  pageOpen: boolean;
  outline: StudioSemanticOutline;
  /** The page or layout the canvas shows, whose blocks the search lists. */
  ownerKey: string | undefined;
  selectedKey: string;
  choose: Choose;
  /** The levels of nested blocks the open page uses, its layout's included. */
  levels: number | undefined;
}>) {
  const [query, setQuery] = useState("");
  const owner = ownerKey === undefined ? undefined : findNode(outline, ownerKey);
  const blocks = useMemo(() => (owner === undefined ? [] : blocksOf(owner)), [owner]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(
    () =>
      needle.length === 0
        ? []
        : blocks.filter((block) => block.label.toLocaleLowerCase().includes(needle)),
    [blocks, needle],
  );
  // Blocks that share a name are told apart by their key.
  const duplicated = useMemo(() => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const block of blocks) (seen.has(block.label) ? repeated : seen).add(block.label);
    return repeated;
  }, [blocks]);
  const searching = needle.length > 0;
  // Forms a flow shows are hidden on the page, so the page lists them apart to keep them in reach.
  const shownByFlows = owner?.children.find(
    (child) => child.kind === "slot" && child.key.endsWith(JSON.stringify("shown_by_flows") + "]"),
  );
  return (
    <StudioPanelShell
      hidden={hidden}
      search={
        pageOpen ? (
          <StudioSearchBox
            value={query}
            onChange={setQuery}
            placeholder="Find a block"
            label="Find a block"
          />
        ) : undefined
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-3">
        {searching && (
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="Matching blocks">
            {matches.slice(0, SEARCH_RESULTS).map((block) => (
              <li key={block.key}>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  aria-current={block.key === selectedKey ? true : undefined}
                  onClick={() => {
                    choose(block);
                    setQuery("");
                  }}
                >
                  <span className="truncate">{block.label}</span>
                  {duplicated.has(block.label) && block.selection?.kind === "placement" && (
                    <span className="truncate text-muted-foreground">
                      {block.selection.placementAlias}
                    </span>
                  )}
                </Button>
              </li>
            ))}
            {matches.length === 0 && (
              <li className="text-sm text-muted-foreground">No block matches.</li>
            )}
            {matches.length > SEARCH_RESULTS && (
              <li className="text-sm text-muted-foreground">
                Showing the first {SEARCH_RESULTS} of {matches.length}. Search for more of the name
                to narrow it.
              </li>
            )}
          </ul>
        )}
        {/* Kept drawn while searching: Puck's rows take a moment to draw again on a long page. */}
        <div className={searching ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
          <StudioPuckOutline open={pageOpen} />
        </div>
        {!searching && shownByFlows !== undefined && (
          <StudioSection title={shownByFlows.label} count={shownByFlows.children.length}>
            <ul className="max-h-40 space-y-1 overflow-y-auto" aria-label={shownByFlows.label}>
              {shownByFlows.children.map((block) => (
                <li key={block.key}>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start"
                    aria-current={block.key === selectedKey ? true : undefined}
                    onClick={() => choose(block)}
                  >
                    <span className="truncate">{block.label}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </StudioSection>
        )}
        {pageOpen && (
          <section className="shrink-0 space-y-1" aria-label="Application limits">
            <StudioLimitRow
              label="Blocks in the application"
              limit="compositionPlacements"
              used={countBlocks(outline.children)}
            />
            {levels === undefined ? null : (
              <StudioLimitRow label="Levels on this page" limit="compositionDepth" used={levels} />
            )}
          </section>
        )}
      </div>
    </StudioPanelShell>
  );
}
