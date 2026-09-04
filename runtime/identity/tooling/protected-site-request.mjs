const bypassHeaderName = "x-vercel-protection-bypass";

export const createProtectedSiteFetch = (fetchImplementation, siteUrl, bypassSecret) => {
  if (typeof fetchImplementation !== "function")
    throw new Error("A fetch implementation is required");

  const site = new globalThis.URL(siteUrl);
  if (site.pathname !== "/" || site.search || site.hash)
    throw new Error("The protected site URL must contain only its origin");
  if (!bypassSecret || bypassSecret.trim().length === 0)
    throw new Error("The Vercel automation bypass secret is required");

  return async (pathname, init = {}) => {
    if (typeof pathname !== "string" || !pathname.startsWith("/"))
      throw new Error("A protected-site request must use an absolute path");

    const requestUrl = new globalThis.URL(pathname, site);
    if (requestUrl.origin !== site.origin)
      throw new Error("A protected-site request cannot leave the configured origin");

    const headers = new globalThis.Headers(init.headers);
    headers.set(bypassHeaderName, bypassSecret);

    return fetchImplementation(requestUrl, { ...init, redirect: "manual", headers });
  };
};
