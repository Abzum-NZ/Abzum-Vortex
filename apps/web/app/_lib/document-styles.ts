import "server-only";

import { createHash } from "node:crypto";
import { ALL_UI_STYLES_CSS } from "@vortex/ui/theme/styles";
import { PLATFORM_ROOT_CSS, STUDIO_ROOT_CSS } from "./document-theme";

const stylesheet = (name: string, css: string) => ({
  filename: `${name}-${createHash("sha256").update(css).digest("hex").slice(0, 16)}.css`,
  css,
});

/** Fixed styles are cacheable assets; request-specific theme variables stay on their roots. */
export const DOCUMENT_STYLESHEETS = {
  platform: stylesheet("platform", PLATFORM_ROOT_CSS),
  studio: stylesheet("studio", `${PLATFORM_ROOT_CSS}\n${STUDIO_ROOT_CSS}`),
  components: stylesheet("components", ALL_UI_STYLES_CSS),
};

export const documentStylesheetHref = (name: keyof typeof DOCUMENT_STYLESHEETS): string =>
  `/api/document-styles/${DOCUMENT_STYLESHEETS[name].filename}`;
