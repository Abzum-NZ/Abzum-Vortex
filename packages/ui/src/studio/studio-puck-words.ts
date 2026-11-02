import type { Dictionary } from "@puckeditor/core";

/**
 * The words Puck's own chrome uses in Studio, in Studio's wording. Puck reads this once per
 * workspace and compares it by identity, so it is one constant.
 */
export const studioPuckWords: Dictionary = {
  "drawer-category-collapse": "Hide {title} blocks",
  "drawer-category-expand": "Show {title} blocks",
  "loader-loading": "Loading the canvas",
};
