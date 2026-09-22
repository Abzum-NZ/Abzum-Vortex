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
  });
};

export type OffboardingInventoryTargetKind = "organization_account" | "group";
export type OffboardingInventorySectionKind = "application" | "organization_shared" | "all";

export interface OffboardingOwnedRecordItem {
  readonly storageContractId: string;
  readonly recordTypeId: string;
  readonly recordId: string;
  readonly concurrencyNumber: number;
  readonly lifecycleState: "active" | "soft_deleted" | "removal_pending";
  readonly installationState: "active" | "detached";
  readonly classification: "transferable" | "refused_incompatible";
  readonly storageScope: "application_contained" | "organization_shared";
  readonly affectedApplications: readonly string[];
}

export interface OffboardingRecordTypeCount {
  readonly recordTypeId: string;
  readonly storageScope: "application_contained" | "organization_shared";
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly total: number;
  readonly affectedApplications?: readonly string[];
}

export interface OffboardingApplicationCount {
  readonly applicationRootId: string;
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly total: number;
}

export interface OffboardingSharedImpact {
  readonly affectedApplications: readonly string[];
  readonly sharedRecordCount: number;
  readonly transferable: number;
  readonly refusedIncompatible: number;
  readonly recordTypeIds: readonly string[];
}

export interface OffboardingInventoryCursor {
  readonly sectionKind: "application" | "organization_shared";
  readonly storageContractId?: string;
  readonly recordId?: string;
}

export interface OffboardingInventoryQuery {
  readonly sourceOrganizationAccountId: string;
  readonly targetKind: OffboardingInventoryTargetKind;
  readonly targetId: string;
  readonly sectionKind?: OffboardingInventorySectionKind;
  readonly after?: OffboardingInventoryCursor | string;
  readonly limit?: number;
}

export interface OffboardingInventoryResult {
  readonly outcome: "listed";
  readonly accessVersion: number;
  readonly items: readonly OffboardingOwnedRecordItem[];
  readonly perRecordType: readonly OffboardingRecordTypeCount[];
  readonly perApplication: readonly OffboardingApplicationCount[];
  readonly sharedImpact: OffboardingSharedImpact;
  readonly summary: {
    readonly totalOwned: number;
    readonly transferable: number;
    readonly refusedIncompatible: number;
  };
  readonly next?: OffboardingInventoryCursor & { readonly token: string };
}

interface OffboardingInventorySqlRow extends DatabaseRow {
  readonly result: unknown;
}

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";

const encodeCursor = (cursor: OffboardingInventoryCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeCursor = (
  after: OffboardingInventoryCursor | string | undefined,
): OffboardingInventoryCursor | undefined => {
  if (after === undefined || after === null) return undefined;
  if (typeof after === "object") {
    if (
      after.sectionKind !== "application" &&
      after.sectionKind !== "organization_shared"
    ) {
      throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
    }
    if (after.storageContractId !== undefined && !isUuid(after.storageContractId)) {
      throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
    }
    if (after.recordId !== undefined && !isUuid(after.recordId)) {
      throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
    }
    if ((after.storageContractId === undefined) !== (after.recordId === undefined)) {
      throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
    }
    return {
      sectionKind: after.sectionKind,
      storageContractId: after.storageContractId,
      recordId: after.recordId,
    };
  }
  if (typeof after === "string") {
    const trimmed = after.trim();
    if (trimmed.length === 0) return undefined;
    try {
      const jsonStr = Buffer.from(trimmed, "base64url").toString("utf8");
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      return decodeCursor(parsed as unknown as OffboardingInventoryCursor);
    } catch {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        return decodeCursor(parsed as unknown as OffboardingInventoryCursor);
      } catch {
        throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
      }
    }
  }
  throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
};

