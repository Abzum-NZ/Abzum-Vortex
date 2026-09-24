import {
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  PLATFORM_BLOCK_RELEASES,
  applicationSourceDocumentV2Schema,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";
import authoredSource from "./application.json";

type JsonObject = Record<string, unknown>;

const sourceObject = authoredSource as unknown as JsonObject;
const body = sourceObject.body as JsonObject;

const collectBlockIds = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectBlockIds(item, result);
  } else if (value !== null && typeof value === "object") {
    const item = value as JsonObject;
    const block = item.block as JsonObject | undefined;
    if (block && typeof block.block_id === "string") result.add(block.block_id);
    for (const child of Object.values(item)) collectBlockIds(child, result);
  }
  return result;
};

const releasesById = new Map<string, PlatformBlockReleaseV2>(
  PLATFORM_BLOCK_RELEASES.map((release) => [release.blockId, release]),
);
const dependencies = [...collectBlockIds(body)]
  .sort()
  .map((blockId) => {
    const release = releasesById.get(blockId);
    if (!release) throw new TypeError(`Unregistered platform block release: ${blockId}`);
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
  token_overrides: {},
};

/** Tenant Administration's authored Application source, loaded from JSON. */
export const tenantAdministrationApplication: ApplicationSourceDocumentV2 =
  applicationSourceDocumentV2Schema.parse({
    ...sourceObject,
    body: {
      ...body,
      platform_block_dependencies: dependencies,
      theme,
    },
  });
