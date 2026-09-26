import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Imports the full shadcn/create theme catalogue at the pinned shadcn version as platform theme
 * releases.
 *
 * It reads only the committed registry snapshot contracts/src/catalogue/shadcn-registry-4.21.0.
 * source.json, the style CSS assets that snapshot names under contracts/src/catalogue/styles/ and
 * the registered 3.0.0 release in contracts/src/catalogue/platform-theme-catalogue.source.json. It
 * never touches the network, so re-running it on the same pinned version produces an identical
 * catalogue. It writes:
 *
 * - contracts/src/catalogue/shadcn-create-theme-releases.generated.json: one complete, versioned
 *   platform theme release per base colour, theme colour, chart colour and radius option. Each
 *   option is its own catalogue theme (a stable UUIDv5 identity) released at the shadcn version,
 *   and each release is the registered 3.0.0 release with that option's tokens applied, so it maps
 *   every role of the shared token vocabulary. The file is separate from
 *   platform-theme-catalogue.source.json because the contracts entry point, which client code
 *   imports, bundles that source; the imported releases are for server-side resolution only.
 * - contracts/src/catalogue/shadcn-create-theme-catalogue.generated.json: the release index, one
 *   entry per option of every dimension with its release identity (or its refusal), the tokens it
 *   sets, style CSS assets, and menu colour and accent variant descriptors.
 *
 * Every option whose release fails the platform's theme contrast gate (the same rules as
 * runtime/theme/src/contrast.ts validateThemeContrast) is refused: it gets no release, and it is
 * listed in the importer output and in the index's `refused` list rather than silently dropped.
 * The existing 2.0.0 and 3.0.0 releases are never written.
 *
 *   node tooling/import-shadcn-theme-catalogue.mjs            import and regenerate fingerprints
 *   node tooling/import-shadcn-theme-catalogue.mjs --check    fail when a generated file is stale
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogueDirectory = path.join(root, "contracts", "src", "catalogue");
const snapshotFile = path.join(catalogueDirectory, "shadcn-registry-4.21.0.source.json");
const platformThemeFile = path.join(catalogueDirectory, "platform-theme-catalogue.source.json");
const releasesFile = path.join(catalogueDirectory, "shadcn-create-theme-releases.generated.json");
const indexFile = path.join(catalogueDirectory, "shadcn-create-theme-catalogue.generated.json");
const fingerprintsScript = path.join(root, "tooling", "generate-catalogue-fingerprints.mjs");

/** The registered release every imported option is applied to. */
const BASE_RELEASE_KEY = "PLATFORM_THEME_RELEASE_3_0_0";

/**
 * How the shadcn CSS variables map onto the shared token vocabulary (contracts/src/
 * application-composition-v2.ts platformThemeTokenRolesV2). Every entry names the shadcn CSS
 * variable and the token-role key it sets. The colour role each token carries is taken from the
 * base release, which declares the vocabulary's role for every key. `surface` and `danger_text`
 * follow the base release's own derivation from shadcn's `sidebar` and `destructive` values.
 */
const TOKEN_MAPPING = [
  { shadcn: "background", key: "background" },
  { shadcn: "sidebar", key: "surface" },
  { shadcn: "foreground", key: "text" },
  { shadcn: "card", key: "card" },
  { shadcn: "card-foreground", key: "card_foreground" },
  { shadcn: "popover", key: "popover" },
  { shadcn: "popover-foreground", key: "popover_foreground" },
  { shadcn: "primary", key: "primary" },
  { shadcn: "primary-foreground", key: "primary_foreground" },
  { shadcn: "secondary", key: "secondary" },
  { shadcn: "secondary-foreground", key: "secondary_foreground" },
  { shadcn: "muted", key: "muted" },
  { shadcn: "muted-foreground", key: "muted_text" },
  { shadcn: "accent", key: "accent" },
  { shadcn: "accent-foreground", key: "accent_foreground" },
  { shadcn: "destructive", key: "danger" },
  { shadcn: "destructive", key: "danger_text" },
  { shadcn: "border", key: "border_color" },
  { shadcn: "input", key: "input" },
  { shadcn: "ring", key: "ring" },
  { shadcn: "chart-1", key: "chart_1" },
  { shadcn: "chart-2", key: "chart_2" },
  { shadcn: "chart-3", key: "chart_3" },
  { shadcn: "chart-4", key: "chart_4" },
  { shadcn: "chart-5", key: "chart_5" },
  { shadcn: "sidebar", key: "sidebar" },
  { shadcn: "sidebar-foreground", key: "sidebar_foreground" },
  { shadcn: "sidebar-primary", key: "sidebar_primary" },
  { shadcn: "sidebar-primary-foreground", key: "sidebar_primary_foreground" },
  { shadcn: "sidebar-accent", key: "sidebar_accent" },
  { shadcn: "sidebar-accent-foreground", key: "sidebar_accent_foreground" },
  { shadcn: "sidebar-border", key: "sidebar_border" },
  { shadcn: "sidebar-ring", key: "sidebar_ring" },
];

