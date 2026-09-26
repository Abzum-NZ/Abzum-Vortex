import {
  type ApplicationThemeSelectionV2,
  applicationThemeSelectionV2Schema,
} from "./application-composition-v2";
import index from "./catalogue/shadcn-create-theme-catalogue.generated.json";

/**
 * The shadcn/create theme catalogue index #1274 generated, exposed to the application theme
 * contract, the designer and the API/MCP draft operations. It lists every option of every
 * dimension at the pinned shadcn version, each option's release identity (or its refusal), the
 * token keys it sets, and its style asset or menu variant descriptor. It imports only the small
 * index; the option releases themselves are server-side and live in
 * `contracts/src/shadcn-theme-releases.ts`.
 */
export const shadcnThemeCatalogueDimensionKeys = [
  "style",
  "baseColor",
  "theme",
  "chartColor",
  "radius",
  "menuColor",
  "menuAccent",
] as const;
export type ShadcnThemeCatalogueDimensionKey = (typeof shadcnThemeCatalogueDimensionKeys)[number];

/** A catalogue option's release identity, or an explicit refusal when it fails the contrast gate. */
export type ShadcnThemeOptionRelease = Readonly<{
  refused?: boolean;
  catalogueThemeId?: string;
  releaseVersion?: string;
}>;

/** One catalogue option as the generator wrote it. Only the fields its dimension declares appear. */
export type ShadcnThemeCatalogueOption = Readonly<{
  id: string;
  label: string;
  /** The release key the option's token values live under; absent for style and menu variants. */
  releaseKey?: string;
  /** The token keys the option sets on the base release; absent for style and menu variants. */
  tokenKeys?: readonly string[];
  /** The option's release, or its refusal; absent for style and menu variants. */
  release?: ShadcnThemeOptionRelease;
  /** Radius option's corner value in rem. */
  rem?: number;
  /** Menu colour option's shadcn variant descriptor. */
  color?: string;
  surface?: string;
  classes?: string;
  /** Menu accent option's shadcn effect name. */
  effect?: string;
  /** Style option's base and description. */
  base?: string;
  description?: string;
  /** Style option's scoped CSS asset and its pinned content fingerprint. */
  asset?: Readonly<{ path: string; contentFingerprint: string }>;
}>;

export type ShadcnThemeCatalogueDimension = Readonly<{
  label: string;
  options: readonly ShadcnThemeCatalogueOption[];
}>;

export type ShadcnThemeCatalogueRefusal = Readonly<{
  dimension: string;
  option: string;
  failures: readonly string[];
}>;

export type ShadcnThemeCatalogue = Readonly<{
  schemaVersion: string;
  registry: Readonly<Record<string, unknown>>;
  baseRelease: Readonly<{ catalogueThemeId: string; releaseVersion: string }>;
  releasesFile: string;
  dimensions: Readonly<Record<ShadcnThemeCatalogueDimensionKey, ShadcnThemeCatalogueDimension>>;
  refused: readonly ShadcnThemeCatalogueRefusal[];
}>;

export const shadcnThemeCatalogue = index as unknown as ShadcnThemeCatalogue;

/** One dimension's catalogue, or undefined for a dimension that has no catalogue entry. */
export const shadcnThemeCatalogueDimension = (
  dimension: ShadcnThemeCatalogueDimensionKey,
): ShadcnThemeCatalogueDimension | undefined => shadcnThemeCatalogue.dimensions[dimension];

/** One dimension's options, in catalogue order. */
export const shadcnThemeCatalogueOptions = (
  dimension: ShadcnThemeCatalogueDimensionKey,
): readonly ShadcnThemeCatalogueOption[] =>
  shadcnThemeCatalogueDimension(dimension)?.options ?? [];

/** One option of one dimension, or undefined when the id is not offered by that dimension. */
export const findShadcnThemeCatalogueOption = (
  dimension: ShadcnThemeCatalogueDimensionKey,
  optionId: string,
): ShadcnThemeCatalogueOption | undefined =>
  shadcnThemeCatalogueOptions(dimension).find((option) => option.id === optionId);

/**
 * The platform default selection: the base-nova style, neutral base colour, neutral theme, neutral
 * chart colour, default radius, default menu colour and subtle menu accent, with the current
 * fonts. Every shipped application pins this so a new application starts from the platform look.
 */
export const DEFAULT_APPLICATION_THEME_SELECTION: ApplicationThemeSelectionV2 =
  applicationThemeSelectionV2Schema.parse({
    style: "nova",
    baseColor: "neutral",
    theme: "neutral",
    chartColor: "neutral",
    radius: "default",
    menuColor: "default",
    menuAccent: "subtle",
  });

/** A fresh mutable copy of the platform default selection, for a caller that will edit it. */
export const defaultApplicationThemeSelection = (): ApplicationThemeSelectionV2 => ({
  ...DEFAULT_APPLICATION_THEME_SELECTION,
});
