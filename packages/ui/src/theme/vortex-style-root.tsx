"use client";

import * as React from "react";

type StyleRootContext = Readonly<{ element: HTMLDivElement | null }>;

const VortexStyleRootContext = React.createContext<StyleRootContext | null>(null);

/** The root attributes that select the style, the menu treatment and the theme scope. */
const DOCUMENT_THEME_ATTRIBUTES = [
  "data-vortex-style",
  "data-vortex-menu",
  "data-vortex-menu-accent",
] as const;

/**
 * While an application surface is mounted the document root carries that application's theme, so
 * the root itself, the body and anything a library places outside the application root paint the
 * application's style, fonts, radius and colours rather than the platform default. Leaving the
 * application puts the platform default back. The viewer's appearance (colour scheme and mode) is
 * never touched: it stays the document root's own.
 */
function useDocumentTheme(element: HTMLDivElement | null, enabled: boolean, themeKey: string) {
  React.useLayoutEffect(() => {
    if (!enabled || element === null) return;
    const root = document.documentElement;
    const attributes = DOCUMENT_THEME_ATTRIBUTES.map(
      (name) => [name, root.getAttribute(name)] as const,
    );
    const properties: [string, string][] = [];
    for (let index = 0; index < element.style.length; index += 1) {
      const name = element.style.item(index);
      if (!name.startsWith("--")) continue;
      properties.push([name, root.style.getPropertyValue(name)]);
      root.style.setProperty(name, element.style.getPropertyValue(name));
    }
    for (const [name] of attributes) {
      const value = element.getAttribute(name);
      if (value !== null) root.setAttribute(name, value);
    }
    return () => {
      for (const [name, value] of attributes) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
      for (const [name, value] of properties) {
        if (value === "") root.style.removeProperty(name);
        else root.style.setProperty(name, value);
      }
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
