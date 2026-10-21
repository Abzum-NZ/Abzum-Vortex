import "server-only";

import { z } from "zod";
import {
  jsonValueSchema,
  describeFailure,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  isRecord,
  readRecordDetailContract,
  readQueryBindings,
  type ExecuteNamedActionCommand,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../access/index";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  readSubjectWithNamedActionAvailability,
  type NamedActionAvailability,
} from "../records/action-record-port";
import type { ActionFlowRunner } from "../rules/index";
import {
  protectedQueryRowCapabilitiesSchema,
  protectedQueryRowSchema,
  type ProtectedQueryRow,
} from "../queries/index";

/** Subject values consumed by the projected placements, including headings and query inputs. */
export const pageSubjectFieldIds = (
  placements: readonly Readonly<{
    settings: Readonly<Record<string, unknown>>;
    vortex: Readonly<Record<string, unknown>>;
  }>[],
): readonly string[] => {
  const fields = new Set<string>();
  for (const { settings: candidate, vortex } of placements) {
    const settings = candidate as Parameters<typeof readRecordDetailContract>[0];
    if (vortex.queryId === undefined) {
      const detail = readRecordDetailContract(settings);
      for (const field of detail?.fields ?? []) fields.add(field.field.toLowerCase());
      if (detail?.headingField !== undefined) fields.add(detail.headingField.toLowerCase());
      const field = candidate.field;
      if (isRecord(field) && field.kind === "field_reference" && typeof field.fieldId === "string")
        fields.add(field.fieldId.toLowerCase());
    }
    const bindings = readQueryBindings(settings);
    if (bindings.kind === "malformed") throw new Error("PAGE_SUBJECT_BINDINGS_INVALID");
    if (bindings.kind === "read")
      for (const binding of bindings.bindings)
        if (binding.source.kind === "record_field") fields.add(binding.source.field.toLowerCase());
  }
  return [...fields];
};

/**
 * What a detail placement reads for its page subject: the one record the page is about, addressed
 * by its record type (from the installed page definition) and its record id (from the page's own
 * address). The read runs through the fixed page subject read, under the viewer's own verified
 * request scope and current authority, previewing in the same call the named actions the caller
 * asks about; their availability, keyed by lower-case action id, comes back with a read subject.
 * A missing record, a record of another organisation or application and a record the viewer may
 * not read all come back as the same `refused`, so the caller can never tell them apart and no
 * field the viewer cannot read is ever returned.
 */
export type PageSubjectReadResult =
  | Readonly<{
      kind: "read";
      row: ProtectedQueryRow;
      /** Present exactly when the read asked for action previews. */
      actionAvailability?: ReadonlyMap<string, NamedActionAvailability>;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

const readableSubjectSchema = z
  .object({
    outcome: z.literal("allowed"),
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    values: z.record(z.string(), jsonValueSchema),
  })
  .passthrough();

/**
 * The readable projection of one fixed read, or the neutral refusal: the one parser every page
 * subject and eligibility read goes through. An explicit database refusal stays neutral;
 * malformed platform data raises an error.
 */
export const readableSubjectFromProjection = (
  result: unknown,
  recordId: string,
):
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "readable"; subject: z.infer<typeof readableSubjectSchema> }> => {
  if (typeof result !== "object" || result === null || !("outcome" in result))
    throw new Error("PAGE_SUBJECT_RESULT_INVALID");
  if (result.outcome === "refused") return { kind: "refused" };
  const subject = readableSubjectSchema.parse(result);
  if (subject.recordId.toLowerCase() !== recordId.toLowerCase())
    throw new Error("PAGE_SUBJECT_ID_MISMATCH");
  return { kind: "readable", subject };
};

/**
 * The page subject from one fixed read's projection and capabilities: the same record must answer
 * both. An explicit database refusal stays neutral; malformed platform data raises an error.
 */
export const pageSubjectFromRead = (
  result: unknown,
  capabilitiesCandidate: unknown,
  recordId: string,
): PageSubjectReadResult => {
  const projection = readableSubjectFromProjection(result, recordId);
  if (projection.kind === "refused") return { kind: "refused" };
  const capabilities = protectedQueryRowCapabilitiesSchema.parse(capabilitiesCandidate);
  const readable = projection.subject;
  const row = protectedQueryRowSchema.parse({
    recordId: readable.recordId,
    values: readable.values,
    revision: readable.concurrencyNumber,
    capabilities,
  });
  return { kind: "read", row };
};

/** The named actions a subject read previews on its record, and how each one's flow is run. */
export type PageSubjectActionPreviews = Readonly<{
  references: readonly ExecuteNamedActionCommand["action"][];
  runFor: (action: ExecuteNamedActionCommand["action"]) => ActionFlowRunner;
}>;

type PageSubjectRequest = Readonly<{
  recordTypeId: string;
  recordId: string;
  requestedFieldIds?: readonly string[];
  actions?: PageSubjectActionPreviews;
}>;

/** Reuses the fixed subject read only inside an already verified human request transaction. */
export const readPageSubjectInTransaction = async (
  transaction: RequestDatabaseTransaction,
  subject: PageSubjectRequest,
): Promise<PageSubjectReadResult> => {
  const recordTypeId = recordTypeIdSchema.safeParse(subject.recordTypeId);
  const recordId = recordIdSchema.safeParse(subject.recordId);
  if (!recordTypeId.success || !recordId.success) return { kind: "refused" };
  try {
    const combined = await readSubjectWithNamedActionAvailability(
      transaction,
      {
        recordTypeId: recordTypeId.data,
        recordId: recordId.data,
        requestedFieldIds: subject.requestedFieldIds ?? null,
      },
      subject.actions?.references ?? [],
      new Date().toISOString(),
      subject.actions?.runFor ??
        (() => {
          throw new Error("PAGE_ACTION_UNEXPECTED");
        }),
    );
    const read = pageSubjectFromRead(combined.record, combined.capabilities, recordId.data);
    return read.kind === "read" && subject.actions !== undefined
      ? { ...read, actionAvailability: combined.availability }
      : read;
  } catch (error) {
    console.error(`[page] subject read failed: ${describeFailure(error)}`);
    return { kind: "temporarily_unavailable" };
  }
};

export const createPageSubjectReader = (dependencies: HumanOrganizationRequestDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  return Object.freeze({
    async read(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      subject: PageSubjectRequest,
    ): Promise<PageSubjectReadResult> {
      if (
        !recordTypeIdSchema.safeParse(subject.recordTypeId).success ||
        !recordIdSchema.safeParse(subject.recordId).success
      )
        return { kind: "refused" };
      try {
        const result = await requests.run(session, selection, (transaction) =>
          readPageSubjectInTransaction(transaction, subject),
        );
        if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
        return result.kind === "available" ? result.value : { kind: "refused" };
      } catch (error) {
        console.error(`[page] subject reader failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
    },
  });
};

export type PageSubjectReader = ReturnType<typeof createPageSubjectReader>;
