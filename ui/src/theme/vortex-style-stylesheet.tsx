"use client";

import { useEffect } from "react";

import { VORTEX_STYLES, vortexStyleStylesheetHref, type VortexStyle } from "./vortex-style";

function removeSupersededStylesheets(currentHref?: string) {
  for (const element of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const href = element.getAttribute("href");
    const style = VORTEX_STYLES.find((candidate) => href === vortexStyleStylesheetHref(candidate));
    if (style === undefined || href === currentHref) continue;
    // Several preview canvases can coexist. A stylesheet is stale only after its last application
    // root leaves the document; the html platform default alone does not need a linked stylesheet.
    if (document.querySelector(`[data-vortex-style-root][data-vortex-style="${style}"]`) === null)
      element.remove();
  }
}

/**
 * The one style stylesheet a page links, and the only place a superseded one is dropped.
 *
 * The link is rendered on the server, so the resolved style is the one that paints the first
 * response, and its href comes from the fixed catalogue, never from the request. A client-side
 * navigation to an application that resolved another style re-renders this link with that style's
 * href. React can leave a former hoisted stylesheet behind; the effect removes it after its last
 * application root has gone. Concurrent preview canvases keep every style they still use.
 */
export function VortexStyleStylesheet({ style }: Readonly<{ style: VortexStyle }>) {
  const href = vortexStyleStylesheetHref(style);
  useEffect(() => {
    removeSupersededStylesheets(href);
    return () => removeSupersededStylesheets();
  }, [href]);
  // React treats a precedence stylesheet as a resource and ignores later prop changes on that link.
  // A new href must therefore mount a new resource before the old one can be removed.
  return (
    <link
      key={href}
      rel="stylesheet"
      href={href}
      data-vortex-style={style}
      precedence="vortex-style"
    />
  );
}
