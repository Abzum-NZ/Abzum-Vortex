import "server-only";

import {
  COMPONENT_BUNDLE_CONTENT_ADDRESS_LENGTH,
  COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL,
  componentBundleAddressDigest,
  isSafeComponentBundlePath,
} from "./component-bundle-storage";
import { COMPONENT_BUNDLE_SERVING_PREFIX, componentBundleServingPath } from "./component-bundle-serving";

/**
 * The Vortex-owned bootstrap document for one custom component bundle, served on the dedicated
 * component origin beside the content-addressed bundle files. The document contains no script of
 * its own: it loads exactly the bundle entry the release names, with the Subresource Integrity
 * digest recovered from the content address, and it is confined by the Content-Security-Policy the
 * application packages appendix defines. Its URL carries the content address, the relative entry
 * file and the release's declared external hosts, and no organisation, record or person identifier.
 */

/** The static last path segment of the bootstrap route, under the shared component serving prefix. */
export const COMPONENT_BOOTSTRAP_SERVING_SUBPATH = "bootstrap";

/** The bootstrap document path on the dedicated component origin. */
export const COMPONENT_BOOTSTRAP_SERVING_PATH = `${COMPONENT_BUNDLE_SERVING_PREFIX}/${COMPONENT_BOOTSTRAP_SERVING_SUBPATH}`;

/**
 * The query parameters of the bootstrap document URL. The host component in `@vortex/ui` builds the
 * same URL, so these names are the contract between the two; both sides keep them in sync.
 */
export const COMPONENT_BOOTSTRAP_QUERY_PARAMETERS = Object.freeze({
  contentAddress: "bundle",
  entryFile: "entry",
  allowedHosts: "hosts",
} as const);

const ADDRESS_PATTERN = new RegExp(`^[0-9a-f]{${COMPONENT_BUNDLE_CONTENT_ADDRESS_LENGTH}}$`);
const ENTRY_FILE_PATTERN = /\.m?js$/;
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAXIMUM_DECLARED_HOSTS = 50;

/** One custom component bootstrap target, already validated to a safe, identifier-free shape. */
export type ComponentBootstrapTarget = Readonly<{
  contentAddress: string;
  entryFile: string;
  allowedHosts: readonly string[];
}>;

export type ComponentBootstrapDocument = Readonly<{
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
}>;

/**
 * Reads and validates the bootstrap target from a URL's query. A malformed content address, a
 * non-JavaScript or unsafe entry path, a repeated host or a non-bare host is refused here, so the
 * document is never built from unvalidated input.
 */
export const parseComponentBootstrapTarget = (
  searchParams: URLSearchParams,
): ComponentBootstrapTarget | undefined => {
  const contentAddress = searchParams.get(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.contentAddress);
  const entryFile = searchParams.get(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.entryFile);
  const hostsValue = searchParams.get(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.allowedHosts);
  if (contentAddress === null || !ADDRESS_PATTERN.test(contentAddress)) return undefined;
  if (
    entryFile === null ||
    !isSafeComponentBundlePath(entryFile) ||
    !ENTRY_FILE_PATTERN.test(entryFile)
  )
    return undefined;
  const allowedHosts =
    hostsValue === null || hostsValue.length === 0 ? [] : hostsValue.split(",");
  if (allowedHosts.length > MAXIMUM_DECLARED_HOSTS) return undefined;
  if (new Set(allowedHosts).size !== allowedHosts.length) return undefined;
  for (const host of allowedHosts) if (!HOST_PATTERN.test(host)) return undefined;
  return Object.freeze({
    contentAddress,
    entryFile,
    allowedHosts: Object.freeze([...allowedHosts]),
  });
};

/**
 * The public bootstrap document URL for one target. The host component builds the same URL, so a
 * change here is a change to the contract both sides share.
 */
export const componentBootstrapServingUrl = (
  componentOrigin: string,
  target: ComponentBootstrapTarget,
): string => {
  const origin = componentOrigin.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.contentAddress, target.contentAddress);
  params.set(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.entryFile, target.entryFile);
  if (target.allowedHosts.length > 0)
    params.set(COMPONENT_BOOTSTRAP_QUERY_PARAMETERS.allowedHosts, target.allowedHosts.join(","));
  return `${origin}${COMPONENT_BOOTSTRAP_SERVING_PATH}?${params.toString()}`;
};

/**
 * The Content-Security-Policy of the bootstrap document. `sandbox allow-scripts` keeps the frame
 * on an opaque origin, so it never shares the bundle host's origin; scripts may only load the
 * content-addressed bundle, and network access is limited to the bundle host and the hosts the
 * release declares. The Vortex site is the only permitted frame ancestor.
 */
export const componentBootstrapContentSecurityPolicy = (
  input: Readonly<{ componentOrigin: string; siteOrigin: string; allowedHosts: readonly string[] }>,
): string => {
  const bundleHost = input.componentOrigin.replace(/\/+$/, "");
  const declared = input.allowedHosts.map((host) => `https://${host}`);
  const networkSources = [bundleHost, ...declared].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${bundleHost} 'wasm-unsafe-eval'`,
    `style-src ${bundleHost} 'unsafe-inline'`,
    "worker-src blob:",
    `connect-src ${networkSources}`,
    `img-src ${networkSources} blob: data:`,
    `media-src ${networkSources} blob:`,
    `font-src ${networkSources}`,
    `frame-ancestors ${input.siteOrigin}`,
  ].join("; ");
};

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Builds the bootstrap document for one validated target. The only interpolated values are the
 * content-addressed entry URL (built by {@link componentBundleServingPath}) and the Subresource
 * Integrity digest recovered from the content address, so the document never embeds unvalidated
 * text and never references the bundle by an identifier-bearing address.
 */
export const renderComponentBootstrapDocument = (
  input: Readonly<{
    target: ComponentBootstrapTarget;
    componentOrigin: string;
    siteOrigin: string;
  }>,
): ComponentBootstrapDocument => {
  const entryPath = componentBundleServingPath(input.target.contentAddress, input.target.entryFile);
  const integrity = componentBundleAddressDigest(input.target.contentAddress);
  const body = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Vortex custom component</title>",
    "<style>html,body{margin:0;height:100%;}#vortex-custom-component-root{height:100%;}</style>",
    "</head>",
    "<body>",
    '<div id="vortex-custom-component-root"></div>',
    `<script type="module" src="${escapeHtmlAttribute(entryPath)}" integrity="${escapeHtmlAttribute(
      integrity,
    )}" crossorigin="anonymous"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
  return Object.freeze({
    body: new TextEncoder().encode(body),
    headers: Object.freeze({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": componentBootstrapContentSecurityPolicy(input),
      "Cache-Control": COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }),
  });
};
