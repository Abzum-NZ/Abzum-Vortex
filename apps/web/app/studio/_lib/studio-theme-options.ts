import type { ApplicationContent, SourceApplicationThemeSelection } from "@vortex/platform/schema";

/** A candidate theme resolved as publication resolves it: the complete theme, or why it is refused. */
export type StudioThemeResolution =
  | Readonly<{ kind: "available"; valid: true; theme: ApplicationContent["theme"] }>
  | Readonly<{ kind: "available"; valid: false; problems: readonly string[] }>
  | Readonly<{ kind: "refused" | "temporarily_unavailable" }>;

/**
 * What the Theme tab offers: each shadcn create setting with the options of the pinned shadcn
 * 4.21.0 catalogue that is checked in, minus any option the catalogue refuses. The server builds
 * it from that catalogue, so Studio never offers a preset or style the repository does not ship.
 */
export type StudioThemeDimensionKey = keyof SourceApplicationThemeSelection;

export type StudioThemeOption = Readonly<{
  id: string;
  label: string;
  description?: string | undefined;
  /** The colour a swatch shows for a colour option, in light and dark. */
  swatch?: Readonly<{ light: string; dark: string }> | undefined;
}>;

export type StudioThemeDimension = Readonly<{
  key: StudioThemeDimensionKey;
  label: string;
  hint: string;
  options: readonly StudioThemeOption[];
}>;

export type StudioThemeOptions = Readonly<{
  /** In shadcn create's order: Style, Base colour, Theme, Chart colour, Heading font, Font, Icon library, Radius, Menu, Menu accent. */
  dimensions: readonly StudioThemeDimension[];
}>;

/** Whether every setting of a selection is an option the Theme tab offers; the first one that is not is named. */
export const studioThemeUnofferedSetting = (
  options: StudioThemeOptions,
  selection: SourceApplicationThemeSelection,
): Readonly<{ dimension: StudioThemeDimension; value: string }> | undefined => {
  for (const dimension of options.dimensions) {
    const value = selection[dimension.key];
    if (!dimension.options.some((option) => option.id === value)) return { dimension, value };
  }
  return undefined;
};

/** A setting's option label, for messages. */
export const studioThemeOptionLabel = (
  options: StudioThemeOptions,
  key: StudioThemeDimensionKey,
  id: string,
): string =>
  options.dimensions
    .find((dimension) => dimension.key === key)
    ?.options.find((option) => option.id === id)?.label ?? id;
