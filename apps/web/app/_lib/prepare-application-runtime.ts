import "server-only";

import type { AppPageModule } from "next/dist/server/route-modules/app-page/module";
import type { LoaderTree } from "next/dist/server/lib/app-dir-module";

/** Initialise the built page modules, without rendering a page or reading a viewer's data. */
export async function prepareApplicationRuntime(): Promise<void> {
  // Only a long-lived server gains from this. A Vercel function instance serves its own routes from
  // a fresh process and need not carry the other pages' entries, so loading them there only adds
  // to its cold start.
  if (process.env.NODE_ENV !== "production" || process.env.VERCEL !== undefined) return;
  const [{ createRequire }, { readFile }, { resolve }] = await Promise.all([
    import("node:module"),
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const distDir = resolve(process.cwd(), ".next");
  const manifest: unknown = JSON.parse(
    await readFile(resolve(distDir, "server/app-paths-manifest.json"), "utf8"),
  );
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    throw new Error("APPLICATION_RUNTIME_MANIFEST_INVALID");
  const { loadClientReferenceManifestForPage } = await import("next/dist/server/load-components");
  const loadedModules = new Set<string>();
  const loadedClientModules = new Set<string | number>();
  const loadedChunks = new Set<string>();
  const loadTree = async (tree: LoaderTree): Promise<void> => {
    for (const module of Object.values(tree[2])) {
      if (!Array.isArray(module) || typeof module[0] !== "function") continue;
      const [load, file] = module;
      if (loadedModules.has(file)) continue;
      await load();
      loadedModules.add(file);
    }
    for (const child of Object.values(tree[1])) await loadTree(child);
  };
  for (const [page, file] of Object.entries(manifest)) {
    if (typeof file !== "string") throw new Error("APPLICATION_RUNTIME_ENTRY_INVALID");
    if (!page.endsWith("/page")) continue;
    // Loading source imports here would create the instrumentation bundle's second module graph.
    // Use Next's built entry and declared loaders so requests reuse the actual RSC and SSR modules.
    const entry = require(resolve(distDir, "server", file)) as AppPageModule;
    await loadTree(entry.routeModule.userland.loaderTree);
    const references = await loadClientReferenceManifestForPage(distDir, page);
    if (references === undefined) throw new Error("APPLICATION_RUNTIME_REFERENCES_UNAVAILABLE");
    for (const mapping of Object.values(references.ssrModuleMapping)) {
      for (const reference of Object.values(mapping)) {
        if (loadedClientModules.has(reference.id)) continue;
        for (const chunk of reference.chunks) {
          if (loadedChunks.has(chunk)) continue;
          await entry.__next_app__.loadChunk(chunk);
          loadedChunks.add(chunk);
        }
        entry.__next_app__.require(reference.id);
        loadedClientModules.add(reference.id);
      }
    }
  }
}
