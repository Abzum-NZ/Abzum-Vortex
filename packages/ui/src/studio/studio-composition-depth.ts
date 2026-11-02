import type {
  ApplicationSourceDocument,
  ImmutablePlatformBlockCatalogue,
  SourceItem,
} from "@vortex/platform/schema";
import { itemSlots, regionHostLevels, regions } from "./application-composition-regions";

/** How deep a list of blocks nests: a block of the list is level one. */
export const nestingOf = (
  catalogue: ImmutablePlatformBlockCatalogue,
  items: readonly SourceItem[],
): number =>
  items.reduce(
    (deepest, item) =>
      Math.max(
        deepest,
        1 +
          [...itemSlots(catalogue, item).values()].reduce(
            (inner, child) => Math.max(inner, nestingOf(catalogue, child.items)),
            0,
          ),
      ),
    0,
  );

/**
 * The levels of nested blocks a region of the application uses: its own, and the layout blocks
 * that host it (the platform counts those too).
 */
export const regionLevels = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  region: ReturnType<typeof regions>[number],
): number => regionHostLevels(catalogue, source, region) + nestingOf(catalogue, region.zone.items);

/** The levels of nested blocks the page with this alias uses. */
export const studioPageNestingLevels = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  pageAlias: string,
): number =>
  Math.max(
    0,
    ...regions(source)
      .filter((region) => region.page?.id === pageAlias)
      .map((region) => regionLevels(catalogue, source, region)),
  );
