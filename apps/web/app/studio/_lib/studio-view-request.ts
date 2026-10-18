import { z } from "zod";
import {
  sourceItemChildSlots,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type SourceItem,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import type { StudioSemanticSelection } from "@vortex/ui/studio";

/** A read describes the visible editor, never the collection of previously visited tabs. */
export const studioViewRequestSchema = z
  .object({
    kind: z.enum(["source", "canvas", "data", "access", "flows", "theme"]),
    pageAlias: z.string().min(1).optional(),
  })
  .strict();
export type StudioViewRequest = z.infer<typeof studioViewRequestSchema>;

export const studioViewRequest = (
  tab: string,
  selected: StudioSemanticSelection | null,
  source: ApplicationSourceDocument,
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
  }
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
    const entryPage = findEntry(source.body.navigation);
    const pageKey =
      entryPage ?? (tab === "menu" || tab === "theme" ? source.body.home_page : undefined);
    pageAlias = source.body.pages.find((page) => page.key === pageKey)?.id;
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
