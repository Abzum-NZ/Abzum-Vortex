import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  createOrganizationInvitationCommandSchema,
  ensureIdentityProjectionCommandSchema,
  identityProjectionSchema,
  invitationSchema,
  revokeOrganizationInvitationCommandSchema,
  verifiedIdentitySchema,
  type CreateOrganizationInvitationCommand,
  type EnsureIdentityProjectionCommand,
  type IdentityProjection,
  type Invitation,
  type RevokeOrganizationInvitationCommand,
  type VerifiedIdentity,
} from "@vortex/contracts";
import {
  withRuntimeTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
  type RuntimeDatabaseTransaction,
} from "@vortex/db";
import { requireRequestIdentityNotDisabled } from "./identity-disablement-publication";

export const organizationAccountErrorCodes = [
  "INVALID_ORGANIZATION_ACCOUNT_COMMAND",
  "INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT",
  "ORGANIZATION_ACCOUNT_CONTEXT_REFUSED",
  "ORGANIZATION_ACCOUNT_STALE_OR_UNAVAILABLE",
  "ORGANIZATION_ACCOUNT_OPERATION_FAILED",
] as const;

export type OrganizationAccountErrorCode = (typeof organizationAccountErrorCodes)[number];

export class OrganizationAccountError extends Error {
  readonly code: OrganizationAccountErrorCode;

  constructor(code: OrganizationAccountErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "OrganizationAccountError";
    this.code = code;
  }
}

export interface CreatedOrganizationInvitation {
  readonly invitation: Invitation;
  readonly invitationSecret: string;
}

type RuntimeTransactionRunner = <Result>(
  operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

interface OrganizationAccountStoreDependencies {
  readonly runtimeTransaction?: RuntimeTransactionRunner;
  readonly generateInvitationSecret?: () => string;
}

/** A non-mutating eligibility lookup for protected-session resolution. */
export interface IdentityProjectionReader {
  readIdentityProjection(
    verifiedIdentity: VerifiedIdentity,
  ): Promise<IdentityProjection | undefined>;
}

type IdentityProjectionRow = DatabaseRow & {
  identity_id: unknown;
  state: unknown;
  created_at: unknown;
  state_changed_at: unknown;
  state_changed_by: unknown;
  state_change_correlation_id: unknown;
  revision: unknown;
};

type InvitationRow = DatabaseRow & {
  invitation_id: unknown;
  organization_id: unknown;
  invited_email: unknown;
  invited_by: unknown;
  created_at: unknown;
  invited_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
  revoked_by: unknown;
  accepted_at: unknown;
  accepted_organization_account_id: unknown;
  changed_at: unknown;
  revision: unknown;
};

const timestamp = (value: unknown): unknown =>
  value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value;

const optional = <Value>(value: Value | null | undefined): Value | undefined =>
  value === null || value === undefined ? undefined : value;

const revision = (value: unknown): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return Number(value);
  return value;
};

const parseIdentityProjection = (row: IdentityProjectionRow): IdentityProjection =>
  identityProjectionSchema.parse({
    identityId: row.identity_id,
    state: row.state,
    createdAt: timestamp(row.created_at),
    stateChangedAt: timestamp(row.state_changed_at),
    stateChangedBy: row.state_changed_by,
    stateChangeCorrelationId: row.state_change_correlation_id,
    revision: revision(row.revision),
  });

