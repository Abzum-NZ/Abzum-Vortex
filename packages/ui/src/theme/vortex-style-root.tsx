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

/**
 * The document root carries the theme of the application on screen. The server render already gives
 * it the addressed application's theme, so the first paint is right; this keeps it right across
 * client-side navigation: an application surface puts its theme on the document root (the same
 * values the server render wrote), and leaving the application removes them again, so the platform
 * default `:root` rule applies with the platform style attributes. The viewer's appearance (colour
 * scheme and mode) is never touched: it stays the document root's own.
 */
function useDocumentTheme(element: HTMLDivElement | null, enabled: boolean, themeKey: string) {
  React.useLayoutEffect(() => {
    if (!enabled || element === null) return;
    const root = document.documentElement;
    const properties: string[] = [];
    for (let index = 0; index < element.style.length; index += 1) {
      const name = element.style.item(index);
      if (!name.startsWith("--")) continue;
      properties.push(name);
      const value = element.style.getPropertyValue(name);
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    }
    for (const name of DOCUMENT_THEME_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && root.getAttribute(name) !== value) root.setAttribute(name, value);
    }
    return () => {
      for (const name of properties) root.style.removeProperty(name);
      for (const name of DOCUMENT_THEME_ATTRIBUTES)
        root.setAttribute(name, PLATFORM_STYLE_ATTRIBUTES[name]);
    };
  }, [element, enabled, themeKey]);
}

/**
 * Keep portalled components inside the application root whose style and theme they inherit. The
 * application surface (`documentTheme`) also gives its theme to the document root.
 */
export function VortexStyleRoot({
  children,
  documentTheme = false,
  ...props
}: React.ComponentProps<"div"> & { documentTheme?: boolean }) {
  const [element, setElement] = React.useState<HTMLDivElement | null>(null);
  const themeKey = JSON.stringify([
    props.style,
    DOCUMENT_THEME_ATTRIBUTES.map((name) => (props as Record<string, unknown>)[name]),
  ]);
  useDocumentTheme(element, documentTheme, themeKey);

  return (
    <VortexStyleRootContext.Provider value={{ element }}>
      <div ref={setElement} {...props} data-vortex-style-root="">
        {children}
      </div>
    </VortexStyleRootContext.Provider>
  );
}

/** A missing context means a platform screen, whose portal belongs under the document root. */
export function useVortexStylePortalRoot(): StyleRootContext | null {
  return React.useContext(VortexStyleRootContext);
}
