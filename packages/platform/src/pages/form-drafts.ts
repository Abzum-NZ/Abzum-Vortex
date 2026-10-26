import "server-only";
import { databaseCode } from "../catalogue/runtime-primitives";

import { z } from "zod";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import { runOrganizationAccessOperation } from "../access/organization-access-decision-access";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import type {
  IdentitySession,
  OrganizationSelectionCandidate,
  SelectedOrganizationScope,
} from "../access/identity-access";
import type { OrganizationAccessDeclaration } from "../access/organization-access-decision";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import {
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  fieldIdSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  revisionSchema,
  ruleIdSchema,
  timestampSchema,
  workflowNodeIdSchema,
} from "../catalogue/identifiers";

/**
 * #587: Page-owned private revisioned form drafts.
 *
 * A draft is one person's unfinished input for one exact form of one exact
 * installed application release. It is deliberately not a business record: it
 * creates no Record, Activity or event, and it is removed thirty days after its
 * last revision. The store is private to the person, so a draft can only be read
 * back by the organisation account that wrote it, while the browser and an
 * authorised MCP client share the one revision-checked contract.
 *
 * Values and validation state are stored as bounded JSON keyed by permanent
 * field identity or by the form's declared input key. Both are written and read
 * only through the server-owned projection of the fields and choices the page
 * layer currently permits, so an unpermitted or write-only field is never stored
 * and a stale field or choice never reaches a caller.
 */

/** An untouched draft is removed thirty days after its last revision. */
export const privateFormDraftRetentionDays = 30 as const;

/** Bounds that keep one draft a bounded personal scratch document. */
export const privateFormDraftLimits = Object.freeze({
  fields: 500,
  serializedBytes: 262_144,
  choicesPerField: 1_000,
});

/** A permanent field identity, or a record-free form input key. Field identities are lower case. */
export const privateFormDraftInputKeySchema = z
  .string()
  .refine(
    (key) => fieldIdSchema.safeParse(key).success || builderKeySchema.safeParse(key).success,
    { message: "A draft key is a permanent field identity or a declared form input key" },
  );

const normalizedKey = (key: string): string => key.toLowerCase();

/**
 * One field's safe validation state. Only a closed state and a bounded machine
 * reason code are stored, never a rendered message or raw server value.
 */
export const privateFormDraftFieldValidationSchema = z
  .object({
    state: z.enum(["valid", "invalid", "incomplete"]),
    reasonCode: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
  })
  .strict();

export type PrivateFormDraftFieldValidation = z.infer<typeof privateFormDraftFieldValidationSchema>;

const serializedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const privateFormDraftValuesSchema = z
  .record(privateFormDraftInputKeySchema, jsonValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > privateFormDraftLimits.fields)
      context.addIssue({
        code: "custom",
        message: "A draft carries at most the bounded number of fields",
      });
    if (serializedBytes(value) > privateFormDraftLimits.serializedBytes)
      context.addIssue({ code: "custom", message: "A draft value set is too large" });
  });

export const privateFormDraftValidationSchema = z
  .record(privateFormDraftInputKeySchema, privateFormDraftFieldValidationSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > privateFormDraftLimits.fields)
      context.addIssue({
        code: "custom",
        message: "A draft carries validation state for at most the bounded number of fields",
      });
  });

/** The exact identity of one unfinished form, before any value is stored. */
const privateFormDraftScopeShape = {
  formId: containedComponentIdSchema,
  flowId: ruleIdSchema.optional(),
  nodeId: workflowNodeIdSchema.optional(),
  subjectRecordId: recordIdSchema.optional(),
};

export const privateFormDraftScopeSchema = z.object(privateFormDraftScopeShape).strict();

export type PrivateFormDraftScope = z.infer<typeof privateFormDraftScopeSchema>;

