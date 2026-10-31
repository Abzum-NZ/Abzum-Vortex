import {
  DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY,
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
  type SourceApplicationThemeSelection,
  type SourceFlow,
} from "@vortex/platform/schema";

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

/**
 * Loads an authored Application with the Modules it owns, its exact registered block dependencies
 * and its explicit theme selection. Each Module is authored in its own file beside the Application
 * and becomes part of the one Application source here, with the default flows its builders made.
 */
export const loadApplicationSource = (
  authoredSource: unknown,
  selection: SourceApplicationThemeSelection,
  modules: readonly unknown[],
  defaultFlows: readonly SourceFlow[],
): ApplicationSourceDocument => {
  const sourceObject = authoredSource as JsonObject;
  const body = sourceObject.body as JsonObject;
  const dependencies = [...collectBlockReleases(body)].sort().map((releaseKey) => {
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
    selection,
  };

  return applicationSourceDocumentSchema.parse({
    ...sourceObject,
    body: {
      ...body,
      // The default flows come from the one builder per kind; the authored flows are the rest.
      flows: [...(body.flows as readonly unknown[]), ...defaultFlows],
      modules,
      platform_block_dependencies: dependencies,
      theme,
    },
  });
};
