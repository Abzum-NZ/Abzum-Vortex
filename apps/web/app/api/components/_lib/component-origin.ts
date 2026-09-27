import "server-only";

import { requestMatchesConfiguredSite } from "../../../auth/_lib/session-request-state";
import { requiredEnvironmentValue } from "../../../_lib/server-configuration";

let componentOrigin: string | undefined;

/**
 * The configured dedicated component origin, refused when its host is, contains or is contained by
 * the Vortex site host. Any configuration error fails closed, so publisher code is never served
 * from a Vortex application origin. Both component routes use this check.
 */
export const configuredComponentOrigin = (): string => {
  if (componentOrigin !== undefined) return componentOrigin;
  const component = new URL(requiredEnvironmentValue("VORTEX_COMPONENT_BUNDLE_ORIGIN"));
  const site = new URL(requiredEnvironmentValue("VORTEX_SITE_URL"));
  const componentHost = component.hostname.toLowerCase();
  const siteHost = site.hostname.toLowerCase();
  if (
    component.origin !== component.href.replace(/\/$/, "") ||
    componentHost === siteHost ||
    componentHost.endsWith(`.${siteHost}`) ||
    siteHost.endsWith(`.${componentHost}`)
  )
    throw new Error("The component bundle origin must be a dedicated domain, never the Vortex site");
  componentOrigin = component.origin;
  return componentOrigin;
};

/** The configured Vortex site origin, used as the bootstrap document's only frame ancestor. */
export const configuredSiteOrigin = (): string =>
  new URL(requiredEnvironmentValue("VORTEX_SITE_URL")).origin;

/** True only for a request addressed to the dedicated component origin. */
export const isComponentOriginRequest = (request: Request): boolean => {
  try {
    return requestMatchesConfiguredSite(
      request.headers,
      new URL(request.url),
      configuredComponentOrigin(),
    );
  } catch {
    return false;
  }
};
