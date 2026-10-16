import {
  applicationRootIdSchema,
  isRecord,
  revisionSchema,
  sourceApplicationThemeSchema,
  sourceItemTree,
  sourceThemeTokenValueSchema,
  type SourceItem,
} from "@vortex/platform/schema";
import type { StudioAppearanceFailureCode, StudioApplicationTheme, StudioThemeTokenValue } from "./application-appearance";

/** One placement's authored theme overrides, addressed by its authored alias. */
export type StudioPlacementThemeOverrides = Readonly<{
  alias: string;
  themeOverrides: Record<string, StudioThemeTokenValue>;
}>;

/** Authored input only: the server reads authority, the pinned release and the revision itself. */
export type StudioPlacementThemeRequest = Readonly<{
  rootId: string;
  expectedDraftRevision: number;
  theme: StudioApplicationTheme;
  placements: readonly StudioPlacementThemeOverrides[];
}>;

export type StudioPlacementThemeFailure = Readonly<{
  alias: string;
  code: StudioAppearanceFailureCode;
  tokenKey?: string;
}>;

export type StudioPlacementThemeResult =
  | Readonly<{ kind: "available"; failures: readonly StudioPlacementThemeFailure[] }>
  | Readonly<{ kind: "refused" | "conflict" | "temporarily_unavailable" }>;

export const parseStudioPlacementThemeRequest = (
  candidate: unknown,
): StudioPlacementThemeRequest | undefined => {
  if (!isRecord(candidate) || Reflect.ownKeys(candidate).length !== 4) return undefined;
  const root = applicationRootIdSchema.safeParse(candidate.rootId);
  const revision = revisionSchema.safeParse(candidate.expectedDraftRevision);
  const theme = sourceApplicationThemeSchema.safeParse(candidate.theme);
  if (!root.success || !revision.success || !theme.success || !Array.isArray(candidate.placements))
    return undefined;
  const placements: StudioPlacementThemeOverrides[] = [];
  for (const entry of candidate.placements as unknown[]) {
    if (!isRecord(entry) || typeof entry.alias !== "string" || !isRecord(entry.themeOverrides))
      return undefined;
    const overrides: Record<string, StudioThemeTokenValue> = {};
    for (const [key, value] of Object.entries(entry.themeOverrides)) {
      const parsed = sourceThemeTokenValueSchema.safeParse(value);
      if (!parsed.success) return undefined;
      overrides[key] = parsed.data;
    }
    placements.push({ alias: entry.alias, themeOverrides: overrides });
  }
  return {
    rootId: root.data,
    expectedDraftRevision: revision.data,
    theme: theme.data,
    placements,
  };
};

/** Every item in a slot, nested slots included, that overrides at least one theme token. */
export const placementsWithThemeOverrides = (
  items: readonly SourceItem[],
): readonly StudioPlacementThemeOverrides[] =>
  sourceItemTree(items).flatMap((item) =>
    Object.keys(item.props.vortex.theme_overrides).length === 0
      ? []
      : [{ alias: item.props.id,
          themeOverrides: item.props.vortex.theme_overrides as Record<string, StudioThemeTokenValue> }]);

/** Why the saved draft would not compile: the refusal's stable code and where it was found. */
export type StudioCompileFailure = Readonly<{
  reasonCode: string;
  family: string;
  blockAlias?: string;
  tokenKey?: string;
}>;

/** Removes one item's theme overrides, wherever it sits in the slot; false when not found. */
export const clearPlacementThemeOverrides = (items: readonly SourceItem[], alias: string): boolean => {
  const item = sourceItemTree(items).find((candidate) => candidate.props.id === alias);
  if (item === undefined) return false;
  item.props.vortex.theme_overrides = {};
  return true;
};
