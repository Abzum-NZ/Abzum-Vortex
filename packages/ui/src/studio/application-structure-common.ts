import {
  type ApplicationUsePlace,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
  type Source,
  type Page,
  applyStudioMenuCommand,
  emptyPageData,
  judged,
  quoted,
  refuse,
  uniqueKey,
  StoredCompositionRefusal,
  validateStoredZone,
} from "@vortex/platform/schema";
export {
  blockItem,
  blockRelease,
  cleanName,
  emptyPageData,
  judged,
  quoted,
  refuse,
  StructureRefusal,
  uniqueKey,
  type Navigation,
  type Shell,
  type StructureRelease,
} from "@vortex/platform/schema";
export type { Page, Source } from "@vortex/platform/schema";
import type { StudioPlacementDescriber } from "./semantic-outline";
import type { StudioSemanticSelection } from "./semantic-selection";
import type { projectStudioFlowDraftChoices } from "./application-flow-step-form";

/**
 * What every Structure edit shares: the draft it is applied to, how a refusal is raised and
 * worded, fresh keys, the catalogue release of a block, a new block item, empty page data
 * in a frame, and the source schema's judgement of the result.
 */

export type StudioStructureResult =
  | Readonly<{
      kind: "applied";
      source: Source;
      message: string;
      select: StudioSemanticSelection | null;
      /** What the edit made, in plain words, one entry per thing; empty for a one-thing edit. */
      details: readonly string[];
    }>
  | Readonly<{
      kind: "refused";
      message: string;
      where?: readonly ApplicationUsePlace[] | undefined;
    }>;

export type StudioStructureContext = Readonly<{
  source: Source;
  catalogue: ImmutablePlatformBlockCatalogue;
  describePlacement: StudioPlacementDescriber;
  /** The draft's root identity, for the flow projection of a form the edit places. */
  rootId: Parameters<typeof projectStudioFlowDraftChoices>[0]["rootId"];
  /**
   * The fields of the application's own modules whose stored shape a published version fixed, as
   * `module.key:record_key.field_key`: their filter and sort choices can't change any more.
   */
  publishedFields: ReadonlySet<string>;
}>;

/**
 * Where a page's blocks go in its frame: nowhere special for the platform default frame (`content`),
 * otherwise the frame's first content area (a root slot named by that area's alias).
 */
export const frameArea = (source: Source, shellAlias: string | null) => {
  const shell =
    shellAlias === null ? undefined : source.body.shells.find((entry) => entry.id === shellAlias);
  if (shellAlias !== null && shell === undefined)
    refuse("The chosen layout is no longer in this application. Choose another.");
  const area = shell?.content_slots[0];
  if (shell !== undefined && area === undefined)
    refuse(
      `The layout ${quoted(shell.name)} has no content area, so the page has nowhere to go. Choose another layout.`,
    );
  return { shell, area };
};
export type FrameArea = ReturnType<typeof frameArea>;

/** Refuses blocks the frame area does not take and blocks the catalogue cannot build. */
export const admitBlocks = (
  context: StudioStructureContext,
  { shell, area }: FrameArea,
  items: readonly SourceItem[],
  pageName: string,
): void => {
  for (const item of items) {
    const group = context.catalogue.releases.find(
      (entry) =>
        String(entry.blockId) === item.props.vortex.block.block_id &&
        String(entry.releaseVersion) === item.props.vortex.block.release_version,
    )?.paletteGroup;
    if (
      area !== undefined &&
      (group === undefined || !area.allowed_child_categories.includes(group))
    )
      refuse(
        `The page ${quoted(pageName)} cannot use the layout ${quoted(shell!.name)}: its area ${quoted(area.label)} does not take ${group ?? "these"} blocks. Choose another layout.`,
      );
  }
  try {
    validateStoredZone(context.catalogue, { items: [...items] });
  } catch (error) {
    // A refusal is the answer the preview shows, with its reason; anything else is a fault.
    if (!(error instanceof StoredCompositionRefusal)) throw error;
    refuse(
      `The page ${quoted(pageName)} could not be built from the block catalogue (${error.reason}), so nothing was changed.`,
    );
  }
};

/** Puts the page's blocks in its frame's first content area, judged as stored data and by what the area admits. */
export const pageData = (
  context: StudioStructureContext,
  source: Source,
  shellAlias: string | null,
  items: SourceItem[],
  pageName: string,
) => {
  const data = emptyPageData(source, shellAlias);
  const frame = frameArea(source, shellAlias);
  admitBlocks(context, frame, items, pageName);
  if (frame.area === undefined) data.content = items;
  else (data.root.props as Record<string, unknown>)[frame.area.id] = items;
  return data;
};

/** The fields of a new page beyond its name, key and composition: its type, permission and, for a record page, its record type and query. */
type NewPageFields = Readonly<Record<string, unknown>> &
  Readonly<{ type: Page["type"]; permission: string }>;

/**
 * Adds one page to the candidate: a fresh key and alias from its name and the given composition,
 * with a menu entry made by the Menu tab's own add when asked for.
 */
export const placeNewPage = (
  candidate: Source,
  name: string,
  fields: NewPageFields,
  composition: unknown,
  addToMenu: boolean,
): Readonly<{ source: Source; page: Page }> => {
  const body = candidate.body;
  if (body.pages.length >= 100) refuse("An application can have at most 100 pages.");
  const key = uniqueKey(name, "", new Set(body.pages.map((page) => page.key)), 40);
  const id = uniqueKey(key, "page_", new Set(body.pages.map((page) => page.id)), 160);
  body.pages.push({ id, key, name, ...fields, composition } as unknown as Page);
  if (!addToMenu) return { source: candidate, page: body.pages.at(-1)! };
  const menu = applyStudioMenuCommand(judged(candidate), {
    kind: "add_entry",
    pageKey: key,
    headingAlias: null,
  });
  if (menu.kind === "refused") return refuse(menu.message);
  return { source: menu.source, page: menu.source.body.pages.find((entry) => entry.id === id)! };
};
