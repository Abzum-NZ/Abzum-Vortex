import "server-only";

import {
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  PLATFORM_BLOCK_RELEASES,
} from "@vortex/platform/server";
import {
  fieldInputControlKeys,
  isRecord,
  sameId,
  walkPageComposition,
  type FieldInputControlKey,
} from "@vortex/platform/schema";
import type { FieldInputControlReleaseMap } from "@vortex/ui";

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

/** Only automatic inputs in the supplied projected compositions need delegated control metadata. */
export const fieldInputControlReleasesFor = (
  ...compositions: readonly unknown[]
): FieldInputControlReleaseMap => {
  const controls = new Set<FieldInputControlKey>();
  for (const composition of compositions)
    walkPageComposition(composition, ({ placementId, props, vortex }) => {
      const block = vortex.block;
      if (
        !isRecord(block) ||
        typeof block.blockId !== "string" ||
        !sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId)
      )
        return;
      const control = fieldInputControlKeys.find((key) => key === props.control);
      if (control === undefined)
        throw new Error(`Automatic field input '${placementId}' has no valid derived control`);
      controls.add(control);
    });
  return Object.fromEntries([...controls].map((key) => [key, FIELD_INPUT_CONTROL_RELEASES[key]]));
};