export const privateFormDraftSchema = z
  .object({
    draftId: platformIdSchema,
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    identityId: identityIdSchema,
    applicationRootId: applicationRootIdSchema,
    installationReleaseRevision: revisionSchema,
    ...privateFormDraftScopeShape,
    revision: revisionSchema,
    values: z.record(privateFormDraftInputKeySchema, jsonValueSchema),
    validation: privateFormDraftValidationSchema,
    state: z.enum(["active", "abandoned"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export type PrivateFormDraft = z.infer<typeof privateFormDraftSchema>;

/**
 * The server-owned projection of one exact installed form: the fields the
 * current person may fill and read back now, and the choices each choice field
 * currently allows. It is derived on the server for every operation and is never
 * part of a caller's command. A write-only (secret) field is not listed, so its
 * value is neither stored in the draft nor returned.
 */
export const privateFormDraftProjectionSchema = z
  .object({
    permittedFieldIds: z.array(privateFormDraftInputKeySchema).max(privateFormDraftLimits.fields),
    fieldChoices: z
      .record(
        privateFormDraftInputKeySchema,
        z.array(jsonValueSchema).min(1).max(privateFormDraftLimits.choicesPerField),
      )
      .optional(),
  })
  .strict();

export type PrivateFormDraftProjection = z.infer<typeof privateFormDraftProjectionSchema>;

export const createPrivateFormDraftCommandSchema = privateFormDraftScopeSchema
  .extend({
    values: privateFormDraftValuesSchema,
    validation: privateFormDraftValidationSchema,
  })
  .strict();

export const readPrivateFormDraftCommandSchema = privateFormDraftScopeSchema;

export const updatePrivateFormDraftCommandSchema = privateFormDraftScopeSchema
  .extend({
    draftId: platformIdSchema,
    expectedRevision: revisionSchema,
    values: privateFormDraftValuesSchema,
    validation: privateFormDraftValidationSchema,
  })
  .strict();

export const abandonPrivateFormDraftCommandSchema = z
  .object({ draftId: platformIdSchema, expectedRevision: revisionSchema })
  .strict();

export type CreatePrivateFormDraftCommand = z.infer<typeof createPrivateFormDraftCommandSchema>;
export type ReadPrivateFormDraftCommand = z.infer<typeof readPrivateFormDraftCommandSchema>;
export type UpdatePrivateFormDraftCommand = z.infer<typeof updatePrivateFormDraftCommandSchema>;
export type AbandonPrivateFormDraftCommand = z.infer<typeof abandonPrivateFormDraftCommandSchema>;

export type PrivateFormDraftCreateResult =
  | Readonly<{ outcome: "created"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "exists" }>
  | Readonly<{ outcome: "unavailable" }>;

export type PrivateFormDraftReadResult =
  | Readonly<{ outcome: "available"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "stale_installation" }>
  | Readonly<{ outcome: "unavailable" }>;

export type PrivateFormDraftUpdateResult =
  | Readonly<{ outcome: "updated"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "stale_revision" }>
  | Readonly<{ outcome: "stale_installation" }>
  | Readonly<{ outcome: "unavailable" }>;

export type PrivateFormDraftAbandonResult =
  | Readonly<{ outcome: "abandoned"; draft: PrivateFormDraft }>
  | Readonly<{ outcome: "stale_revision" }>
  | Readonly<{ outcome: "unavailable" }>;

export const privateFormDraftErrorCodes = [
  "INVALID_PRIVATE_FORM_DRAFT_COMMAND",
  "INVALID_PRIVATE_FORM_DRAFT_STORAGE_RESULT",
  "PRIVATE_FORM_DRAFT_SCOPE_UNAVAILABLE",
  "PRIVATE_FORM_DRAFT_OPERATION_FAILED",
] as const;

export type PrivateFormDraftErrorCode = (typeof privateFormDraftErrorCodes)[number];

export class PrivateFormDraftError extends Error {
  readonly code: PrivateFormDraftErrorCode;

  constructor(code: PrivateFormDraftErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "PrivateFormDraftError";
    this.code = code;
  }
}

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

type ProjectedField = Readonly<{ keep: boolean; changed: boolean; value: JsonValue }>;

const projectField = (
  value: JsonValue,
  choices: readonly JsonValue[] | undefined,
): ProjectedField => {
  if (choices === undefined) return { keep: true, changed: false, value };
  if (Array.isArray(value)) {
    const allowed = value.filter((part) => choices.some((choice) => sameJson(choice, part)));
    return { keep: true, changed: allowed.length !== value.length, value: allowed };
  }
  return choices.some((choice) => sameJson(choice, value))
    ? { keep: true, changed: false, value }
    : { keep: false, changed: true, value };
};

/**
 * Restricts one value set and its validation state to the exact permitted
 * fields and choices. An unpermitted field is omitted, a value outside a
 * permitted choice list is dropped, and validation is kept only for a permitted
 * field whose value the projection left unchanged, so a stale "valid" state
 * never describes a value the caller no longer sees. Keys come back normalised.
 */
export const restrictPrivateFormDraftInput = (
  input: Readonly<{
    values: Readonly<Record<string, JsonValue>>;
    validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>;
  }>,
  projectionCandidate: PrivateFormDraftProjection,
): Readonly<{
  values: Record<string, JsonValue>;
  validation: Record<string, PrivateFormDraftFieldValidation>;
}> => {
  const parsed = privateFormDraftProjectionSchema.safeParse(projectionCandidate);
  if (!parsed.success)
    throw new PrivateFormDraftError("PRIVATE_FORM_DRAFT_OPERATION_FAILED", { cause: parsed.error });
  const projection = parsed.data;
  const permitted = new Set(projection.permittedFieldIds.map(normalizedKey));
  const choicesByField = new Map(
    Object.entries(projection.fieldChoices ?? {}).map(
      ([fieldId, choices]) => [normalizedKey(fieldId), choices] as const,
    ),
  );

  const values: Record<string, JsonValue> = {};
  const changed = new Set<string>();
  for (const [fieldId, value] of Object.entries(input.values)) {
    const key = normalizedKey(fieldId);
    if (!permitted.has(key)) continue;
    const projected = projectField(value, choicesByField.get(key));
    if (projected.changed) changed.add(key);
    if (projected.keep) values[key] = projected.value;
  }

  const validation: Record<string, PrivateFormDraftFieldValidation> = {};
  for (const [fieldId, state] of Object.entries(input.validation)) {
    const key = normalizedKey(fieldId);
    if (permitted.has(key) && !changed.has(key)) validation[key] = state;
  }
  return { values, validation };
};

/**
 * Projects one stored draft to the exact currently permitted fields, choices
 * and validation state. This is the only shape a caller ever receives.
 */
export const projectPrivateFormDraft = (
  draft: PrivateFormDraft,
  projection: PrivateFormDraftProjection,
): PrivateFormDraft => {
  const restricted = restrictPrivateFormDraftInput(draft, projection);
  return {
    ...draft,
    values: restricted.values as PrivateFormDraft["values"],
    validation: restricted.validation as PrivateFormDraft["validation"],
  };
};

/**
 * Storage-bound functions and session service for private form drafts.
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
const createPrivateFormDraft = async (
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
        from vortex_definition.create_private_form_draft(
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
    return {
      outcome: "created",
      draft: projectPrivateFormDraft(parseDraft(row.result), projection),
    };
  });
};

/** Reads the exact live draft and projects it through the permitted fields and choices. */
const readPrivateFormDraft = async (
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
        from vortex_definition.read_private_form_draft(
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
const updatePrivateFormDraft = async (
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
        from vortex_definition.update_private_form_draft(
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
    return {
      outcome: "updated",
      draft: projectPrivateFormDraft(parseDraft(row.result), projection),
    };
  });
};

/** Abandons and deletes exactly the owned live draft at its expected revision; no values are returned. */
const abandonPrivateFormDraft = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: AbandonPrivateFormDraftCommand,
): Promise<PrivateFormDraftAbandonResult> => {
  const command = parseCommand(abandonPrivateFormDraftCommandSchema, commandCandidate);
  return runStorage(async () => {
    const row = requireOne(
      await transaction.query<DraftResultRow>`
        select outcome, result
        from vortex_definition.abandon_private_form_draft(
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
export type LoadPrivateFormDraftAuthority = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  form: PrivateFormDraftScope,
) => Promise<PrivateFormDraftAuthority | undefined>;

export type PrivateFormDraftServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{ loadAuthority: LoadPrivateFormDraftAuthority }>;

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
    const authority = await dependencies.loadAuthority(transaction, scope, formScope(form));
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
