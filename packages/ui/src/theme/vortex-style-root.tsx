"use client";

import * as React from "react";
import { createVortexStyleRootProps, resolveVortexStyleSelection } from "./vortex-style";

type StyleRootContext = Readonly<{ element: HTMLDivElement | null }>;

const VortexStyleRootContext = React.createContext<StyleRootContext | null>(null);

/** The root attributes that select the style, the menu treatment and the theme scope. */
const DOCUMENT_THEME_ATTRIBUTES = [
  "data-vortex-style",
  "data-vortex-menu",
  "data-vortex-menu-accent",
] as const;

const platformStyle = createVortexStyleRootProps(resolveVortexStyleSelection());

/** The platform default style attributes, which the document root returns to outside applications. */
const PLATFORM_STYLE_ATTRIBUTES: Readonly<
  Record<(typeof DOCUMENT_THEME_ATTRIBUTES)[number], string>
> = {
  "data-vortex-style": platformStyle["data-vortex-style"],
  "data-vortex-menu": platformStyle["data-vortex-menu"],
  "data-vortex-menu-accent": platformStyle["data-vortex-menu-accent"],
};

/** The marker of a surface with its own document rule (Studio); the root has none elsewhere. */
const SURFACE_ATTRIBUTE = "data-vortex-surface";

/** The theme variables of a style: its custom properties, in order. */
const themeVariables = (style: React.CSSProperties | undefined): [string, string][] =>
  Object.entries(style ?? {}).flatMap(([name, value]) =>
    name.startsWith("--") && value !== undefined ? [[name, String(value)] as [string, string]] : [],
  );

/**
 * The document root carries the theme of the application on screen. The server render already gives
 * it the addressed application's theme, so the first paint is right; this keeps it right across
 * client-side navigation: an application surface puts its theme on the document root (the same
 * values the server render wrote), and leaving the application removes them again, so the platform
 * default `:root` rule applies with the platform style attributes. The viewer's appearance (colour
 * scheme and mode) is never touched: it stays the document root's own.
 */
function useDocumentTheme(
  element: HTMLDivElement | null,
  enabled: boolean,
  variables: readonly (readonly [string, string])[],
  attributes: string,
) {
  React.useLayoutEffect(() => {
    if (!enabled || element === null) return;
    const root = document.documentElement;
    for (const [name, value] of variables)
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    for (const name of DOCUMENT_THEME_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && root.getAttribute(name) !== value) root.setAttribute(name, value);
    }
    const surface = element.getAttribute(SURFACE_ATTRIBUTE);
    if (surface === null) root.removeAttribute(SURFACE_ATTRIBUTE);
    else if (root.getAttribute(SURFACE_ATTRIBUTE) !== surface)
      root.setAttribute(SURFACE_ATTRIBUTE, surface);
    return () => {
      root.removeAttribute(SURFACE_ATTRIBUTE);
      for (const [name] of variables) root.style.removeProperty(name);
      for (const name of DOCUMENT_THEME_ATTRIBUTES)
        root.setAttribute(name, PLATFORM_STYLE_ATTRIBUTES[name]);
    };
  }, [element, enabled, variables, attributes]);
}

/**
 * Keep portalled components inside the application root whose style and theme they inherit. The
 * application surface (`documentTheme`) gives its theme to the document root and not to its own
 * element: the root carries each variable once (the server render writes it there, and this
 * surface applies it there after a client-side navigation), and everything below inherits it.
 */
export function VortexStyleRoot({
  children,
  documentTheme = false,
  style,
  ...props
}: React.ComponentProps<"div"> & { documentTheme?: boolean }) {
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);
  const variablesKey = JSON.stringify(documentTheme ? themeVariables(style) : []);
  const variables = React.useMemo(
    () => JSON.parse(variablesKey) as readonly (readonly [string, string])[],
    [variablesKey],
  );
  const attributes = JSON.stringify(
    [...DOCUMENT_THEME_ATTRIBUTES, SURFACE_ATTRIBUTE].map(
      (name) => (props as Record<string, unknown>)[name],
    ),
  );
  useDocumentTheme(element, documentTheme, variables, attributes);
  const ownStyle = documentTheme
    ? Object.fromEntries(Object.entries(style ?? {}).filter(([name]) => !name.startsWith("--")))
    : style;

  return (
    <VortexStyleRootContext.Provider value={{ element }}>
      <div ref={setElement} {...props} style={ownStyle} data-vortex-style-root="">
        {children}
      </div>
    </VortexStyleRootContext.Provider>
  );
}

/** A missing context means a platform screen, whose portal belongs under the document root. */
export function useVortexStylePortalRoot(): StyleRootContext | null {
  return React.useContext(VortexStyleRootContext);
}