const parseInvitation = (row: InvitationRow): Invitation =>
  invitationSchema.parse({
    invitationId: row.invitation_id,
    organizationId: row.organization_id,
    invitedEmail: row.invited_email,
    invitedBy: row.invited_by,
    createdAt: timestamp(row.created_at),
    invitedAt: timestamp(row.invited_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: optional(timestamp(row.revoked_at)),
    revokedBy: optional(row.revoked_by),
    acceptedAt: optional(timestamp(row.accepted_at)),
    acceptedOrganizationAccountId: optional(row.accepted_organization_account_id),
    changedAt: timestamp(row.changed_at),
    revision: revision(row.revision),
  });

const mapStorageFailure = (error: unknown): OrganizationAccountError => {
  const databaseCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;

  if (databaseCode === "22023" || databaseCode === "23514")
    return new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  if (databaseCode === "42501")
    return new OrganizationAccountError("ORGANIZATION_ACCOUNT_CONTEXT_REFUSED");
  if (databaseCode === "40001" || databaseCode === "23503" || databaseCode === "23505")
    return new OrganizationAccountError("ORGANIZATION_ACCOUNT_STALE_OR_UNAVAILABLE");
  return new OrganizationAccountError("ORGANIZATION_ACCOUNT_OPERATION_FAILED");
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const fingerprintSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`;

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  return rows[0];
};

const requireZeroOrOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row | undefined => {
  if (rows.length > 1)
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  return rows[0];
};

export const createOrganizationAccountStore = (
  dependencies: OrganizationAccountStoreDependencies = {},
) => {
  const runtimeTransaction = dependencies.runtimeTransaction ?? withRuntimeTransaction;
  const generateInvitationSecret =
    dependencies.generateInvitationSecret ?? (() => randomBytes(32).toString("base64url"));

  return Object.freeze({
    async ensureIdentityProjection(
      verifiedIdentity: VerifiedIdentity,
      command: EnsureIdentityProjectionCommand,
    ): Promise<IdentityProjection> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      const parsed = ensureIdentityProjectionCommandSchema.safeParse(command);
      if (!verified.success || !parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<IdentityProjectionRow>`
            select *
            from vortex_identity.ensure_identity_projection(
              ${verified.data.identityId}::uuid,
              ${parsed.data.correlationId}::uuid
            )
          `;
          return parseIdentityProjection(requireOne(rows));
        });
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async readIdentityProjection(
      verifiedIdentity: VerifiedIdentity,
    ): Promise<IdentityProjection | undefined> {
      const verified = verifiedIdentitySchema.safeParse(verifiedIdentity);
      if (!verified.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      try {
        return await runtimeTransaction(async (transaction) => {
          const rows = await transaction.query<IdentityProjectionRow>`
            select *
            from vortex_identity.read_identity_projection(${verified.data.identityId}::uuid)
          `;
          const row = requireZeroOrOne(rows);
          return row === undefined ? undefined : parseIdentityProjection(row);
        });
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async createInvitationAfterAuthorization(
      transaction: RequestDatabaseTransaction,
      command: CreateOrganizationInvitationCommand,
    ): Promise<CreatedOrganizationInvitation> {
      const parsed = createOrganizationInvitationCommandSchema.safeParse(command);
      if (!parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");

      const invitationSecret = generateInvitationSecret();
      if (Buffer.byteLength(invitationSecret, "utf8") < 32)
        throw new OrganizationAccountError("ORGANIZATION_ACCOUNT_OPERATION_FAILED");
      const tokenFingerprint = fingerprintSecret(invitationSecret);
      const invitedEmail = normalizeEmail(parsed.data.invitedEmail);

      try {
        const rows = await transaction.query<InvitationRow>`
          select *
          from vortex_identity.create_organization_invitation(
            ${invitedEmail}::text,
            ${tokenFingerprint}::text,
            ${parsed.data.expiresAt}::timestamptz
          )
        `;
        const invitation = parseInvitation(requireOne(rows));
        return { invitation, invitationSecret };
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async revokeInvitationAfterAuthorization(
      transaction: RequestDatabaseTransaction,
      command: RevokeOrganizationInvitationCommand,
    ): Promise<Invitation> {
      const parsed = revokeOrganizationInvitationCommandSchema.safeParse(command);
      if (!parsed.success)
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
      try {
        const rows = await transaction.query<InvitationRow>`
          select * from vortex_identity.revoke_organization_invitation(
            ${parsed.data.invitationId}::uuid,
            ${parsed.data.expectedRevision}::bigint
          )
        `;
        return parseInvitation(requireOne(rows));
      } catch (error) {
        if (error instanceof OrganizationAccountError) throw error;
        throw mapStorageFailure(error);
      }
    },

    async listOffboardingOwnedRecords(
      transaction: RequestDatabaseTransaction,
      query: OffboardingInventoryQuery,
    ): Promise<OffboardingInventoryResult> {
      return executeListOffboardingOwnedRecords(transaction, query);
    },

    async transferOffboardingOwnedRecords(
      transaction: RequestDatabaseTransaction,
      command: OffboardingTransferBatchCommand,
    ): Promise<OffboardingTransferBatchResult> {
      return executeTransferOffboardingOwnedRecords(transaction, command);
    },

    async beginOrganizationAccountClosing(
      transaction: RequestDatabaseTransaction,
      command: BeginOrganizationAccountClosingCommand,
    ): Promise<OrganizationAccountClosingResult> {
      return executeBeginOrganizationAccountClosing(transaction, command);
    },

    async finalizeOrganizationAccountDeletion(
      transaction: RequestDatabaseTransaction,
      organizationAccountId: string,
    ): Promise<AccountDeletionFenceResult> {
      return executeFinalizeOrganizationAccountDeletion(transaction, organizationAccountId);
    },
  });
};

export type OffboardingInventoryTargetKind = "organization_account" | "group";
export type OffboardingInventorySectionKind = "application" | "organization_shared" | "all";
export type OffboardingSectionKind = "application" | "organization_shared";
export type OffboardingStorageScope = "application_contained" | "organization_shared";
export type OffboardingLifecycleState = "active" | "soft_deleted" | "removal_pending";
export type OffboardingInstallationState = "active" | "detached";
export type OffboardingClassification = "transferable" | "refused_incompatible";

const offboardingTargetKinds = ["organization_account", "group"] as const;
const offboardingRequestedSections = ["application", "organization_shared", "all"] as const;
const offboardingSectionKinds = ["application", "organization_shared"] as const;
const offboardingStorageScopes = ["application_contained", "organization_shared"] as const;
const offboardingLifecycleStates = ["active", "soft_deleted", "removal_pending"] as const;
const offboardingInstallationStates = ["active", "detached"] as const;
const offboardingClassifications = ["transferable", "refused_incompatible"] as const;

const offboardingInventoryPageLimit = 50;

export interface OffboardingOwnedRecordItem {
  readonly storageContractId: string;
  readonly recordTypeId: string;
  readonly recordId: string;
  /** The stored revision this preview saw, for the transfer's expected revision. */
  readonly concurrencyNumber: number;
  readonly lifecycleState: OffboardingLifecycleState;
  readonly installationState: OffboardingInstallationState;
  readonly classification: OffboardingClassification;
  readonly storageScope: OffboardingStorageScope;
  /**
   * Every application this record is reachable from. An application-contained
   * record affects the application containing it; an organisation-shared record
   * affects every application its storage contract is installed into, which is
   * the impact the administrator accepts by including it.
   */
  readonly affectedApplications: readonly string[];
}

export interface OffboardingRecordTypePageCount {
  readonly recordTypeId: string;
  readonly storageScope: OffboardingStorageScope;
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly total: number;
  readonly affectedApplications: readonly string[];
}

export interface OffboardingApplicationPageCount {
  readonly applicationRootId: string;
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly total: number;
}

export interface OffboardingSharedPageImpact {
  readonly affectedApplications: readonly string[];
  readonly sharedRecords: number;
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly recordTypeIds: readonly string[];
}

/**
 * Aggregates of the records disclosed on this page, and of nothing else. A
 * section-wide total would have to count records the caller may not read, so
 * the inventory never presents one. A shared record contributes to
 * `perApplication` once per affected application, so those counts describe
 * organisation-wide reach rather than a number of records.
 */
export interface OffboardingInventoryPage {
  readonly ownedRecords: number;
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly perRecordType: readonly OffboardingRecordTypePageCount[];
  readonly perApplication: readonly OffboardingApplicationPageCount[];
  readonly sharedImpact: OffboardingSharedPageImpact;
}

export interface OffboardingInventoryCursor {
  readonly sectionKind: OffboardingSectionKind;
  readonly storageContractId?: string;
  readonly recordId?: string;
}

export interface OffboardingInventoryQuery {
  readonly sourceOrganizationAccountId: string;
  readonly targetKind: OffboardingInventoryTargetKind;
  readonly targetId: string;
  /** Defaults to `all`, which walks the application section then the shared one. */
  readonly sectionKind?: OffboardingInventorySectionKind;
  readonly after?: OffboardingInventoryCursor | string;
  readonly limit?: number;
}

export interface OffboardingInventoryResult {
  readonly outcome: "listed";
  readonly accessVersion: number;
  readonly items: readonly OffboardingOwnedRecordItem[];
  readonly page: OffboardingInventoryPage;
  /**
   * True when the requested scope had no further disclosed page. It does not
   * assert that the account owns nothing else: records hidden from this
   * administrator stay concealed by design, and only the protected deletion
   * fence decides that no owned record remains.
   */
  readonly complete: boolean;
  readonly next?: OffboardingInventoryCursor & { readonly token: string };
}

/**
 * A batch is addressed by the same keyset and target that its preview uses.
 * `commandId` is stable for a retry of this batch; item command, Activity and
 * Event identities are derived from it and the exact previewed record, so a
 * retry reuses the same protected receipt instead of repeating an effect. A
 * record whose revision, target or protected entry differs from the attempt
 * that already used its derived command identity is refused, never transferred
 * twice.
 */
export interface OffboardingTransferBatchCommand extends OffboardingInventoryQuery {
  readonly commandId: string;
}

export type OffboardingTransferBatchRecordOutcome = "completed" | "conflicted" | "refused";

export interface OffboardingTransferBatchRecordResult {
  readonly storageContractId: string;
  readonly recordTypeId: string;
  readonly recordId: string;
  readonly outcome: OffboardingTransferBatchRecordOutcome;
  readonly concurrencyNumber?: number;
}

export interface OffboardingTransferBatchResult {
  readonly outcome: "processed";
  /** The preview's admitted access version for this bounded batch. */
  readonly accessVersion: number;
  readonly items: readonly OffboardingTransferBatchRecordResult[];
  /**
   * True when the disclosed walk had no further page. It does not assert that
   * the account now owns nothing: refused and conflicted records of this and
   * earlier pages remain owned, records hidden from this administrator stay
   * concealed, and only the protected deletion fence decides that none remain.
   */
  readonly complete: boolean;
  readonly next?: OffboardingInventoryCursor & { readonly token: string };
}

export type OrganizationAccountLifecycleState =
  | "active"
  | "suspended"
  | "closed"
  | "closing"
  | "deleted";

const organizationAccountLifecycleStates = [
  "active",
  "suspended",
  "closed",
  "closing",
  "deleted",
] as const;

/**
 * Begins the one-way account-closing fence from 'active', 'suspended' or
 * 'closed'. Like closure it stops the account acting and invalidates the
 * organisation's Access version. From then on no write can assign the account
 * as a record owner, and the account can only proceed to deletion.
 */
export interface BeginOrganizationAccountClosingCommand {
  readonly organizationAccountId: string;
  readonly expectedRevision: number;
}

export interface OrganizationAccountClosingResult {
  readonly outcome: "closing";
  readonly organizationAccountId: string;
  readonly organizationId: string;
  readonly state: "closing";
  readonly revision: number;
  readonly accessVersion: number;
}

export type AccountDeletionFenceOutcome = "deleted" | "not_closing" | "records_remain";

const accountDeletionFenceOutcomes = ["deleted", "not_closing", "records_remain"] as const;

/**
 * The final deletion fence. It locks a 'closing' account, then runs a private,
 * undisclosed inventory over every Record table in the organisation (every
 * application, installed or not, and organisation-shared storage; every
 * lifecycle state; blind to the caller's own record visibility). It deletes
 * only when that inventory proves nothing is owned, and fails instead when
 * completeness cannot be proved. `records_remain` never identifies a record,
 * type or scope. A retry after deletion reports `deleted` again. Deletion
 * retains the account row and its historical attribution.
 */
export interface AccountDeletionFenceResult {
  readonly outcome: AccountDeletionFenceOutcome;
  readonly organizationAccountId?: string;
  readonly state?: OrganizationAccountLifecycleState;
  readonly revision?: number;
  readonly accessVersion: number;
}

interface OffboardingInventorySqlRow extends DatabaseRow {
  readonly result: unknown;
}

interface OffboardingTransferSqlRow extends DatabaseRow {
  readonly result: unknown;
}

interface OffboardingInventorySelector {
  readonly sourceOrganizationAccountId: string;
  readonly targetKind: OffboardingInventoryTargetKind;
  readonly targetId: string;
  readonly sectionKind: OffboardingInventorySectionKind;
  readonly after: OffboardingInventoryCursor | undefined;
  readonly limit: number;
}

interface OffboardingTransferBatchSelector {
  readonly commandId: string;
}

interface OffboardingInventorySection {
  readonly items: readonly OffboardingOwnedRecordItem[];
  readonly next?: { readonly storageContractId: string; readonly recordId: string };
  readonly accessVersion: number;
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

const isMember = <Member extends string>(
  value: unknown,
  allowed: readonly Member[],
): value is Member =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

const invalidCommand = (): never => {
  throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
};

// The inventory decides what an administrator may see and what a later transfer
// will be allowed to change. A missing or unrecognised value is a defect in the
// protected read, never a default, so every reader below refuses rather than
// guessing an ownership, lifecycle, installation or revision fact.
const invalidResult = (): never => {
  throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
};

const commandUuid = (value: unknown): string => (isUuid(value) ? value : invalidCommand());

const commandRevision = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9007199254740991
    ? value
    : invalidCommand();

const commandMember = <Member extends string>(
  value: unknown,
  allowed: readonly Member[],
): Member => (isMember(value, allowed) ? value : invalidCommand());

const resultUuid = (value: unknown): string => (isUuid(value) ? value : invalidResult());

const resultMember = <Member extends string>(
  value: unknown,
  allowed: readonly Member[],
): Member => (isMember(value, allowed) ? value : invalidResult());

/** A `bigint` column as the driver may present it: number, bigint or digits. */
const resultStoredInteger = (value: unknown): number => {
  const candidate =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : value;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 1
    ? candidate
    : invalidResult();
};

const resultUuidArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.map(resultUuid) : invalidResult();

const encodeCursor = (cursor: OffboardingInventoryCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const readCursorFields = (fields: Record<string, unknown>): OffboardingInventoryCursor => {
  const sectionKind = commandMember(fields.sectionKind, offboardingSectionKinds);
  // A position is both keys or neither: one alone cannot address a keyset page.
  if ((fields.storageContractId === undefined) !== (fields.recordId === undefined)) {
    invalidCommand();
  }
  return fields.storageContractId === undefined
    ? { sectionKind }
    : {
        sectionKind,
        storageContractId: commandUuid(fields.storageContractId),
        recordId: commandUuid(fields.recordId),
      };
};

const decodeCursor = (after: unknown): OffboardingInventoryCursor | undefined => {
  if (after === undefined || after === null) return undefined;
  if (typeof after === "string") {
    const trimmed = after.trim();
    if (trimmed.length === 0) return undefined;
    // Exactly the token this service issues: one base64url JSON object, decoded
    // once. A token addresses a position, so a decoded string is not a token.
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8"));
    } catch {
      return invalidCommand();
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      return invalidCommand();
    }
    return readCursorFields(decoded as Record<string, unknown>);
  }
  if (typeof after !== "object" || Array.isArray(after)) return invalidCommand();
  return readCursorFields(after as Record<string, unknown>);
};

const readInventorySelector = (query: unknown): OffboardingInventorySelector => {
  if (typeof query !== "object" || query === null) return invalidCommand();
  const fields = query as Record<string, unknown>;

  // The protected read refuses a limit outside 1..50; keep the same bound here
  // so an out-of-range request is an invalid command, not a failed read.
  if (
    fields.limit !== undefined &&
    (typeof fields.limit !== "number" ||
      !Number.isInteger(fields.limit) ||
      fields.limit < 1 ||
      fields.limit > offboardingInventoryPageLimit)
  ) {
    invalidCommand();
  }

  const sectionKind =
    fields.sectionKind === undefined
      ? "all"
      : commandMember(fields.sectionKind, offboardingRequestedSections);
  const after = decodeCursor(fields.after);
  // A cursor addresses one section's keyset. Applying an application position to
  // the shared section, or the reverse, would silently skip or repeat records.
  if (after !== undefined && sectionKind !== "all" && after.sectionKind !== sectionKind) {
    invalidCommand();
  }

  return {
    sourceOrganizationAccountId: commandUuid(fields.sourceOrganizationAccountId),
    targetKind: commandMember(fields.targetKind, offboardingTargetKinds),
    targetId: commandUuid(fields.targetId),
    sectionKind,
    after,
    limit:
      typeof fields.limit === "number" ? fields.limit : offboardingInventoryPageLimit,
  };
};

const readTransferBatchSelector = (command: unknown): OffboardingTransferBatchSelector => {
  if (typeof command !== "object" || command === null || Array.isArray(command))
    return invalidCommand();
  return { commandId: commandUuid((command as Record<string, unknown>).commandId) };
};

const derivedBatchItemId = (
  batchCommandId: string,
  item: OffboardingOwnedRecordItem,
  purpose: "command" | "activity" | "occurrence",
): string => {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${batchCommandId}:${item.recordTypeId}:${item.recordId}:${purpose}`, "utf8")
      .digest()
      .subarray(0, 16),
  );
  // Make the digest a RFC 4122 variant, version-5-shaped UUID. The batch
  // command is caller-provided and stable, so replays use the same protected
  // receipt, Activity and Event identities for this exact record.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const querySqlSection = async (
  transaction: RequestDatabaseTransaction,
  selector: OffboardingInventorySelector,
  sectionKind: OffboardingSectionKind,
  afterContractId: string | null,
  afterRecordId: string | null,
  limit: number,
): Promise<OffboardingInventorySection> => {
  const rows = await transaction.query<OffboardingInventorySqlRow>`
    select vortex_record.list_offboarding_owned_records(
      ${selector.sourceOrganizationAccountId}::uuid,
      ${selector.targetKind}::text,
      ${selector.targetId}::uuid,
      ${sectionKind}::text,
      ${afterContractId}::uuid,
      ${afterRecordId}::uuid,
      ${limit}::integer
    ) as result
  `;
  const raw = requireOne(rows).result;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalidResult();
  const data = raw as Record<string, unknown>;
  if (data.outcome !== "listed") invalidResult();

  if (typeof data.section !== "object" || data.section === null) invalidResult();
  const section = data.section as Record<string, unknown>;
  // The read must answer the section that was asked for; anything else would
  // attribute one section's records and continuation to the other.
  if (section.kind !== sectionKind) invalidResult();
  const applicationRootId =
    sectionKind === "application" ? resultUuid(section.applicationRootId) : undefined;
  const sectionInstallationState = resultMember(
    data.installationState,
    offboardingInstallationStates,
  );
  const accessVersion = resultStoredInteger(data.accessVersion);

  if (!Array.isArray(data.items)) invalidResult();
  const items = (data.items as readonly unknown[]).map((entry): OffboardingOwnedRecordItem => {
    if (typeof entry !== "object" || entry === null) invalidResult();
    const item = entry as Record<string, unknown>;
    const storageScope = resultMember(
      item.storageScope ?? "application_contained",
      offboardingStorageScopes,
    );
    if ((storageScope === "organization_shared") !== (sectionKind === "organization_shared")) {
      invalidResult();
    }
    return {
      storageContractId: resultUuid(item.storageContractId),
      recordTypeId: resultUuid(item.recordTypeId),
      recordId: resultUuid(item.recordId),
      concurrencyNumber: resultStoredInteger(item.concurrencyNumber),
      lifecycleState: resultMember(item.lifecycleState, offboardingLifecycleStates),
      installationState: resultMember(
        item.installationState ?? sectionInstallationState,
        offboardingInstallationStates,
      ),
      classification: resultMember(item.classification, offboardingClassifications),
      storageScope,
      // An application-contained record affects the application containing it,
      // which the section itself names.
      affectedApplications:
        applicationRootId === undefined
          ? resultUuidArray(item.affectedApplications)
          : [applicationRootId],
    };
  });

  // A malformed continuation refuses rather than disappearing: dropping it would
  // present a truncated page as the end of the section.
  if (data.next === undefined) return { items, accessVersion };
  if (typeof data.next !== "object" || data.next === null) invalidResult();
  const next = data.next as Record<string, unknown>;
  return {
    items,
    next: {
      storageContractId: resultUuid(next.storageContractId),
      recordId: resultUuid(next.recordId),
    },
    accessVersion,
  };
};