/**
 * The tokens each dimension option sets on the base release. A base colour sets the complete
 * neutral palette. An accent theme sets only the accent variables shadcn ships for it, and a chart
 * colour only the five chart variables. The sidebar-primary pair is deliberately not taken from an
 * accent theme: shadcn's accent sidebar-primary is a fill very close to its own foreground, so it
 * would fail the normal-text contrast rule and refuse every accent theme; the base colour
 * dimension sets the sidebar pair. A radius sets only `radius_base`.
 */
const DIMENSION_TOKENS = {
  baseColor: [...new Set(TOKEN_MAPPING.map((entry) => entry.key))],
  theme: ["primary", "primary_foreground", "secondary", "secondary_foreground", "chart_1", "chart_2", "chart_3", "chart_4", "chart_5"],
  chartColor: ["chart_1", "chart_2", "chart_3", "chart_4", "chart_5"],
  radius: ["radius_base"],
};

const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
const WCAG_AA_NON_TEXT_MIN_CONTRAST = 3.0;
const DEFAULT_LIGHT_SURFACE = "#FFFFFF";
const DEFAULT_DARK_SURFACE = "#000000";
/** The vocabulary's brand fill, which the renderer also paints on the surface as the accent. */
const ACCENT_TOKEN_KEY = "primary";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/** The deterministic namespace every generated catalogue identity is derived from. */
const CATALOGUE_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** RFC 4122 UUIDv5 over SHA-1: stable catalogue identities, reproducible offline. */
const uuidV5 = (namespace, name) => {
  const namespaceBytes = Uint8Array.from(namespace.replace(/-/g, "").match(/../g), (pair) => parseInt(pair, 16));
  const digest = Uint8Array.from(createHash("sha1").update(namespaceBytes).update(name, "utf8").digest());
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/* The colour helpers below mirror runtime/theme/src/contrast.ts so the importer refuses exactly
 * what publication refuses: the WCAG AA ratio is computed on the colour a browser paints, with the
 * CSS Color 4 OKLCH gamut mapping. */
const COLOR_COMPONENT = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const OKLCH_COLOR = new RegExp(
  `^oklch\\(\\s*(${COLOR_COMPONENT})(%?)\\s+(${COLOR_COMPONENT})\\s+(${COLOR_COMPONENT})(?:deg)?\\s*(?:\\/\\s*(${COLOR_COMPONENT})(%?))?\\s*\\)$`,
);
/** The release contract's colour forms: a six-digit hex value or an oklch() function. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const GAMUT_MAPPING_JND = 0.02;
const GAMUT_MAPPING_EPSILON = 0.0001;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const parseHex = (hex) => {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(clean)) throw new Error(`Invalid hex color: "${hex}"`);
  const expanded = clean.length <= 4 ? [...clean].map((character) => character + character).join("") : clean;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
};

const oklabToLinearSrgb = (lightness, labA, labB) => {
  const l = (lightness + 0.3963377774 * labA + 0.2158037573 * labB) ** 3;
  const m = (lightness - 0.1055613458 * labA - 0.0638541728 * labB) ** 3;
  const s = (lightness - 0.0894841775 * labA - 1.291485548 * labB) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};

const linearSrgbToOklab = ([r, g, b]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const encodeSrgb = (linear) => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
const decodeSrgb = (encoded) => (encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4);
const clipLinearSrgb = (linear) => linear.map((channel) => decodeSrgb(clamp(encodeSrgb(channel), 0, 1)));
const inSrgbGamut = (linear) =>
  linear.every((channel) => encodeSrgb(channel) >= -GAMUT_MAPPING_EPSILON && encodeSrgb(channel) <= 1 + GAMUT_MAPPING_EPSILON);
const deltaEOk = (left, right) => {
  const [l1, a1, b1] = linearSrgbToOklab(left);
  const [l2, a2, b2] = linearSrgbToOklab(right);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

const oklchToLinearSrgb = (lightness, chroma, hueDegrees) => {
  if (lightness >= 1) return [1, 1, 1];
  if (lightness <= 0) return [0, 0, 0];
  const hue = (hueDegrees * Math.PI) / 180;
  const atChroma = (value) => oklabToLinearSrgb(lightness, value * Math.cos(hue), value * Math.sin(hue));
  const original = atChroma(chroma);
  if (inSrgbGamut(original)) return clipLinearSrgb(original);
  if (deltaEOk(original, clipLinearSrgb(original)) < GAMUT_MAPPING_JND) return clipLinearSrgb(original);
  let minimum = 0;
  let maximum = chroma;
  let minimumInGamut = true;
  while (maximum - minimum > GAMUT_MAPPING_EPSILON) {
    const candidateChroma = (minimum + maximum) / 2;
    const candidate = atChroma(candidateChroma);
    if (minimumInGamut && inSrgbGamut(candidate)) {
      minimum = candidateChroma;
      continue;
    }
    const clipped = clipLinearSrgb(candidate);
    const error = deltaEOk(candidate, clipped);
    if (error < GAMUT_MAPPING_JND) {
      if (GAMUT_MAPPING_JND - error < GAMUT_MAPPING_EPSILON) return clipped;
      minimumInGamut = false;
      minimum = candidateChroma;
    } else {
      maximum = candidateChroma;
    }
  }
  return clipLinearSrgb(atChroma(minimum));
};

const parseOklch = (value) => {
  const match = OKLCH_COLOR.exec(value);
  if (match === null) throw new Error(`Invalid oklch color: "${value}"`);
  const [, lightnessText, lightnessPercent, chromaText, hueText, alphaText, alphaPercent] = match;
  const lightness = clamp(Number(lightnessText) / (lightnessPercent === "%" ? 100 : 1), 0, 1);
  const alpha = alphaText === undefined ? 1 : clamp(Number(alphaText) / (alphaPercent === "%" ? 100 : 1), 0, 1);
  const [r, g, b] = oklchToLinearSrgb(lightness, Number(chromaText), Number(hueText) % 360);
  const toChannel = (linear) => clamp(encodeSrgb(linear), 0, 1) * 255;
  return { r: toChannel(r), g: toChannel(g), b: toChannel(b), a: alpha };
};

const parseColor = (value) => (value.startsWith("oklch(") ? parseOklch(value) : parseHex(value));
const isOpaqueColor = (value) => parseColor(value).a === 1;
const composite = (foreground, background) => {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
};
const channelLuminance = (channel) => {
  const sRGB = channel / 255;
  return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
};
const colorLuminance = ({ r, g, b }) =>
  0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
const contrastRatio = (foreground, background, canvas) => {
  const opaqueCanvas = parseColor(canvas);
  if (opaqueCanvas.a !== 1) throw new Error("Contrast canvas must resolve to an opaque color");
  const effectiveBackground = composite(parseColor(background), opaqueCanvas);
  const effectiveForeground = composite(parseColor(foreground), effectiveBackground);
  const lumA = colorLuminance(effectiveForeground);
  const lumB = colorLuminance(effectiveBackground);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
};

/**
 * The surface a theme paints text and brand colours on, chosen as runtime/theme/src/contrast.ts
 * findThemeSurface chooses it: a colour pair declared with the background role, by priority.
 */
const findThemeSurface = (tokens) => {
  const backgrounds = Object.keys(tokens)
    .sort()
    .filter((key) => tokens[key]?.kind === "color_pair" && tokens[key].role === "background");
  const exactPriority = ["background", "canvas", "surface", "bg", "page_background", "app_background"];
  const key =
    exactPriority.flatMap((candidate) => backgrounds.filter((entry) => entry.toLowerCase() === candidate))[0] ??
    backgrounds[0];
  return key === undefined ? undefined : { key, light: tokens[key].light, dark: tokens[key].dark };
};

/**
 * The failures the platform's theme gate reports for one complete release, mirroring
 * runtime/theme/src/contrast.ts validateThemeContrast: every vocabulary colour carries exactly the
 * role the vocabulary declares, the release declares an opaque background surface, every unpaired
 * foreground reads on that surface at 4.5:1, the brand fill is visible on it at 3:1, and every
 * `<fill>_foreground` reads on its fill at 4.5:1, in light and in dark mode. Returns one message
 * per failure.
 */
const themeGateFailures = (tokens, vocabularyRoles) => {
  const failures = [];
  for (const [key, declared] of vocabularyRoles) {
    const token = tokens[key];
    if (token?.kind === "color_pair" && token.role !== declared)
      failures.push(`${key} role=${token.role ?? "none"} expected=${declared ?? "none"}`);
  }

  const surface = findThemeSurface(tokens);
  if (surface === undefined) return [...failures, "no colour declares the background role"];
  if (!(isOpaqueColor(surface.light) && isOpaqueColor(surface.dark)))
    return [...failures, `${surface.key} is translucent`];

  const modes = [
    ["light", surface.light, DEFAULT_LIGHT_SURFACE],
    ["dark", surface.dark, DEFAULT_DARK_SURFACE],
  ];
  const pairedForegrounds = new Set(
    Object.keys(tokens).flatMap((key) =>
      tokens[key]?.kind === "color_pair" && tokens[`${key}_foreground`]?.kind === "color_pair" ? [`${key}_foreground`] : [],
    ),
  );

  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token.kind !== "color_pair" || key === surface.key) continue;

    if (token.role === "foreground" && !pairedForegrounds.has(key))
      for (const [mode, surfaceColour, canvas] of modes) {
        const ratio = contrastRatio(token[mode], surfaceColour, canvas);
        if (ratio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) failures.push(`${key}/${surface.key} ${mode}=${ratio.toFixed(2)}`);
      }

    if (key === ACCENT_TOKEN_KEY)
      for (const [mode, surfaceColour, canvas] of modes) {
        const ratio = contrastRatio(token[mode], surfaceColour, canvas);
        if (ratio < WCAG_AA_NON_TEXT_MIN_CONTRAST) failures.push(`${key}/${surface.key} ${mode}=${ratio.toFixed(2)}`);
      }

    const foreground = tokens[`${key}_foreground`];
    if (foreground?.kind === "color_pair")
      for (const [mode, surfaceColour] of modes) {
        const ratio = contrastRatio(foreground[mode], token[mode], surfaceColour);
        if (ratio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST) failures.push(`${key}_foreground/${key} ${mode}=${ratio.toFixed(2)}`);
      }
  }
  return failures;
};

