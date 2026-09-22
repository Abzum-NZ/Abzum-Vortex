import "server-only";

import { randomBytes } from "node:crypto";
import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  PRIVATE_FILE_BUCKET,
  fileStorageOperationClaimsSchema,
  privateFileObjectPathSchema,
  type FileId,
  type FileStorageOperation,
  type FileStorageOperationClaims,
  type OrganizationId,
  type VerifiedFileActor,
} from "@vortex/contracts";

export { MAXIMUM_FILE_STORAGE_OPERATION_SECONDS, PRIVATE_FILE_BUCKET };

/** Issuance is accepted a few seconds ahead of this clock to absorb verified clock skew. */
const ISSUED_AT_SKEW_SECONDS = 5;

/**
 * Creates an unguessable storage object key strictly scoped under the organisation
 * identifier and its file identifier. The original file name is never part of the path.
 */
export const createUnguessableStorageKey = (
  organizationId: OrganizationId,
  fileId: FileId,
): string => `${organizationId}/${fileId}/${randomBytes(16).toString("hex")}`;

/**
 * Validates that an object key belongs to the expected organisation and uses the
 * unguessable platform format, with no traversal and no original file name.
 */
export const validateStorageKey = (
  storageKey: string,
  organizationId: OrganizationId,
): boolean =>
  privateFileObjectPathSchema.safeParse(storageKey).success &&
  storageKey.startsWith(`${organizationId}/`);

export type CreateSignedStorageOperationClaimsInput = Readonly<{
  destinationProject: string;
  issuer: string;
  organizationId: OrganizationId;
  objectPath: string;
  operation: FileStorageOperation;
  actor: VerifiedFileActor;
  correlationId: string;
  ttlSeconds?: number;
  clock?: () => Date;
}>;

/**
 * Mints the exact operation claims for the Supabase Storage credential bridge, per
 * the storage credential bridge in the files specification: `role=authenticated`,
 * a File-specific token kind, the destination project and its issuer, the source
 * organisation, the exact private bucket, object path and single allowed operation,
 * a correlation identifier, and a lifetime of at most 60 seconds. Actor attribution
 * names the verified human account or registered system actor and never invents one.
 *
 * This mints claims only. Signing keys, token emission and object access belong to
 * the credential bridge slice and stay out of this module.
 */
export const createSignedStorageOperationClaims = (
  input: CreateSignedStorageOperationClaimsInput,
): FileStorageOperationClaims => {
  const clock = input.clock ?? (() => new Date());
  const issuedAtEpochSeconds = Math.floor(clock().getTime() / 1000);

  const ttlSeconds = Math.min(
    Math.max(1, Math.floor(input.ttlSeconds ?? MAXIMUM_FILE_STORAGE_OPERATION_SECONDS)),
    MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  );

  if (!validateStorageKey(input.objectPath, input.organizationId)) {
    throw new Error(
      `Refusing a storage operation credential for organisation ${input.organizationId}: the object path is not an organisation-scoped unguessable private path`,
    );
  }

  return fileStorageOperationClaimsSchema.parse({
    role: "authenticated",
    aud: "authenticated",
    iss: input.issuer,
    tokenKind: "vortex_file_storage_operation",
    destinationProject: input.destinationProject,
    organizationId: input.organizationId,
    bucketId: PRIVATE_FILE_BUCKET,
    objectPath: input.objectPath,
    operation: input.operation,
    actor: input.actor,
    correlationId: input.correlationId,
    iat: issuedAtEpochSeconds,
    exp: issuedAtEpochSeconds + ttlSeconds,
  });
};

export type VerifySignedStorageOperationClaimsExpected = Readonly<{
  destinationProject: string;
  issuer: string;
  organizationId: OrganizationId;
  objectPath: string;
  operation: FileStorageOperation;
  nowEpochSeconds?: number;
}>;

export type VerifyStorageClaimsResult =
  | Readonly<{ valid: true; claims: FileStorageOperationClaims }>
  | Readonly<{ valid: false; reason: string }>;

/**
 * Verifies that presented Storage claims match the expected destination project and
 * issuer, organisation, private bucket, exact object path and single operation, and
 * that they are inside the 60-second boundary. An ordinary Auth token, a token from
 * another project, a token for another object or operation, and a long-lived or
 * not-yet-valid token all fail.
 */
export const verifySignedStorageOperationClaims = (
  claims: unknown,
  expected: VerifySignedStorageOperationClaimsExpected,
): VerifyStorageClaimsResult => {
  const parseResult = fileStorageOperationClaimsSchema.safeParse(claims);
  if (!parseResult.success) {
    return {
      valid: false,
      reason:
        "Missing, malformed or out-of-boundary storage operation claims; an ordinary Auth token confers no file authority",
    };
  }

  const parsed = parseResult.data;
  const nowEpochSeconds = expected.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

  if (parsed.iat > nowEpochSeconds + ISSUED_AT_SKEW_SECONDS) {
    return { valid: false, reason: "Storage operation claims are not yet valid" };
  }

  if (parsed.exp <= nowEpochSeconds) {
    return { valid: false, reason: "Storage operation claims have expired" };
  }

  if (parsed.destinationProject !== expected.destinationProject) {
    return { valid: false, reason: "Destination project does not match this destination" };
  }

  if (parsed.iss !== expected.issuer) {
    return { valid: false, reason: "Issuer does not match the destination project issuer" };
  }

  if (parsed.organizationId !== expected.organizationId) {
    return { valid: false, reason: "Organisation identifier does not match the expected scope" };
  }

  if (parsed.objectPath !== expected.objectPath) {
    return { valid: false, reason: "Object path does not match the expected exact target" };
  }

  if (!parsed.objectPath.startsWith(`${expected.organizationId}/`)) {
    return { valid: false, reason: "Object path is outside the expected organisation scope" };
  }

  if (parsed.operation !== expected.operation) {
    return {
      valid: false,
      reason: `Operation mismatch: the credential authorises '${parsed.operation}', the request is '${expected.operation}'`,
    };
  }

  return { valid: true, claims: parsed };
};