const summarizeInventoryPage = (
  items: readonly OffboardingOwnedRecordItem[],
): OffboardingInventoryPage => {
  const perRecordType = new Map<
    string,
    {
      readonly recordTypeId: string;
      readonly storageScope: OffboardingStorageScope;
      transferable: number;
      refusedIncompatible: number;
      readonly affectedApplications: Set<string>;
    }
  >();
  const perApplication = new Map<
    string,
    { readonly applicationRootId: string; transferable: number; refusedIncompatible: number }
  >();
  const sharedApplications = new Set<string>();
  const sharedRecordTypeIds = new Set<string>();
  let transferable = 0;
  let refusedIncompatible = 0;
  let sharedRecords = 0;
  let sharedTransferable = 0;
  let sharedRefusedIncompatible = 0;

  for (const item of items) {
    const isTransferable = item.classification === "transferable";
    if (isTransferable) transferable += 1;
    else refusedIncompatible += 1;

    const recordType = perRecordType.get(item.recordTypeId) ?? {
      recordTypeId: item.recordTypeId,
      storageScope: item.storageScope,
      transferable: 0,
      refusedIncompatible: 0,
      affectedApplications: new Set<string>(),
    };
    if (isTransferable) recordType.transferable += 1;
    else recordType.refusedIncompatible += 1;
    for (const application of item.affectedApplications) {
      recordType.affectedApplications.add(application);
    }
    perRecordType.set(item.recordTypeId, recordType);

    for (const application of item.affectedApplications) {
      const reach = perApplication.get(application) ?? {
        applicationRootId: application,
        transferable: 0,
        refusedIncompatible: 0,
      };
      if (isTransferable) reach.transferable += 1;
      else reach.refusedIncompatible += 1;
      perApplication.set(application, reach);
    }

    if (item.storageScope !== "organization_shared") continue;
    sharedRecords += 1;
    if (isTransferable) sharedTransferable += 1;
    else sharedRefusedIncompatible += 1;
    sharedRecordTypeIds.add(item.recordTypeId);
    for (const application of item.affectedApplications) sharedApplications.add(application);
  }

  return {
    ownedRecords: items.length,
    transferable,
    refusedIncompatible,
    perRecordType: Array.from(perRecordType.values())
      .map((entry) => ({
        recordTypeId: entry.recordTypeId,
        storageScope: entry.storageScope,
        transferable: entry.transferable,
        refusedIncompatible: entry.refusedIncompatible,
        total: entry.transferable + entry.refusedIncompatible,
        affectedApplications: Array.from(entry.affectedApplications).sort(),
      }))
      .sort((left, right) => left.recordTypeId.localeCompare(right.recordTypeId)),
    perApplication: Array.from(perApplication.values())
      .map((entry) => ({
        applicationRootId: entry.applicationRootId,
        transferable: entry.transferable,
        refusedIncompatible: entry.refusedIncompatible,
        total: entry.transferable + entry.refusedIncompatible,
      }))
      .sort((left, right) => left.applicationRootId.localeCompare(right.applicationRootId)),
    sharedImpact: {
      affectedApplications: Array.from(sharedApplications).sort(),
      sharedRecords,
      transferable: sharedTransferable,
      refusedIncompatible: sharedRefusedIncompatible,
      recordTypeIds: Array.from(sharedRecordTypeIds).sort(),
    },
  };
};

