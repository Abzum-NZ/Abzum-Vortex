import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  acceptOrganizationInvitationAccessCommandSchema,
  correlationIdSchema,
  createOrganizationInvitationWithAccessIntentCommandSchema,
  createOrganizationInvitationWithAccessIntentResultSchema,
  organizationInvitationAccessAcceptanceResultSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  verifiedIdentitySchema,
  type AcceptOrganizationInvitationAccessCommand,
  type CreateOrganizationInvitationWithAccessIntentCommand,
  type CreateOrganizationInvitationWithAccessIntentResult,
  type OrganizationInvitationAccessAcceptanceResult,
  type OrganizationAccountId,
  type OrganizationId,
  type CorrelationId,
  type VerifiedIdentity,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const organizationInvitationAccessHandoffErrorCodes = [
  "INVALID_ORGANIZATION_INVITATION_ACCESS_COMMAND",
  "INVALID_ORGANIZATION_INVITATION_ACCESS_STORAGE_RESULT",
  "ORGANIZATION_INVITATION_ACCESS_SCOPE_UNAVAILABLE",
  "ORGANIZATION_INVITATION_ACCESS_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_INVITATION_ACCESS_VERSION_EXHAUSTED",
  "ORGANIZATION_INVITATION_ACCESS_FAILED",
] as const;

export type OrganizationInvitationAccessHandoffErrorCode =
  (typeof organizationInvitationAccessHandoffErrorCodes)[number];

export class OrganizationInvitationAccessHandoffError extends Error {
  readonly code: OrganizationInvitationAccessHandoffErrorCode;

  constructor(code: OrganizationInvitationAccessHandoffErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationInvitationAccessHandoffError";
    this.code = code;
  }
}

export interface CreatedOrganizationInvitationWithAccessIntent extends CreateOrganizationInvitationWithAccessIntentResult {
  readonly invitationSecret: string;
}

export interface OrganizationInvitationAccessOwnerHandoff {
  create(
    context: OrganizationInvitationAccessCreateContext,
    command: CreateOrganizationInvitationWithAccessIntentCommand,
  ): Promise<CreatedOrganizationInvitationWithAccessIntent>;
  accept(
    identity: VerifiedIdentity,
    command: AcceptOrganizationInvitationAccessCommand,
  ): Promise<OrganizationInvitationAccessAcceptanceResult>;
}

export interface OrganizationInvitationAccessCreateContext {
  readonly organizationId: OrganizationId;
  readonly organizationAccountId: OrganizationAccountId;
  readonly correlationId: CorrelationId;
}

type CreateRow = DatabaseRow & { invitation: unknown; access_intent: unknown };
type AcceptRow = DatabaseRow & {
  outcome: unknown;
  organization_account: unknown;
  invitation_id: unknown;
  membership_ids: unknown;
  role_assignment_ids: unknown;
  access_version: unknown;
  correlation_id: unknown;
};

const invalidStorage = (): never => {
  throw new OrganizationInvitationAccessHandoffError(
    "INVALID_ORGANIZATION_INVITATION_ACCESS_STORAGE_RESULT",
  );
};
const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};
const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();
const sameInstant = (left: string, right: string): boolean =>
  Date.parse(left) === Date.parse(right);
const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const fingerprintSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;

const intentIdentity = (candidate: {
  membershipIntents: readonly {
    membershipId: string;
    groupId: string;
    startsAt: string;
    expiresAt?: string;
  }[];
  roleAssignmentIntents: readonly {
    roleAssignmentId: string;
    roleId: string;
    expectedRoleRevision: number;
    assignmentKind: string;
    startsAt: string;
    expiresAt?: string;
  }[];
}): string =>
  JSON.stringify({
    membershipIntents: candidate.membershipIntents.map((item) => ({
      membershipId: item.membershipId.toLowerCase(),
      groupId: item.groupId.toLowerCase(),
      startsAt: Date.parse(item.startsAt),
      expiresAt: item.expiresAt === undefined ? null : Date.parse(item.expiresAt),
    })),
    roleAssignmentIntents: candidate.roleAssignmentIntents.map((item) => ({
      roleAssignmentId: item.roleAssignmentId.toLowerCase(),
      roleId: item.roleId.toLowerCase(),
      expectedRoleRevision: item.expectedRoleRevision,
      assignmentKind: item.assignmentKind,
      startsAt: Date.parse(item.startsAt),
      expiresAt: item.expiresAt === undefined ? null : Date.parse(item.expiresAt),
    })),
  });

