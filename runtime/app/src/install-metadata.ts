import "server-only";

import { z } from "zod";
import { builderKeySchema, namespacedKeySchema, themeTokenValueV2Schema } from "@vortex/contracts";
import { isReservedTenantSegment } from "./application-address";
import { requireInstalledRuntimeContext, type InstalledRuntimeContext } from "./installed-runtime-context";

export const applicationInstallAddressSchema = z.object({
  tenantShortName: builderKeySchema,
  organizationShortName: builderKeySchema,
  applicationKey: namespacedKeySchema,
}).strict().refine((value) => !isReservedTenantSegment(value.tenantShortName));
export type ApplicationInstallAddress = z.infer<typeof applicationInstallAddressSchema>;

export type ApplicationInstallManifest = Readonly<{
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  icons: readonly Readonly<{ src: string; type: "image/svg+xml"; sizes: "any"; purpose: "any" }>[];
  background_color: string;
  theme_color: string;
  display: "standalone";
  lang: "en";
  dir: "ltr";
}>;

/** Reads only a validated compiled color token, preserving both accepted color forms. */
export const applicationInstallColor = (context: InstalledRuntimeContext, key: string): string => {
  const token = themeTokenValueV2Schema.parse(
    requireInstalledRuntimeContext(context).releaseSet.application.content.theme.tokens[key],
  );
  if (token.kind !== "color_pair") throw new Error("APPLICATION_INSTALL_METADATA_UNAVAILABLE");
  return token.light;
};

/** Appearance metadata is never authority; the Web caller must freshly authorize its context. */
export const createApplicationInstallManifest = (
  candidate: InstalledRuntimeContext,
  addressCandidate: ApplicationInstallAddress,
  iconDataUri: string,
): ApplicationInstallManifest => {
  const context = requireInstalledRuntimeContext(candidate);
  const address = applicationInstallAddressSchema.parse(addressCandidate);
  const application = context.releaseSet.application;
  if (application.definitionKey !== address.applicationKey ||
      iconDataUri.length > 100_000 || !iconDataUri.startsWith("data:image/svg+xml,"))
    throw new Error("APPLICATION_INSTALL_METADATA_UNAVAILABLE");
  const svg = decodeURIComponent(iconDataUri.slice("data:image/svg+xml,".length));
  if (svg.length > 32_768 || !svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ') ||
      !svg.endsWith("</svg>") ||
      /<(?:script|foreignObject|image|use|a|style)\b|\son[a-z]+=|\shref=|url\(|javascript:|data:/i.test(svg))
    throw new Error("APPLICATION_INSTALL_METADATA_UNAVAILABLE");
  const id = `/${[address.tenantShortName, address.organizationShortName, address.applicationKey]
    .map(encodeURIComponent).join("/")}`;
  const manifest: ApplicationInstallManifest = Object.freeze({
    id,
    name: application.content.name,
    short_name: application.content.name,
    start_url: `${id}/_install`,
    scope: `${id}/`,
    icons: Object.freeze([Object.freeze({ src: iconDataUri, type: "image/svg+xml" as const,
      sizes: "any" as const, purpose: "any" as const })]),
    background_color: applicationInstallColor(context, "background"),
    theme_color: applicationInstallColor(context, "primary"),
    display: "standalone", lang: "en", dir: "ltr",
  });
  if (JSON.stringify(manifest).length > 200_000)
    throw new Error("APPLICATION_INSTALL_METADATA_UNAVAILABLE");
  return manifest;
};
