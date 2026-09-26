import "server-only";

import { createHash, type KeyObject } from "node:crypto";
import {
  customComponentBundleV2Schema,
  type CustomComponentReleaseV2,
} from "@vortex/contracts";
import { z } from "zod";
import {
  createStorageSignerFromPrivateKey,
  type StorageKeySigner,
} from "./storage-credentials";

/**
 * The private bucket that holds custom component bundles. It is created and
 * locked down by migration 20260926040000; it is never public-writable, and a
 * bundle is read only through the serving credential minted for one exact
 * content address.
 */
export const COMPONENT_BUNDLE_BUCKET = "component_bundles";

/** The two content-addressed namespaces inside the bucket. */
export const COMPONENT_BUNDLE_MANIFEST_PREFIX = "manifests";
export const COMPONENT_BUNDLE_FILES_PREFIX = "bundles";

/** A published bundle is immutable, so every response may be cached forever. */
export const COMPONENT_BUNDLE_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * A bundle is not private data: it carries no organisation, record or person
 * identifier and the sandboxed frame loads it from an opaque origin, so the
 * bundle host is openly readable.
 */
export const COMPONENT_BUNDLE_CORS_ORIGIN = "*";

/** A content address is the 96-character lowercase hex form of a SHA-384 digest. */
export const COMPONENT_BUNDLE_CONTENT_ADDRESS_LENGTH = 96;
export const COMPONENT_BUNDLE_MAXIMUM_OPERATION_SECONDS = 60;

const componentBundleContentAddressSchema = z
  .string()
  .regex(/^[0-9a-f]{96}$/, "Use a lowercase hex SHA-384 content address");
const componentBundleDigestSchema = z
  .string()
  .regex(/^sha384-[A-Za-z0-9+/]{64}$/, "Use a base64 SHA-384 Subresource Integrity digest");
const componentBundleFileDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{96}$/, "Use a lowercase hex SHA-384 file digest");

/**
 * A relative bundle path: forward-slash separated segments of a safe alphabet,
 * with no scheme, absolute leading slash, empty segment or `.`/`..` step, so a
 * bundle file can never escape its content-address directory.
 */
export const componentBundleRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "Use a relative bundle path")
  .refine(
    (value) => value.split("/").every((segment) => !/^\.+$/.test(segment)),
    "Use a relative path without dot or parent steps",
  );

export const isSafeComponentBundlePath = (value: string): boolean =>
  componentBundleRelativePathSchema.safeParse(value).success;

/**
 * The bundle manifest stored beside the bundle's files. The entry file's digest
 * is the bundle's content address and its Subresource Integrity value; every
 * file carries its own digest so the serving route can verify each served byte.
 */
