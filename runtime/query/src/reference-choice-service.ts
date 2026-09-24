import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  organizationAccountIdSchema,
  organizationIdSchema,
  type FieldId,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type RecordTypeId,
  type RecordTypeReference,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import type { QueryContinuationKey } from "./continuation-token";
import type { ProtectedQueryRow } from "./protected-query-contracts";
import {
  createProtectedQueryService,
  type ProtectedQueryServiceDependencies,
} from "./protected-query-service";
import {
  referenceChoiceCommandSchema,
  type OrganizationAccountReferenceChoiceCommand,
  type RecordReferenceChoiceCommand,
  type ReferenceChoiceOption,
  type ReferenceChoiceRefusal,
  type ReferenceChoiceRefusalReasonCode,
  type ReferenceChoiceResult,
  type ReferenceChoiceValue,
} from "./reference-choice-contracts";

export type ReferenceChoiceServiceDependencies = ProtectedQueryServiceDependencies;

/** The #582 `choice_input` projected values for one reference input placement. */
export type ReferenceChoiceInputValues = Readonly<{
  kind: "choice_input";
  value?: string | null;
  options: readonly Readonly<{ key: string; label: string }>[];
  error?: string;
}>;

const refusal = (reasonCode: ReferenceChoiceRefusalReasonCode): ReferenceChoiceRefusal =>
  Object.freeze({ outcome: "refused", reasonCode });

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const maximumLabelLength = 200;

const boundedLabel = (text: string): string => {
  const trimmed = text.trim();
  return Array.from(trimmed).slice(0, maximumLabelLength).join("");
};

/**
 * A choice-input option key for one referenced identity. Option keys are
 * builder keys, so the UUID is carried as its 32 lowercase hex digits under a
 * kind prefix; the key is resolved back only against the permitted choices.
 */
const choiceKey = (prefix: "r" | "a", id: string): string =>
  `${prefix}_${id.replaceAll("-", "").toLowerCase()}`;

const matchesSearch = (label: string, search: string | undefined): boolean =>
  search === undefined || label.toLowerCase().includes(search.toLowerCase());

const freezeChoices = (choices: readonly ReferenceChoiceOption[]): ReferenceChoiceOption[] =>
  choices.map((choice) => Object.freeze({ ...choice, value: Object.freeze(choice.value) }));

/**
 * Projects one page of permitted choices into #582 `choice_input` values. A
 * selected key outside the permitted choices is dropped rather than shown.
 */
