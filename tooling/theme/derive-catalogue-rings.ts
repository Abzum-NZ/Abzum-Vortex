/** Re-derive catalogue rings after changing the non-text contrast gate. Run with react-server + tsx. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  contrastRatio,
  WCAG_AA_NON_TEXT_MIN_CONTRAST,
} from "../../packages/platform/src/theme/contrast";
import type { ShadcnThemeContrastDerivation } from "../../packages/platform/src/theme/shadcn-theme-catalogue";

const directory = new URL("../../packages/platform/src/catalogue/catalogue/", import.meta.url);
type Pair = { kind: string; light: string; dark: string };
type Release = { tokens: Record<string, Pair> };
type Option = {
  releaseKey?: string;
  tokenKeys?: string[];
  contrastDerivations?: ShadcnThemeContrastDerivation[];
};
const read = (name: string) => JSON.parse(readFileSync(new URL(name, directory), "utf8"));
const catalogue = read("shadcn-create-theme-catalogue.json") as {
  dimensions: Record<string, { options: Option[] }>;
};
const releases = read("shadcn-create-theme-releases.json") as Record<string, Release>;
const platform = read("platform-theme-catalogue.source.json") as Record<string, Release>;

function derive(release: Release): ShadcnThemeContrastDerivation[] {
  const ring = release.tokens.ring!;
  const background = release.tokens.background!;
  const derivations: ShadcnThemeContrastDerivation[] = [];
  for (const mode of ["light", "dark"] as const) {
    const from = ring[mode];
    if (contrastRatio(from, background[mode]) >= WCAG_AA_NON_TEXT_MIN_CONTRAST) continue;
    const match = /^oklch\(([\d.]+)(.*)\)$/.exec(from);
    if (match === null) throw new Error(`Cannot derive catalogue ring: ${from}`);
    const original = Number(match[1]);
    const at = (lightness: number) => `oklch(${lightness.toFixed(6)}${match[2]})`;
    // Find the closest compliant lightness in either direction, preserving hue and chroma.
    const candidates = [0, 1]
      .flatMap((end) => {
        if (contrastRatio(at(end), background[mode]) < WCAG_AA_NON_TEXT_MIN_CONTRAST) return [];
        let passing = end;
        let failing = original;
        for (let step = 0; step < 32; step += 1) {
          const middle = (passing + failing) / 2;
          if (contrastRatio(at(middle), background[mode]) >= WCAG_AA_NON_TEXT_MIN_CONTRAST)
            passing = middle;
          else failing = middle;
        }
        return [passing];
      })
      .sort((left, right) => Math.abs(left - original) - Math.abs(right - original));
    if (candidates[0] === undefined) throw new Error(`No compliant ring for ${mode}: ${from}`);
    const to = at(candidates[0]);
    ring[mode] = to;
    derivations.push({
      token: "ring",
      mode,
      from,
      to,
      requirement: "3:1 on background (non-text focus indicator)",
    });
  }
  return derivations;
}

for (const dimension of Object.values(catalogue.dimensions)) {
  for (const option of dimension.options) {
    if (option.releaseKey === undefined) continue;
    const corrections = derive(releases[option.releaseKey]!);
    if (option.tokenKeys?.includes("ring") && corrections.length > 0)
      option.contrastDerivations = [...(option.contrastDerivations ?? []), ...corrections];
  }
}
for (const release of Object.values(platform)) derive(release);
for (const [name, value] of [
  ["shadcn-create-theme-catalogue.json", catalogue],
  ["shadcn-create-theme-releases.json", releases],
  ["platform-theme-catalogue.source.json", platform],
] as const)
  writeFileSync(fileURLToPath(new URL(name, directory)), `${JSON.stringify(value, null, 2)}\n`);
