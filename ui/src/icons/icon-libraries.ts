import { SHADCN_ICON_LIBRARIES, isShadcnIconLibrary, type ShadcnIconLibrary } from "@vortex/contracts";
import type { PRESET_ICON_LIBRARIES } from "shadcn/preset";

import type { VortexIconAdapter } from "./icon-names";

/**
 * The catalogue's icon libraries are exactly the pinned shadcn preset's, checked both ways at
 * compile time: a shadcn upgrade that adds a library fails here until it has an adapter below.
 */
type PresetIconLibrary = (typeof PRESET_ICON_LIBRARIES)[number];
type SameMembers<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : never
  : never;
const catalogueMatchesPreset: SameMembers<ShadcnIconLibrary, PresetIconLibrary> = true;
void catalogueMatchesPreset;

/**
 * One loader per catalogue icon library. Each adapter is its own module reached only through a
 * dynamic import, so the bundler splits every library into its own chunk and a page loads the
 * selected library's code and no other's.
 */
const ADAPTER_LOADERS: Readonly<
  Record<ShadcnIconLibrary, () => Promise<Readonly<{ icons: VortexIconAdapter }>>>
> = {
  lucide: () => import("./adapters/lucide"),
  hugeicons: () => import("./adapters/hugeicons"),
  tabler: () => import("./adapters/tabler"),
  phosphor: () => import("./adapters/phosphor"),
  remixicon: () => import("./adapters/remixicon"),
};

const loadedAdapters = new Map<ShadcnIconLibrary, Promise<VortexIconAdapter>>();

/**
 * The adapter of one icon library, loaded once. The same promise is returned on every call, so a
 * component reading it with `use` suspends only until the library's chunk first arrives.
 */
export function loadIconAdapter(library: string): Promise<VortexIconAdapter> {
  if (!isShadcnIconLibrary(library)) throw new Error("Unknown icon library");
  let adapter = loadedAdapters.get(library);
  if (adapter === undefined) {
    adapter = ADAPTER_LOADERS[library]().then((module) => module.icons);
    loadedAdapters.set(library, adapter);
  }
  return adapter;
}

/** Every catalogue icon library, in the pinned preset's order. */
export const VORTEX_ICON_LIBRARIES: readonly ShadcnIconLibrary[] = SHADCN_ICON_LIBRARIES;