export function projectReferenceChoiceInputValues(
  choices: readonly ReferenceChoiceOption[],
  selectedKey?: string | null,
  error?: string,
): ReferenceChoiceInputValues {
  const options = Object.freeze(
    choices.map((choice) => Object.freeze({ key: choice.key, label: choice.label })),
  );
  const selected =
    selectedKey === undefined || selectedKey === null
      ? selectedKey
      : choices.some((choice) => choice.key === selectedKey)
        ? selectedKey
        : null;
  return Object.freeze({
    kind: "choice_input",
    options,
    ...(selected === undefined ? {} : { value: selected }),
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * The typed reference value a submitted option key stands for, or undefined
 * when the key is not one of the permitted choices, so a value outside the
 * offered set can never be submitted through the binding.
 */
export function resolveReferenceChoiceSelection(
  choices: readonly ReferenceChoiceOption[],
  selectedKey: string | null,
): ReferenceChoiceValue | null | undefined {
  if (selectedKey === null) return null;
  return choices.find((choice) => choice.key === selectedKey)?.value;
}

const allowsRecordType = (
  allowed: readonly RecordTypeReference[],
  target: RecordTypeReference,
): target is Extract<RecordTypeReference, { state: "resolved" }> =>
  target.state === "resolved" &&
  allowed.some(
    (candidate) =>
      candidate.state === "resolved" &&
      sameId(candidate.moduleRootId, target.moduleRootId) &&
      sameId(candidate.recordTypeId, target.recordTypeId),
  );

const recordChoice = (
  row: ProtectedQueryRow,
  recordTypeId: RecordTypeId,
  labelFieldId: FieldId,
): ReferenceChoiceOption => {
  // A withheld label field is absent from the row, so the fallback names only
  // the record the viewer may already read.
  const labelValue: JsonValue | undefined = row.values[labelFieldId];
  const labelText =
    typeof labelValue === "number" && Number.isFinite(labelValue) ? String(labelValue) : labelValue;
  const label =
    typeof labelText === "string" && labelText.trim().length > 0
      ? boundedLabel(labelText)
      : `Record ${row.recordId.slice(0, 8).toLowerCase()}`;
  return {
    key: choiceKey("r", row.recordId),
    label,
    value: { recordTypeId, recordId: row.recordId },
  };
};

const recordChoices = async (
  queries: ReturnType<typeof createProtectedQueryService>,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  command: RecordReferenceChoiceCommand,
): Promise<HumanOrganizationRequestResult<ReferenceChoiceResult>> => {
  const { source } = command;
  const target = source.query.recordType;
  if (
    !allowsRecordType(command.allowedRecordTypes, target) ||
    !source.query.selectedFieldIds.some((fieldId) => sameId(fieldId, command.labelFieldId)) ||
    source.query.groupByFieldIds.length > 0 ||
    source.query.aggregates.length > 0 ||
    source.query.inputs.some((input) => input.required)
  )
    return { kind: "available", value: refusal("source_invalid") };

  const result = await queries.run(session, selection, {
    moduleRootId: source.moduleRootId,
    queryId: source.query.queryId,
    inputValues: {},
    requestedFieldIds: [command.labelFieldId],
    pageSize: Math.min(command.pageSize, source.query.pageSize),
    ...(command.continuationToken === undefined
      ? {}
      : { continuationToken: command.continuationToken }),
  });
  if (result.kind !== "available") return result;
  const page = result.value;
  if (page.outcome === "refused") {
    switch (page.reasonCode) {
      case "cursor_invalid":
      case "cursor_stale":
        return { kind: "available", value: refusal(page.reasonCode) };
      case "request_invalid":
        return { kind: "available", value: refusal("request_invalid") };
      default:
        return { kind: "available", value: refusal("source_unavailable") };
    }
  }
  // Choice values name the descriptor's record type, so the rows must come
  // from that exact installed release.
  if (
    !sameId(page.moduleRootId, source.moduleRootId) ||
    !sameId(page.queryId, source.query.queryId) ||
    page.moduleReleaseVersion !== source.moduleReleaseVersion
  )
    return { kind: "available", value: refusal("source_stale") };

  const choices = page.rows
    .map((row) => recordChoice(row, target.recordTypeId, command.labelFieldId))
    .filter((choice) => matchesSearch(choice.label, command.search));
  return {
    kind: "available",
    value: {
      outcome: "completed",
      kind: "record_reference",
      choices: freezeChoices(choices),
      ...(page.nextContinuationToken === undefined
        ? {}
        : { nextContinuationToken: page.nextContinuationToken }),
    },
  };
};

const accountContinuationSchema = z
  .object({
    version: z.literal(1),
    organizationId: organizationIdSchema,
    organizationAccountId: organizationAccountIdSchema,
    searchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sortKey: z.string().max(1_000),
    afterOrganizationAccountId: organizationAccountIdSchema,
  })
  .strict();
type AccountContinuation = z.infer<typeof accountContinuationSchema>;

class AccountContinuationError extends Error {
  constructor() {
    super("vortex.query.account_choice_continuation_invalid");
    this.name = "AccountContinuationError";
  }
}

const nonceLength = 12;
const tagLength = 16;
const accountTokenVersion = 1;
const accountAssociatedData = Buffer.from("vortex.query.account-choice.continuation.v1", "utf8");

const cipherKey = (key: QueryContinuationKey): Buffer => {
  if (!(key.key instanceof Uint8Array) || key.key.byteLength !== 32)
    throw new Error("QUERY_CONTINUATION_KEY_INVALID");
  return Buffer.from(key.key);
};

const searchFingerprint = (search: string | undefined): string =>
  createHash("sha256")
    .update(search === undefined ? "" : `search:${search.toLowerCase()}`, "utf8")
    .digest("hex");

// The last position is encrypted as well as authenticated: the token is
// opaque, bound to the viewer, organisation and search it was issued for.
const encodeAccountContinuation = (
  continuation: AccountContinuation,
  key: QueryContinuationKey,
): string => {
  const payload = Buffer.from(JSON.stringify(accountContinuationSchema.parse(continuation)), "utf8");
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(key), nonce, { authTagLength: tagLength });
  cipher.setAAD(accountAssociatedData);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([
    Buffer.from([accountTokenVersion]),
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]).toString("base64url");
};

const decodeAccountContinuation = (
  token: string,
  key: QueryContinuationKey,
): AccountContinuation => {
  const secret = cipherKey(key);
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new AccountContinuationError();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length <= 1 + nonceLength + tagLength || bytes[0] !== accountTokenVersion)
      throw new AccountContinuationError();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      bytes.subarray(1, 1 + nonceLength),
      { authTagLength: tagLength },
    );
    decipher.setAAD(accountAssociatedData);
    decipher.setAuthTag(bytes.subarray(1 + nonceLength, 1 + nonceLength + tagLength));
    const payload = Buffer.concat([
      decipher.update(bytes.subarray(1 + nonceLength + tagLength)),
      decipher.final(),
    ]).toString("utf8");
    const parsed = accountContinuationSchema.safeParse(JSON.parse(payload));
    if (!parsed.success) throw new AccountContinuationError();
    return parsed.data;
  } catch {
    throw new AccountContinuationError();
  }
};

