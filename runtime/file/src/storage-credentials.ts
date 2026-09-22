import "server-only";

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  PRIVATE_FILE_BUCKET,
  correlationIdSchema,
  fileRecordSchema,
  type DownloadGrant,
  type FileRecord,
  type FileStorageOperation,
  type FileStorageOperationClaims,
  type OrganizationId,
  type UploadGrant,
  type VerifiedFileActor,
} from "@vortex/contracts";
import {
  createSignedStorageOperationClaims,
  validateStorageKey,
  verifySignedStorageOperationClaims,
  type VerifyStorageClaimsResult,
} from "./storage-policy";

/**
 * Bounded authorised storage purposes.
 *
 * Each operation (upload, read, delete) must be an already-authorised, single-operation
 * purpose carrying the source organisation, verified actor, and correlation identifier.
 * Upload and read purposes may additionally include the bounded transfer grant
 * (UploadGrant or DownloadGrant) from which they were derived.
 */
export type AuthorizedUploadPurpose = Readonly<{
  operation: "upload";
  organizationId: OrganizationId;
  actor: VerifiedFileActor;
  correlationId: string;
  grant?: UploadGrant;
  ttlSeconds?: number;
}>;

export type AuthorizedReadPurpose = Readonly<{
  operation: "read";
  organizationId: OrganizationId;
  actor: VerifiedFileActor;
  correlationId: string;
  grant?: DownloadGrant;
  ttlSeconds?: number;
}>;

export type AuthorizedDeletePurpose = Readonly<{
  operation: "delete";
  organizationId: OrganizationId;
  actor: VerifiedFileActor;
  correlationId: string;
  ttlSeconds?: number;
}>;

export type AuthorizedStoragePurpose =
  | AuthorizedUploadPurpose
  | AuthorizedReadPurpose
  | AuthorizedDeletePurpose;

/**
 * Creates an authorized upload purpose from an already-authorized UploadGrant.
 */
export const createAuthorizedUploadPurpose = (
  grant: UploadGrant,
  correlationId: string,
  ttlSeconds?: number,
): AuthorizedUploadPurpose => ({
  operation: "upload",
  organizationId: grant.organizationId,
  actor: grant.actor,
  correlationId,
  grant,
  ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
});

/**
 * Creates an authorized read purpose from an already-authorized DownloadGrant.
 */
export const createAuthorizedReadPurpose = (
  grant: DownloadGrant,
  correlationId: string,
  ttlSeconds?: number,
): AuthorizedReadPurpose => ({
  operation: "read",
  organizationId: grant.organizationId,
  actor: grant.actor,
  correlationId,
  grant,
  ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
});

/**
 * Creates an authorized delete purpose from verified caller context.
 */
export const createAuthorizedDeletePurpose = (
  organizationId: OrganizationId,
  actor: VerifiedFileActor,
  correlationId: string,
  ttlSeconds?: number,
): AuthorizedDeletePurpose => ({
  operation: "delete",
  organizationId,
  actor,
  correlationId,
  ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
});

/**
 * A signing function that takes signing input bytes and produces a base64url-encoded
 * ES256 signature in IEEE P1363 format (r || s, 64 bytes).
 */
export type StorageKeySigner = (data: Buffer) => string | Promise<string>;

/**
 * Server-injected signing key definition.
 * Accepts a direct signing function, or a Node KeyObject / PEM string / Buffer
 * that is encapsulated into a standard ES256 IEEE P1363 signer.
 */
export type StorageKeyDefinition = Readonly<{
  keyId: string;
  signer: StorageKeySigner | KeyObject | string | Buffer;
}>;

/**
 * Safe public key rotation metadata.
 * Contains only non-sensitive key identifiers and algorithm configuration;
 * never exposes private signing keys, PEMs or secrets.
 */
export type StorageKeyRotationMetadata = Readonly<{
  destinationProject: string;
  issuer: string;
  activeKeyId: string;
  availableKeyIds: readonly string[];
  algorithm: "ES256";
}>;

/**
 * Server-side configuration for the Supabase Storage credential bridge.
 * All configuration is injected server-side; no caller-selected projects, signing
 * material, arbitrary paths or service-role credentials can be supplied through client requests.
 */
export type StorageCredentialBridgeConfig = Readonly<{
  destinationProject: string;
  issuer: string;
  activeKeyId: string;
  keys: readonly StorageKeyDefinition[];
  clock?: () => Date;
}>;

