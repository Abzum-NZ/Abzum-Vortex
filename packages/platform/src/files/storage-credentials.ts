import "server-only";

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  PRIVATE_FILE_BUCKET,
  correlationIdSchema,
  downloadGrantSchema,
  fileIdSchema,
  fileRecordSchema,
  timestampSchema,
  uploadGrantSchema,
  verifiedFileActorSchema,
  type DownloadGrant,
  type FileId,
  type FileRecord,
  type FileStorageOperation,
  type OrganizationId,
  type UploadGrant,
  type VerifiedFileActor,
} from "@vortex/contracts";
import { createSignedStorageOperationClaims, validateStorageKey } from "./storage-policy";
import {
  evaluateResolvedFileRemovalAuthority,
  type FileRemovalAuthoritySnapshot,
  type FileRemovalOwnerBinding,
} from "./removal-eligibility";

/**
 * The request presented to the trusted, server-injected authority resolver.
 * Transfer grants are required for upload and read; delete is resolved from its
 * exact file identifier. Inspect is the File service's own server-side read of a
 * pending uploaded object for trusted inspection and isolated scanning; it signs
 * a Storage read of that exact object and is never projected to a browser. None
 * of these values is accepted as authority by itself.
 */
export type StorageCredentialRequest =
  | Readonly<{ operation: "upload"; grant: UploadGrant }>
  | Readonly<{ operation: "read"; grant: DownloadGrant }>
  | Readonly<{ operation: "inspect"; fileId: FileId }>
  | Readonly<{ operation: "delete"; fileId: FileId }>;

/**
 * Current authority and canonical metadata returned by trusted File-service
 * wiring. The resolver must re-run the ordinary Access-resolved operation and
 * load the current FileRecord; upload/read resolution also revalidates and
 * consumes the grant's one-time identifier. Mint callers cannot supply these
 * results.
 */
type CurrentStorageAuthorityBase = Readonly<{
  authorized: true;
  organizationId: OrganizationId;
  fileId: FileId;
  fileRecord: FileRecord;
  actor: VerifiedFileActor;
  correlationId: string;
  validUntil: string;
}>;

export type CurrentStorageAuthority =
  | (CurrentStorageAuthorityBase &
      Readonly<{
        operation: "upload" | "read";
        transferGrantId: UploadGrant["oneTimeId"];
      }>)
  | (CurrentStorageAuthorityBase & Readonly<{ operation: "inspect" }>)
  | (CurrentStorageAuthorityBase &
      Readonly<{
        operation: "delete";
        /**
         * Complete live state resolved with the FileRecord by trusted server
         * wiring. A request or previously returned eligibility decision is never
         * accepted in its place.
         */
        removalAuthority: FileRemovalAuthoritySnapshot;
      }>);

export type StorageAuthorityResolution =
  | CurrentStorageAuthority
  | Readonly<{ authorized: false }>;

export type ResolveCurrentStorageAuthority = (
  request: StorageCredentialRequest,
) => Promise<StorageAuthorityResolution>;

/**
 * A signing function backed by the destination environment's secret store or
 * HSM. It returns an unpadded base64url ES256 signature in IEEE P1363 r || s
 * form (exactly 64 bytes before encoding).
 */
export type StorageKeySigner = (data: Buffer) => string | Promise<string>;

export type StorageKeyDefinition = Readonly<{
  keyId: string;
  signer: StorageKeySigner | KeyObject | string | Buffer;
}>;

/** Public rotation information; private signing material is never projected. */
export type StorageKeyRotationMetadata = Readonly<{
  activeKeyId: string;
  availableKeyIds: readonly string[];
  algorithm: "ES256";
}>;

/**
 * Server-owned bridge configuration. The authority resolver and signing keys
 * are installed once by trusted service wiring, never selected by a request.
 */
export type StorageCredentialBridgeConfig = Readonly<{
  destinationProject: string;
  issuer: string;
  activeKeyId: string;
  keys: readonly StorageKeyDefinition[];
  resolveCurrentAuthority: ResolveCurrentStorageAuthority;
  clock?: () => Date;
}>;

/**
 * Server-side credential for exactly one Storage operation. A non-enumerable
 * toJSON guard installed at runtime prevents accidental response serialization;
 * only mintBrowserUploadGrant creates a browser-safe projection.
 */
