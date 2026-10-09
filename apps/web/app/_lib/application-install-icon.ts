import "server-only";

import { resolveShadcnIconLibrary } from "@vortex/contracts";
import { applicationInstallColor, requireInstalledRuntimeContext, type InstalledRuntimeContext } from "@vortex/app";
import catalogue from "./application-install-icons.generated.json";

/** The catalogue is source-produced from the same shipped semantic adapters as ApplicationLauncher. */
export const createApplicationInstallIcon = (candidate: InstalledRuntimeContext): string => {
  const context = requireInstalledRuntimeContext(candidate);
  const content = context.releaseSet.application.content;
  const library = resolveShadcnIconLibrary(content.theme.selection?.iconLibrary);
  const glyphs: Readonly<Record<string, string>> = catalogue.libraries[library];
  const name = Object.hasOwn(glyphs, content.icon) ? content.icon : "circle";
  const glyph = glyphs[name];
  if (catalogue.version !== 1 || typeof glyph !== "string" || glyph.length > 30_000 ||
      !glyph.startsWith("<svg ") || !glyph.endsWith("</svg>") ||
      /<(?:script|foreignObject|image|use|a|style)\b|\son[a-z]+=|url\(|javascript:|data:/i.test(glyph))
    throw new Error("APPLICATION_INSTALL_METADATA_UNAVAILABLE");
  const background = applicationInstallColor(context, "primary");
  const foreground = applicationInstallColor(context, "primary_foreground");
  // Only validated color syntax and source-generated inert markup enter this document.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
    `<rect width="512" height="512" rx="96" fill="${background}"/>` +
    `<g transform="translate(96 96) scale(13.3333333333)" color="${foreground}">${glyph}</g></svg>`;
  if (svg.length > 32_768) throw new Error("APPLICATION_INSTALL_METADATA_UNAVAILABLE");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