const parseCreate = (
  rows: readonly CreateRow[],
  command: CreateOrganizationInvitationWithAccessIntentCommand,
  invitationSecret: string,
  context: OrganizationInvitationAccessCreateContext,
): CreatedOrganizationInvitationWithAccessIntent => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const parsed = createOrganizationInvitationWithAccessIntentResultSchema.safeParse({
    invitation: rows[0].invitation,
    accessIntent: rows[0].access_intent,
  });
  if (!parsed.success) return invalidStorage();
  if (
    normalizeEmail(parsed.data.invitation.invitedEmail) !== normalizeEmail(command.invitedEmail) ||
    !sameInstant(parsed.data.invitation.expiresAt, command.expiresAt) ||
    parsed.data.invitation.revision !== 1 ||
    parsed.data.invitation.acceptedAt !== undefined ||
    parsed.data.invitation.revokedAt !== undefined ||
    !sameUuid(parsed.data.invitation.organizationId, context.organizationId) ||
    !sameUuid(parsed.data.invitation.invitedBy, context.organizationAccountId) ||
    !sameUuid(parsed.data.accessIntent.intentCorrelationId, context.correlationId) ||
    intentIdentity(parsed.data.accessIntent) !== intentIdentity(command.accessIntent)
  )
    return invalidStorage();
  return { ...parsed.data, invitationSecret };
};

const parseAccept = (
  rows: readonly AcceptRow[],
  identity: VerifiedIdentity,
  command: AcceptOrganizationInvitationAccessCommand,
): OrganizationInvitationAccessAcceptanceResult => {
  if (rows.length !== 1 || rows[0] === undefined) return invalidStorage();
  const row = rows[0];
  const refusal = row.outcome === "unavailable" || row.outcome === "identity_inactive";
  if (
    refusal &&
    [
      row.organization_account,
      row.invitation_id,
      row.membership_ids,
      row.role_assignment_ids,
      row.access_version,
      row.correlation_id,
    ].some((value) => value !== null && value !== undefined)
  )
    return invalidStorage();
  const candidate = refusal
    ? { outcome: row.outcome }
    : {
        outcome: row.outcome,
        account: row.organization_account,
        invitationId: row.invitation_id,
        membershipIds: row.membership_ids,
        roleAssignmentIds: row.role_assignment_ids,
        accessVersion: revision(row.access_version),
        correlationId: row.correlation_id,
      };
  const parsed = organizationInvitationAccessAcceptanceResultSchema.safeParse(candidate);
  if (!parsed.success) return invalidStorage();
  if (parsed.data.outcome === "unavailable" || parsed.data.outcome === "identity_inactive")
    return parsed.data;
  if (
    !sameUuid(parsed.data.account.identityId, identity.identityId) ||
    !sameUuid(parsed.data.correlationId, command.correlationId)
  )
    return invalidStorage();
  return parsed.data;
};