const validateOffboardingInventoryQuery = (query: unknown): OffboardingInventoryQuery => {
  if (typeof query !== "object" || query === null) {
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  }
  const q = query as Record<string, unknown>;
  if (!isUuid(q.sourceOrganizationAccountId)) {
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  }
  if (q.targetKind !== "organization_account" && q.targetKind !== "group") {
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  }
  if (!isUuid(q.targetId)) {
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
  }
  const sectionKind: OffboardingInventorySectionKind =
    q.sectionKind === undefined || q.sectionKind === "all"
      ? "all"
      : q.sectionKind === "application"
        ? "application"
        : q.sectionKind === "organization_shared"
          ? "organization_shared"
          : (() => {
              throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
            })();

  let limit = 50;
  if (q.limit !== undefined) {
    if (typeof q.limit !== "number" || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 50) {
      throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_COMMAND");
    }
    limit = q.limit;
  }

  const after = decodeCursor(q.after as OffboardingInventoryCursor | string | undefined);

  return {
    sourceOrganizationAccountId: q.sourceOrganizationAccountId,
    targetKind: q.targetKind,
    targetId: q.targetId,
    sectionKind,
    after,
    limit,
  };
};

const querySqlSection = async (
  transaction: RequestDatabaseTransaction,
  sourceOrganizationAccountId: string,
  targetKind: "organization_account" | "group",
  targetId: string,
  sectionKind: "application" | "organization_shared",
  afterContractId: string | null,
  afterRecordId: string | null,
  limit: number,
): Promise<{
  readonly outcome: string;
  readonly section: { readonly kind: string; readonly applicationRootId?: string };
  readonly installationState?: string;
  readonly items: readonly OffboardingOwnedRecordItem[];
  readonly affectedApplications: readonly string[];
  readonly next?: { readonly storageContractId: string; readonly recordId: string };
  readonly accessVersion: number;
}> => {
  const rows = await transaction.query<OffboardingInventorySqlRow>`
    select vortex_record.list_offboarding_owned_records(
      ${sourceOrganizationAccountId}::uuid,
      ${targetKind}::text,
      ${targetId}::uuid,
      ${sectionKind}::text,
      ${afterContractId}::uuid,
      ${afterRecordId}::uuid,
      ${limit}::integer
    ) as result
  `;
  const row = requireOne(rows);
  const raw = row.result;
  if (typeof raw !== "object" || raw === null) {
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  }
  const data = raw as Record<string, unknown>;
  if (data.outcome !== "listed") {
    throw new OrganizationAccountError("INVALID_ORGANIZATION_ACCOUNT_STORAGE_RESULT");
  }
  const rawSection = (data.section ?? {}) as Record<string, unknown>;
  const sectionKindReturned = String(rawSection.kind ?? sectionKind);
  const applicationRootId =
    typeof rawSection.applicationRootId === "string" ? rawSection.applicationRootId : undefined;
  const rawInstallationState =
    data.installationState === "detached" ? "detached" : "active";
  const accessVersion =
    typeof data.accessVersion === "number"
      ? data.accessVersion
      : typeof data.accessVersion === "bigint" || typeof data.accessVersion === "string"
        ? Number(data.accessVersion)
        : 1;

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items: OffboardingOwnedRecordItem[] = rawItems.map((itemRaw) => {
    const item = (typeof itemRaw === "object" && itemRaw !== null ? itemRaw : {}) as Record<
      string,
      unknown
    >;
    const storageScope: "application_contained" | "organization_shared" =
      item.storageScope === "organization_shared" || sectionKindReturned === "organization_shared"
        ? "organization_shared"
        : "application_contained";
    const affectedApps: string[] = Array.isArray(item.affectedApplications)
      ? (item.affectedApplications as unknown[]).filter((a): a is string => typeof a === "string")
      : storageScope === "application_contained" && applicationRootId
        ? [applicationRootId]
        : [];
    const classification: "transferable" | "refused_incompatible" =
      item.classification === "transferable" ? "transferable" : "refused_incompatible";
    const lifecycleState: "active" | "soft_deleted" | "removal_pending" =
      item.lifecycleState === "soft_deleted"
        ? "soft_deleted"
        : item.lifecycleState === "removal_pending"
          ? "removal_pending"
          : "active";
    const installationState: "active" | "detached" =
      item.installationState === "detached" ? "detached" : rawInstallationState;

    return {
      storageContractId: String(item.storageContractId),
      recordTypeId: String(item.recordTypeId),
      recordId: String(item.recordId),
      concurrencyNumber: Number(item.concurrencyNumber ?? 1),
      lifecycleState,
      installationState,
      classification,
      storageScope,
      affectedApplications: affectedApps,
    };
  });

  const rawNext =
    typeof data.next === "object" && data.next !== null
      ? (data.next as Record<string, unknown>)
      : undefined;
  const next =
    rawNext && typeof rawNext.storageContractId === "string" && typeof rawNext.recordId === "string"
      ? {
          storageContractId: rawNext.storageContractId,
          recordId: rawNext.recordId,
        }
      : undefined;

  const rawAffectedApps = Array.isArray(data.affectedApplications)
    ? (data.affectedApplications as unknown[]).filter((a): a is string => typeof a === "string")
    : [];

  return {
    outcome: "listed",
    section: {
      kind: sectionKindReturned,
      ...(applicationRootId ? { applicationRootId } : {}),
    },
    installationState: rawInstallationState,
    items,
    affectedApplications: rawAffectedApps,
    ...(next ? { next } : {}),
    accessVersion,
  };
};