/**
 * Server-side Storage operation credential.
 * Contains the minted short-lived asymmetric JWT and exact claim context.
 * Kept strictly server-side for read and delete operations; only pending-upload
 * credentials may be projected into browser grants.
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
  claims: FileStorageOperationClaims;
}>;

/**
 * Browser upload grant.
 * Permitted ONLY for pending-object upload INSERT.
 * Does NOT authorize read, list, update, upsert, copy, move or delete.
 * Does NOT expose internal upstream endpoints, database connections or private keys.
 */
export type BrowserUploadGrant = Readonly<{
  token: string;
  bucketId: typeof PRIVATE_FILE_BUCKET;
  objectPath: string;
  expiresAt: string;
  operation: "upload";
}>;

/**
 * Input to mint a scoped Storage operation credential.
 * Accepts exactly one authorised purpose and the verified FileRecord context.
 * Arbitrary paths, caller-selected projects, signing material and user-editable metadata
 * are never accepted.
 */
export type MintStorageCredentialInput = Readonly<{
  purpose: AuthorizedStoragePurpose;
  fileRecord: FileRecord;
  keyId?: string;
  ttlSeconds?: number;
  clock?: () => Date;
}>;

/**
 * Creates an ES256 IEEE P1363 base64url signer from a Node KeyObject, PEM string or Buffer.
 * The private key stays encapsulated inside the closure.
 */
