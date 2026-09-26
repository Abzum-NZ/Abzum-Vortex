import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Imports the full shadcn/create theme catalogue at the pinned shadcn version into the platform
 * theme catalogue.
 *
 * It reads only the committed registry snapshot contracts/src/catalogue/shadcn-registry-4.21.0.
 * source.json and the style CSS assets that snapshot names under contracts/src/catalogue/styles/.
 * It never touches the network, so re-running it on the same pinned version produces an identical
 * catalogue. It appends one versioned platform theme release per option to
 * contracts/src/catalogue/platform-theme-catalogue.source.json, writes the release index
 * contracts/src/catalogue/shadcn-create-theme-catalogue.generated.json, lists every option refused
 * by the shared contrast rule, and regenerates catalogue fingerprints. The existing 2.0.0 and
 * 3.0.0 releases are left byte-unchanged.
 *
 *   node tooling/import-shadcn-theme-catalogue.mjs            import and regenerate fingerprints
 *   node tooling/import-shadcn-theme-catalogue.mjs --check    fail when the generated files are stale
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogueDirectory = path.join(root, "contracts", "src", "catalogue");
const snapshotFile = path.join(catalogueDirectory, "shadcn-registry-4.21.0.source.json");
const themeFile = path.join(catalogueDirectory, "platform-theme-catalogue.source.json");
const indexFile = path.join(catalogueDirectory, "shadcn-create-theme-catalogue.generated.json");
const fingerprintsScript = path.join(root, "tooling", "generate-catalogue-fingerprints.mjs");

/**
 * The platform theme token vocabulary the shadcn CSS variables map onto (contracts/src/
 * application-composition-v2.ts platformThemeTokenRolesV2), in the order a release lists tokens.
 * Every entry names the shadcn CSS variable, the shared token-role key and the foreground or
 * background role the vocabulary declares for that key.
 */
const TOKEN_MAPPING = [
  { shadcn: "background", key: "background", role: "background" },
  { shadcn: "foreground", key: "text", role: "foreground" },
  { shadcn: "card", key: "card", role: "background" },
  { shadcn: "card-foreground", key: "card_foreground", role: "foreground" },
  { shadcn: "popover", key: "popover", role: "background" },
  { shadcn: "popover-foreground", key: "popover_foreground", role: "foreground" },
  { shadcn: "primary", key: "primary" },
  { shadcn: "primary-foreground", key: "primary_foreground", role: "foreground" },
  { shadcn: "secondary", key: "secondary" },
  { shadcn: "secondary-foreground", key: "secondary_foreground", role: "foreground" },
  { shadcn: "muted", key: "muted", role: "background" },
  { shadcn: "muted-foreground", key: "muted_text", role: "foreground" },
  { shadcn: "accent", key: "accent", role: "background" },
  { shadcn: "accent-foreground", key: "accent_foreground", role: "foreground" },
  { shadcn: "destructive", key: "danger" },
  { shadcn: "border", key: "border_color" },
  { shadcn: "input", key: "input" },
  { shadcn: "ring", key: "ring" },
  { shadcn: "chart-1", key: "chart_1" },
  { shadcn: "chart-2", key: "chart_2" },
  { shadcn: "chart-3", key: "chart_3" },
  { shadcn: "chart-4", key: "chart_4" },
  { shadcn: "chart-5", key: "chart_5" },
  { shadcn: "sidebar", key: "sidebar", role: "background" },
  { shadcn: "sidebar-foreground", key: "sidebar_foreground", role: "foreground" },
  { shadcn: "sidebar-primary", key: "sidebar_primary" },
  { shadcn: "sidebar-primary-foreground", key: "sidebar_primary_foreground", role: "foreground" },
  { shadcn: "sidebar-accent", key: "sidebar_accent" },
  { shadcn: "sidebar-accent-foreground", key: "sidebar_accent_foreground", role: "foreground" },
  { shadcn: "sidebar-border", key: "sidebar_border" },
  { shadcn: "sidebar-ring", key: "sidebar_ring" },
];