const cursorFor = (
  sectionKind: OffboardingSectionKind,
  next: OffboardingInventorySection["next"],
): OffboardingInventoryCursor | undefined =>
  next === undefined
    ? undefined
    : { sectionKind, storageContractId: next.storageContractId, recordId: next.recordId };

const executeListOffboardingOwnedRecords = async (
  transaction: RequestDatabaseTransaction,
  query: unknown,
): Promise<OffboardingInventoryResult> => {
  const selector = readInventorySelector(query);
  const { sectionKind, after, limit } = selector;

  try {
    const items: OffboardingOwnedRecordItem[] = [];
    let cursor: OffboardingInventoryCursor | undefined;
    let accessVersion: number;

    if (sectionKind !== "all" || after?.sectionKind === "organization_shared") {
      // One section, addressed by its own keyset.
      const only: OffboardingSectionKind =
        sectionKind === "all" ? "organization_shared" : sectionKind;
      const section = await querySqlSection(
        transaction,
        selector,
        only,
        after?.storageContractId ?? null,
        after?.recordId ?? null,
        limit,
      );
      accessVersion = section.accessVersion;
      items.push(...section.items);
      cursor = cursorFor(only, section.next);
    } else {
      // `all` walks the application section first and the shared section after
      // it, so every disclosed record is reached exactly once across the pages.
      const application = await querySqlSection(
        transaction,
        selector,
        "application",
        after?.storageContractId ?? null,
        after?.recordId ?? null,
        limit,
      );
      accessVersion = application.accessVersion;
      items.push(...application.items);

      if (application.next !== undefined) {
        cursor = cursorFor("application", application.next);
      } else if (application.items.length >= limit) {
        // The page is full and the application section is finished, so the
        // shared section starts at its own beginning on the next page.
        cursor = { sectionKind: "organization_shared" };
      } else {
        const shared = await querySqlSection(
          transaction,
          selector,
          "organization_shared",
          null,
          null,
          limit - application.items.length,
        );
        // Both reads run in one transaction under one admitted scope, so a
        // divergent access version means the response cannot be attributed to a
        // single authorisation state.
        if (shared.accessVersion !== accessVersion) invalidResult();
        items.push(...shared.items);
        cursor = cursorFor("organization_shared", shared.next);
      }
    }

    // The two sections address disjoint storage, so a repeat is a defect in the
    // protected read rather than something to conceal by discarding a row.
    const seen = new Set<string>();
    for (const item of items) {
      const identity = `${item.storageContractId}:${item.recordId}`;
      if (seen.has(identity)) invalidResult();
      seen.add(identity);
    }

    return {
      outcome: "listed",
      accessVersion,
      items,
      page: summarizeInventoryPage(items),
      complete: cursor === undefined,
      ...(cursor === undefined ? {} : { next: { ...cursor, token: encodeCursor(cursor) } }),
    };
  } catch (error) {
    if (error instanceof OrganizationAccountError) throw error;
    throw mapStorageFailure(error);
  }
};

