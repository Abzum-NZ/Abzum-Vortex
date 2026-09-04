import "server-only";

export const identitySessionProxyHeader = "x-vortex-internal-identity-session";

export type IdentitySessionProxyState =
  "missing" | "verified" | "invalid" | "temporarily_unavailable";

export const forwardedIdentitySessionHeaders = (
  source: Headers,
  state: IdentitySessionProxyState,
): Headers => {
  const forwarded = new Headers(source);
  // Proxy owns this marker. A caller-supplied value is always replaced.
  forwarded.set(identitySessionProxyHeader, state);
  return forwarded;
};

export const requestMatchesConfiguredSite = (
  requestHeaders: Headers,
  requestUrl: URL,
  siteUrl: string,
): boolean => {
  const configured = new URL(siteUrl);
  const actualHost = requestHeaders.get("host");
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  const actualProtocol = forwardedProtocol ? `${forwardedProtocol}:` : requestUrl.protocol;
  return actualHost === configured.host && actualProtocol === configured.protocol;
};