export const componentBundleManifestSchema = z
  .object({
    digest: componentBundleDigestSchema,
    entryFile: componentBundleRelativePathSchema,
    files: z
      .array(
        z
          .object({
            path: componentBundleRelativePathSchema,
            sha384: componentBundleFileDigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
  })
  .strict();

export type ComponentBundleManifest = z.infer<typeof componentBundleManifestSchema>;

/** One file supplied to publication: a relative path and its exact bytes. */
export type ComponentBundleFile = Readonly<{ path: string; bytes: Uint8Array }>;

/**
 * A closed refusal reason. `digest_mismatch` refuses a supplied bundle whose
 * entry bytes do not match the digest recorded in its #1142 component release;
 * `integrity_failure` refuses a served object whose bytes do not match the
 * digest recorded for it, so a tampered bundle is never delivered.
 */
export type ComponentBundleRefusalReason =
  | "malformed_bundle"
  | "bundle_not_found"
  | "digest_mismatch"
  | "integrity_failure"
  | "bundle_conflict"
  | "storage_unavailable";

export class ComponentBundleStorageError extends Error {
  readonly reason: ComponentBundleRefusalReason;

  constructor(reason: ComponentBundleRefusalReason) {
    super(reason);
    this.name = "ComponentBundleStorageError";
    this.reason = reason;
  }
}

const refuse = (reason: ComponentBundleRefusalReason): never => {
  throw new ComponentBundleStorageError(reason);
};

/**
 * The Subresource Integrity digest of one bundle's bytes, formatted exactly as
 * the #1142 component release records it.
 */
export const computeComponentBundleDigest = (bytes: Uint8Array): string =>
  `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** The lowercase hex digest of one bundle file's bytes. */
export const componentBundleFileDigest = (bytes: Uint8Array): string =>
  createHash("sha384").update(bytes).digest("hex");

/**
 * The URL-safe content address of a `sha384-<base64>` digest. The address is a
 * pure function of the entry bytes and never carries an organisation, record or
 * person identifier.
 */
export const componentBundleContentAddress = (digest: string): string => {
  const parsed = componentBundleDigestSchema.safeParse(digest);
  if (!parsed.success) return refuse("malformed_bundle");
  return Buffer.from(parsed.data.slice("sha384-".length), "base64").toString("hex");
};

/** The SRI digest that names a content address, recovered from its hex form. */
export const componentBundleAddressDigest = (contentAddress: string): string => {
  const parsed = componentBundleContentAddressSchema.safeParse(contentAddress);
  if (!parsed.success) return refuse("malformed_bundle");
  return `sha384-${Buffer.from(parsed.data, "hex").toString("base64")}`;
};

export const componentBundleManifestObjectPath = (contentAddress: string): string =>
  `${COMPONENT_BUNDLE_MANIFEST_PREFIX}/${contentAddress}.json`;

export const componentBundleFileObjectPath = (
  contentAddress: string,
  relativePath: string,
): string => `${COMPONENT_BUNDLE_FILES_PREFIX}/${contentAddress}/${relativePath}`;

const encodeObjectPath = (objectPath: string): string =>
  objectPath.split("/").map(encodeURIComponent).join("/");

/** Serialises a manifest deterministically so the same bundle always hashes alike. */
export const encodeComponentBundleManifest = (manifest: ComponentBundleManifest): Uint8Array => {
  const parsed = componentBundleManifestSchema.parse({
    digest: manifest.digest,
    entryFile: manifest.entryFile,
    files: [...manifest.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  });
  return new TextEncoder().encode(JSON.stringify(parsed));
};

export const decodeComponentBundleManifest = (bytes: Uint8Array): ComponentBundleManifest => {
  const parsed = componentBundleManifestSchema.safeParse(
    JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  );
  if (!parsed.success) return refuse("integrity_failure");
  return parsed.data;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;

/**
 * The server-side bundle object store. Implementations read and write exactly
 * one object per call and never accept a caller-supplied bucket or key. Writes
 * are additive: an existing object is never overwritten.
 */
export interface ComponentBundleObjectStore {
  writeObject(
    input: Readonly<{ objectPath: string; bytes: Uint8Array; contentType: string }>,
  ): Promise<void>;
  readObject(input: Readonly<{ objectPath: string }>): Promise<Uint8Array | undefined>;
}

export type ComponentBundleStorageOperation = "upload" | "read";

/**
 * Mints one server-held Storage credential for one operation on one content
 * address. The credential is short-lived and never projected to a browser.
 */
export type MintComponentBundleStorageCredential = (
  input: Readonly<{ operation: ComponentBundleStorageOperation; objectPath: string }>,
) => Promise<Readonly<{ token: string }>>;

type ComponentBundleStorageClaims = Readonly<{
  role: "authenticated";
  aud: "authenticated";
  iss: string;
  tokenKind: "vortex_component_bundle_operation";
  destinationProject: string;
  bucketId: typeof COMPONENT_BUNDLE_BUCKET;
  objectPath: string;
  operation: ComponentBundleStorageOperation;
  iat: number;
  exp: number;
}>;

export type ComponentBundleSigningKey = Readonly<{
  keyId: string;
  signer: StorageKeySigner | KeyObject | string | Buffer;
}>;

export type ComponentBundleStorageSigningConfig = Readonly<{
  destinationProject: string;
  issuer: string;
  activeKeyId: string;
  keys: readonly ComponentBundleSigningKey[];
  clock?: () => Date;
}>;

const encodeBase64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Creates the component-bundle Storage credential minter. The signing key is
 * server-only and scoped by its token kind: the bucket policies admit only
 * `vortex_component_bundle_operation` claims, so a private business file token
 * or an ordinary Auth token authorises nothing.
 */
export const createComponentBundleStorageCredentialMinter = (
  config: ComponentBundleStorageSigningConfig,
): MintComponentBundleStorageCredential => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(config.destinationProject))
    throw new Error("Component bundle destination project must be a canonical project ref");
  if (config.issuer !== `https://${config.destinationProject}.supabase.co/auth/v1`)
    throw new Error("Component bundle issuer must be the destination project's Auth issuer");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.activeKeyId))
    throw new Error("Component bundle active key identifier is invalid");
  if (config.keys.length === 0)
    throw new Error("Component bundle signing requires at least one key");

  const signers = new Map<string, StorageKeySigner>();
  for (const key of config.keys) {
    if (signers.has(key.keyId)) throw new Error("Component bundle key identifiers must be unique");
    signers.set(
      key.keyId,
      typeof key.signer === "function" ? key.signer : createStorageSignerFromPrivateKey(key.signer),
    );
  }
  const activeSigner = signers.get(config.activeKeyId);
  if (activeSigner === undefined) throw new Error("Component bundle active signing key is unavailable");
  const clock = config.clock ?? (() => new Date());

  return async ({ operation, objectPath }) => {
    if (operation !== "upload" && operation !== "read")
      throw new Error("Component bundle credential operation is unsupported");
    const isContentAddressedObject =
      /^manifests\/[0-9a-f]{96}\.json$/.test(objectPath) ||
      /^bundles\/[0-9a-f]{96}\/[A-Za-z0-9._/-]+$/.test(objectPath);
    if (!isContentAddressedObject)
      throw new Error("Component bundle credential object path is not a content address");

    const now = clock();
    if (!Number.isFinite(now.getTime()))
      throw new Error("Component bundle credential clock returned an invalid time");
    const iat = Math.floor(now.getTime() / 1_000);
    const exp = iat + COMPONENT_BUNDLE_MAXIMUM_OPERATION_SECONDS;
    const claims: ComponentBundleStorageClaims = {
      role: "authenticated",
      aud: "authenticated",
      iss: config.issuer,
      tokenKind: "vortex_component_bundle_operation",
      destinationProject: config.destinationProject,
      bucketId: COMPONENT_BUNDLE_BUCKET,
      objectPath,
      operation,
      iat,
      exp,
    };
    const header = encodeBase64UrlJson({ alg: "ES256", kid: config.activeKeyId, typ: "JWT" });
    const payload = encodeBase64UrlJson(claims);
    const signature = await activeSigner(Buffer.from(`${header}.${payload}`));
    if (
      !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      Buffer.from(signature, "base64url").length !== 64
    )
      throw new Error("Component bundle signer returned an invalid ES256 signature");
    return Object.freeze({ token: `${header}.${payload}.${signature}` });
  };
};