const transferBatchItem = async (
  transaction: RequestDatabaseTransaction,
  batchCommandId: string,
  selector: OffboardingInventorySelector,
  accessVersion: number,
  item: OffboardingOwnedRecordItem,
): Promise<OffboardingTransferBatchRecordResult> => {
  const base = {
    storageContractId: item.storageContractId,
    recordTypeId: item.recordTypeId,
    recordId: item.recordId,
  } as const;

  // The inventory already records why this item is incompatible. In particular,
  // Group targets and removal-pending rows never enter the mutable path.
  if (item.classification !== "transferable") return { ...base, outcome: "refused" };

  const commandId = derivedBatchItemId(batchCommandId, item, "command");
  const activityId = derivedBatchItemId(batchCommandId, item, "activity");
  const occurrenceId = derivedBatchItemId(batchCommandId, item, "occurrence");

  // One protected ownership action with two entries. Its retained/offboarding
  // path exists for a retained row or a disabled installation and refuses an
  // ordinary active record of an active installation, so the batch routes each
  // disclosed record to the entry that owns it. The disclosed facts choose the
  // entry and nothing else: each entry independently reloads lifecycle,
  // installation, ownership, authority, target and revision, so a route that no
  // longer matches the stored row refuses instead of transferring it.
  const rows =
    item.installationState === "active" && item.lifecycleState === "active"
      ? await transaction.query<OffboardingTransferSqlRow>`
          select vortex_record.transfer_offboarding_active_owned_record(
            ${commandId}::uuid,
            ${item.recordTypeId}::uuid,
            ${item.recordId}::uuid,
            ${item.concurrencyNumber}::bigint,
            ${selector.targetKind}::text,
            ${selector.targetId}::uuid,
            ${activityId}::uuid,
            ${occurrenceId}::uuid,
            ${accessVersion}::bigint
          ) as result
        `
      : await transaction.query<OffboardingTransferSqlRow>`
          select vortex_record.transfer_offboarding_owned_record(
            ${commandId}::uuid,
            ${item.recordTypeId}::uuid,
            ${item.recordId}::uuid,
            ${item.concurrencyNumber}::bigint,
            ${selector.targetKind}::text,
            ${selector.targetId}::uuid,
            ${activityId}::uuid,
            ${occurrenceId}::uuid,
            ${selector.sourceOrganizationAccountId}::uuid,
            ${accessVersion}::bigint
          ) as result
        `;
  const raw = requireOne(rows).result;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalidResult();
  const result = raw as Record<string, unknown>;

  if (result.outcome === "transferred") {
    if (resultUuid(result.recordId) !== item.recordId) invalidResult();
    return {
      ...base,
      outcome: "completed",
      concurrencyNumber: resultStoredInteger(result.concurrencyNumber),
    };
  }
  if (result.outcome === "conflict") {
    return {
      ...base,
      outcome: "conflicted",
      ...(result.concurrencyNumber === undefined
        ? {}
        : { concurrencyNumber: resultStoredInteger(result.concurrencyNumber) }),
    };
  }
  if (result.outcome === "refused" || result.outcome === "refused_recorded")
    return { ...base, outcome: "refused" };
  return invalidResult();
};

