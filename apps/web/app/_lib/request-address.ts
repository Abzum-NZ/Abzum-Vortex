import "server-only";

/**
 * The address (path and query) of the request being rendered. Next.js gives a layout only its own
 * segment's parameters, but the application frame layout must project the frame of the page the
 * request addresses, so the proxy forwards the address in this header. The proxy owns the header:
 * a caller-supplied value is always replaced.
 */
export const requestAddressHeader = "x-vortex-internal-request-address";

/** The value the proxy forwards: the path and query, without Next.js's own router parameters. */
export const requestAddressOf = (url: URL): string => {
  const query = new URLSearchParams(url.search);
  query.delete("_rsc");
  const search = query.toString();
  return search === "" ? url.pathname : `${url.pathname}?${search}`;
};