export type SupabaseComponentBundleObjectStoreConfig = Readonly<{
  supabaseUrl: string;
  mintCredential: MintComponentBundleStorageCredential;
  fetchImplementation?: typeof fetch;
}>;

/**
 * The default object store over the destination project's Storage REST API. It
 * mints one exact credential per operation, refuses redirects and never caches
 * an upstream response. A 409 on write means the immutable object already
 * exists and is treated as success.
 */
export const createSupabaseComponentBundleObjectStore = (
  config: SupabaseComponentBundleObjectStoreConfig,
): ComponentBundleObjectStore => {
  const base = config.supabaseUrl.replace(/\/+$/, "");
  const fetchImplementation = config.fetchImplementation ?? fetch;

  const uploadUrl = (objectPath: string): string =>
    `${base}/storage/v1/object/${encodeURIComponent(COMPONENT_BUNDLE_BUCKET)}/${encodeObjectPath(objectPath)}`;
  const readUrl = (objectPath: string): string =>
    `${base}/storage/v1/object/authenticated/${encodeURIComponent(COMPONENT_BUNDLE_BUCKET)}/${encodeObjectPath(objectPath)}`;

  return Object.freeze({
    async writeObject({ objectPath, bytes, contentType }) {
      const token = (await config.mintCredential({ operation: "upload", objectPath })).token;
      const response = await fetchImplementation(uploadUrl(objectPath), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": contentType,
          "x-upsert": "false",
          "Cache-Control": "max-age=31536000",
        },
        body: Buffer.from(bytes),
        redirect: "error",
        cache: "no-store",
      });
      if (response.body !== null) await response.body.cancel().catch(() => undefined);
      if (response.status === 200 || response.status === 201 || response.status === 409) return;
      throw new Error("COMPONENT_BUNDLE_UPLOAD_REFUSED");
    },
    async readObject({ objectPath }) {
      const token = (await config.mintCredential({ operation: "read", objectPath })).token;
      const response = await fetchImplementation(readUrl(objectPath), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
        redirect: "error",
        cache: "no-store",
      });
      if (response.status === 404) {
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        return undefined;
      }
      if (response.status !== 200 || response.body === null) {
        if (response.body !== null) await response.body.cancel().catch(() => undefined);
        throw new Error("COMPONENT_BUNDLE_READ_REFUSED");
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  });
};