export type StorageOperationCredential = Readonly<{
  token: string;
  tokenKind: "vortex_file_storage_operation";
  role: "authenticated";
  destinationProject: string;
  organizationId: OrganizationId;
  bucketId: typeof PRIVATE_FILE_BUCKET;
  objectPath: string;
  operation: FileStorageOperation;
  keyId: string;
  iat: number;
  exp: number;
  expiresAt: string;
}>;

/** The only credential projection permitted to leave the server boundary. */
export type BrowserUploadGrant = Readonly<{
  token: string;
  bucketId: typeof PRIVATE_FILE_BUCKET;
  objectPath: string;
  expiresAt: string;
  operation: "upload";
}>;

export type MintStorageCredentialInput = Readonly<{
  request: StorageCredentialRequest;
  /** A caller may request a shorter lifetime, never a longer one. */
  ttlSeconds?: number;
}>;

const sameActor = (left: VerifiedFileActor, right: VerifiedFileActor): boolean => {
  if (left.kind !== right.kind) return false;
  return left.kind === "human" && right.kind === "human"
    ? left.organizationAccountId === right.organizationAccountId &&
        left.identityId === right.identityId
    : left.kind === "system" &&
        right.kind === "system" &&
        left.systemActorId === right.systemActorId;
};

const timestampSeconds = (value: string): number | undefined => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : undefined;
};

const validateCredentialRequest = (
  request: StorageCredentialRequest,
): StorageCredentialRequest => {
  if (request === null || typeof request !== "object") {
    throw new Error("Storage credential request is invalid");
  }
  switch (request.operation) {
    case "upload": {
      const grant = uploadGrantSchema.safeParse(request.grant);
      if (!grant.success) {
        throw new Error("Storage credential request has an invalid upload grant");
      }
      return Object.freeze({ operation: "upload", grant: grant.data });
    }
    case "read": {
      const grant = downloadGrantSchema.safeParse(request.grant);
      if (!grant.success) {
        throw new Error("Storage credential request has an invalid download grant");
      }
      return Object.freeze({ operation: "read", grant: grant.data });
    }
    case "inspect": {
      const fileId = fileIdSchema.safeParse(request.fileId);
      if (!fileId.success) throw new Error("Storage credential request has an invalid file ID");
      return Object.freeze({ operation: "inspect", fileId: fileId.data });
    }
    case "delete": {
      const fileId = fileIdSchema.safeParse(request.fileId);
      if (!fileId.success) throw new Error("Storage credential request has an invalid file ID");
      return Object.freeze({ operation: "delete", fileId: fileId.data });
    }
    default:
      throw new Error("Storage credential request has an unsupported operation");
  }
};

const ownerMatches = (
  fileRecord: FileRecord,
  grant: Pick<UploadGrant, "recordTypeId" | "recordId" | "fieldId">,
): boolean =>
  fileRecord.ownerRecordTypeId !== undefined &&
  fileRecord.ownerRecordId !== undefined &&
  fileRecord.ownerFieldId !== undefined &&
  fileRecord.ownerRecordTypeId === grant.recordTypeId &&
  fileRecord.ownerRecordId === grant.recordId &&
  fileRecord.ownerFieldId === grant.fieldId;

const removalOwnerMatches = (
  fileRecord: FileRecord,
  owner: FileRemovalOwnerBinding | null,
): boolean =>
  owner === null
    ? fileRecord.ownerRecordTypeId === undefined &&
      fileRecord.ownerRecordId === undefined &&
      fileRecord.ownerFieldId === undefined
    : owner.sourceOrganizationId === fileRecord.organizationId &&
      owner.applicationRootId === fileRecord.applicationRootId &&
      owner.recordTypeId === fileRecord.ownerRecordTypeId &&
      owner.recordId === fileRecord.ownerRecordId &&
      owner.fieldId === fileRecord.ownerFieldId;

/** Creates a standards-compliant ES256 signer and keeps its private key in the closure. */
export const createStorageSignerFromPrivateKey = (
  privateKeyInput: KeyObject | string | Buffer,
): StorageKeySigner => {
  const privateKey =
    typeof privateKeyInput === "string" || Buffer.isBuffer(privateKeyInput)
      ? createPrivateKey(privateKeyInput)
      : privateKeyInput;

  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("Storage signing key must be a private P-256 elliptic-curve key");
  }

  return (data: Buffer) =>
    sign("sha256", data, {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
};

const encodeBase64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const validateSignature = (candidate: string): string => {
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(candidate) ||
    Buffer.from(candidate, "base64url").length !== 64 ||
    Buffer.from(candidate, "base64url").toString("base64url") !== candidate
  ) {
    throw new Error("Storage signer returned an invalid ES256 IEEE P1363 signature");
  }
  return candidate;
};

