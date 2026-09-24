import "server-only";

import type {
  IdentitySession,
  OrganizationAccessDeclaration,
  OrganizationSelectionCandidate,
  SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import type { z } from "zod";
import {
  abandonPrivateFormDraftCommandSchema,
  createPrivateFormDraftCommandSchema,
  PrivateFormDraftError,
  privateFormDraftSchema,
  projectPrivateFormDraft,
  readPrivateFormDraftCommandSchema,
  restrictPrivateFormDraftInput,
  updatePrivateFormDraftCommandSchema,
  type AbandonPrivateFormDraftCommand,
  type CreatePrivateFormDraftCommand,
  type PrivateFormDraft,
  type PrivateFormDraftAbandonResult,
  type PrivateFormDraftCreateResult,
  type PrivateFormDraftProjection,
  type PrivateFormDraftReadResult,
  type PrivateFormDraftScope,
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
 * Values are stored and returned only through the server-owned projection of
 * the exact installed form.
 *
 * The session service derives that projection and the governing access
 * declaration on the server for every operation, from the exact form/flow/node
 * of the active installation, and re-evaluates current access before any value
 * is stored or returned.
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

const parseCommand = <Schema extends z.ZodType>(
  schema: Schema,
  candidate: unknown,
): z.infer<Schema> => {
  const command = schema.safeParse(candidate);
  if (!command.success)
    throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_COMMAND", { cause: command.error });
  return command.data;
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

const scopeArguments = (scope: PrivateFormDraftScope) =>
  [scope.flowId ?? null, scope.nodeId ?? null, scope.subjectRecordId ?? null] as const;

/**
 * Creates revision 1 holding only the permitted values, or reports `exists` when
 * a live draft already holds the exact scope.
 */
export const createPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: CreatePrivateFormDraftCommand,
  projection: PrivateFormDraftProjection,
): Promise<PrivateFormDraftCreateResult> => {
  const command = parseCommand(createPrivateFormDraftCommandSchema, commandCandidate);
  const input = restrictPrivateFormDraftInput(command, projection);
  const [flowId, nodeId, subjectRecordId] = scopeArguments(command);
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.create_private_form_draft(
          ${command.formId}::uuid,
          ${flowId}::uuid,
          ${nodeId}::uuid,
          ${subjectRecordId}::uuid,
          ${JSON.stringify(input.values)}::text::jsonb,
          ${JSON.stringify(input.validation)}::text::jsonb
        )
      `,
    );
    if (row.outcome === "exists") return { outcome: "exists" };
    if (row.outcome !== "created")
      throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
    return { outcome: "created", draft: projectPrivateFormDraft(parseDraft(row.result), projection) };
  });
};

/** Reads the exact live draft and projects it through the permitted fields and choices. */
export const readPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: ReadPrivateFormDraftCommand,
  projection: PrivateFormDraftProjection,
): Promise<PrivateFormDraftReadResult> => {
  const command = parseCommand(readPrivateFormDraftCommandSchema, commandCandidate);
  const [flowId, nodeId, subjectRecordId] = scopeArguments(command);
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.read_private_form_draft(
          ${command.formId}::uuid,
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
      draft: projectPrivateFormDraft(parseDraft(row.result), projection),
    };
  });
};

/**
 * Compare-and-updates one draft at its exact current revision with only the
 * permitted values; a stale revision is refused.
 */
export const updatePrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: UpdatePrivateFormDraftCommand,
  projection: PrivateFormDraftProjection,
): Promise<PrivateFormDraftUpdateResult> => {
  const command = parseCommand(updatePrivateFormDraftCommandSchema, commandCandidate);
  const input = restrictPrivateFormDraftInput(command, projection);
  const [flowId, nodeId, subjectRecordId] = scopeArguments(command);
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.update_private_form_draft(
          ${command.draftId}::uuid,
          ${command.expectedRevision}::bigint,
          ${command.formId}::uuid,
          ${flowId}::uuid,
          ${nodeId}::uuid,
          ${subjectRecordId}::uuid,
          ${JSON.stringify(input.values)}::text::jsonb,
          ${JSON.stringify(input.validation)}::text::jsonb
        )
      `,
    );
    if (row.outcome === "unavailable") return { outcome: "unavailable" };
    if (row.outcome === "stale_revision") return { outcome: "stale_revision" };
    if (row.outcome === "stale_installation") return { outcome: "stale_installation" };
    if (row.outcome !== "updated")
      throw new PrivateFormDraftError("INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT");
    return { outcome: "updated", draft: projectPrivateFormDraft(parseDraft(row.result), projection) };
  });
};

