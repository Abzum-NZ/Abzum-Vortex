import "server-only";

import {
  COMPONENT_BUNDLE_CONTENT_ADDRESS_LENGTH,
  COMPONENT_BUNDLE_CORS_ORIGIN,
  COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL,
  componentBundleContentAddress,
  componentBundleFileDigest,
  componentBundleFileObjectPath,
  componentBundleManifestObjectPath,
  componentBundleMediaType,
  decodeComponentBundleManifest,
  isSafeComponentBundlePath,
  type ComponentBundleManifest,
  type ComponentBundleObjectStore,
  type ComponentBundleRefusalReason,
} from "./component-bundle-storage";

/**
 * The canonical HTTP status of each serving refusal. A missing bundle is 404; a
 * served object whose bytes do not match its recorded digest is 502, because the
 * store itself failed the integrity the address promised, and it is never
 * delivered.
 */
export const componentBundleRefusalHttpStatus: Readonly<Record<ComponentBundleRefusalReason, number>> =
  Object.freeze({
    malformed_bundle: 400,
    bundle_not_found: 404,
    digest_mismatch: 409,
    integrity_failure: 502,
    bundle_conflict: 409,
    storage_unavailable: 503,
  });

const REFUSAL_MESSAGES: Readonly<Record<ComponentBundleRefusalReason, string>> = Object.freeze({
  malformed_bundle: "The component bundle request is malformed",
  bundle_not_found: "The component bundle was not found",
  digest_mismatch: "The component bundle does not match its recorded digest",
  integrity_failure: "The component bundle failed its integrity check",
  bundle_conflict: "The component bundle address already holds different content",
  storage_unavailable: "The component bundle is temporarily unavailable",
});

const ADDRESS_PATTERN = new RegExp(`^[0-9a-f]{${COMPONENT_BUNDLE_CONTENT_ADDRESS_LENGTH}}$`);

export type ServedComponentBundle = Readonly<{
  outcome: "served";
  statusCode: 200;
  headers: Readonly<Record<string, string>>;
  bytes: Uint8Array;
}>;

export type RefusedComponentBundle = Readonly<{
  outcome: "refused";
  reason: ComponentBundleRefusalReason;
  message: string;
  statusCode: number;
  headers: Readonly<Record<string, string>>;
}>;

export type ServeComponentBundleResult = ServedComponentBundle | RefusedComponentBundle;

const servedHeaders = (relativePath: string): Readonly<Record<string, string>> =>
  Object.freeze({
    "Cache-Control": COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL,
    "Content-Type": componentBundleMediaType(relativePath),
    "Access-Control-Allow-Origin": COMPONENT_BUNDLE_CORS_ORIGIN,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

const refusalHeaders = (): Readonly<Record<string, string>> =>
  Object.freeze({
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": COMPONENT_BUNDLE_CORS_ORIGIN,
    "X-Content-Type-Options": "nosniff",
  });

const refused = (reason: ComponentBundleRefusalReason): RefusedComponentBundle =>
  Object.freeze({
    outcome: "refused",
    reason,
    message: REFUSAL_MESSAGES[reason],
    statusCode: componentBundleRefusalHttpStatus[reason],
    headers: refusalHeaders(),
  });

/**
 * The public address of one bundle file on the dedicated component domain. The
 * address is just the entry digest plus the file's own relative path: it carries
 * no organisation, record or person identifier.
 */
export const componentBundleServingPath = (contentAddress: string, relativePath: string): string =>
  `/${contentAddress}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Serves one file of one content-addressed bundle.
 *
 * 1. The content address must be the hex SHA-384 digest of the bundle's entry
 *    file.
 * 2. The manifest at that address is read and must describe the same address.
 * 3. The requested file's bytes are read from beneath the address and their
 *    SHA-384 must equal the digest the manifest records, so a tampered stored
 *    object is refused rather than delivered.
 * 4. A served file gets immutable cache headers and open CORS, because the
 *    sandboxed frame loads it from an opaque origin.
 */
export const serveComponentBundle = async (
  input: Readonly<{ contentAddress: string; relativePath?: string }>,
  store: ComponentBundleObjectStore,
): Promise<ServeComponentBundleResult> => {
  if (!ADDRESS_PATTERN.test(input.contentAddress)) return refused("malformed_bundle");

  let manifestBytes: Uint8Array | undefined;
  try {
    manifestBytes = await store.readObject({
      objectPath: componentBundleManifestObjectPath(input.contentAddress),
    });
  } catch {
    return refused("storage_unavailable");
  }
  if (manifestBytes === undefined) return refused("bundle_not_found");

  let manifest: ComponentBundleManifest;
  try {
    manifest = decodeComponentBundleManifest(manifestBytes);
    if (
      componentBundleContentAddress(manifest.digest) !== input.contentAddress ||
      !isSafeComponentBundlePath(manifest.entryFile)
    )
      return refused("integrity_failure");
  } catch {
    return refused("integrity_failure");
  }

  const requested = input.relativePath ?? manifest.entryFile;
  if (!isSafeComponentBundlePath(requested)) return refused("malformed_bundle");
  const recorded = manifest.files.find((file) => file.path === requested);
  if (recorded === undefined) return refused("bundle_not_found");

  let bytes: Uint8Array | undefined;
  try {
    bytes = await store.readObject({
      objectPath: componentBundleFileObjectPath(input.contentAddress, requested),
    });
  } catch {
    return refused("storage_unavailable");
  }
  if (bytes === undefined) return refused("bundle_not_found");
  if (componentBundleFileDigest(bytes) !== recorded.sha384) return refused("integrity_failure");

  return Object.freeze({
    outcome: "served",
    statusCode: 200,
    headers: servedHeaders(requested),
    bytes,
  });
};
