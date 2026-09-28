/**
 * Emits one plain stylesheet per shadcn/create visual style for the runtime style loader (#1276), and
 * the platform default's rules for the shared stylesheet (#1347).
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
 * Every emitted file declares its rules in a cascade layer and inside a `@scope`, both declared by
 * the shared stylesheet, so a style owns the properties the shared components leave to it, a
 * utility a caller passes through `className` still outranks it, and a nested style root decides its
 * own subtree instead of inheriting the one around it.
 *
 * Usage: `pnpm styles:emit`. Re-running it on unchanged inputs produces identical output, and it
 * refuses to write when an asset's content does not match the fingerprint the catalogue pins.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
/**
 * The cascade layer every emitted style's rules sit in. The shared stylesheet
 * (`ui/src/styles/globals.css`) declares it after `vortex-style-default` and before `utilities`, so
 * a style owns the properties the components' structural classes leave to it, while a utility a
 * caller passes through `className` still outranks the style, exactly as the pinned registry behaves.
 */
const VORTEX_STYLE_LAYER = "vortex-style";
/**
 * The layer the platform default's component rules sit in, declared by the shared stylesheet before
 * `vortex-style`, so an application that resolves another style always paints with its own rules.
 */
const VORTEX_STYLE_DEFAULT_LAYER = "vortex-style-default";
/**
 * The style every page paints with when nothing selects one, matching
 * `DEFAULT_VORTEX_STYLE` in ui/src/theme/vortex-style.ts. Its component rules are emitted into the
 * shared `ui` package, because the screens that render shadcn components outside an application
 * root (the sign-in family, studio) load the shared stylesheet and no style stylesheet of their own.
 */
const PLATFORM_DEFAULT_STYLE = "nova";
/** Where the shared stylesheet's default rules are written, beside the stylesheet that imports them. */
const DEFAULT_OUTPUT_FILE = path.join(REPOSITORY_ROOT, "ui", "src", "styles", "base-nova-components.css");

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

/**
 * The shared stylesheet imports the platform default's rules, and the compile below references the
 * shared stylesheet, so that file has to exist before the compile runs. A stub stands in for it on a
 * first run and is removed again when a style cannot be compiled, so a failed run leaves the tree
 * exactly as it found it. The stub cannot change the result: a referenced stylesheet contributes
 * utility definitions only, never output.
 */
const DEFAULT_STUB = "/* Emitted by tooling/emit-style-stylesheets.mjs; run `pnpm styles:emit`. */\n";
const stubbed = !existsSync(DEFAULT_OUTPUT_FILE);
if (stubbed) await writeFile(DEFAULT_OUTPUT_FILE, DEFAULT_STUB, "utf8");

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
 *
 * Its rules are wrapped in the named \`${VORTEX_STYLE_LAYER}\` cascade layer, which the shared
 * stylesheet declares after \`${VORTEX_STYLE_DEFAULT_LAYER}\`: the style owns every property a
 * component's structural classes leave to it, a utility a caller passes through \`className\` still
 * outranks it, and the platform default it sits above can never decide an application that resolved
 * a style of its own.
 */
`;

const defaultHeader = (option) => `/*
 * Generated by tooling/emit-style-stylesheets.mjs from ${toPosix(
   path.relative(REPOSITORY_ROOT, CONTRACTS_CATALOGUE),
)}/${option.asset.path} (${option.id} of the pinned ${index.registry.package} ${index.registry.packageVersion}
 * registry, ${option.asset.contentFingerprint}). Do not edit; run \`pnpm styles:emit\` instead.
 *
 * The shadcn/create ${PLATFORM_DEFAULT_STYLE} style, the platform default, for every screen that renders the
 * shared components without an application root: the sign-in family and studio load the shared
 * stylesheet and link no style stylesheet of their own. The shared stylesheet imports this file into
 * the \`${VORTEX_STYLE_DEFAULT_LAYER}\` cascade layer, below the layer every linked style uses, so a resolved
 * style always decides and this one only fills what nothing else has.
 *
 * Its scope runs from the document root to the first element carrying a style other than ${PLATFORM_DEFAULT_STYLE}, so
 * no property it declares reaches an application that resolved a style of its own, and the \`html\`
 * element's own ${PLATFORM_DEFAULT_STYLE} attribute cannot decide one either.
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

if (unusable.length > 0) {
  if (stubbed) await rm(DEFAULT_OUTPUT_FILE, { force: true });
  throw new Error(
    `${unusable.length} of ${styleDimension.options.length} style assets cannot be compiled; no stylesheet was written:\n  ${unusable.join("\n  ")}`,
  );
}

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
const emitted = [];
for (const { option, css } of compiled) {
  // A donut scope, so the nearest style root owns the subtree: an application root that resolves this
  // style paints with these rules, an inner root (a preview canvas) paints with its own, and no rule
  // here reaches either. Without it, two nested roots carrying different attributes would both match
  // and the later stylesheet in the document would win, which is not a decision anyone made.
  // The limit explicitly selects descendant style roots. The compiled selectors also name the
  // root, but selectors inside @scope are relative to it, so use :scope instead of looking for
  // a second root.
  const scope = `@scope ([data-vortex-style="${option.id}"]) to (:scope [data-vortex-style])`;
  const scopedCss = css.replaceAll(`[data-vortex-style="${option.id}"]`, ":scope");
  const sheet = `@layer ${VORTEX_STYLE_LAYER} {\n${scope} {\n${scopedCss}\n}\n}\n`;
  await writeFile(
    path.join(OUTPUT_DIRECTORY, `${option.id}.css`),
    `${header(option.id, option)}\n${sheet}`,
    "utf8",
  );
  emitted.push(`${option.id}.css (${sheet.length} bytes)`);
}

// The platform default's rules, for everything that renders the shared components without an
// application root of its own. The scope reaches from the document root to the first element that
// carries a style other than the default, so nothing a default sets leaks into an application that
// resolved another style, and the shared stylesheet's layer keeps it below any linked style.
const platformDefault = compiled.find(({ option }) => option.id === PLATFORM_DEFAULT_STYLE);
if (platformDefault === undefined)
  throw new Error(`The catalogue offers no "${PLATFORM_DEFAULT_STYLE}" style for the platform default`);
const defaultScope = `@scope (:root) to ([data-vortex-style]:not([data-vortex-style="${PLATFORM_DEFAULT_STYLE}"]))`;
const defaultCss = platformDefault.css.replaceAll(
  `[data-vortex-style="${PLATFORM_DEFAULT_STYLE}"]`,
  ":scope",
);
const defaultSheet = `${defaultScope} {\n${defaultCss}\n}\n`;
await writeFile(
  DEFAULT_OUTPUT_FILE,
  `${defaultHeader(platformDefault.option)}\n${defaultSheet}`,
  "utf8",
);
emitted.push(
  `${toPosix(path.relative(REPOSITORY_ROOT, DEFAULT_OUTPUT_FILE))} (${defaultSheet.length} bytes)`,
);

process.stdout.write(
  `Emitted ${emitted.length} style stylesheets:\n  ${emitted.join("\n  ")}\n`,
);
