/**
 * Emits every shadcn/create font as a self-hosted asset (#1277), and the font catalogue the theme
 * selection, the theme bridge and the runtime font loader read.
 *
 * The font list is the pinned shadcn preset's own (`PRESET_FONTS` and the default body and heading
 * fonts of `DEFAULT_PRESET_CONFIG` in `shadcn/preset`), so the catalogue offers exactly the fonts
 * shadcn/create offers at the pinned version. Each font's files come from the Fontsource package the
 * shadcn CLI itself installs for that font (`@fontsource-variable/<id>`, or `@fontsource/<id>` for a
 * font published only as a static face), pinned exactly in the `ui` package. Nothing is fetched: the
 * files, their stylesheet and their licence are read from those installed packages.
 *
 * For every font it writes, under `apps/web/public/fonts/<id>/` (served from the Vortex origin):
 *
 * - `font.css`: the package's upright faces (its default `index.css`: every subset, split by
 *   `unicode-range` so a browser downloads only the subsets a page uses), with only the WOFF2
 *   sources kept and every source rewritten to a file beside it. It refuses a stylesheet that names
 *   any remote address.
 * - the WOFF2 files that stylesheet names, and nothing else from the package;
 * - `LICENSE.txt`: the font's licence, copied from the package.
 *
 * It also writes contracts/src/catalogue/shadcn-fonts.generated.json: one entry per font with its
 * id, label, CSS family, category, source package and version, licence, stylesheet path and the
 * Latin file a page preloads, plus the pinned default body and heading fonts. A font is loaded
 * only when a resolved theme selects it, because the runtime links one stylesheet per selected font.
 *
 * Usage: `pnpm fonts:emit` writes; `pnpm fonts:emit --check` fails when anything it would write is
 * missing or different. Re-running it on the same pinned packages produces identical output.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The package that pins shadcn and every font package, so its resolution decides the versions. */
const UI_PACKAGE = path.join(REPOSITORY_ROOT, "ui", "package.json");
/** Where `apps/web` serves the fonts from: it publishes `public/` at the root of the Vortex origin. */
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, "apps", "web", "public", "fonts");
const CATALOGUE_FILE = path.join(
  REPOSITORY_ROOT,
  "contracts",
  "src",
  "catalogue",
  "shadcn-fonts.generated.json",
);
/** Fonts that Fontsource publishes only as static faces; every other font uses its variable package. */
const STATIC_FONT_PACKAGES = new Map([["instrument-serif", "@fontsource/instrument-serif"]]);
/** The subset whose file a page preloads: the one every Latin-script page needs first. */
const PRELOAD_SUBSET = "latin";

const require = createRequire(UI_PACKAGE);
const check = process.argv.includes("--check");
const toPosix = (value) => value.split(path.sep).join("/");
const fingerprintOf = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

/** The installed directory of a package the `ui` package depends on, found as Node resolves it. */
const packageRoot = (name) => {
  for (let directory = path.dirname(UI_PACKAGE); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(directory) === directory)
      throw new Error(`Cannot resolve ${name} from ${UI_PACKAGE}`);
  }
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const shadcnRoot = packageRoot("shadcn");
const shadcn = await readJson(path.join(shadcnRoot, "package.json"));
const preset = await import(pathToFileURL(require.resolve("shadcn/preset")).href);
const { PRESET_FONTS, PRESET_FONT_HEADINGS, DEFAULT_PRESET_CONFIG } = preset;
if (!Array.isArray(PRESET_FONTS) || PRESET_FONTS.length === 0)
  throw new Error("shadcn/preset exports no PRESET_FONTS");
for (const heading of PRESET_FONT_HEADINGS)
  if (heading !== "inherit" && !PRESET_FONTS.includes(heading))
    throw new Error(`shadcn/preset heading font "${heading}" is not a body font`);

const FONT_FACE = /@font-face\s*\{([^}]*)\}/g;
const declaration = (body, property) =>
  new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();

/**
 * The upright faces of one package stylesheet, each with its WOFF2 source only. Returns the faces
 * (with the file each one names) and the one CSS family they share.
 */
