import "server-only";

import {
  COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL,
  COMPONENT_BUNDLE_CORS_ORIGIN,
  componentBundleRefusalHttpStatus,
  createComponentBundleStorageCredentialMinter,
  createSupabaseComponentBundleObjectStore,
  serveComponentBundle,
  type ComponentBundleObjectStore,
  type ServeComponentBundleResult,
} from "@vortex/file";
import { requestMatchesConfiguredSite } from "../../../auth/_lib/session-request-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The bundle host for the dedicated component domain. The domain serves one
 * content-addressed bundle file at `/api/components/<contentAddress>/<relativePath>`;
 * an address with no relative path serves the bundle's entry file. The URL
 * carries no organisation, record or person identifier.
 *
 * The route answers only on the configured component origin
 * (`VORTEX_COMPONENT_BUNDLE_ORIGIN`), which must be a different domain from the
 * Vortex site, so publisher code is never served from a Vortex application
 * origin. Reads pass through this server route, which mints one exact read
 * credential for the requested object; the private bucket is never
 * public-readable. Bytes are verified against the digest recorded for them, so
 * a tampered object is refused rather than delivered.
 */

const requiredEnvironmentValue = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0)
    throw new Error(`Missing required server configuration: ${name}`);
  return value;
};

const refusal = (
  reason: keyof typeof componentBundleRefusalHttpStatus,
  headers?: Readonly<Record<string, string>>,
): Response => {
  const response = Response.json(
    { outcome: "refused", reason },
    { status: componentBundleRefusalHttpStatus[reason] },
  );
  for (const [name, value] of Object.entries({
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": COMPONENT_BUNDLE_CORS_ORIGIN,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  }))
    response.headers.set(name, value);
  return response;
};

let componentOrigin: string | undefined;

/**
 * The configured component origin, refused when its host is, contains or is
 * contained by the Vortex site host. Any configuration error fails closed.
 */
const configuredComponentOrigin = (): string => {
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

/** True only for a request addressed to the dedicated component origin. */
const isComponentOriginRequest = (request: Request): boolean => {
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

let objectStore: ComponentBundleObjectStore | undefined;

/**
 * The server-only component bundle Storage credential. The destination project
 * is derived from the configured Supabase URL; a local or non-Supabase address
 * has no Storage bridge, so serving fails closed.
 */
const componentBundleObjectStore = (): ComponentBundleObjectStore => {
  if (objectStore !== undefined) return objectStore;
  const supabaseUrl = requiredEnvironmentValue("VORTEX_SUPABASE_URL");
  const hostname = new URL(supabaseUrl).hostname;
  const match = /^([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\.supabase\.co$/.exec(hostname);
  if (match === null || match[1] === undefined)
    throw new Error("Component bundle Storage requires a hosted Supabase destination project");
  const destinationProject = match[1];
  // The component bundle credentials are signed by the destination project's
  // own server-only Storage signing key and carry a distinct token kind, so the
  // bucket policies admit only component bundle operations on one address.
  const keyId = requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY_ID");
  const minter = createComponentBundleStorageCredentialMinter({
    destinationProject,
    issuer: `https://${destinationProject}.supabase.co/auth/v1`,
    activeKeyId: keyId,
    keys: [
      {
        keyId,
        signer: requiredEnvironmentValue("VORTEX_FILE_STORAGE_SIGNING_KEY").replace(/\\n/g, "\n"),
      },
    ],
  });
  // The serving route only ever reads, so its store can never mint an upload.
  objectStore = createSupabaseComponentBundleObjectStore({
    supabaseUrl,
    mintCredential: async (input) => {
      if (input.operation !== "read")
        throw new Error("The component bundle serving route mints read credentials only");
      return minter(input);
    },
  });
  return objectStore;
};

/** One content-addressed bundle file, or the entry file when no path follows. */
export async function GET(
  request: Request,
  context: { params: Promise<{ address: string[] }> },
): Promise<Response> {
  if (!isComponentOriginRequest(request)) return refusal("bundle_not_found");
  const { address } = await context.params;
  const contentAddress = address[0];
  if (contentAddress === undefined) return refusal("malformed_bundle");
  const relativePath = address.length > 1 ? address.slice(1).join("/") : undefined;

  let result: ServeComponentBundleResult;
  try {
    result = await serveComponentBundle(
      { contentAddress, ...(relativePath === undefined ? {} : { relativePath }) },
      componentBundleObjectStore(),
    );
  } catch {
    return refusal("storage_unavailable");
  }
  if (result.outcome === "refused") return refusal(result.reason, result.headers);
  return new Response(Buffer.from(result.bytes), { status: result.statusCode, headers: result.headers });
}

/** The sandboxed frame loads module scripts cross-origin, so preflight is open. */
export function OPTIONS(request: Request): Response {
  if (!isComponentOriginRequest(request)) return refusal("bundle_not_found");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": COMPONENT_BUNDLE_CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL,
    },
  });
}