type ResultRow = DatabaseRow & { readonly result: unknown };

const accountPageSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            organizationAccountId: organizationAccountIdSchema,
            displayName: z.string().optional(),
          })
          .strict(),
      )
      .max(100),
    next: z
      .object({
        sortKey: z.string().max(1_000),
        organizationAccountId: organizationAccountIdSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();

const accountChoices = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  command: OrganizationAccountReferenceChoiceCommand,
  continuationKey: QueryContinuationKey,
): Promise<ReferenceChoiceResult> => {
  const fingerprint = searchFingerprint(command.search);
  let after: AccountContinuation | undefined;
  if (command.continuationToken !== undefined) {
    try {
      after = decodeAccountContinuation(command.continuationToken, continuationKey);
    } catch (error) {
      if (error instanceof AccountContinuationError) return refusal("cursor_invalid");
      throw error;
    }
    if (
      !sameId(after.organizationId, scope.organizationId) ||
      !sameId(after.organizationAccountId, scope.organizationAccountId) ||
      after.searchFingerprint !== fingerprint
    )
      return refusal("cursor_stale");
  }

  const rows = await transaction.query<ResultRow>`
    select vortex_access.list_organization_account_choices(
      ${command.search ?? null}::text,
      ${command.pageSize}::integer,
      ${after?.sortKey ?? null}::text,
      ${after?.afterOrganizationAccountId ?? null}::uuid
    ) as result
  `;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("ACCOUNT_CHOICE_RESULT_INVALID");
  const page = accountPageSchema.parse(rows[0].result);

  const choices: ReferenceChoiceOption[] = page.accounts.map((account) => ({
    key: choiceKey("a", account.organizationAccountId),
    label:
      account.displayName !== undefined && account.displayName.trim().length > 0
        ? boundedLabel(account.displayName)
        : `Account ${account.organizationAccountId.slice(0, 8).toLowerCase()}`,
    value: { organizationAccountId: account.organizationAccountId },
  }));
  return {
    outcome: "completed",
    kind: "organization_account_reference",
    choices: freezeChoices(choices),
    ...(page.next === null
      ? {}
      : {
          nextContinuationToken: encodeAccountContinuation(
            {
              version: 1,
              organizationId: scope.organizationId,
              organizationAccountId: scope.organizationAccountId,
              searchFingerprint: fingerprint,
              sortKey: page.next.sortKey,
              afterOrganizationAccountId: page.next.organizationAccountId,
            },
            continuationKey,
          ),
        }),
  };
};

/**
 * Protected choices for record- and account-reference inputs. Record choices
 * are the rows the #572 protected Query admits for a published query of an
 * allowed record type; account choices are active accounts in the verified
 * current organisation. Neither carries counts, and every refusal is neutral.
 */
export const createReferenceChoiceService = (dependencies: ReferenceChoiceServiceDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const queries = createProtectedQueryService(dependencies);
  const { continuationKey } = dependencies;

  return Object.freeze({
    async run(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      commandCandidate: unknown,
    ): Promise<HumanOrganizationRequestResult<ReferenceChoiceResult>> {
      const command = referenceChoiceCommandSchema.safeParse(commandCandidate);
      if (!command.success) return { kind: "available", value: refusal("request_invalid") };
      if (command.data.kind === "record_reference")
        return recordChoices(queries, session, selection, command.data);
      const accountCommand = command.data;
      return requests.run(session, selection, (transaction, scope) =>
        accountChoices(transaction, scope, accountCommand, continuationKey),
      );
    },
  });
};
