import {
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  PLATFORM_BLOCK_RELEASES,
  applicationSourceDocumentV2Schema,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type SourceApplicationThemeSelectionV2,
} from "@vortex/contracts";

type JsonObject = Record<string, unknown>;

/** Every placed block release as `block_id@release_version`: one block can have several releases. */
const collectBlockReleases = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectBlockReleases(item, result);
  } else if (value !== null && typeof value === "object") {
    const item = value as JsonObject;
    const block = item.block as JsonObject | undefined;
    if (block && typeof block.block_id === "string" && typeof block.release_version === "string")
      result.add(`${block.block_id}@${block.release_version}`);
    for (const child of Object.values(item)) collectBlockReleases(child, result);
  }
  return result;
};

const releasesByKey = new Map<string, PlatformBlockReleaseV2>(
  PLATFORM_BLOCK_RELEASES.map((release) => [
    `${release.blockId}@${release.releaseVersion}`,
    release,
  ]),
);

/** Loads authored JSON with its exact registered block dependencies and explicit theme selection. */
export const loadApplicationSource = (
  authoredSource: unknown,
  selection: SourceApplicationThemeSelectionV2,
): ApplicationSourceDocumentV2 => {
  const sourceObject = authoredSource as JsonObject;
  const body = sourceObject.body as JsonObject;
  const dependencies = [...collectBlockReleases(body)]
    .sort()
    .map((releaseKey) => {
      const release = releasesByKey.get(releaseKey);
      if (!release) throw new TypeError(`Unregistered platform block release: ${releaseKey}`);
      return {
        kind: "platform_block" as const,
        block_id: release.blockId,
        release_version: release.releaseVersion,
        content_fingerprint: release.contentFingerprint,
        catalogue_fingerprint: release.catalogueFingerprint,
      };
    });

  const theme = {
    base: {
      kind: "platform_theme" as const,
      catalogue_theme_id: DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueThemeId,
      release_version: DEFAULT_PLATFORM_THEME_RELEASE_V2.releaseVersion,
      content_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.contentFingerprint,
      catalogue_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueFingerprint,
    },
    selection,
    token_overrides: {},
  };

  return applicationSourceDocumentV2Schema.parse({
    ...sourceObject,
    body: {
      ...body,
      platform_block_dependencies: dependencies,
      theme,
    },
  });
};
