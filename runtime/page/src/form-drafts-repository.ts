import "server-only";

import {
  organizationAccessDeclarationSchema,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  abandonPrivateFormDraftCommandSchema,
  createPrivateFormDraftCommandSchema,
  PrivateFormDraftError,
  privateFormDraftSchema,
  projectPrivateFormDraft,
  readPrivateFormDraftCommandSchema,
  updatePrivateFormDraftCommandSchema,
  type AbandonPrivateFormDraftCommand,
  type CreatePrivateFormDraftCommand,
  type PrivateFormDraft,
  type PrivateFormDraftAbandonResult,
  type PrivateFormDraftCreateResult,
  type PrivateFormDraftReadResult,
  type PrivateFormDraftUpdateResult,
  type ReadPrivateFormDraftCommand,
  type UpdatePrivateFormDraftCommand,
} from "./form-drafts";

/**
 * #587: storage-bound repository and session service for private form drafts.
 *
 * The repository functions run inside an already established protected request
 * transaction, so the organisation, identity, organisation account and active
 * installation always come from the validated request context. A caller never
 * supplies them, which is what keeps one person out of another person's draft.
 *
 * The session service additionally re-evaluates the exact current access
 * declaration on every operation, so a resume after access was reduced returns
 * no values, and it reads the active installation again so a draft bound to a
 * different installed release is refused instead of silently resumed.
 */

type DraftResultRow = DatabaseRow & { outcome: unknown; result: unknown };

const requireOne = <Row extends DatabaseRow>(rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
  return rows[0];
};

const parseDraft = (value: unknown): PrivateFormDraft => {
  const parsed = privateFormDraftSchema.safeParse(value);
  if (!parsed.success)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT", {
      cause: parsed.error,
    });
  return parsed.data;
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapStorageFailure = (error: unknown): PrivateFormDraftError => {
  const code = databaseCode(error);
  if (code === "22023")
    return new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND", { cause: error });
  if (code === "42501" || code === "P0002" || code === "55000")
    return new PrivateFormDraftError("PRIVATE_FORM_DRAFT_SCOPE_UNAVAILABLE", { cause: error });
  if (code === "23505")
    return new PrivateFormDraftError("PRIVATE_FORM_DRAFT_ALREADY_EXISTS", { cause: error });
  if (code === "V3102")
    return new PrivateFormDraftError("PRIVATE_FORM_DRAFT_REVISION_STALE", { cause: error });
  if (code === "V3103")
    return new PrivateFormDraftError("PRIVATE_FORM_DRAFT_INSTALLATION_STALE", { cause: error });
  return new PrivateFormDraftError("PRIVATE_FORM_DRAFT_OPERATION_FAILED", { cause: error });
};

const runStorage = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PrivateFormDraftError) throw error;
    throw mapStorageFailure(error);
  }
};

const scopeArguments = (
  flowId: string | undefined,
  nodeId: string | undefined,
  subjectRecordId: string | undefined,
) => [flowId ?? null, nodeId ?? null, subjectRecordId ?? null] as const;

/** Creates revision 1, or reports `exists` when an active draft already holds the exact scope. */
export const createPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CreatePrivateFormDraftCommand,
): Promise<PrivateFormDraftCreateResult> => {
  const command = createPrivateFormDraftCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND", { cause: command.error });
  const [flowId, nodeId, subjectRecordId] = scopeArguments(
    command.data.flowId,
    command.data.nodeId,
    command.data.subjectRecordId,
  );
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.create_private_form_draft(
          ${command.data.formId}::uuid,
          ${flowId}::uuid,
          ${nodeId}::uuid,
          ${subjectRecordId}::uuid,
          ${JSON.stringify(command.data.values)}::text::jsonb,
          ${JSON.stringify(command.data.validation)}::text::jsonb
        )
      `,
    );
    if (row.outcome === "exists") return { outcome: "exists" };
    if (row.outcome !== "created")
      throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
    return { outcome: "created", draft: parseDraft(row.result) };
  });
};

/** Reads the exact active draft and projects it through the permitted fields and choices. */
export const readPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReadPrivateFormDraftCommand,
): Promise<PrivateFormDraftReadResult> => {
  const command = readPrivateFormDraftCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND", { cause: command.error });
  const [flowId, nodeId, subjectRecordId] = scopeArguments(
    command.data.flowId,
    command.data.nodeId,
    command.data.subjectRecordId,
  );
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.read_private_form_draft(
          ${command.data.formId}::uuid,
          ${flowId}::uuid,
          ${nodeId}::uuid,
          ${subjectRecordId}::uuid
        )
      `,
    );
    if (row.outcome === "unavailable") return { outcome: "unavailable" };
    if (row.outcome === "stale_installation") return { outcome: "stale_installation" };
    if (row.outcome !== "available")
      throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
    return {
      outcome: "available",
      draft: projectPrivateFormDraft(parseDraft(row.result), command.data.projection),
    };
  });
};