const mapStorageFailure = (error: unknown): OrganizationInvitationAccessHandoffError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (databaseCode === "22023")
    return new OrganizationInvitationAccessHandoffError(
      "INVALID_ORGANIZATION_INVITATION_ACCESS_COMMAND",
    );
  if (databaseCode === "42501")
    return new OrganizationInvitationAccessHandoffError(
      "ORGANIZATION_INVITATION_ACCESS_SCOPE_UNAVAILABLE",
    );
  if (databaseCode === "22003")
    return new OrganizationInvitationAccessHandoffError(
      "ORGANIZATION_INVITATION_ACCESS_VERSION_EXHAUSTED",
    );
  if (["23503", "23505", "23514", "40001", "55000"].includes(databaseCode ?? ""))
    return new OrganizationInvitationAccessHandoffError(
      "ORGANIZATION_INVITATION_ACCESS_STALE_OR_UNAVAILABLE",
    );
  return new OrganizationInvitationAccessHandoffError("ORGANIZATION_INVITATION_ACCESS_FAILED");
};

/**
 * Test-only binding proof for the owner compositions. A create result containing
 * the secret is an in-transaction owner-only intermediate: its caller must not
 * expose it until the enclosing transaction commits, and this helper does not
 * prove either commit or delivery. #40 supplies protected invocation and current
 * authority; this helper is not a shipping writer.
 */
export const createOrganizationInvitationAccessOwnerHandoff = (
  transaction: RequestDatabaseTransaction,
  generateInvitationSecret: () => string = () => randomBytes(32).toString("base64url"),
): OrganizationInvitationAccessOwnerHandoff =>
  Object.freeze({
    async create(context, commandCandidate) {
      const checkedContext = {
        organizationId: organizationIdSchema.safeParse(context.organizationId),
        organizationAccountId: organizationAccountIdSchema.safeParse(context.organizationAccountId),
        correlationId: correlationIdSchema.safeParse(context.correlationId),
      };
      const command =
        createOrganizationInvitationWithAccessIntentCommandSchema.safeParse(commandCandidate);
      if (
        !command.success ||
        !checkedContext.organizationId.success ||
        !checkedContext.organizationAccountId.success ||
        !checkedContext.correlationId.success
      )
        throw new OrganizationInvitationAccessHandoffError(
          "INVALID_ORGANIZATION_INVITATION_ACCESS_COMMAND",
        );
      const invitationSecret = generateInvitationSecret();
      if (Buffer.byteLength(invitationSecret, "utf8") < 32)
        throw new OrganizationInvitationAccessHandoffError("ORGANIZATION_INVITATION_ACCESS_FAILED");
      try {
        const rows = await transaction.query<CreateRow>`
          select *
          from vortex_access.coordinate_organization_invitation_with_access_intent(
            ${normalizeEmail(command.data.invitedEmail)}::text,
            ${fingerprintSecret(invitationSecret)}::text,
            ${command.data.expiresAt}::timestamptz,
            ${command.data.accessIntent}::jsonb
          )
        `;
        return parseCreate(rows, command.data, invitationSecret, {
          organizationId: checkedContext.organizationId.data,
          organizationAccountId: checkedContext.organizationAccountId.data,
          correlationId: checkedContext.correlationId.data,
        });
      } catch (error) {
        if (error instanceof OrganizationInvitationAccessHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async accept(identityCandidate, commandCandidate) {
      const identity = verifiedIdentitySchema.safeParse(identityCandidate);
      const command = acceptOrganizationInvitationAccessCommandSchema.safeParse(commandCandidate);
      if (!identity.success || !command.success)
        throw new OrganizationInvitationAccessHandoffError(
          "INVALID_ORGANIZATION_INVITATION_ACCESS_COMMAND",
        );
      try {
        const rows = await transaction.query<AcceptRow>`
          select *
          from vortex_access.coordinate_organization_invitation_access_acceptance(
            ${fingerprintSecret(command.data.invitationSecret)}::text,
            ${identity.data.identityId}::uuid,
            ${normalizeEmail(identity.data.verifiedPrimaryEmail)}::text,
            ${command.data.displayName ?? null}::text,
            ${command.data.correlationId}::uuid
          )
        `;
        return parseAccept(rows, identity.data, command.data);
      } catch (error) {
        if (error instanceof OrganizationInvitationAccessHandoffError) throw error;
        throw mapStorageFailure(error);
      }
    },
  });
