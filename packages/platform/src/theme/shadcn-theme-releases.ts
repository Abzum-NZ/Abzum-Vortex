import releases from "./catalogue/shadcn-create-theme-releases.generated.json";

/**
 * The shadcn/create theme catalogue releases #1274 generated: one complete platform theme release
 * per base colour, theme colour, chart colour and radius option, each already applying the base
 * release's roles. It is deliberately not part of the contracts root export (which client code
 * imports), so the option token values reach only the server-side theme resolution. Option releases
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

/** One option release by its generated release key, or undefined when the key has no release. */
export const findShadcnThemeRelease = (releaseKey: string): ShadcnThemeRelease | undefined =>
  shadcnThemeReleases[releaseKey];
