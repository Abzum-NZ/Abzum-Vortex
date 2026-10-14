import "server-only";

import { PLATFORM_BLOCK_RELEASES } from "@vortex/platform/server";

/** The browser registry only needs metadata for releases present in the rendered compositions. */
export const platformBlockReleasesFor = (...compositions: readonly unknown[]) => {
  const availableIdentities = new Set(
    PLATFORM_BLOCK_RELEASES.map((release) => `${release.blockId}:${release.releaseVersion}`),
  );
  const referencedIdentities = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    const candidate = value as Readonly<{ blockId?: unknown; releaseVersion?: unknown }>;
    if (typeof candidate.blockId === "string" && typeof candidate.releaseVersion === "string") {
      const identity = `${candidate.blockId}:${candidate.releaseVersion}`;
      if (availableIdentities.has(identity)) referencedIdentities.add(identity);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  for (const composition of compositions) visit(composition);
  return PLATFORM_BLOCK_RELEASES.filter((release) =>
    referencedIdentities.has(`${release.blockId}:${release.releaseVersion}`),
  );
};
