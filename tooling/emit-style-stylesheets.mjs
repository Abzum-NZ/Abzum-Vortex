/**
 * Emits one plain stylesheet per shadcn/create visual style for the runtime style loader (#1276).
 *
 * The catalogue import (#1274) stores every style's CSS exactly as the pinned shadcn registry
 * publishes it: a Tailwind source file whose single top-level rule is `.style-<id> { ... }` and
 * whose declarations are `@apply` bodies. A browser cannot read that, so each asset is compiled
 * here with the workspace's own tailwindcss into plain CSS, with its scope rewritten from
 * `.style-<id>` to `[data-vortex-style="<id>"]` so one root attribute selects the style.
 *
 * The theme, the utility definitions and the custom variants come from the shared stylesheet
 * (`@reference` imports it without emitting any of it), so a compiled style paints with the same
 * `--primary`/`--radius` variables the theme bridge sets and resolves `dark:` exactly as the
 * application does. One file per style means a page links one stylesheet, never eight.
 *
 * Usage: `pnpm styles:emit`. Re-running it on unchanged inputs produces identical output, and it
 * refuses to write when an asset's content does not match the fingerprint the catalogue pins.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_CATALOGUE = path.join(REPOSITORY_ROOT, "contracts", "src", "catalogue");
const CATALOGUE_INDEX = path.join(CONTRACTS_CATALOGUE, "shadcn-create-theme-catalogue.generated.json");
/** The shared stylesheet whose theme, utilities and variants every style's `@apply` resolves against. */
const REFERENCE_STYLESHEET = path.join(REPOSITORY_ROOT, "ui", "src", "styles", "globals.css");
/** Where the runtime loader links each stylesheet from: `apps/web` serves `public/` at the root. */
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, "apps", "web", "public", "styles");
/** The package that declares tailwindcss, so the workspace's own pinned build is the compiler. */
const COMPILER_PACKAGE = path.join(REPOSITORY_ROOT, "ui", "package.json");

/** Tailwind v4 serves a bare `style` specifier through the `style` export condition, not `main`. */
const STYLE_CONDITIONS = ["style", "default", "import", "require"];

const toPosix = (value) => value.split(path.sep).join("/");

/**
 * The stylesheet a bare specifier names, resolved from the `ui` package that declares the pinned
 * dependencies. Only the exports a stylesheet can be loaded through are honoured; a Tailwind
 * stylesheet has no `main` to fall back to.
 */
