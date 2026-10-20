import "server-only";

import { headers } from "next/headers";
import type { CSSProperties } from "react";
import { DEFAULT_PLATFORM_THEME_RELEASE, STUDIO_THEME_ROOT } from "@vortex/platform/server";
import {
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
  type VortexStyleRootProps,
} from "@vortex/ui/theme";
import { loadApplicationStartTheme } from "./application-frame";
import { requestAddressHeader } from "./request-address";

/** The first path segments that are platform routes, never a tenant. */
const PLATFORM_SEGMENTS = new Set(["api", "auth", "health", "signed-in"]);

const platformTheme = createThemeRootProps(undefined, DEFAULT_PLATFORM_THEME_RELEASE.tokens);
const platformStyle = createVortexStyleRootProps(resolveVortexStyleSelection());

/** The same Studio root props serve the document's first paint and client-side route transitions. */
const studioTheme = createThemeRootProps(STUDIO_THEME_ROOT, DEFAULT_PLATFORM_THEME_RELEASE.tokens);
const studioStyle = createVortexStyleRootProps(
  resolveVortexStyleSelection(STUDIO_THEME_ROOT.selection),
);
export const STUDIO_DOCUMENT_THEME = {
  ...studioTheme,
  ...studioStyle,
  style: { ...studioTheme.style, ...studioStyle.style },
};

/**
 * The platform default theme as one `:root` rule. It is the document's theme wherever no
 * application is addressed, and what remains when an application's own variables (inline on the
 * document root) are removed after a client-side navigation leaves the application.
 */
const variablesRule = (selector: string, style: CSSProperties): string =>
  `${selector}{${Object.entries(style)
    .map(([name, value]) => `${name}:${String(value)}`)
    .join(";")}}`;
export const PLATFORM_ROOT_CSS = variablesRule(":root", {
  ...platformTheme.style,
  ...platformStyle.style,
});

// Studio's fixed definition also supplies its first paint through a cached stylesheet. A surface
// overrides these variables inline. Leaving a surface restores the platform attributes, which no
// longer match this selector, so the platform defaults apply even if the stylesheet stays loaded.
const { style: studioDocumentStyle, ...studioDocumentAttributes } = STUDIO_DOCUMENT_THEME;
export const STUDIO_ROOT_CSS = variablesRule(
  `:root${Object.entries(studioDocumentAttributes)
    .map(([name, value]) => `[${name}=${JSON.stringify(value)}]`)
    .join("")}`,
  studioDocumentStyle,
);

type DocumentTheme = Readonly<{
  attributes: Omit<VortexStyleRootProps, "style">;
  style: CSSProperties;
  stylesheet: "platform" | "studio";
}>;

/**
 * The theme the document root carries in the server render: the addressed application's own theme
 * (style, menu attributes and every theme variable), so the first paint is already the
 * application's; otherwise the platform default (its variables come from `PLATFORM_ROOT_CSS`).
 */
export async function loadDocumentTheme(): Promise<DocumentTheme> {
  const platform: DocumentTheme = {
    stylesheet: "platform",
    attributes: {
      "data-vortex-style": platformStyle["data-vortex-style"],
      "data-vortex-menu": platformStyle["data-vortex-menu"],
      "data-vortex-menu-accent": platformStyle["data-vortex-menu-accent"],
    },
    style: {},
  };
  const address = (await headers()).get(requestAddressHeader);
  if (address === null) return platform;
  const segments = new URL(address, "http://address.invalid").pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));
  const [tenant, organization, application] = segments;
  if (tenant === "studio") {
    return { attributes: studioDocumentAttributes, style: {}, stylesheet: "studio" };
  }
  if (
    segments.length !== 4 ||
    tenant === undefined ||
    organization === undefined ||
    application === undefined ||
    PLATFORM_SEGMENTS.has(tenant)
  )
    return platform;
  const theme = await loadApplicationStartTheme(tenant, organization, application);
  if (theme === undefined) return platform;
  const themeRoot = createThemeRootProps(theme, DEFAULT_PLATFORM_THEME_RELEASE.tokens);
  const styleRoot = createVortexStyleRootProps(resolveVortexStyleSelection(theme.selection));
  return {
    stylesheet: "platform",
    attributes: {
      "data-vortex-style": styleRoot["data-vortex-style"],
      "data-vortex-menu": styleRoot["data-vortex-menu"],
      "data-vortex-menu-accent": styleRoot["data-vortex-menu-accent"],
    },
    style: { ...themeRoot.style, ...styleRoot.style },
  };
}
