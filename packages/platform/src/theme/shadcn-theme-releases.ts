import releases from "../catalogue/catalogue/shadcn-create-theme-releases.json";

/**
 * The checked-in shadcn 4.21.0 theme option releases: one complete platform theme release
 * per base colour, theme colour, chart colour and radius option, each already applying the base
 * release's roles. It is deliberately available only from the server entry, so option token values
 * reach only server-side theme resolution. Option releases
 * are keyed by the index's `releaseKey`; a caller reads the index first and then this map.
 */
export type ShadcnThemeRelease = Readonly<{
  catalogueThemeId: string;
  releaseVersion: string;
  tokens: Readonly<Record<string, unknown>>;
}>;

export const shadcnThemeReleases = releases as unknown as Readonly<
  Record<string, ShadcnThemeRelease | undefined>
>;

/** One option release by its checked-in release key, or undefined when the key has no release. */
export const findShadcnThemeRelease = (releaseKey: string): ShadcnThemeRelease | undefined =>
  shadcnThemeReleases[releaseKey];