const resolveStyleSpecifier = (specifier) => {
  const match = /^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/.exec(specifier);
  if (match === null) throw new Error(`Cannot parse stylesheet specifier "${specifier}"`);
  const [, packageName, subpath = ""] = match;
  let directory = path.dirname(COMPILER_PACKAGE);
  for (;;) {
    const packageRoot = path.join(directory, "node_modules", packageName);
    if (existsSync(path.join(packageRoot, "package.json"))) {
      const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      const key = subpath === "" ? "." : `.${subpath}`;
      const target = pickStyleTarget(manifest.exports, key) ?? manifest.style;
      if (typeof target !== "string")
        throw new Error(`No style export for "${specifier}" in ${manifest.name}`);
      return path.join(packageRoot, target);
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot resolve stylesheet "${specifier}" from ${COMPILER_PACKAGE}`);
    directory = parent;
  }
};

/** The `style`-condition target of one exports entry, whether the entry is a string or a map. */
const pickStyleTarget = (exportsField, key) => {
  if (exportsField === undefined) return undefined;
  if (typeof exportsField === "string") return key === "." ? exportsField : undefined;
  const entry = exportsField[key] ?? (key === "." ? undefined : exportsField);
  if (typeof entry === "string") return entry;
  if (entry === undefined || typeof entry !== "object") return undefined;
  for (const condition of STYLE_CONDITIONS) {
    const target = entry[condition];
    if (typeof target === "string") return target;
  }
  return undefined;
};

const require = createRequire(COMPILER_PACKAGE);
const { compile } = require("tailwindcss");

/** Resolves the `@reference` and `@import` specifiers of a compile run. */
const loadStylesheet = async (id, base) => {
  const resolved = id.startsWith(".") || path.isAbsolute(id)
    ? path.resolve(base, id)
    : resolveStyleSpecifier(id);
  const content = await readFile(resolved, "utf8");
  return { base: path.dirname(resolved), content };
};

/** No asset in this repository uses `@plugin` or `@config`; a reference to one is a loud failure. */
const loadModule = async (id) => {
  throw new Error(`Style stylesheets must not load the module "${id}"`);
};

const fingerprintOf = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

/**
 * The style's own top-level rule, `.<class> {`, rewritten to the root-attribute selector the
 * loader selects with. Only that one selector changes: every rule inside it already targets the
 * style's own `cn-*` component classes, which is what the attribute is there to scope.
 */
const scopeToRootAttribute = (css, style) => {
  const original = `.style-${style}`;
  const selector = `[data-vortex-style="${style}"]`;
  const opening = css.indexOf(`${original} {`);
  if (opening !== 0) throw new Error(`Style asset does not open with "${original} {"`);
  if (css.indexOf(original, opening + original.length) !== -1)
    throw new Error(`Style asset names "${original}" more than once`);
  return `${selector}${css.slice(original.length)}`;
};

const index = JSON.parse(await readFile(CATALOGUE_INDEX, "utf8"));
const styleDimension = index.dimensions.style;
if (styleDimension === undefined) throw new Error("The catalogue index has no style dimension");

const header = (style, option) => `/*
 * Generated by tooling/emit-style-stylesheets.mjs from ${toPosix(
   path.relative(REPOSITORY_ROOT, CONTRACTS_CATALOGUE),
 )}/${option.asset.path} (${option.id} of the pinned ${index.registry.package} ${index.registry.packageVersion}
 * registry, ${option.asset.contentFingerprint}). Do not edit; run \`pnpm styles:emit\` instead.
 *
 * The shadcn/create ${style} style, scoped to [data-vortex-style="${style}"] on the root element, so the
 * runtime loader can link this one stylesheet for the resolved style and no other.
 *
 * It carries its own registrations of the \`--tw-*\` custom properties its rules read, because the
 * shared stylesheet registers only those its own utilities use; a registration the shared
 * stylesheet also makes is identical, so the repeat is harmless.
 */
`;

/**
 * Every style is compiled before anything is written, so a catalogue whose assets cannot all be
 * compiled leaves the committed stylesheets untouched instead of half-replacing them. Each
 * unresolvable `@apply` body is reported by the style it came from, because one unusable utility
 * is a decision for the platform (a variant or a utility the shared stylesheet must declare), not
 * a reason to ship a stylesheet that silently paints nothing.
 */
const compiled = [];
const unusable = [];
for (const option of styleDimension.options) {
  if (option.asset === undefined)
    throw new Error(`Catalogue style option "${option.id}" ships no stylesheet asset`);
  const asset = await readFile(path.join(CONTRACTS_CATALOGUE, option.asset.path), "utf8");
  const actual = fingerprintOf(asset);
  if (actual !== option.asset.contentFingerprint)
    throw new Error(
      `Catalogue style option "${option.id}" asset ${option.asset.path} is ${actual}, not the pinned ${option.asset.contentFingerprint}`,
    );
  const scoped = scopeToRootAttribute(asset, option.id);
  const reference = toPosix(path.relative(CONTRACTS_CATALOGUE, REFERENCE_STYLESHEET));
  try {
    const compiler = await compile(`@reference "${reference}";\n\n${scoped}`, {
      base: CONTRACTS_CATALOGUE,
      loadStylesheet,
      loadModule,
    });
    // No candidate is requested: the style's rules are ordinary CSS, and only its `@apply` bodies
    // need the reference, so an empty build emits exactly the style and nothing from the utilities.
    const output = compiler.build([]).trim();
    if (output.length === 0) throw new Error("the compile produced no CSS");
    compiled.push({ option, css: output });
  } catch (error) {
    unusable.push(`${option.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (unusable.length > 0)
  throw new Error(
    `${unusable.length} of ${styleDimension.options.length} style assets cannot be compiled; no stylesheet was written:\n  ${unusable.join("\n  ")}`,
  );

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const emitted = [];
for (const { option, css } of compiled) {
  await writeFile(
    path.join(OUTPUT_DIRECTORY, `${option.id}.css`),
    `${header(option.id, option)}\n${css}\n`,
    "utf8",
  );
  emitted.push(`${option.id}.css (${css.length} bytes)`);
}

process.stdout.write(
  `Emitted ${emitted.length} style stylesheets to ${toPosix(path.relative(REPOSITORY_ROOT, OUTPUT_DIRECTORY))}:\n  ${emitted.join("\n  ")}\n`,
);