const executeTransferOffboardingOwnedRecords = async (
  transaction: RequestDatabaseTransaction,
  command: unknown,
): Promise<OffboardingTransferBatchResult> => {
  const batch = readTransferBatchSelector(command);
  const selector = readInventorySelector(command);

  try {
    // Read a single bounded #563 page first. Each protected entry below
    // re-admits the offboarding scope and this page's access version for every
    // mutable item, while the fixed operation behind it rechecks installation,
    // lifecycle, ownership, transfer authority, target state and this exact
    // expected revision. Nothing outside this disclosed page is touched.
    const inventory = await executeListOffboardingOwnedRecords(transaction, command);
    const items: OffboardingTransferBatchRecordResult[] = [];
    for (const item of inventory.items) {
      items.push(
        await transferBatchItem(
          transaction,
          batch.commandId,
          selector,
          inventory.accessVersion,
          item,
        ),
      );
    }
    return {
      outcome: "processed",
      accessVersion: inventory.accessVersion,
      items,
      complete: inventory.complete,
      ...(inventory.next === undefined ? {} : { next: inventory.next }),
    };
  } catch (error) {
    if (error instanceof OrganizationAccountError) throw error;
    throw mapStorageFailure(error);
  }
};

interface BeginClosingSqlRow extends DatabaseRow {
  readonly organization_account_id: unknown;
  readonly organization_id: unknown;
  readonly state: unknown;
  readonly closing_at: unknown;
  readonly revision: unknown;
  readonly access_version: unknown;
}

