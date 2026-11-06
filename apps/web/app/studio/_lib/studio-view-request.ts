import { z } from "zod";
import {
  sourceItemChildSlots,
  sourcePageSlotAddresses,
  sourcePageShell,
  sourcePageSlotAt,
  type SourceItem,
  type ApplicationSourceDocument,
  type StudioSemanticSelection,
} from "@vortex/platform/schema";

/** A read describes the visible editor, never the collection of previously visited tabs. */
export const studioViewRequestSchema = z
  .object({
    kind: z.enum(["source", "canvas", "data", "access", "flows", "theme", "authoring"]),
    pageAlias: z.string().min(1).optional(),
    creation: z.enum(["layout", "record_page"]).optional(),
  })
  .strict();
export type StudioViewRequest = z.infer<typeof studioViewRequestSchema>;

/** The page a layout is previewed on: the first page that uses it, one rule for the view and the canvas. */
export const pageUsingLayout = (
  source: ApplicationSourceDocument,
  shellAlias: string | undefined,
): string | undefined =>
  shellAlias === undefined
    ? undefined
    : source.body.pages.find((page) => sourcePageShell(page.composition) === shellAlias)?.id;

export const studioViewRequest = (
  tab: string,
  selected: StudioSemanticSelection | null,
  source: ApplicationSourceDocument,
  /** The page the address names (its `page` setting), when it has one. */
  addressPageKey?: string,
): StudioViewRequest => {
  if (tab === "data" || tab === "access" || tab === "flows") return { kind: tab };
  if (tab === "releases") return { kind: "source" };
  let pageAlias = selected?.kind === "page" ? selected.pageAlias : undefined;
  if (selected?.kind === "placement") {
    const contains = (items: readonly SourceItem[]): boolean =>
      items.some(
        (item) =>
          item.props.id === selected.placementAlias ||
          sourceItemChildSlots(item).some(([, children]) => contains(children)),
      );
    pageAlias = source.body.pages.find((page) =>
      sourcePageSlotAddresses(page).some((at) => {
        const slot = sourcePageSlotAt(page, at);
        return slot !== undefined && contains(slot.items);
      }),
    )?.id;
    // A block of a layout is drawn on a page that uses that layout.
    if (pageAlias === undefined) {
      const layout = source.body.shells.find((shell) => contains(shell.layout.content));
      pageAlias = pageUsingLayout(source, layout?.id);
    }
  }
  if (selected?.kind === "shell") pageAlias = pageUsingLayout(source, selected.shellAlias);
  if (pageAlias === undefined) {
    const findEntry = (
      items: ApplicationSourceDocument["body"]["navigation"],
    ): string | undefined => {
      for (const item of items) {
        if (
          selected?.kind === "navigation" &&
          item.id === selected.navigationItemAlias &&
          item.type === "page"
        )
          return item.page;
        if (item.type === "heading") {
          const found = findEntry(item.children);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    // One rule for every tab, the same the canvas follows: the selection's page, otherwise the page
    // the address names, otherwise the home page.
    const pageOf = (key: string | undefined) =>
      source.body.pages.find((page) => page.key === key)?.id;
    pageAlias =
      pageOf(findEntry(source.body.navigation)) ??
      pageOf(addressPageKey) ??
      pageOf(source.body.home_page);
  }
  return tab === "theme"
    ? { kind: "theme", ...(pageAlias === undefined ? {} : { pageAlias }) }
    : pageAlias !== undefined ||
        selected?.kind === "shell" ||
        selected?.kind === "placement" ||
        tab === "blocks" ||
        tab === "outline"
      ? { kind: "canvas", ...(pageAlias === undefined ? {} : { pageAlias }) }
      : { kind: "source" };
};