export const createStorageSignerFromPrivateKey = (
  privateKeyInput: KeyObject | string | Buffer,
): StorageKeySigner => {
  const privateKey =
    typeof privateKeyInput === "string" || Buffer.isBuffer(privateKeyInput)
      ? createPrivateKey(privateKeyInput)
      : privateKeyInput;

  return (data: Buffer) =>
    sign("sha256", data, {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
};

const encodeBase64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const validateBridgeConfig = (config: StorageCredentialBridgeConfig): void => {
  if (
    typeof config.destinationProject !== "string" ||
    config.destinationProject.trim().length === 0 ||
    config.destinationProject.length > 120
  ) {
    throw new Error(
      "Invalid destinationProject: must be a non-empty string of at most 120 characters",
    );
  }

  // Strictly refuse service-role or platform secret credentials from entering the bridge
  if (
    config.destinationProject.includes("service_role") ||
    config.destinationProject.startsWith("sb_secret_")
  ) {
    throw new Error(
      "Platform and service-role credentials must never enter the storage credential bridge",
    );
  }

  let parsedIssuer: URL;
  try {
    parsedIssuer = new URL(config.issuer);
  } catch {
    throw new Error("Invalid issuer: must be a valid URL");
  }
  if (parsedIssuer.protocol !== "http:" && parsedIssuer.protocol !== "https:") {
    throw new Error("Invalid issuer: protocol must be http or https");
  }
  if (
    parsedIssuer.username.length > 0 ||
    parsedIssuer.password.length > 0 ||
    parsedIssuer.search.length > 0 ||
    parsedIssuer.hash.length > 0
  ) {
    throw new Error(
      "Invalid issuer: must not contain user credentials, query parameters or fragment",
    );
  }

  if (
    typeof config.activeKeyId !== "string" ||
    config.activeKeyId.trim().length === 0
  ) {
    throw new Error("Invalid activeKeyId: must be a non-empty string");
  }

  if (!Array.isArray(config.keys) || config.keys.length === 0) {
    throw new Error("Storage credential bridge requires at least one signing key definition");
  }

  const keyIds = new Set<string>();
  for (const keyDef of config.keys) {
    if (typeof keyDef.keyId !== "string" || keyDef.keyId.trim().length === 0) {
      throw new Error("Every signing key definition must have a non-empty keyId");
    }
    if (keyIds.has(keyDef.keyId)) {
      throw new Error(`Duplicate signing keyId '${keyDef.keyId}' in configuration`);
    }
    keyIds.add(keyDef.keyId);
  }

  if (!keyIds.has(config.activeKeyId)) {
    throw new Error(
      `Active keyId '${config.activeKeyId}' is not among configured keys (${[...keyIds].join(", ")})`,
    );
  }
};

/**
 * Validates and rechecks all admission requirements for minting a scoped storage credential:
 * organisation ownership, destination project, private bucket, exact object path,
 * actor attribution, correlation identifier, and single operation semantics.
 */
const recheckStorageOperationAdmission = (
  purpose: AuthorizedStoragePurpose,
  fileRecord: FileRecord,
  destinationProject: string,
  nowSeconds: number,
): void => {
  // 1. Verify FileRecord schema
  const parsedFileRecord = fileRecordSchema.safeParse(fileRecord);
  if (!parsedFileRecord.success) {
    throw new Error(
      `File record failed contract validation: ${parsedFileRecord.error.message}`,
    );
  }

  // 2. Correlation identifier check
  const correlationResult = correlationIdSchema.safeParse(purpose.correlationId);
  if (!correlationResult.success) {
    throw new Error("Storage credential minting refused: invalid correlation identifier");
  }

  // 3. Organisation ownership recheck
  if (purpose.organizationId !== fileRecord.organizationId) {
    throw new Error(
      `Storage credential minting refused: purpose organisation '${purpose.organizationId}' does not match file organisation '${fileRecord.organizationId}'`,
    );
  }

  if (fileRecord.organizationId !== fileRecord.organizationId.toLowerCase()) {
    throw new Error(
      "Storage credential minting refused: organisation identifier must be canonical lowercase",
    );
  }

  // 4. Private bucket recheck
  if (fileRecord.bucketId !== PRIVATE_FILE_BUCKET) {
    throw new Error(
      `Storage credential minting refused: bucket '${fileRecord.bucketId}' is not the private file bucket '${PRIVATE_FILE_BUCKET}'`,
    );
  }

  // 5. Exact object path recheck
  if (!validateStorageKey(fileRecord.storageKey, fileRecord.organizationId)) {
    throw new Error(
      `Storage credential minting refused: object path '${fileRecord.storageKey}' is not an organisation-scoped unguessable private path`,
    );
  }

  if (!fileRecord.storageKey.startsWith(`${fileRecord.organizationId}/${fileRecord.fileId}/`)) {
    throw new Error(
      `Storage credential minting refused: object path '${fileRecord.storageKey}' is not scoped to file '${fileRecord.fileId}'`,
    );
  }

  // 6. Transfer grant recheck (when grant is attached)
  if (purpose.operation === "upload" && purpose.grant) {
    if (purpose.grant.kind !== "upload") {
      throw new Error("Upload purpose contains a non-upload transfer grant");
    }
    if (purpose.grant.organizationId !== fileRecord.organizationId) {
      throw new Error("Upload grant organisation does not match file record organisation");
    }
    const grantExpiryEpoch = Math.floor(new Date(purpose.grant.expiresAt).getTime() / 1000);
    if (grantExpiryEpoch < nowSeconds) {
      throw new Error("Upload grant has expired");
    }
    if (fileRecord.ownerRecordTypeId !== undefined) {
      if (
        purpose.grant.recordTypeId !== fileRecord.ownerRecordTypeId ||
        purpose.grant.recordId !== fileRecord.ownerRecordId ||
        purpose.grant.fieldId !== fileRecord.ownerFieldId
      ) {
        throw new Error(
          "Upload grant record/field scope does not match file record owner scope",
        );
      }
    }
  }

  if (purpose.operation === "read" && purpose.grant) {
    if (purpose.grant.kind !== "download") {
      throw new Error("Read purpose contains a non-download transfer grant");
    }
    if (purpose.grant.organizationId !== fileRecord.organizationId) {
      throw new Error("Download grant organisation does not match file record organisation");
    }
    if (purpose.grant.fileId !== fileRecord.fileId) {
      throw new Error("Download grant fileId does not match file record fileId");
    }
    const grantExpiryEpoch = Math.floor(new Date(purpose.grant.expiresAt).getTime() / 1000);
    if (grantExpiryEpoch < nowSeconds) {
      throw new Error("Download grant has expired");
    }
    if (fileRecord.ownerRecordTypeId !== undefined) {
      if (
        purpose.grant.recordTypeId !== fileRecord.ownerRecordTypeId ||
        purpose.grant.recordId !== fileRecord.ownerRecordId ||
        purpose.grant.fieldId !== fileRecord.ownerFieldId
      ) {
        throw new Error(
          "Download grant record/field scope does not match file record owner scope",
        );
      }
    }
  }

  // 7. Single operation & lifecycle state rechecks
  switch (purpose.operation) {
    case "upload": {
      // Upload credentials are permitted ONLY for pending objects.
      // Re-uploading or overwriting active/quarantined/abandoned/soft_deleted/removed files is refused.
      if (fileRecord.lifecycleState !== "pending") {
        throw new Error(
          `Refusing upload credential for file '${fileRecord.fileId}': lifecycle state is '${fileRecord.lifecycleState}', expected 'pending'. Overwriting existing objects is prohibited.`,
        );
      }
      // Actor attribution recheck: uploader must match the file record uploader
      if (JSON.stringify(purpose.actor) !== JSON.stringify(fileRecord.uploadedBy)) {
        throw new Error(
          "Refusing upload credential: actor does not match the verified uploader recorded on the pending file",
        );
      }
      break;
    }

    case "read": {
      if (fileRecord.lifecycleState === "abandoned" || fileRecord.lifecycleState === "removed") {
        throw new Error(
          `Refusing read credential for file '${fileRecord.fileId}': file is '${fileRecord.lifecycleState}'`,
        );
      }
      if (fileRecord.lifecycleState === "quarantined") {
        throw new Error(
          `Refusing read credential for file '${fileRecord.fileId}': file is quarantined due to safety checks`,
        );
      }
      if (fileRecord.lifecycleState === "soft_deleted") {
        throw new Error(
          `Refusing read credential for file '${fileRecord.fileId}': file is soft-deleted and must be restored before read`,
        );
      }
      // A human user can only read an active file whose safety check passed
      if (purpose.actor.kind === "human" && fileRecord.lifecycleState !== "active") {
        throw new Error(
          `Refusing read credential for human actor: file '${fileRecord.fileId}' is '${fileRecord.lifecycleState}', expected 'active'`,
        );
      }
      break;
    }

    case "delete": {
      if (fileRecord.lifecycleState === "removed") {
        throw new Error(
          `Refusing delete credential for file '${fileRecord.fileId}': file is already removed`,
        );
      }
      if (fileRecord.legalHold) {
        throw new Error(
          `Refusing delete credential for file '${fileRecord.fileId}': a legal hold prevents permanent removal`,
        );
      }
      break;
    }

    default: {
      const exhaustiveCheck: never = purpose;
      throw new Error(`Unsupported storage operation in purpose: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * Storage credential bridge interface.
 * Implements the scoped Supabase Storage credential bridge.
 */
export type StorageCredentialBridge = Readonly<{
  destinationProject: string;
  issuer: string;
  activeKeyId: string;
  getKeyRotationMetadata(): StorageKeyRotationMetadata;
  mintStorageOperationCredential(
    input: MintStorageCredentialInput,
  ): Promise<StorageOperationCredential>;
  mintBrowserUploadGrant(
    input: MintStorageCredentialInput,
  ): Promise<BrowserUploadGrant>;
}>;

/**
 * Creates the Supabase Storage credential bridge from server-injected configuration.
 * Never accepts signing material or service credentials through caller requests.
 */
export const createStorageCredentialBridge = (
  config: StorageCredentialBridgeConfig,
): StorageCredentialBridge => {
  validateBridgeConfig(config);

  const signersMap = new Map<string, StorageKeySigner>();
  for (const keyDef of config.keys) {
    if (typeof keyDef.signer === "function") {
      signersMap.set(keyDef.keyId, keyDef.signer);
    } else {
      signersMap.set(keyDef.keyId, createStorageSignerFromPrivateKey(keyDef.signer));
    }
  }

  const getKeyRotationMetadata = (): StorageKeyRotationMetadata =>
    Object.freeze({
      destinationProject: config.destinationProject,
      issuer: config.issuer,
      activeKeyId: config.activeKeyId,
      availableKeyIds: Object.freeze([...signersMap.keys()]),
      algorithm: "ES256" as const,
    });

  const mintStorageOperationCredential = async (
    input: MintStorageCredentialInput,
  ): Promise<StorageOperationCredential> => {
    // Input must never contain caller-selected project, arbitrary path, or signing material
    if (
      "privateKey" in input ||
      "signingKey" in input ||
      "destinationProject" in input ||
      "serviceRoleKey" in input
    ) {
      throw new Error(
        "Refusing storage credential mint: caller must not supply signing material, platform keys or destination project",
      );
    }

    const clock = input.clock ?? config.clock ?? (() => new Date());
    const nowSeconds = Math.floor(clock().getTime() / 1000);

    // Recheck admission
    recheckStorageOperationAdmission(
      input.purpose,
      input.fileRecord,
      config.destinationProject,
      nowSeconds,
    );

    // Select signing key
    const selectedKeyId = input.keyId ?? config.activeKeyId;
    const signer = signersMap.get(selectedKeyId);
    if (!signer) {
      throw new Error(
        `Signing keyId '${selectedKeyId}' is not configured in this storage credential bridge`,
      );
    }

    // TTL bounded to at most 60 seconds
    const effectiveTtlSeconds = Math.min(
      Math.max(
        1,
        Math.floor(
          input.ttlSeconds ??
            input.purpose.ttlSeconds ??
            MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
        ),
      ),
      MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
    );

    // Mint exact operation claims per storage policy contract
    const claims = createSignedStorageOperationClaims({
      destinationProject: config.destinationProject,
      issuer: config.issuer,
      organizationId: input.fileRecord.organizationId,
      objectPath: input.fileRecord.storageKey,
      operation: input.purpose.operation,
      actor: input.purpose.actor,
      correlationId: input.purpose.correlationId,
      ttlSeconds: effectiveTtlSeconds,
      clock,
    });

    // Construct JWT header & payload
    const header = encodeBase64UrlJson({
      alg: "ES256",
      kid: selectedKeyId,
      typ: "JWT",
    });
    const payload = encodeBase64UrlJson(claims);
    const signingInput = Buffer.from(`${header}.${payload}`);

    // Sign using server-injected asymmetric signer
    const signatureResult = await signer(signingInput);
    const signature =
      typeof signatureResult === "string"
        ? signatureResult
        : Buffer.from(signatureResult).toString("base64url");

    const token = `${header}.${payload}.${signature}`;

    return Object.freeze({
      token,
      tokenKind: "vortex_file_storage_operation" as const,
      role: "authenticated" as const,
      destinationProject: config.destinationProject,
      organizationId: input.fileRecord.organizationId,
      bucketId: PRIVATE_FILE_BUCKET,
      objectPath: input.fileRecord.storageKey,
      operation: input.purpose.operation,
      keyId: selectedKeyId,
      iat: claims.iat,
      exp: claims.exp,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      claims,
    });
  };

  const mintBrowserUploadGrant = async (
    input: MintStorageCredentialInput,
  ): Promise<BrowserUploadGrant> => {
    if (input.purpose.operation !== "upload") {
      throw new Error(
        `Browser output is permitted only for pending-object upload INSERT; read, preview and removal credentials remain server-side only (requested '${input.purpose.operation}')`,
      );
    }
    if (input.fileRecord.lifecycleState !== "pending") {
      throw new Error(
        `Browser upload grant is permitted only for files in 'pending' lifecycle state (file '${input.fileRecord.fileId}' is '${input.fileRecord.lifecycleState}')`,
      );
    }

    const credential = await mintStorageOperationCredential(input);
    return projectBrowserUploadGrant(credential, input.fileRecord);
  };

  return Object.freeze({
    destinationProject: config.destinationProject,
    issuer: config.issuer,
    activeKeyId: config.activeKeyId,
    getKeyRotationMetadata,
    mintStorageOperationCredential,
    mintBrowserUploadGrant,
  });
};

/**
 * Projects a server-side storage operation credential into a safe browser upload grant.
 * Permitted ONLY for pending-object upload INSERT.
 * Rejects any read, preview or delete credentials, and rejects non-pending files.
 */
export const projectBrowserUploadGrant = (
  credential: StorageOperationCredential,
  fileRecord: FileRecord,
): BrowserUploadGrant => {
  if (credential.operation !== "upload") {
    throw new Error(
      `Browser output is permitted only for pending-object upload INSERT; read, preview and removal credentials remain server-side only (requested '${credential.operation}')`,
    );
  }

  if (fileRecord.lifecycleState !== "pending") {
    throw new Error(
      `Browser upload grant is permitted only for files in 'pending' lifecycle state (file '${fileRecord.fileId}' is '${fileRecord.lifecycleState}')`,
    );
  }

  if (credential.objectPath !== fileRecord.storageKey) {
    throw new Error(
      `Credential object path '${credential.objectPath}' does not match file record storage key '${fileRecord.storageKey}'`,
    );
  }

  return Object.freeze({
    token: credential.token,
    bucketId: credential.bucketId,
    objectPath: credential.objectPath,
    expiresAt: credential.expiresAt,
    operation: "upload" as const,
  });
};

/**
 * Verifies that a storage credential's claims match the expected scope and boundaries.
 */
export const verifyStorageCredentialClaims = (
  credential: StorageOperationCredential,
  expected: Readonly<{
    destinationProject: string;
    issuer: string;
    organizationId: OrganizationId;
    objectPath: string;
    operation: FileStorageOperation;
    nowEpochSeconds?: number;
  }>,
): VerifyStorageClaimsResult =>
  verifySignedStorageOperationClaims(credential.claims, expected);