const executeListOffboardingOwnedRecords = async (
  transaction: RequestDatabaseTransaction,
  rawQuery: OffboardingInventoryQuery,
): Promise<OffboardingInventoryResult> => {
  const query = validateOffboardingInventoryQuery(rawQuery);
  const { sourceOrganizationAccountId, targetKind, targetId, sectionKind, after, limit } = query;

  try {
    let combinedItems: OffboardingOwnedRecordItem[] = [];
    let nextCursor: OffboardingInventoryCursor | undefined;
    let accessVersion = 1;

    if (sectionKind === "application") {
      const result = await querySqlSection(
        transaction,
        sourceOrganizationAccountId,
        targetKind,
        targetId,
        "application",
        after?.storageContractId ?? null,
        after?.recordId ?? null,
        limit,
      );
      accessVersion = result.accessVersion;
      combinedItems = [...result.items];
      if (result.next) {
        nextCursor = {
          sectionKind: "application",
          storageContractId: result.next.storageContractId,
          recordId: result.next.recordId,
        };
      }
    } else if (sectionKind === "organization_shared") {
      const result = await querySqlSection(
        transaction,
        sourceOrganizationAccountId,
        targetKind,
        targetId,
        "organization_shared",
        after?.storageContractId ?? null,
        after?.recordId ?? null,
        limit,
      );
      accessVersion = result.accessVersion;
      combinedItems = [...result.items];
      if (result.next) {
        nextCursor = {
          sectionKind: "organization_shared",
          storageContractId: result.next.storageContractId,
          recordId: result.next.recordId,
        };
      }
    } else {
      // sectionKind === "all"
      if (after?.sectionKind === "organization_shared") {
        const result = await querySqlSection(
          transaction,
          sourceOrganizationAccountId,
          targetKind,
          targetId,
          "organization_shared",
          after.storageContractId ?? null,
          after.recordId ?? null,
          limit,
        );
        accessVersion = result.accessVersion;
        combinedItems = [...result.items];
        if (result.next) {
          nextCursor = {
            sectionKind: "organization_shared",
            storageContractId: result.next.storageContractId,
            recordId: result.next.recordId,
          };
        }
      } else {
        // after is application or start
        const appResult = await querySqlSection(
          transaction,
          sourceOrganizationAccountId,
          targetKind,
          targetId,
          "application",
          after?.storageContractId ?? null,
          after?.recordId ?? null,
          limit,
        );
        accessVersion = appResult.accessVersion;
        combinedItems = [...appResult.items];

        if (appResult.next) {
          nextCursor = {
            sectionKind: "application",
            storageContractId: appResult.next.storageContractId,
            recordId: appResult.next.recordId,
          };
        } else if (appResult.items.length >= limit) {
          nextCursor = {
            sectionKind: "organization_shared",
          };
        } else {
          // Application scope exhausted in this page; drain shared scope with remainder
          const remainingLimit = limit - appResult.items.length;
          const sharedResult = await querySqlSection(
            transaction,
            sourceOrganizationAccountId,
            targetKind,
            targetId,
            "organization_shared",
            null,
            null,
            remainingLimit,
          );
          accessVersion = sharedResult.accessVersion;
          combinedItems.push(...sharedResult.items);
          if (sharedResult.next) {
            nextCursor = {
              sectionKind: "organization_shared",
              storageContractId: sharedResult.next.storageContractId,
              recordId: sharedResult.next.recordId,
            };
          }
        }
      }
    }

    // Deduplicate items to guarantee each record is returned once
    const uniqueItems: OffboardingOwnedRecordItem[] = [];
    const seen = new Set<string>();
    for (const item of combinedItems) {
      if (!seen.has(item.recordId)) {
        seen.add(item.recordId);
        uniqueItems.push(item);
      }
    }

    // Compute perRecordType
    const recordTypeMap = new Map<
      string,
      {
        recordTypeId: string;
        storageScope: "application_contained" | "organization_shared";
        transferable: number;
        refusedIncompatible: number;
        affectedApplications: Set<string>;
      }
    >();

    for (const item of uniqueItems) {
      let entry = recordTypeMap.get(item.recordTypeId);
      if (!entry) {
        entry = {
          recordTypeId: item.recordTypeId,
          storageScope: item.storageScope,
          transferable: 0,
          refusedIncompatible: 0,
          affectedApplications: new Set<string>(),
        };
        recordTypeMap.set(item.recordTypeId, entry);
      }
      if (item.classification === "transferable") {
        entry.transferable++;
      } else {
        entry.refusedIncompatible++;
      }
      for (const appId of item.affectedApplications) {
        entry.affectedApplications.add(appId);
      }
    }

    const perRecordType: OffboardingRecordTypeCount[] = Array.from(recordTypeMap.values())
      .map((entry) => ({
        recordTypeId: entry.recordTypeId,
        storageScope: entry.storageScope,
        transferable: entry.transferable,
        refusedIncompatible: entry.refusedIncompatible,
        total: entry.transferable + entry.refusedIncompatible,
        affectedApplications: Array.from(entry.affectedApplications).sort(),
      }))
      .sort((a, b) => a.recordTypeId.localeCompare(b.recordTypeId));

    // Compute perApplication
    const applicationMap = new Map<
      string,
      {
        applicationRootId: string;
        transferable: number;
        refusedIncompatible: number;
      }
    >();

    for (const item of uniqueItems) {
      const isTransferable = item.classification === "transferable";
      for (const appId of item.affectedApplications) {
        let appEntry = applicationMap.get(appId);
        if (!appEntry) {
          appEntry = { applicationRootId: appId, transferable: 0, refusedIncompatible: 0 };
          applicationMap.set(appId, appEntry);
        }
        if (isTransferable) {
          appEntry.transferable++;
        } else {
          appEntry.refusedIncompatible++;
        }
      }
    }

    const perApplication: OffboardingApplicationCount[] = Array.from(applicationMap.values())
      .map((entry) => ({
        applicationRootId: entry.applicationRootId,
        transferable: entry.transferable,
        refusedIncompatible: entry.refusedIncompatible,
        total: entry.transferable + entry.refusedIncompatible,
      }))
      .sort((a, b) => a.applicationRootId.localeCompare(b.applicationRootId));

    // Compute sharedImpact
    const sharedItems = uniqueItems.filter((i) => i.storageScope === "organization_shared");
    const sharedAffectedApps = new Set<string>();
    const sharedRecordTypes = new Set<string>();
    let sharedTransferable = 0;
    let sharedRefusedIncompatible = 0;

    for (const item of sharedItems) {
      if (item.classification === "transferable") {
        sharedTransferable++;
      } else {
        sharedRefusedIncompatible++;
      }
      sharedRecordTypes.add(item.recordTypeId);
      for (const appId of item.affectedApplications) {
        sharedAffectedApps.add(appId);
      }
    }

    const sharedImpact: OffboardingSharedImpact = {
      affectedApplications: Array.from(sharedAffectedApps).sort(),
      sharedRecordCount: sharedItems.length,
      transferable: sharedTransferable,
      refusedIncompatible: sharedRefusedIncompatible,
      recordTypeIds: Array.from(sharedRecordTypes).sort(),
    };

    const summary = {
      totalOwned: uniqueItems.length,
      transferable: uniqueItems.filter((i) => i.classification === "transferable").length,
      refusedIncompatible: uniqueItems.filter((i) => i.classification === "refused_incompatible").length,
    };

    const next = nextCursor
      ? {
          ...nextCursor,
          token: encodeCursor(nextCursor),
        }
      : undefined;

    return {
      outcome: "listed",
      accessVersion,
      items: uniqueItems,
      perRecordType,
      perApplication,
      sharedImpact,
      summary,
      ...(next ? { next } : {}),
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
export const listOffboardingInventory = defaultStore.listOffboardingOwnedRecords;

