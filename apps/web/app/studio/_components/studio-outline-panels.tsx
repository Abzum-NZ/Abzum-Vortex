"use client";
import { useState, type ReactNode } from "react";
import type { StudioSemanticOutline, StudioSemanticOutlineNode } from "@vortex/ui/studio";
import { StudioPuckOutline } from "@vortex/ui/studio";
import { useStudioCanvas } from "@vortex/ui/studio/puck-provider";
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

export function StudioOutlinePanel({
  hidden,
  pageOpen,
  outline,
  levels,
}: Readonly<{
  hidden: boolean;
  /** Whether the canvas holds a page: Puck's outline lists the blocks of the data it holds. */
  pageOpen: boolean;
  outline: StudioSemanticOutline;
  /** The levels of nested blocks the open page uses, its layout's included. */
  levels: number | undefined;
}>) {
  const canvas = useStudioCanvas();
  return (
    <StudioPanelShell title="Outline" hidden={hidden}>
      <StudioPuckOutline open={pageOpen} areaEmpty={canvas.model.slot?.items.length === 0} />
      {pageOpen && (
        <section className="space-y-1 px-1 pt-2" aria-label="Application limits">
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
    </StudioPanelShell>
  );
}