/** Fails the import when a token the importer writes would not parse against the release contract. */
const assertContractValue = (key, token, context) => {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key) || key.length > 40) throw new Error(`${context}: invalid token key ${key}`);
  if (token.kind === "color_pair") {
    for (const mode of ["light", "dark"]) {
      const value = token[mode];
      if (typeof value !== "string" || !(HEX_COLOR.test(value) || OKLCH_COLOR.test(value)))
        throw new Error(`${context}: ${key} ${mode} "${value}" is not a six-digit hex or oklch() colour`);
    }
  } else if (token.kind === "corners") {
    if (!Number.isFinite(token.rem) || token.rem < 0) throw new Error(`${context}: ${key} must be a non-negative rem value`);
  }
};

/** The option's own token values, keyed by vocabulary key, with the base release's colour roles. */
const optionTokens = (dimension, option, baseTokens) => {
  const keys = DIMENSION_TOKENS[dimension];
  if (dimension === "radius") return { radius_base: { kind: "corners", rem: option.rem } };
  const tokens = {};
  for (const entry of TOKEN_MAPPING) {
    if (!keys.includes(entry.key)) continue;
    const light = option.tokens.light?.[entry.shadcn];
    const dark = option.tokens.dark?.[entry.shadcn];
    if (light === undefined || dark === undefined) continue;
    const role = baseTokens[entry.key]?.role;
    tokens[entry.key] = { kind: "color_pair", light, dark, ...(role === undefined ? {} : { role }) };
  }
  return tokens;
};

