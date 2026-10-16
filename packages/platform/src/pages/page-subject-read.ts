import "server-only";

import { z } from "zod";
import {
  jsonValueSchema,
  describeFailure,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../access/index";
import type { RequestDatabaseTransaction } from "../db/index";
import { readSubjectWithNamedActionAvailability } from "../records/action-record-port";
import {
  protectedQueryRowCapabilitiesSchema,
  protectedQueryRowSchema,
  type ProtectedQueryRow,
} from "../queries/index";

/**
 * What a detail placement reads for its page subject: the one record the page is about, addressed
 * by its record type (from the installed page definition) and its record id (from the page's own
 * address). The read runs through the fixed page subject read with an empty action set, under the
 * viewer's own verified request scope and
 * current authority. A missing record, a record of another organisation or application and a
 * record the viewer may not read all come back as the same `refused`, so the caller can never tell
 * them apart and no field the viewer cannot read is ever returned.
 */
export type PageSubjectReadResult =
  | Readonly<{ kind: "read"; row: ProtectedQueryRow }>
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
 * The page subject from one fixed read's projection and capabilities: the same record must answer
 * both. An explicit database refusal stays neutral; malformed platform data raises an error.
 */
export const pageSubjectFromRead = (
  result: unknown,
  capabilitiesCandidate: unknown,
  recordId: string,
): PageSubjectReadResult => {
  if (typeof result !== "object" || result === null || !("outcome" in result))
    throw new Error("PAGE_SUBJECT_RESULT_INVALID");
  if (result.outcome === "refused") return { kind: "refused" };
  const readable = readableSubjectSchema.parse(result);
  const capabilities = protectedQueryRowCapabilitiesSchema.parse(capabilitiesCandidate);
  if (readable.recordId.toLowerCase() !== recordId.toLowerCase())
    throw new Error("PAGE_SUBJECT_ID_MISMATCH");
  const row = protectedQueryRowSchema.parse({
    recordId: readable.recordId,
    values: readable.values,
    revision: readable.concurrencyNumber,
    capabilities,
  });
  return { kind: "read", row };
};

/** Reuses the fixed subject read only inside an already verified human request transaction. */
export const readPageSubjectInTransaction = async (
  transaction: RequestDatabaseTransaction,
  subject: Readonly<{ recordTypeId: string; recordId: string }>,
): Promise<PageSubjectReadResult> => {
  const recordTypeId = recordTypeIdSchema.safeParse(subject.recordTypeId);
  const recordId = recordIdSchema.safeParse(subject.recordId);
  if (!recordTypeId.success || !recordId.success) return { kind: "refused" };
  try {
    const combined = await readSubjectWithNamedActionAvailability(
      transaction,
      { recordTypeId: recordTypeId.data, recordId: recordId.data },
      [],
      new Date().toISOString(),
      () => {
        throw new Error("PAGE_ACTION_UNEXPECTED");
      },
    );
    return pageSubjectFromRead(combined.record, combined.capabilities, recordId.data);
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
      subject: Readonly<{ recordTypeId: string; recordId: string }>,
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