const validateBridgeConfig = (config: StorageCredentialBridgeConfig): void => {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(config.destinationProject)) {
    throw new Error("Storage destination project must be a canonical lowercase project ref");
  }

  const expectedIssuer = `https://${config.destinationProject}.supabase.co/auth/v1`;
  if (config.issuer !== expectedIssuer) {
    throw new Error("Storage issuer must be the destination Supabase project's Auth issuer");
  }

  if (typeof config.resolveCurrentAuthority !== "function") {
    throw new Error("Storage credential bridge requires a current-authority resolver");
  }

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.activeKeyId)) {
    throw new Error("Storage active key identifier is invalid");
  }

  if (!Array.isArray(config.keys) || config.keys.length === 0) {
    throw new Error("Storage credential bridge requires at least one signing key");
  }

  const keyIds = new Set<string>();
  for (const key of config.keys) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key.keyId)) {
      throw new Error("Storage signing key identifier is invalid");
    }
    if (keyIds.has(key.keyId)) {
      throw new Error("Storage signing key identifiers must be unique");
    }
    keyIds.add(key.keyId);
  }

  if (!keyIds.has(config.activeKeyId)) {
    throw new Error("Storage active signing key is not configured");
  }
};

type ValidatedAuthority = Readonly<{
  fileRecord: FileRecord;
  actor: VerifiedFileActor;
  correlationId: string;
  expiresAtSeconds: number;
}>;

