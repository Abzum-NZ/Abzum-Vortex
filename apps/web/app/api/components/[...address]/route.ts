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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The bundle host for the dedicated component domain. The domain serves one
 * content-addressed bundle file at `/<contentAddress>/<relativePath>`; an
 * address with no relative path serves the bundle's entry file. The URL carries
 * no organisation, record or person identifier.
 *
 * Reads pass through this server route, which mints one exact read credential
 * for the requested object; the private bucket is never public-readable. Bytes
 * are verified against the digest recorded for them, so a tampered object is
 * refused rather than delivered.
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
  objectStore = createSupabaseComponentBundleObjectStore({ supabaseUrl, mintCredential: minter });
  return objectStore;
};

/** One content-addressed bundle file, or the entry file when no path follows. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ address: string[] }> },
): Promise<Response> {
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
export function OPTIONS(): Response {
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
