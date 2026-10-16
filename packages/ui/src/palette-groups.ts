import type { BlockPaletteGroup } from "@vortex/platform/schema";

/** The name of each block palette group, as the editor and the Studio palette show it. */
export const PALETTE_GROUP_TITLES: Readonly<Record<BlockPaletteGroup, string>> = Object.freeze({
  layout: "Layout",
  content: "Content",
  data: "Data",
  figures: "Figures",
  record: "Record",
  input: "Inputs",
  actions: "Actions",
});