const readFaces = (css, font) => {
  const faces = [];
  for (const match of css.matchAll(FONT_FACE)) {
    const body = match[1];
    const family = declaration(body, "font-family")?.replace(/^['"]|['"]$/g, "");
    const style = declaration(body, "font-style");
    const weight = declaration(body, "font-weight");
    const range = declaration(body, "unicode-range");
    const source = declaration(body, "src");
    if (family === undefined || style === undefined || weight === undefined || source === undefined)
      throw new Error(`${font}: a @font-face in its stylesheet is incomplete`);
    if (style !== "normal") continue;
    const woff2 =
      /url\(\.\/files\/([a-z0-9-]+\.woff2)\)\s*format\('(woff2(?:-variations)?)'\)/.exec(source);
    if (woff2 === null) throw new Error(`${font}: a @font-face has no local WOFF2 source`);
    faces.push({ family, weight, range, file: woff2[1], format: woff2[2] });
  }
  if ([...css.matchAll(/@font-face/g)].length !== [...css.matchAll(FONT_FACE)].length)
    throw new Error(`${font}: a @font-face in its stylesheet could not be read`);
  if (faces.length === 0) throw new Error(`${font}: its stylesheet declares no upright face`);
  const families = new Set(faces.map((face) => face.family));
  if (families.size !== 1) throw new Error(`${font}: its faces name more than one family`);
  return { faces, family: faces[0].family };
};

const stylesheetFor = (font, packageName, version, licence, faces) => {
  const header = `/*
 * Generated by tooling/emit-font-assets.mjs from ${packageName} ${version} (${licence}; see
 * LICENSE.txt beside this file). Do not edit; run \`pnpm fonts:emit\` instead.
 *
 * The ${font} font for the shadcn/create catalogue, served from the Vortex origin. Each face covers
 * one subset through its unicode-range, so a browser downloads only the subsets a page uses.
 */
`;
  const rules = faces.map(
    (face) => `@font-face {
  font-family: '${face.family}';
  font-style: normal;
  font-display: swap;
  font-weight: ${face.weight};
  src: url(./${face.file}) format('${face.format}');${face.range === undefined ? "" : `\n  unicode-range: ${face.range};`}
}
`,
  );
  return `${header}\n${rules.join("\n")}`;
};

/** Every file the run would write, keyed by absolute path, so --check can compare them all. */
const outputs = new Map();
const catalogueFonts = [];

for (const id of PRESET_FONTS) {
  const packageName = STATIC_FONT_PACKAGES.get(id) ?? `@fontsource-variable/${id}`;
  const root = packageRoot(packageName);
  const manifest = await readJson(path.join(root, "package.json"));
  const metadata = await readJson(path.join(root, "metadata.json"));
  if (metadata.id !== id)
    throw new Error(`${packageName} describes font "${metadata.id}", not "${id}"`);
  const licence = metadata.license?.type;
  if (typeof licence !== "string" || licence.length === 0)
    throw new Error(`${packageName} declares no font licence`);
  const css = await readFile(path.join(root, manifest.main ?? "index.css"), "utf8");
  if (/@import\b|https?:\/\/|url\(\s*['"]?(?!\.\/files\/)/i.test(css))
    throw new Error(`${packageName}: its stylesheet names an import or a remote address`);
  const { faces, family } = readFaces(css, id);
  // `latin-ext` shares the prefix, so the Latin face is the one whose subset is exactly `latin`.
  const preloadFace = faces.find((face) =>
    new RegExp(`^${id}-${PRELOAD_SUBSET}-(?!ext-)[a-z0-9]+-normal\\.woff2$`).test(face.file),
  );
  if (preloadFace === undefined)
    throw new Error(`${id}: it has no ${PRELOAD_SUBSET} face to preload`);

  const directory = path.join(OUTPUT_DIRECTORY, id);
  outputs.set(
    path.join(directory, "font.css"),
    Buffer.from(stylesheetFor(id, packageName, manifest.version, licence, faces)),
  );
  // Text is committed with LF line endings, so the licence is normalised to match what --check reads.
  const licenceText = (await readFile(path.join(root, "LICENSE"), "utf8")).replace(/\r\n/g, "\n");
  outputs.set(path.join(directory, "LICENSE.txt"), Buffer.from(licenceText));
  for (const face of faces)
    outputs.set(
      path.join(directory, face.file),
      await readFile(path.join(root, "files", face.file)),
    );

  catalogueFonts.push({
    id,
    label: metadata.family,
    family,
    category: metadata.category,
    package: packageName,
    packageVersion: manifest.version,
    licence,
    stylesheet: `${id}/font.css`,
    preload: `${id}/${preloadFace.file}`,
  });
}

const catalogue = {
  schemaVersion: "1.0.0",
  registry: { package: shadcn.name, packageVersion: shadcn.version },
  defaults: {
    bodyFont: DEFAULT_PRESET_CONFIG.font,
    headingFont: DEFAULT_PRESET_CONFIG.fontHeading,
  },
  headingInherit: "inherit",
  fonts: catalogueFonts,
};
outputs.set(CATALOGUE_FILE, Buffer.from(`${JSON.stringify(catalogue, null, 2)}\n`));

/** Files under the output directory that the run would not write: stale fonts or faces. */
const listFiles = async (directory) => {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    ),
  );
  return nested.flat();
};
const stale = (await listFiles(OUTPUT_DIRECTORY)).filter((file) => !outputs.has(file));

const differing = [];
for (const [file, content] of outputs) {
  const current = existsSync(file) ? await readFile(file) : undefined;
  if (current === undefined || fingerprintOf(current) !== fingerprintOf(content))
    differing.push(file);
}

if (check) {
  if (differing.length > 0 || stale.length > 0) {
    for (const file of [...differing, ...stale])
      console.error(`  ${toPosix(path.relative(REPOSITORY_ROOT, file))}`);
    console.error("The emitted fonts are stale; run pnpm fonts:emit");
    process.exitCode = 1;
  } else console.log(`The ${catalogueFonts.length} emitted fonts are current.`);
} else {
  for (const file of stale) await rm(file);
  for (const file of differing) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, outputs.get(file));
  }
  console.log(
    `Emitted ${catalogueFonts.length} fonts from shadcn ${shadcn.version} (${differing.length} file(s) written, ${stale.length} removed).`,
  );
}
