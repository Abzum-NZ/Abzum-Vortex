import {
  DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";

type JsonObject = Record<string, unknown>;

const sourceObject = authoredSource as unknown as JsonObject;
const body = sourceObject.body as JsonObject;

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

const dependencies = [...collectBlockReleases(body)]
  .sort()
  .map((releaseKey) => {
    const separator = releaseKey.lastIndexOf("@");
    if (separator < 1 || separator === releaseKey.length - 1)
      throw new TypeError(`Invalid platform block release identity: ${releaseKey}`);
    return {
      kind: "platform_block" as const,
      block_id: releaseKey.slice(0, separator),
      release_version: releaseKey.slice(separator + 1),
    };
  });

const theme = {
  base: {
    kind: "platform_theme" as const,
    catalogue_theme_id: DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY.catalogueThemeId,
    release_version: DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY.releaseVersion,
  },
  selection: DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  token_overrides: {},
};

/** The Landing Zone application composes the shared launcher, link-tile and filter blocks. */
export const landingZoneApplication: ApplicationSourceDocument = applicationSourceDocumentSchema.parse({
  ...sourceObject,
  body: {
    ...body,
    platform_block_dependencies: dependencies,
    theme,
  },
});
