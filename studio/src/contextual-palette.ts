import {
  platformBlockReleaseIdentityV2,
  type BlockPaletteGroup,
  type PlatformBlockReleaseSummaryV2,
} from "@vortex/contracts";
import type { StudioDiscoveryAdapter, StudioPlacementTarget } from "./discovery-adapter";

/** Hard cap for results returned to the Studio workspace. */
export const STUDIO_CONTEXTUAL_PALETTE_MAX_RESULTS = 100;

export type StudioContextualPaletteChoice = Readonly<{
  /** Stable identity of this exact block release for keyboard and list consumers. */
  id: string;
  blockId: string;
  releaseVersion: string;
  release: PlatformBlockReleaseSummaryV2;
}>;

export type StudioContextualPaletteGroup = Readonly<{
  paletteGroup: BlockPaletteGroup;
  choices: readonly StudioContextualPaletteChoice[];
}>;

export type StudioContextualPaletteOptions = Readonly<{
  /** Lowers the result count; values above the hard cap are clamped to the cap. */
  maxResults?: number;
}>;

/**
 * Builds the searchable eligible block palette for the shared Studio workspace in
 * [#545](https://github.com/Abzum-NZ/Abzum-Vortex/issues/545). Eligibility and surface filtering
 * come only from `discovery.getPlacementChoices(target)`.
 */
export function getStudioContextualPaletteGroups(
  discovery: StudioDiscoveryAdapter,
  target: StudioPlacementTarget,
  searchText: string,
  options: StudioContextualPaletteOptions = {},
): readonly StudioContextualPaletteGroup[] {
  const requestedLimit = options.maxResults ?? STUDIO_CONTEXTUAL_PALETTE_MAX_RESULTS;
  const maxResults = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(STUDIO_CONTEXTUAL_PALETTE_MAX_RESULTS, Math.floor(requestedLimit)))
    : STUDIO_CONTEXTUAL_PALETTE_MAX_RESULTS;
  if (maxResults === 0) return Object.freeze([]);

  const needle = searchText.trim().toLowerCase();
  const grouped = new Map<BlockPaletteGroup, PlatformBlockReleaseSummaryV2[]>();
  let resultCount = 0;

  for (const release of discovery.getPlacementChoices(target)) {
    if (
      needle.length > 0 &&
      !release.name.toLowerCase().includes(needle) &&
      !release.key.toLowerCase().includes(needle)
    )
      continue;

    const group = grouped.get(release.paletteGroup);
    if (group === undefined) grouped.set(release.paletteGroup, [release]);
    else group.push(release);

    resultCount += 1;
    if (resultCount >= maxResults) break;
  }

  return Object.freeze(
    [...grouped].map(([paletteGroup, releases]) =>
      Object.freeze({
        paletteGroup,
        choices: Object.freeze(
          releases.map((release) =>
            Object.freeze({
              id: platformBlockReleaseIdentityV2(release),
              blockId: release.blockId,
              releaseVersion: release.releaseVersion,
              release,
            }),
          ),
        ),
      }),
    ),
  );
}
