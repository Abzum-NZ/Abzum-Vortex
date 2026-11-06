import "server-only";

import { cache, type CSSProperties } from "react";
import { headers } from "next/headers";
import { DEFAULT_APPLICATION_THEME_SELECTION, organizationIdSchema } from "@vortex/platform/schema";
import {
  DEFAULT_PLATFORM_THEME_RELEASE,
  resolveApplicationTheme,
  STUDIO_THEME,
} from "@vortex/platform/server";
import {
  createDocumentThemeVariables,
  createThemeRootProps,
  createVortexStyleRootProps,
  resolveVortexStyleSelection,
  type ApplicationTheme,
  type VortexStyleRootProps,
} from "@vortex/ui/theme";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { loadApplicationStartTheme } from "./application-frame";
import { loadOrganizationTheme } from "./organization-theme";
import { requestAddressHeader } from "./request-address";

/** The first path segments that are platform routes, never a tenant. */
const PLATFORM_SEGMENTS = new Set(["api", "auth", "health", "signed-in"]);

const platformTheme = createThemeRootProps(undefined, DEFAULT_PLATFORM_THEME_RELEASE.tokens);
const platformStyle = createVortexStyleRootProps(
  resolveVortexStyleSelection(DEFAULT_APPLICATION_THEME_SELECTION),
);

/** The document root props of Studio drawn in one theme: its attributes and every theme variable. */
const studioDocumentThemeOf = (theme: ApplicationTheme) => {
  const root = createThemeRootProps(theme, DEFAULT_PLATFORM_THEME_RELEASE.tokens);
  const style = createVortexStyleRootProps(resolveVortexStyleSelection(theme.selection));
  return {
    ...root,
    ...style,
    // Studio's own marker: the Studio rule below matches only while Studio is on screen, never an
    // application that happens to pick Studio's style, menu and accent.
    "data-vortex-surface": "studio",
    style: { ...root.style, ...style.style },
  };
};

/** The same Studio root props serve the document's first paint and client-side route transitions. */
const studioTheme = resolveApplicationTheme(STUDIO_THEME, undefined);
export const STUDIO_DOCUMENT_THEME = studioDocumentThemeOf(studioTheme);

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
// overrides these variables inline. Leaving Studio removes its surface marker, which no longer
// matches this selector, so the platform defaults apply even if the stylesheet stays loaded (an
// application writes only the variables that differ from them).
const { style: studioDocumentStyle, ...studioDocumentAttributes } = STUDIO_DOCUMENT_THEME;
export const STUDIO_ROOT_CSS = variablesRule(
  `:root${Object.entries(studioDocumentAttributes)
    .map(([name, value]) => `[${name}=${JSON.stringify(value)}]`)
    .join("")}`,
  studioDocumentStyle,
);

/**
 * Studio's theme for the organisation its address names (`/studio/<organisation>/...`): Studio's
 * platform theme with that organisation's theme applied, or undefined where Studio keeps its own
 * theme (no organisation named, not signed in, an organisation the person is not a member of, or
 * an organisation theme that cannot be read just now: the read has logged why, and the document
 * root and Studio's layout agree on Studio's own theme, so nothing is thrown above every boundary).
 */
const loadStudioOrganizationTheme = cache(
  async (organizationId: string | undefined): Promise<ApplicationTheme | undefined> => {
    if (organizationId === undefined || !organizationIdSchema.safeParse(organizationId).success)
      return undefined;
    const resolution = await resolveIdentitySession();
    if (resolution.kind !== "active") return undefined;
    const load = await loadOrganizationTheme(resolution.session, organizationId);
    if (load.kind !== "available") return undefined;
    const theme = resolveApplicationTheme(STUDIO_THEME, load.theme.selection);
    return theme === studioTheme ? undefined : theme;
  },
);

/** The root props Studio draws with for one organisation: Studio's own, or the organisation's. */
export async function loadStudioDocumentTheme(
  organizationId: string,
): Promise<typeof STUDIO_DOCUMENT_THEME> {
  const theme = await loadStudioOrganizationTheme(organizationId);
  return theme === undefined ? STUDIO_DOCUMENT_THEME : studioDocumentThemeOf(theme);
}

type DocumentTheme = Readonly<{
  attributes: Omit<VortexStyleRootProps, "style">;
  style: CSSProperties;
  stylesheet: "platform" | "studio";
}>;

/**
 * The theme the document root carries in the server render: the addressed application's own theme
 * (style, menu attributes and each theme variable the platform rule does not already give), so the
 * first paint is already the application's; otherwise the platform default (its variables come from `PLATFORM_ROOT_CSS`).
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
    const studio = await loadStudioOrganizationTheme(organization);
    if (studio === undefined)
      return { attributes: studioDocumentAttributes, style: {}, stylesheet: "studio" };
    return {
      attributes: Object.fromEntries(
        Object.entries(studioDocumentThemeOf(studio)).filter(([name]) => name !== "style"),
      ) as typeof studioDocumentAttributes,
      // Only what differs from the platform rule the document already links.
      style: createDocumentThemeVariables(studio, DEFAULT_PLATFORM_THEME_RELEASE.tokens),
      stylesheet: "studio",
    };
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
  const styleRoot = createVortexStyleRootProps(resolveVortexStyleSelection(theme.selection));
  return {
    stylesheet: "platform",
    attributes: {
      "data-vortex-style": styleRoot["data-vortex-style"],
      "data-vortex-menu": styleRoot["data-vortex-menu"],
      "data-vortex-menu-accent": styleRoot["data-vortex-menu-accent"],
    },
    // Only what differs from the platform rule the document already links: one write per variable.
    style: createDocumentThemeVariables(theme, DEFAULT_PLATFORM_THEME_RELEASE.tokens),
  };
}