/**
 * The tokens each dimension option sets. A base colour carries the complete neutral palette. An
 * accent theme sets only the accent variables shadcn ships for it, and a chart colour sets only the
 * five chart variables. The sidebar-primary pair is deliberately not imported from an accent theme:
 * shadcn's accent sidebar-primary is a fill very close to its own foreground, so importing it would
 * fail the platform's normal-text contrast rule and refuse every accent theme; the base colour
 * dimension already maps the sidebar pair.
 */
const DIMENSION_TOKENS = {
  baseColor: TOKEN_MAPPING.map((entry) => entry.key),
  theme: ["primary", "primary_foreground", "secondary", "secondary_foreground", "chart_1", "chart_2", "chart_3", "chart_4", "chart_5"],
  chartColor: ["chart_1", "chart_2", "chart_3", "chart_4", "chart_5"],
};

const WCAG_AA_NORMAL_TEXT_MIN_CONTRAST = 4.5;
const DEFAULT_LIGHT_SURFACE = "#FFFFFF";
const DEFAULT_DARK_SURFACE = "#000000";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

/** The deterministic namespace every generated catalogue identity is derived from. */
const CATALOGUE_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** RFC 4122 UUIDv5 over SHA-1: stable catalogue identities for a dimension, reproducible offline. */
const uuidV5 = (namespace, name) => {
  const namespaceBytes = Uint8Array.from(namespace.replace(/-/g, "").match(/../g), (pair) => parseInt(pair, 16));
  const digest = Uint8Array.from(createHash("sha1").update(namespaceBytes).update(name, "utf8").digest());
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const colourToken = (value, role) => ({
  kind: "color_pair",
  light: value.light,
  dark: value.dark,
  ...(role === undefined ? {} : { role }),
});

/** Maps one shadcn CSS-variable set onto the platform token values of a dimension option. */
const mapTokens = (rawTokens, dimension) => {
  const keys = DIMENSION_TOKENS[dimension];
  if (keys === undefined) throw new Error(`Unknown release dimension: ${dimension}`);
  const tokens = {};
  for (const entry of TOKEN_MAPPING) {
    if (!keys.includes(entry.key)) continue;
    const shadcn = entry.shadcn;
    if (rawTokens.light?.[shadcn] === undefined || rawTokens.dark?.[shadcn] === undefined) continue;
    tokens[entry.key] = colourToken({ light: rawTokens.light[shadcn], dark: rawTokens.dark[shadcn] }, entry.role);
  }
  return tokens;
};

/* The contrast helpers below mirror runtime/theme/src/contrast.ts so the importer refuses exactly
 * what publication refuses: the WCAG AA ratio is computed on the colour a browser paints, with the
 * CSS Color 4 OKLCH gamut mapping. */
const COLOR_COMPONENT = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const OKLCH_COLOR = new RegExp(
  `^oklch\\(\\s*(${COLOR_COMPONENT})(%?)\\s+(${COLOR_COMPONENT})\\s+(${COLOR_COMPONENT})(?:deg)?\\s*(?:\\/\\s*(${COLOR_COMPONENT})(%?))?\\s*\\)$`,
);
const GAMUT_MAPPING_JND = 0.02;
const GAMUT_MAPPING_EPSILON = 0.0001;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const parseHex = (hex) => {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
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
  const effectiveBackground = composite(parseColor(background), parseColor(canvas));
  const effectiveForeground = composite(parseColor(foreground), effectiveBackground);
  const lumA = colorLuminance(effectiveForeground);
  const lumB = colorLuminance(effectiveBackground);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
};

/**
 * The contrast failures one option's declared colour pairs produce, using the shared vocabulary to
 * pair each fill with `<fill>_foreground` and to judge every unpaired foreground against the
 * option's surface. Returns one message per failing pair.
 */
const contrastFailures = (tokens) => {
  const failures = [];
  const isColour = (key) => tokens[key]?.kind === "color_pair";
  const pairedForegrounds = new Set(
    Object.keys(tokens).flatMap((key) => (isColour(key) && isColour(`${key}_foreground`) ? [`${key}_foreground`] : [])),
  );
  const surfaceLight = isColour("background") ? tokens.background.light : DEFAULT_LIGHT_SURFACE;
  const surfaceDark = isColour("background") ? tokens.background.dark : DEFAULT_DARK_SURFACE;

  for (const key of Object.keys(tokens).sort()) {
    const token = tokens[key];
    if (token.kind !== "color_pair") continue;

    if (token.role === "foreground" && !pairedForegrounds.has(key)) {
      for (const [mode, surface, canvas] of [
        ["light", surfaceLight, DEFAULT_LIGHT_SURFACE],
        ["dark", surfaceDark, DEFAULT_DARK_SURFACE],
      ]) {
        const ratio = contrastRatio(token[mode], surface, canvas);
        if (ratio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST)
          failures.push(`${key}/${"background"} ${mode}=${ratio.toFixed(2)}`);
      }
    }

    const foreground = tokens[`${key}_foreground`];
    if (foreground?.kind === "color_pair") {
      for (const [mode, surface, canvas] of [
        ["light", surfaceLight, DEFAULT_LIGHT_SURFACE],
        ["dark", surfaceDark, DEFAULT_DARK_SURFACE],
      ]) {
        const ratio = contrastRatio(foreground[mode], token[mode], canvas);
        if (ratio < WCAG_AA_NORMAL_TEXT_MIN_CONTRAST)
          failures.push(`${key}_foreground/${key} ${mode}=${ratio.toFixed(2)}`);
      }
    }
  }
  return failures;
};

const releaseKey = (dimension, optionId) =>
  `SHADCN_CREATE_${dimension.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_${optionId.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;

const dimensionThemeId = (dimension) =>
  uuidV5(CATALOGUE_NAMESPACE, `vortex.shadcn-create.theme.${dimension}`);

/**
 * Builds one platform theme release per colour, chart and radius option, refusing any option whose
 * declared colour pairs fail contrast. Returns the releases by source key plus the refusal list.
 */
const buildReleases = (snapshot) => {
  const releases = {};
  const refused = [];
  const dimensions = [
    { id: "baseColor", options: snapshot.baseColors },
    { id: "theme", options: snapshot.themes },
    { id: "chartColor", options: snapshot.chartColors },
  ];

  for (const dimension of dimensions) {
    const catalogueThemeId = dimensionThemeId(dimension.id);
    for (const option of dimension.options) {
      const tokens = mapTokens(option.tokens, dimension.id);
      const failures = contrastFailures(tokens);
      if (failures.length > 0) {
        refused.push({ dimension: dimension.id, option: option.id, failures });
        continue;
      }
      releases[releaseKey(dimension.id, option.id)] = {
        catalogueThemeId,
        releaseVersion: `${snapshot.registry.packageVersion}-${option.id}`,
        tokens,
      };
    }
  }

  const radiusThemeId = dimensionThemeId("radius");
  for (const option of snapshot.radii) {
    const tokens = { radius_base: { kind: "corners", rem: option.rem } };
    releases[releaseKey("radius", option.id)] = {
      catalogueThemeId: radiusThemeId,
      releaseVersion: `${snapshot.registry.packageVersion}-${option.id}`,
      tokens,
    };
  }

  return { releases, refused };
};

/** The release index the application-selection work will read: one entry per dimension option. */
const buildIndex = (snapshot, releases, refused) => {
  const releaseOf = (dimension, optionId) => {
    const release = releases[releaseKey(dimension, optionId)];
    if (release === undefined) return undefined;
    return { catalogueThemeId: release.catalogueThemeId, releaseVersion: release.releaseVersion };
  };
  const option = (dimension, entry, extra) => ({
    id: entry.id,
    label: entry.label,
    ...extra,
    release: releaseOf(dimension, entry.id),
  });

  return {
    schemaVersion: "1.0.0",
    registry: {
      package: snapshot.registry.package,
      packageVersion: snapshot.registry.packageVersion,
      tag: snapshot.registry.tag,
      registryUrl: snapshot.registry.registryUrl,
      fetchedAt: snapshot.registry.fetchedAt,
      licence: snapshot.registry.licence,
    },
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
      baseColor: {
        label: "Base colour",
        options: snapshot.baseColors.map((entry) => option("baseColor", entry, {})),
      },
      theme: {
        label: "Theme colour",
        options: snapshot.themes.map((entry) => option("theme", entry, {})),
      },
      chartColor: {
        label: "Chart colour",
        options: snapshot.chartColors.map((entry) => option("chartColor", entry, {})),
      },
      radius: {
        label: "Radius",
        options: snapshot.radii.map((entry) => option("radius", entry, { rem: entry.rem })),
      },
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

  for (const style of snapshot.styles) {
    const css = (await readFile(path.join(catalogueDirectory, style.cssPath), "utf8")).replace(/\r\n/g, "\n");
    const digest = `sha256:${createHash("sha256").update(css, "utf8").digest("hex")}`;
    if (digest !== style.cssSha256)
      throw new Error(`Style asset ${style.cssPath} does not match its pinned sha256 in the registry snapshot`);
  }

  const { releases, refused } = buildReleases(snapshot);
  const index = buildIndex(snapshot, releases, refused);

  const themeCatalogue = await readJson(themeFile);
  for (const key of Object.keys(themeCatalogue)) if (key.startsWith("SHADCN_CREATE_")) delete themeCatalogue[key];
  const releaseKeys = new Set(Object.keys(releases));
  for (const [key, release] of Object.entries(releases)) themeCatalogue[key] = release;

  const themeOutput = `${JSON.stringify(themeCatalogue, null, 2)}\n`;
  const indexOutput = `${JSON.stringify(index, null, 2)}\n`;
  const currentTheme = await readFile(themeFile, "utf8");
  const currentIndex = await readFile(indexFile, "utf8").catch(() => "");

  if (currentTheme !== themeOutput) await writeFile(themeFile, themeOutput, "utf8");
  if (currentIndex !== indexOutput) await writeFile(indexFile, indexOutput, "utf8");
  console.log(`Imported ${releaseKeys.size} platform theme releases from shadcn ${snapshot.registry.packageVersion}.`);
  console.log(
    `Covered every option shown on shadcn/create: ${snapshot.styles.length} styles, ${snapshot.baseColors.length} base colours, ` +
      `${snapshot.themes.length} themes, ${snapshot.chartColors.length} chart colours, ${snapshot.radii.length} radii, ` +
      `${snapshot.menuColors.length} menu colours, ${snapshot.menuAccents.length} menu accents.`,
  );
  if (refused.length === 0) console.log("No option was refused: every colour pair meets WCAG AA contrast.");
  else {
    console.log(`Refused ${refused.length} option(s) whose colour pairs fail WCAG AA contrast:`);
    for (const entry of refused) console.log(`  - ${entry.dimension}/${entry.option}: ${entry.failures.join(", ")}`);
  }

  const generatedFilesChanged = currentTheme !== themeOutput || currentIndex !== indexOutput;
  if (check) {
    if (generatedFilesChanged) {
      console.error("The shadcn catalogue is stale; run node tooling/import-shadcn-theme-catalogue.mjs");
      process.exitCode = 1;
    }
    return;
  }

  const result = spawnSync(process.execPath, [fingerprintsScript], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Regenerating catalogue fingerprints failed");
};

await main();
