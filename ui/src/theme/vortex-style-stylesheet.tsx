"use client";

import { useEffect } from "react";

import { vortexStyleStylesheetHref, type VortexStyle } from "./vortex-style";

/**
 * The one style stylesheet a page links, and the only place a superseded one is dropped.
 *
 * The link is rendered on the server, so the resolved style is the one that paints the first
 * response, and its href comes from the fixed catalogue, never from the request. A client-side
 * navigation to an application that resolved another style re-renders this link with that style's
 * href, and a stylesheet React already hoisted into the same precedence group can stay in the
 * document; the effect removes every other linked style stylesheet once the current one is in
 * place, so exactly one style stylesheet is ever applied. The rules each one carries are scoped to
 * its own style root, so the stale sheet was already inert; removing it keeps the document honest
 * about what the page loads.
 */
export function VortexStyleStylesheet({ style }: Readonly<{ style: VortexStyle }>) {
  const href = vortexStyleStylesheetHref(style);
  useEffect(() => {
    for (const element of document.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][data-vortex-style]',
    )) {
      if (element.getAttribute("href") !== href) element.remove();
    }
  }, [href]);
  return <link rel="stylesheet" href={href} data-vortex-style={style} precedence="vortex-style" />;
}
