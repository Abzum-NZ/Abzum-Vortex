/**
 * Browser-safe construction of the Vortex-owned bootstrap document URL for one custom component
 * bundle. The server route that serves the document lives at the same path and reads the same query
 * parameter names (`runtime/file/src/component-bootstrap-serving.ts`); keep both in sync.
 */

/** The bootstrap document path on the dedicated component origin. */
export const COMPONENT_BOOTSTRAP_SERVING_PATH = "/api/components/bootstrap";

/** The query parameter names the bootstrap document route reads. */
export const COMPONENT_BOOTSTRAP_QUERY_PARAMETERS = Object.freeze({
  contentAddress: "bundle",
  entryFile: "entry",
  allowedHosts: "hosts",
} as const);

const INTEGRITY_PATTERN = /^sha384-([A-Za-z0-9+/]{64})$/;

/**
 * Converts the base64 SHA-384 Subresource Integrity digest recorded in a custom component release
 * into the lowercase hex content address the bundle host serves. A tampered or malformed digest is
 * refused rather than served.
 */
export const componentBundleContentAddressFromIntegrity = (
  integrity: string,
): string | undefined => {
  const match = INTEGRITY_PATTERN.exec(integrity);
  const encoded = match?.[1];
  if (encoded === undefined) return undefined;
  const decoded = atob(encoded);
  if (decoded.length !== 48) return undefined;
  let hex = "";
  for (let index = 0; index < decoded.length; index += 1)
    hex += decoded.charCodeAt(index).toString(16).padStart(2, "0");
  return hex;
};

/** The validated pieces of one custom component's bootstrap document URL. */
export type CustomComponentBootstrapTarget = Readonly<{
  contentAddress: string;
  entryFile: string;
  allowedHosts: readonly string[];
}>;

/**
 * Builds the identifier-free bootstrap document URL for one target: the content address, the
 * relative entry file and the release's declared external hosts only.
 */
export const customComponentBootstrapUrl = (
  componentOrigin: string,
  target: CustomComponentBootstrapTarget,
): string => {
  const origin = componentOrigin.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.contentAddress, target.contentAddress);
  params.set(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.entryFile, target.entryFile);
  if (target.allowedHosts.length > 0)
    params.set(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.allowedHosts, target.allowedHosts.join(","));
  return `${origin}${COMPONENT_BOOTSTRAP_SERVING_PATH}?${params.toString()}`;
};
