import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";
import tilesSource from "./sources/landing-zone.tiles.json";

/** The Landing Zone Module provides owner-scoped personal tiles. */
export const landingZoneModuleSources: readonly ModuleSourceDocument[] = Object.freeze(
  [tilesSource].map((source) => moduleSourceDocumentSchema.parse(source)),
);