const executeBeginOrganizationAccountClosing = async (
  transaction: RequestDatabaseTransaction,
  command: unknown,
): Promise<OrganizationAccountClosingResult> => {
  if (typeof command !== "object" || command === null || Array.isArray(command)) {
    invalidCommand();
  }
  const fields = command as Record<string, unknown>;
  const organizationAccountId = commandUuid(fields.organizationAccountId);
  const expectedRevision = commandRevision(fields.expectedRevision);

  try {
    await requireRequestIdentityNotDisabled(transaction);
    const rows = await transaction.query<BeginClosingSqlRow>`
      select *
      from vortex_access.begin_organization_account_closing_for_administration(
        ${organizationAccountId}::uuid,
        ${expectedRevision}::bigint
      )
    `;
    const row = requireOne(rows);
    if (resultMember(row.state, organizationAccountLifecycleStates) !== "closing") {
      invalidResult();
    }
    return {
      outcome: "closing",
      organizationAccountId: resultUuid(row.organization_account_id),
      organizationId: resultUuid(row.organization_id),
      state: "closing",
      revision: resultStoredInteger(row.revision),
      accessVersion: resultStoredInteger(row.access_version),
    };
  } catch (error) {
    if (error instanceof OrganizationAccountError) throw error;
    throw mapStorageFailure(error);
  }
};

