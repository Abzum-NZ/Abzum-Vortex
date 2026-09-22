import "server-only";

import { randomBytes } from "node:crypto";
import {
  fileStorageOperationClaimsSchema,
  fileStorageOperationSchema,
  type FileStorageOperation,
  type FileStorageOperationClaims,
  type FileUploaderActor,
  type FileId,
  type OrganizationId,
} from "@vortex/contracts";

export const PRIVATE_STORAGE_BUCKET = "private_files";
export const MAXIMUM_STORAGE_OPERATION_TTL_SECONDS = 60;

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/[a-f0-9]{16,64})?$/;

/**
 * Creates an unguessable storage object key strictly scoped under the organization identifier.
 * The original file name is never included in the storage path.
 */
export const createUnguessableStorageKey = (
  organizationId: OrganizationId,
  fileId: FileId,
): string => {
  const entropyToken = randomBytes(16).toString("hex");
  return `${organizationId}/${fileId}/${entropyToken}`;
};

/**
 * Validates that an object key begins with the expected organization ID and uses
 * an unguessable platform format with no path traversal.
 */
export const validateStorageKey = (
  storageKey: string,
  organizationId: OrganizationId,
): boolean => {
  if (typeof storageKey !== "string" || storageKey.length === 0 || storageKey.length > 1_000) {
    return false;
  }
  if (!storageKey.startsWith(`${organizationId}/`)) {
    return false;
  }
  if (storageKey.includes("..") || storageKey.includes("\\")) {
    return false;
  }
  return STORAGE_KEY_PATTERN.test(storageKey);
};

export type CreateSignedStorageOperationClaimsInput = Readonly<{
  destinationProject: string;
  issuer: string;
  organizationId: OrganizationId;
  bucketId?: string;
  objectPath: string;
  operation: FileStorageOperation;
  uploader: FileUploaderActor;
  correlationId: string;
  ttlSeconds?: number;
  clock?: () => Date;
}>;

/**
 * Mints exact signed operation claims for the Supabase Storage credential bridge.
 * Per specification:
 * - valid for at most 60 seconds
 * - role = authenticated
 * - file-specific token kind = vortex_file_storage_operation
 * - exact destination project, source organisation, bucket, object path, operation, and correlation ID
 * - actor attribution identifying verified human/account or registered system actor (never a fabricated org account)
 */
export const createSignedStorageOperationClaims = (
  input: CreateSignedStorageOperationClaimsInput,
): FileStorageOperationClaims => {
  const clock = input.clock ?? (() => new Date());
  const nowMs = clock().getTime();
  const nowEpochSeconds = Math.floor(nowMs / 1000);

  const ttlSeconds = Math.min(
    Math.max(1, input.ttlSeconds ?? MAXIMUM_STORAGE_OPERATION_TTL_SECONDS),
    MAXIMUM_STORAGE_OPERATION_TTL_SECONDS,
  );

  const bucketId = input.bucketId ?? PRIVATE_STORAGE_BUCKET;

  if (!validateStorageKey(input.objectPath, input.organizationId)) {
    throw new Error(
      `Invalid storage key for organization ${input.organizationId}: object path must begin with organization and follow unguessable pattern`,
    );
  }

  const rawClaims = {
    role: "authenticated",
    iss: input.issuer,
    tokenKind: "vortex_file_storage_operation",
    destinationProject: input.destinationProject,
    organizationId: input.organizationId,
    bucketId,
    objectPath: input.objectPath,
    operation: input.operation,
    uploader: input.uploader,
    correlationId: input.correlationId,
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + ttlSeconds,
  };

  return fileStorageOperationClaimsSchema.parse(rawClaims);
};

export type VerifySignedStorageOperationClaimsExpected = Readonly<{
  destinationProject?: string;
  organizationId: OrganizationId;
  bucketId?: string;
  objectPath: string;
  operation: FileStorageOperation;
  nowEpochSeconds?: number;
}>;

export type VerifyStorageClaimsResult =
  | Readonly<{ valid: true; claims: FileStorageOperationClaims }>
  | Readonly<{ valid: false; reason: string }>;

/**
 * Verifies that incoming Storage claims strictly match expected destination, organization,
 * bucket, object path, operation, and expiry boundaries.
 * Denies ordinary Auth tokens, wrong operations, expired tokens, and cross-organization attempts.
 */
export const verifySignedStorageOperationClaims = (
  claims: unknown,
  expected: VerifySignedStorageOperationClaimsExpected,
): VerifyStorageClaimsResult => {
  const parseResult = fileStorageOperationClaimsSchema.safeParse(claims);
  if (!parseResult.success) {
    return {
      valid: false,
      reason: "Missing, malformed, or unauthorized storage operation claims; ordinary Auth tokens confer no file authority",
    };
  }

  const parsed = parseResult.data;
  const nowEpochSeconds = expected.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  if (parsed.exp < nowEpochSeconds) {
    return { valid: false, reason: "Storage operation claims have expired" };
  }

  if (parsed.organizationId !== expected.organizationId) {
    return { valid: false, reason: "Organization identifier does not match expected scope" };
  }

  const expectedBucket = expected.bucketId ?? PRIVATE_STORAGE_BUCKET;
  if (parsed.bucketId !== expectedBucket) {
    return { valid: false, reason: "Bucket identifier does not match private storage bucket" };
  }

  if (parsed.objectPath !== expected.objectPath) {
    return { valid: false, reason: "Object path does not match expected exact target" };
  }

  if (parsed.operation !== expected.operation) {
    return {
      valid: false,
      reason: `Operation mismatch: token authorizes '${parsed.operation}', requested '${expected.operation}'`,
    };
  }

  if (expected.destinationProject && parsed.destinationProject !== expected.destinationProject) {
    return { valid: false, reason: "Destination project mismatch" };
  }

  return { valid: true, claims: parsed };
};