const releaseKey = (dimension, optionId) =>
  `SHADCN_CREATE_${dimension.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_${optionId.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;

/** Each option is its own catalogue theme; a later shadcn version releases a new version of it. */
const optionThemeId = (dimension, optionId) =>
  uuidV5(CATALOGUE_NAMESPACE, `vortex.shadcn-create.${dimension}.${optionId}`);

/**
 * Builds one complete release per colour, chart and radius option: the base release with the
 * option's tokens applied, refused when it fails the theme gate. Returns the releases by key, the
 * token keys each option sets and the refusal list.
 */
const buildReleases = (snapshot, base) => {
  const releases = {};
  const optionKeys = {};
  const refused = [];
  const vocabularyRoles = Object.entries(base.tokens)
    .filter(([, token]) => token.kind === "color_pair")
    .map(([key, token]) => [key, token.role]);
  const dimensions = [
    { id: "baseColor", options: snapshot.baseColors },
    { id: "theme", options: snapshot.themes },
    { id: "chartColor", options: snapshot.chartColors },
    { id: "radius", options: snapshot.radii },
  ];

  for (const dimension of dimensions) {
    for (const option of dimension.options) {
      const key = releaseKey(dimension.id, option.id);
      const own = optionTokens(dimension.id, option, base.tokens);
      if (Object.keys(own).length === 0) throw new Error(`${dimension.id}/${option.id} sets no token`);
      const tokens = { ...base.tokens };
      for (const [tokenKey, token] of Object.entries(own)) {
        if (base.tokens[tokenKey]?.kind !== token.kind)
          throw new Error(`${dimension.id}/${option.id}: ${tokenKey} is not a ${token.kind} role of the base release`);
        tokens[tokenKey] = token;
      }
      for (const [tokenKey, token] of Object.entries(tokens)) assertContractValue(tokenKey, token, key);
      optionKeys[key] = Object.keys(own);
      const failures = themeGateFailures(tokens, vocabularyRoles);
      if (failures.length > 0) {
        refused.push({ dimension: dimension.id, option: option.id, failures });
        continue;
      }
      releases[key] = {
        catalogueThemeId: optionThemeId(dimension.id, option.id),
        releaseVersion: snapshot.registry.packageVersion,
        tokens,
      };
    }
  }
  return { releases, optionKeys, refused };
};

/** The release index the application-selection work reads: one entry per dimension option. */
const buildIndex = (snapshot, base, releases, optionKeys) => (refused) => {
  const option = (dimension, entry, extra) => {
    const key = releaseKey(dimension, entry.id);
    const release = releases[key];
    return {
      id: entry.id,
      label: entry.label,
      ...extra,
      releaseKey: key,
      tokenKeys: optionKeys[key],
      release:
        release === undefined
          ? { refused: true }
          : { catalogueThemeId: release.catalogueThemeId, releaseVersion: release.releaseVersion },
    };
  };

  return {
    schemaVersion: "1.0.0",
    registry: {
      package: snapshot.registry.package,
      packageVersion: snapshot.registry.packageVersion,
      tag: snapshot.registry.tag,
      registryUrl: snapshot.registry.registryUrl,
      repository: snapshot.registry.repository,
      fetchedAt: snapshot.registry.fetchedAt,
      sources: snapshot.registry.sources,
      licence: snapshot.registry.licence,
    },
    // Every option release is this release with the option's `tokenKeys` applied, so combining
    // options of different dimensions takes each option's `tokenKeys` from its own release.
    baseRelease: { catalogueThemeId: base.catalogueThemeId, releaseVersion: base.releaseVersion },
    releasesFile: "shadcn-create-theme-releases.generated.json",
    dimensions: {
      style: {
        label: "Visual style",
        options: snapshot.styles.map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.description,
          base: entry.base,
          asset: { path: entry.cssPath, contentFingerprint: entry.cssSha256 },
        })),
      },
      baseColor: { label: "Base colour", options: snapshot.baseColors.map((entry) => option("baseColor", entry, {})) },
      theme: { label: "Theme colour", options: snapshot.themes.map((entry) => option("theme", entry, {})) },
      chartColor: { label: "Chart colour", options: snapshot.chartColors.map((entry) => option("chartColor", entry, {})) },
      radius: { label: "Radius", options: snapshot.radii.map((entry) => option("radius", entry, { rem: entry.rem })) },
      // Menu colour and accent are component class variants in shadcn 4.21.0
      // (packages/shadcn/src/utils/transformers/transform-menu.ts), not colour tokens, so they are
      // variant descriptors applied by the run-time style loading rather than theme releases.
      menuColor: {
        label: "Menu colour",
        options: snapshot.menuColors.map((entry) => ({
          id: entry.id,
          label: entry.label,
          color: entry.color,
          surface: entry.surface,
          classes: entry.classes,
        })),
      },
      menuAccent: {
        label: "Menu accent",
        options: snapshot.menuAccents.map((entry) => ({ id: entry.id, label: entry.label, effect: entry.effect })),
      },
    },
    refused,
  };
};

const main = async () => {
  const check = process.argv.includes("--check");
  const snapshot = await readJson(snapshotFile);
  const base = (await readJson(platformThemeFile))[BASE_RELEASE_KEY];
  if (base === undefined) throw new Error(`${BASE_RELEASE_KEY} is missing from platform-theme-catalogue.source.json`);

  for (const style of snapshot.styles) {
    const css = (await readFile(path.join(catalogueDirectory, style.cssPath), "utf8")).replace(/\r\n/g, "\n");
    const digest = `sha256:${createHash("sha256").update(css, "utf8").digest("hex")}`;
    if (digest !== style.cssSha256)
      throw new Error(`Style asset ${style.cssPath} does not match its pinned sha256 in the registry snapshot`);
    // A style asset is served as-is by the application, so it may never load anything remotely.
    if (/@import\b|url\s*\(|https?:\/\//i.test(css) || css.charCodeAt(0) === 0xfeff)
      throw new Error(`Style asset ${style.cssPath} contains an import, a URL or a byte-order mark`);
  }

  const { releases, optionKeys, refused } = buildReleases(snapshot, base);
  const index = buildIndex(snapshot, base, releases, optionKeys)(refused);

  const releasesOutput = `${JSON.stringify(releases, null, 2)}\n`;
  const indexOutput = `${JSON.stringify(index, null, 2)}\n`;
  const currentReleases = await readFile(releasesFile, "utf8").catch(() => "");
  const currentIndex = await readFile(indexFile, "utf8").catch(() => "");
  const stale = currentReleases !== releasesOutput || currentIndex !== indexOutput;

  console.log(`Imported ${Object.keys(releases).length} platform theme releases from shadcn ${snapshot.registry.packageVersion}.`);
  console.log(
    `Covered every option shown on shadcn/create: ${snapshot.styles.length} styles, ${snapshot.baseColors.length} base colours, ` +
      `${snapshot.themes.length} themes, ${snapshot.chartColors.length} chart colours, ${snapshot.radii.length} radii, ` +
      `${snapshot.menuColors.length} menu colours, ${snapshot.menuAccents.length} menu accents.`,
  );
  if (refused.length === 0) console.log("No option was refused: every release passes the theme contrast gate.");
  else {
    console.log(`Refused ${refused.length} option(s) whose release fails the theme contrast gate:`);
    for (const entry of refused) console.log(`  - ${entry.dimension}/${entry.option}: ${entry.failures.join(", ")}`);
  }

  if (check) {
    // --check only compares; it never rewrites the files it is judging.
    if (stale) {
      console.error("The shadcn catalogue is stale; run node tooling/import-shadcn-theme-catalogue.mjs");
      process.exitCode = 1;
    }
    const fingerprints = spawnSync(process.execPath, [fingerprintsScript, "--check"], { stdio: "inherit" });
    if (fingerprints.status !== 0) process.exitCode = 1;
    return;
  }

  if (currentReleases !== releasesOutput) await writeFile(releasesFile, releasesOutput, "utf8");
  if (currentIndex !== indexOutput) await writeFile(indexFile, indexOutput, "utf8");
  const result = spawnSync(process.execPath, [fingerprintsScript], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Regenerating catalogue fingerprints failed");
};

await main();