interface FinalizeAccountDeletionSqlRow extends DatabaseRow {
  readonly result: unknown;
}

const executeFinalizeOrganizationAccountDeletion = async (
  transaction: RequestDatabaseTransaction,
  organizationAccountIdCandidate: unknown,
): Promise<AccountDeletionFenceResult> => {
  const organizationAccountId = commandUuid(organizationAccountIdCandidate);

  try {
    await requireRequestIdentityNotDisabled(transaction);
    const rows = await transaction.query<FinalizeAccountDeletionSqlRow>`
      select vortex_record.finalize_account_deletion_fence(
        ${organizationAccountId}::uuid
      ) as result
    `;
    const raw = requireOne(rows).result;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalidResult();
    const data = raw as Record<string, unknown>;
    const outcome = resultMember(data.outcome, accountDeletionFenceOutcomes);
    return {
      outcome,
      ...(data.organizationAccountId === undefined || data.organizationAccountId === null
        ? {}
        : { organizationAccountId: resultUuid(data.organizationAccountId) }),
      ...(data.state === undefined || data.state === null
        ? {}
        : { state: resultMember(data.state, organizationAccountLifecycleStates) }),
      ...(data.revision === undefined || data.revision === null
        ? {}
        : { revision: resultStoredInteger(data.revision) }),
      accessVersion: resultStoredInteger(data.accessVersion),
    };
  } catch (error) {
    if (error instanceof OrganizationAccountError) throw error;
    throw mapStorageFailure(error);
  }
};

const defaultStore = createOrganizationAccountStore();

export const ensureIdentityProjection = defaultStore.ensureIdentityProjection;
export const readIdentityProjection = defaultStore.readIdentityProjection;
export const createInvitationAfterAuthorization = defaultStore.createInvitationAfterAuthorization;
export const revokeInvitationAfterAuthorization = defaultStore.revokeInvitationAfterAuthorization;
export const listOffboardingOwnedRecords = defaultStore.listOffboardingOwnedRecords;
export const transferOffboardingOwnedRecords = defaultStore.transferOffboardingOwnedRecords;
export const beginOrganizationAccountClosing = defaultStore.beginOrganizationAccountClosing;
export const finalizeOrganizationAccountDeletion = defaultStore.finalizeOrganizationAccountDeletion;