/** Abandons and deletes exactly the owned live draft at its expected revision; no values are returned. */
export const abandonPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: AbandonPrivateFormDraftCommand,
): Promise<PrivateFormDraftAbandonResult> => {
  const command = parseCommand(abandonPrivateFormDraftCommandSchema, commandCandidate);
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_page.abandon_private_form_draft(
          ${command.draftId}::uuid,
          ${command.expectedRevision}::bigint
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

/** Deletes at most `limit` of the current organisation's untouched expired drafts. */
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

/**
 * What the server currently allows for one exact installed form: the access
 * declaration that governs filling it and the projection of fields and choices
 * the person may store and read back now.
 */
export type PrivateFormDraftAuthority = Readonly<{
  access: OrganizationAccessDeclaration;
  projection: PrivateFormDraftProjection;
}>;

/**
 * Server-side source of draft authority. It resolves the exact form, flow and
 * node from the active installed release of the request's application, inside
 * the same protected transaction, and returns `undefined` when that release
 * does not declare them, so a draft is never resumed against a changed form.
 */
export interface PrivateFormDraftAuthorityAdapter {
  load(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    form: PrivateFormDraftScope,
  ): Promise<PrivateFormDraftAuthority | undefined>;
}

export type PrivateFormDraftServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ authority: PrivateFormDraftAuthorityAdapter }>;

const formScope = (command: PrivateFormDraftScope): PrivateFormDraftScope => ({
  formId: command.formId,
  ...(command.flowId === undefined ? {} : { flowId: command.flowId }),
  ...(command.nodeId === undefined ? {} : { nodeId: command.nodeId }),
  ...(command.subjectRecordId === undefined ? {} : { subjectRecordId: command.subjectRecordId }),
});

/**
 * Lets the protected request classify a storage refusal exactly as it does for
 * every other service: an access or scope refusal is `unavailable`, anything
 * else is `temporarily_unavailable`, and no database detail reaches the caller.
 */
const asProtectedRequest = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof PrivateFormDraftError &&
      error.code === "PRIVATE_FORM_DRAFT_SCOPE_UNAVAILABLE" &&
      error.cause !== undefined
    )
      throw error.cause;
    throw error;
  }
};

/**
 * Session-facing service. Every operation validates its command before any
 * request is opened, verifies the session and application selection, derives
 * the exact form authority on the server, re-establishes current access, and
 * only then runs the storage-bound repository under that same protected request.
 */
export const createPrivateFormDraftService = (
  dependencies: PrivateFormDraftServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);

  const withAuthority = async <Result>(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    form: PrivateFormDraftScope,
    unavailable: Result,
    operation: (projection: PrivateFormDraftProjection) => Promise<Result>,
  ): Promise<Result> => {
    const authority = await dependencies.authority.load(transaction, scope, formScope(form));
    if (authority === undefined) return unavailable;
    const checked = await runOrganizationAccessOperation(
      transaction,
      scope,
      authority.access,
      async () => true,
    );
    if (checked.outcome !== "completed") return unavailable;
    return asProtectedRequest(() => operation(authority.projection));
  };

  return Object.freeze({
    async create(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: CreatePrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftCreateResult>> {
      const command = parseCommand(createPrivateFormDraftCommandSchema, commandCandidate);
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.runChange(session, selection, (transaction, scope) =>
        withAuthority<PrivateFormDraftCreateResult>(
          transaction,
          scope,
          command,
          { outcome: "unavailable" },
          (projection) => createPrivateFormDraft(transaction, command, projection),
        ),
      );
    },
    async read(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: ReadPrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftReadResult>> {
      const command = parseCommand(readPrivateFormDraftCommandSchema, commandCandidate);
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.run(session, selection, (transaction, scope) =>
        withAuthority<PrivateFormDraftReadResult>(
          transaction,
          scope,
          command,
          { outcome: "unavailable" },
          (projection) => readPrivateFormDraft(transaction, command, projection),
        ),
      );
    },
    async update(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: UpdatePrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftUpdateResult>> {
      const command = parseCommand(updatePrivateFormDraftCommandSchema, commandCandidate);
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.runChange(session, selection, (transaction, scope) =>
        withAuthority<PrivateFormDraftUpdateResult>(
          transaction,
          scope,
          command,
          { outcome: "unavailable" },
          (projection) => updatePrivateFormDraft(transaction, command, projection),
        ),
      );
    },
    /**
     * Abandoning deletes the person's own draft and returns no values, so it
     * needs only the verified request, not current form access: a person can
     * always discard their own input, even after access or the form changed.
     */
    async abandon(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: AbandonPrivateFormDraftCommand,
    ): Promise<HumanOrganizationRequestResult<PrivateFormDraftAbandonResult>> {
      const command = parseCommand(abandonPrivateFormDraftCommandSchema, commandCandidate);
      if (selection.applicationRootId === undefined) return { kind: "unavailable" };
      return requests.runChange(session, selection, (transaction) =>
        asProtectedRequest(() => abandonPrivateFormDraft(transaction, command)),
      );
    },
  });
};