/** Compare-and-updates one draft at its exact current revision; a stale revision is refused. */
export const updatePrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: UpdatePrivateFormDraftCommand,
): Promise<PrivateFormDraftUpdateResult> => {
  const command = updatePrivateFormDraftCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND", { cause: command.error });
  const [flowId, nodeId, subjectRecordId] = scopeArguments(
    command.data.flowId,
    command.data.nodeId,
    command.data.subjectRecordId,
  );
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.update_private_form_draft(
          ${command.data.draftId}::uuid,
          ${command.data.expectedRevision}::bigint,
          ${command.data.formId}::uuid,
          ${flowId}::uuid,
          ${nodeId}::uuid,
          ${subjectRecordId}::uuid,
          ${JSON.stringify(command.data.values)}::text::jsonb,
          ${JSON.stringify(command.data.validation)}::text::jsonb
        )
      `,
    );
    if (row.outcome === "unavailable") return { outcome: "unavailable" };
    if (row.outcome === "stale_revision") return { outcome: "stale_revision" };
    if (row.outcome === "stale_installation") return { outcome: "stale_installation" };
    if (row.outcome !== "updated")
      throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
    return { outcome: "updated", draft: parseDraft(row.result) };
  });
};

/** Abandons exactly the owned active draft at its expected revision. */
export const abandonPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: AbandonPrivateFormDraftCommand,
): Promise<PrivateFormDraftAbandonResult> => {
  const command = abandonPrivateFormDraftCommandSchema.safeParse(commandCandidate);
  if (!command.success)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND", { cause: command.error });
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.abandon_private_form_draft(
          ${command.data.draftId}::uuid,
          ${command.data.expectedRevision}::bigint
        )
      `,
    );
    if (row.outcome === "unavailable") return { outcome: "unavailable" };
    if (row.outcome === "stale_revision") return { outcome: "stale_revision" };
    if (row.outcome !== "abandoned")
      throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
    return { outcome: "abandoned", draft: parseDraft(row.result) };
  });
};

/** Expires at most `limit` untouched drafts. Runs without a human draft scope. */
export const expirePrivateFormDrafts = async (
  transaction: RequestDatabaseTransaction,
  limit = 500,
): Promise<number> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND");
  return runStorage(async () => {
    const rows = await transaction.query<DatabaseRow & { expired: unknown }>`
      select vortex_page.expire_private_form_drafts(${limit}::integer) as expired
    `;
    const expired = requireOne(rows).expired;
    if (typeof expired === "number") return expired;
    if (typeof expired === "string" && /^[0-9]+$/.test(expired)) return Number(expired);
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
  });
};

export type PrivateFormDraftServiceDependencies = HumanOrganizationRequestDependencies;

/**
 * Session-facing service. Every operation verifies the session and selection,
 * re-establishes the exact declared access, then runs the storage-bound
 * repository under that same protected request. `undefined` (or the explicit
 * refusal outcome) means current access refused the operation.
 */
export const createPrivateFormDraftService = (
  dependencies: PrivateFormDraftServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  const accessAllowed = async (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    accessCandidate: OrganizationAccessDeclaration,
  ): Promise<boolean> => {
    const access = organizationAccessDeclarationSchema.parse(accessCandidate);
    const checked = await runOrganizationAccessOperation(
      transaction,
      scope,
      access,
      async () => true,
    );
    return checked.outcome === "completed";
  };

  return Object.freeze({
    create: (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      access: OrganizationAccessDeclaration,
      command: CreatePrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftCreateResult>> =>
      requests.runChange<PrivateFormDraftCreateResult>(
        session,
        selection,
        async (transaction, scope) =>
          (await accessAllowed(transaction, scope, access))
            ? createPrivateFormDraft(transaction, command)
            : { outcome: "unavailable" },
      ),
    read: (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      access: OrganizationAccessDeclaration,
      command: ReadPrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftReadResult>> =>
      requests.run<PrivateFormDraftReadResult>(
        session,
        selection,
        async (transaction, scope) =>
          (await accessAllowed(transaction, scope, access))
            ? readPrivateFormDraft(transaction, command)
            : { outcome: "unavailable" },
      ),
    update: (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      access: OrganizationAccessDeclaration,
      command: UpdatePrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftUpdateResult>> =>
      requests.runChange<PrivateFormDraftUpdateResult>(
        session,
        selection,
        async (transaction, scope) =>
          (await accessAllowed(transaction, scope, access))
            ? updatePrivateFormDraft(transaction, command)
            : { outcome: "unavailable" },
      ),
    abandon: (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      access: OrganizationAccessDeclaration,
      command: AbandonPrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftAbandonResult>> =>
      requests.runChange<PrivateFormDraftAbandonResult>(
        session,
        selection,
        async (transaction, scope) =>
          (await accessAllowed(transaction, scope, access))
            ? abandonPrivateFormDraft(transaction, command)
            : { outcome: "unavailable" },
      ),
  });
};