const validateCurrentAuthority = (
  request: StorageCredentialRequest,
  resolution: StorageAuthorityResolution,
  now: Date,
): ValidatedAuthority => {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (resolution.authorized !== true) {
    throw new Error("Storage credential minting refused by current authority");
  }

  const fileResult = fileRecordSchema.safeParse(resolution.fileRecord);
  const actorResult = verifiedFileActorSchema.safeParse(resolution.actor);
  const correlationResult = correlationIdSchema.safeParse(resolution.correlationId);
  const authorityValidUntil = timestampSchema.safeParse(resolution.validUntil);
  const authorityExpiry = authorityValidUntil.success
    ? timestampSeconds(authorityValidUntil.data)
    : undefined;
  if (
    !fileResult.success ||
    !actorResult.success ||
    !correlationResult.success ||
    authorityExpiry === undefined ||
    authorityExpiry <= nowSeconds ||
    resolution.operation !== request.operation ||
    resolution.organizationId !== fileResult.data.organizationId ||
    resolution.fileId !== fileResult.data.fileId
  ) {
    throw new Error("Storage credential minting refused: current authority is invalid or expired");
  }

  const fileRecord = fileResult.data;
  const actor = actorResult.data;

  if (
    fileRecord.bucketId !== PRIVATE_FILE_BUCKET ||
    !validateStorageKey(fileRecord.storageKey, fileRecord.organizationId) ||
    !fileRecord.storageKey.startsWith(`${fileRecord.organizationId}/${fileRecord.fileId}/`)
  ) {
    throw new Error("Storage credential minting refused: file storage scope is invalid");
  }

  let grantExpiry = authorityExpiry;
  switch (request.operation) {
    case "upload": {
      const grantResult = uploadGrantSchema.safeParse(request.grant);
      if (!grantResult.success) {
        throw new Error("Storage credential minting refused: upload grant is invalid");
      }
      const grant = grantResult.data;
      const expires = timestampSeconds(grant.expiresAt);
      if (
        expires === undefined ||
        expires <= nowSeconds ||
        !("transferGrantId" in resolution) ||
        resolution.transferGrantId !== grant.oneTimeId ||
        grant.organizationId !== fileRecord.organizationId ||
        !ownerMatches(fileRecord, grant) ||
        grant.maximumBytes < fileRecord.sizeBytes ||
        !sameActor(grant.actor, actor) ||
        !sameActor(actor, fileRecord.uploadedBy) ||
        fileRecord.lifecycleState !== "pending" ||
        fileRecord.scannerResult !== "pending"
      ) {
        throw new Error("Storage credential minting refused: upload scope is not current");
      }
      grantExpiry = expires;
      break;
    }
    case "read": {
      const grantResult = downloadGrantSchema.safeParse(request.grant);
      if (!grantResult.success) {
        throw new Error("Storage credential minting refused: download grant is invalid");
      }
      const grant = grantResult.data;
      const expires = timestampSeconds(grant.expiresAt);
      if (
        expires === undefined ||
        expires <= nowSeconds ||
        !("transferGrantId" in resolution) ||
        resolution.transferGrantId !== grant.oneTimeId ||
        grant.fileId !== fileRecord.fileId ||
        grant.organizationId !== fileRecord.organizationId ||
        !ownerMatches(fileRecord, grant) ||
        !sameActor(grant.actor, actor) ||
        fileRecord.lifecycleState !== "active" ||
        fileRecord.scannerResult !== "clean"
      ) {
        throw new Error("Storage credential minting refused: read scope is not current");
      }
      grantExpiry = expires;
      break;
    }
    case "inspect": {
      const fileIdResult = fileIdSchema.safeParse(request.fileId);
      if (
        !fileIdResult.success ||
        fileIdResult.data !== fileRecord.fileId ||
        !sameActor(actor, fileRecord.uploadedBy) ||
        fileRecord.lifecycleState !== "pending" ||
        fileRecord.scannerResult !== "pending"
      ) {
        throw new Error("Storage credential minting refused: inspection scope is not current");
      }
      break;
    }
    case "delete": {
      const fileIdResult = fileIdSchema.safeParse(request.fileId);
      if (
        !fileIdResult.success ||
        fileIdResult.data !== fileRecord.fileId ||
        fileRecord.lifecycleState === "removed"
      ) {
        throw new Error("Storage credential minting refused: removal scope is not current");
      }
      if (!("removalAuthority" in resolution)) {
        throw new Error("Storage credential minting refused: removal authority is unavailable");
      }
      const decision = evaluateResolvedFileRemovalAuthority(
        resolution.removalAuthority,
        now,
      );
      if (!decision.eligible) {
        throw new Error("Storage credential minting refused: file is not eligible for removal");
      }
      const removalAuthority = resolution.removalAuthority;
      if (
        removalAuthority.organizationId !== fileRecord.organizationId ||
        removalAuthority.sourceOrganizationId !== fileRecord.organizationId ||
        removalAuthority.fileId !== fileRecord.fileId ||
        removalAuthority.bucketId !== fileRecord.bucketId ||
        removalAuthority.objectPath !== fileRecord.storageKey ||
        removalAuthority.lifecycleState !== fileRecord.lifecycleState ||
        removalAuthority.applicationRootId !== fileRecord.applicationRootId ||
        !removalOwnerMatches(fileRecord, removalAuthority.owner) ||
        fileRecord.owningAttachmentReferences.length !== 0 ||
        removalAuthority.recoveryPolicy?.recoveryDeadline !== fileRecord.removalDueAt
      ) {
        throw new Error("Storage credential minting refused: removal binding is not current");
      }
      const removalAuthorityExpiry = timestampSeconds(removalAuthority.validUntil);
      const holdAuthorityExpiry =
        removalAuthority.holdAuthority === null
          ? undefined
          : timestampSeconds(removalAuthority.holdAuthority.validUntil);
      const recoveryPolicyExpiry =
        removalAuthority.recoveryPolicy === null
          ? undefined
          : timestampSeconds(removalAuthority.recoveryPolicy.validUntil);
      if (
        removalAuthorityExpiry === undefined ||
        holdAuthorityExpiry === undefined ||
        recoveryPolicyExpiry === undefined
      ) {
        throw new Error("Storage credential minting refused: removal authority is unavailable");
      }
      grantExpiry = Math.min(
        removalAuthorityExpiry,
        holdAuthorityExpiry,
        recoveryPolicyExpiry,
      );
      break;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unsupported storage operation: ${JSON.stringify(exhaustive)}`);
    }
  }

  return {
    fileRecord,
    actor,
    correlationId: correlationResult.data,
    expiresAtSeconds: Math.min(authorityExpiry, grantExpiry),
  };
};

const requestedTtl = (ttlSeconds: number | undefined): number => {
  if (ttlSeconds === undefined) return MAXIMUM_FILE_STORAGE_OPERATION_SECONDS;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAXIMUM_FILE_STORAGE_OPERATION_SECONDS
  ) {
    throw new Error(
      `Storage credential lifetime must be between 1 and ${MAXIMUM_FILE_STORAGE_OPERATION_SECONDS} seconds`,
    );
  }
  return ttlSeconds;
};

const makeServerCredential = (
  value: StorageOperationCredential,
): StorageOperationCredential => {
  Object.defineProperty(value, "toJSON", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: () => {
      throw new Error("Server-side Storage credentials cannot be serialized");
    },
  });
  return Object.freeze(value);
};

export type StorageCredentialBridge = Readonly<{
  getKeyRotationMetadata(): StorageKeyRotationMetadata;
  mintStorageOperationCredential(
    input: MintStorageCredentialInput,
  ): Promise<StorageOperationCredential>;
  mintBrowserUploadGrant(
    input: MintStorageCredentialInput &
      Readonly<{
        request: Extract<StorageCredentialRequest, Readonly<{ operation: "upload" }>>;
      }>,
  ): Promise<BrowserUploadGrant>;
}>;

/** Creates a bridge whose authority and signing dependencies remain server-side. */
export const createStorageCredentialBridge = (
  config: StorageCredentialBridgeConfig,
): StorageCredentialBridge => {
  validateBridgeConfig(config);

  const destinationProject = config.destinationProject;
  const issuer = config.issuer;
  const activeKeyId = config.activeKeyId;
  const resolveCurrentAuthority = config.resolveCurrentAuthority;
  const clock = config.clock ?? (() => new Date());
  const signers = new Map<string, StorageKeySigner>();
  for (const key of config.keys) {
    signers.set(
      key.keyId,
      typeof key.signer === "function"
        ? key.signer
        : createStorageSignerFromPrivateKey(key.signer),
    );
  }
  const activeSigner = signers.get(activeKeyId);
  if (activeSigner === undefined) {
    throw new Error("Storage active signing key is unavailable");
  }

  const rotationMetadata = Object.freeze({
    activeKeyId,
    availableKeyIds: Object.freeze([...signers.keys()]),
    algorithm: "ES256" as const,
  });

  const mintStorageOperationCredential = async (
    input: MintStorageCredentialInput,
  ): Promise<StorageOperationCredential> => {
    const now = clock();
    const nowMilliseconds = now.getTime();
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("Storage credential clock returned an invalid time");
    }
    const nowSeconds = Math.floor(nowMilliseconds / 1_000);

    const request = validateCredentialRequest(input.request);
    let resolution: StorageAuthorityResolution;
    try {
      resolution = await resolveCurrentAuthority(request);
    } catch {
      throw new Error("Storage credential current authority is unavailable");
    }
    const authority = validateCurrentAuthority(
      request,
      resolution,
      now,
    );
    const ttlSeconds = Math.min(
      requestedTtl(input.ttlSeconds),
      authority.expiresAtSeconds - nowSeconds,
    );
    if (ttlSeconds < 1) {
      throw new Error("Storage credential minting refused: current authority has expired");
    }

    // Inspection is a server-side read of the exact pending object.
    const storageOperation: FileStorageOperation =
      request.operation === "inspect" ? "read" : request.operation;
    const claims = createSignedStorageOperationClaims({
      destinationProject,
      issuer,
      organizationId: authority.fileRecord.organizationId,
      objectPath: authority.fileRecord.storageKey,
      operation: storageOperation,
      actor: authority.actor,
      correlationId: authority.correlationId,
      ttlSeconds,
      clock: () => now,
    });

    const header = encodeBase64UrlJson({ alg: "ES256", kid: activeKeyId, typ: "JWT" });
    const payload = encodeBase64UrlJson(claims);
    const signingInput = Buffer.from(`${header}.${payload}`);
    const signature = validateSignature(await activeSigner(signingInput));

    return makeServerCredential({
      token: `${header}.${payload}.${signature}`,
      tokenKind: "vortex_file_storage_operation",
      role: "authenticated",
      destinationProject,
      organizationId: authority.fileRecord.organizationId,
      bucketId: PRIVATE_FILE_BUCKET,
      objectPath: authority.fileRecord.storageKey,
      operation: storageOperation,
      keyId: activeKeyId,
      iat: claims.iat,
      exp: claims.exp,
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
    });
  };

  const mintBrowserUploadGrant: StorageCredentialBridge["mintBrowserUploadGrant"] = async (
    input,
  ) => {
    if (input.request.operation !== "upload") {
      throw new Error("Only a pending-object upload credential may be projected to a browser");
    }
    const credential = await mintStorageOperationCredential(input);
    return Object.freeze({
      token: credential.token,
      bucketId: credential.bucketId,
      objectPath: credential.objectPath,
      expiresAt: credential.expiresAt,
      operation: "upload" as const,
    });
  };

  return Object.freeze({
    getKeyRotationMetadata: () => rotationMetadata,
    mintStorageOperationCredential,
    mintBrowserUploadGrant,
  });
};
