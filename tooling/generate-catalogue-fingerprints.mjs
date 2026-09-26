import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates every platform catalogue release fingerprint from the one catalogue source.
 *
 * The catalogue source files under contracts/src/catalogue/ hold each release's content and
 * identity but never a fingerprint. This script derives the content and catalogue fingerprints
 * with runtime/definition/src/catalogue-release-fingerprints.ts, the same canonical-JSON SHA-256
 * derivation the publication catalogue uses to materialise and verify releases, and writes them to
 * catalogue-fingerprints.generated.json, keyed by exact release identity (the identity the
 * publication catalogue resolves: block or theme id and release version, or service, operation and
 * release version). The contracts catalogues merge that file in by the same identity, so no
 * fingerprint is ever typed by hand and a new release version never reuses another's values. Run
 * it after any catalogue source change:
 *
 *   pnpm catalogue:fingerprints           write the generated file
 *   pnpm catalogue:fingerprints --check   fail when the generated file is stale
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogueDirectory = path.join(root, "contracts", "src", "catalogue");
const generatedFile = path.join(catalogueDirectory, "catalogue-fingerprints.generated.json");

// The shared derivation is TypeScript that imports its siblings without a file extension, as the
// workspace's bundler resolution allows. Resolve those the same way for this script.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && path.extname(specifier) === "") {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Fall through to the default resolution and its error.
      }
    }
    return nextResolve(specifier, context);
  },
});
const {
  platformBlockReleaseFingerprints,
  platformServiceOperationReleaseFingerprints,
  platformThemeReleaseFingerprints,
} = await import("../runtime/definition/src/catalogue-release-fingerprints.ts");

const readSource = async (name) =>
  JSON.parse(await readFile(path.join(catalogueDirectory, name), "utf8"));

const byIdentity = (kind, entries, identityOf, derive) => {
  const generated = new Map();
  for (const entry of entries) {
    const identity = identityOf(entry);
    if (generated.has(identity)) throw new Error(`Catalogue source repeats ${kind} ${identity}`);
    generated.set(identity, derive(entry));
  }
  return Object.fromEntries([...generated].sort(([left], [right]) => (left < right ? -1 : 1)));
};

const platformBlocks = byIdentity(
  "platform block",
  Object.values(await readSource("application-composition-catalogue.source.json")),
  (release) => `${release.blockId}:${release.releaseVersion}`,
  platformBlockReleaseFingerprints,
);

const platformServiceOperations = byIdentity(
  "platform-service operation",
  Object.values(await readSource("platform-service-operation-catalogue.source.json")),
  (entry) => `${entry.release.serviceId}:${entry.release.operationId}:${entry.release.releaseVersion}`,
  (entry) => platformServiceOperationReleaseFingerprints(entry.release, entry.descriptor),
);

// The imported shadcn/create releases live in their own importer-generated file so the contracts
// entry point, which client code imports, never bundles them; they are fingerprinted here with the
// hand-written releases so every platform theme identity stays unique across both files.
const platformThemes = byIdentity(
  "platform theme",
  [
    ...Object.values(await readSource("platform-theme-catalogue.source.json")),
    ...Object.values(await readSource("shadcn-create-theme-releases.generated.json")),
  ],
  (release) => `${release.catalogueThemeId}:${release.releaseVersion}`,
  platformThemeReleaseFingerprints,
);

/**
 * Every imported shadcn style CSS asset is fingerprinted by its own content, keyed by style id. A
 * raw-text SHA-256 is used because the asset is CSS rather than a canonical JSON value; the
 * catalogue fingerprint binds the style id to that content, so a changed asset or a reused id can
 * never keep another asset's fingerprint.
 */
const styleDirectory = path.join(catalogueDirectory, "styles");
const styleContentFingerprint = (css) =>
  `sha256:${createHash("sha256").update(css, "utf8").digest("hex")}`;
const styleFiles = (await readdir(styleDirectory).catch(() => []))
  .filter((name) => name.endsWith(".css"))
  .sort();
const platformThemeStyleAssets = {};
for (const file of styleFiles) {
  const styleId = file.slice(0, -".css".length);
  const css = (await readFile(path.join(styleDirectory, file), "utf8")).replace(/\r\n/g, "\n");
  const contentFingerprint = styleContentFingerprint(css);
  platformThemeStyleAssets[styleId] = {
    contentFingerprint,
    catalogueFingerprint: styleContentFingerprint(
      `platform_theme_style:${styleId}:${contentFingerprint}`,
    ),
  };
}

const output = `${JSON.stringify(
  { platformBlocks, platformServiceOperations, platformThemes, platformThemeStyleAssets },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const current = (await readFile(generatedFile, "utf8").catch(() => "")).replace(/\r\n/g, "\n");
  if (current !== output) {
    console.error(
      "contracts/src/catalogue/catalogue-fingerprints.generated.json is stale; run pnpm catalogue:fingerprints",
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(generatedFile, output, "utf8");
  console.log(
    `Wrote ${Object.keys(platformBlocks).length} block, ${Object.keys(platformServiceOperations).length} operation and ${Object.keys(platformThemes).length} theme fingerprints.`,
  );
}