const readObjectOrRefuse = async (
  store: ComponentBundleObjectStore,
  objectPath: string,
): Promise<Uint8Array | undefined> => {
  try {
    return await store.readObject({ objectPath });
  } catch {
    return refuse("storage_unavailable");
  }
};

const writeObjectOrRefuse = async (
  store: ComponentBundleObjectStore,
  input: Readonly<{ objectPath: string; bytes: Uint8Array; contentType: string }>,
): Promise<void> => {
  try {
    await store.writeObject(input);
  } catch {
    refuse("storage_unavailable");
  }
};

export type PublishedComponentBundle = Readonly<{
  /** The #1142 component release with its verified digest recorded. */
  release: CustomComponentReleaseV2;
  digest: string;
  contentAddress: string;
  entryFile: string;
  entryObjectPath: string;
  manifestObjectPath: string;
  files: readonly Readonly<{ path: string; sha384: string; objectPath: string }>[];
}>;

/**
 * The publication step for one custom component bundle.
 *
 * 1. It validates the #1142 bundle manifest.
 * 2. It computes the SHA-384 Subresource Integrity digest of the supplied entry
 *    bytes and refuses the bundle unless it matches the digest the release
 *    records.
 * 3. It writes the bundle manifest and every bundle file beneath the entry
 *    digest's content address, so the release's digest is the immutable address
 *    the bootstrap document loads.
 *
 * The content address describes one manifest; a different file set for the same
 * entry digest is refused rather than overwritten.
 */
export const publishComponentBundle = async (
  input: Readonly<{ release: CustomComponentReleaseV2; files: readonly ComponentBundleFile[] }>,
  store: ComponentBundleObjectStore,
): Promise<PublishedComponentBundle> => {
  const parsedBundle = customComponentBundleV2Schema.safeParse(input.release.bundle);
  if (!parsedBundle.success) return refuse("malformed_bundle");
  const bundle = parsedBundle.data;

  const byPath = new Map<string, Uint8Array>();
  for (const file of input.files) {
    if (!isSafeComponentBundlePath(file.path) || byPath.has(file.path))
      return refuse("malformed_bundle");
    byPath.set(file.path, file.bytes);
  }
  const entryBytes = byPath.get(bundle.entryFile);
  if (entryBytes === undefined) return refuse("malformed_bundle");

  const digest = computeComponentBundleDigest(entryBytes);
  if (digest !== bundle.digest) return refuse("digest_mismatch");

  const contentAddress = componentBundleContentAddress(digest);
  const files = [...byPath.entries()]
    .map(([path, bytes]) => ({
      path,
      sha384: componentBundleFileDigest(bytes),
      objectPath: componentBundleFileObjectPath(contentAddress, path),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest: ComponentBundleManifest = {
    digest,
    entryFile: bundle.entryFile,
    files: files.map(({ path, sha384 }) => ({ path, sha384 })),
  };
  const manifestObjectPath = componentBundleManifestObjectPath(contentAddress);
  const encodedManifest = encodeComponentBundleManifest(manifest);

  const existingManifest = await readObjectOrRefuse(store, manifestObjectPath);
  if (existingManifest !== undefined) {
    let decoded: ComponentBundleManifest;
    try {
      decoded = decodeComponentBundleManifest(existingManifest);
    } catch {
      return refuse("bundle_conflict");
    }
    if (!bytesEqual(encodeComponentBundleManifest(decoded), encodedManifest))
      return refuse("bundle_conflict");
  } else {
    await writeObjectOrRefuse(store, {
      objectPath: manifestObjectPath,
      bytes: encodedManifest,
      contentType: "application/json; charset=utf-8",
    });
  }

  for (const [path, bytes] of byPath) {
    await writeObjectOrRefuse(store, {
      objectPath: componentBundleFileObjectPath(contentAddress, path),
      bytes,
      contentType: componentBundleMediaType(path),
    });
  }

  return Object.freeze({
    release: Object.freeze({ ...input.release, bundle: Object.freeze({ ...bundle, digest }) }),
    digest,
    contentAddress,
    entryFile: bundle.entryFile,
    entryObjectPath: componentBundleFileObjectPath(contentAddress, bundle.entryFile),
    manifestObjectPath,
    files: Object.freeze(files),
  });
};

const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  html: "text/html; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
});

/** The media type of one bundle file, derived only from its relative path. */
export const componentBundleMediaType = (relativePath: string): string => {
  const separator = relativePath.lastIndexOf(".");
  const extension = separator < 0 ? "" : relativePath.slice(separator + 1).toLowerCase();
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
};
