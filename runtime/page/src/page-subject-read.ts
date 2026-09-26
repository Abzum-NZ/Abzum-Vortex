import "server-only";

import { z } from "zod";
import {
  jsonValueSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import type { DatabaseRow } from "@vortex/db";
import {
  protectedQueryRowCapabilitiesSchema,
  protectedQueryRowSchema,
  type ProtectedQueryRow,
} from "@vortex/query";

/**
 * What a detail placement reads for its page subject: the one record the page is about, addressed
 * by its record type (from the installed page definition) and its record id (from the page's own
 * address). The read runs through the fixed record read path, `vortex_record.read_record` with
 * `vortex_record.read_record_capabilities`, under the viewer's own verified request scope and
 * current authority. A missing record, a record of another organisation or application and a
 * record the viewer may not read all come back as the same `refused`, so the caller can never tell
 * them apart and no field the viewer cannot read is ever returned.
 */
export type PageSubjectReadResult =
  | Readonly<{ kind: "read"; row: ProtectedQueryRow }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type SubjectRow = DatabaseRow & { readonly result: unknown; readonly capabilities: unknown };

const readableSubjectSchema = z
  .object({
    outcome: z.literal("allowed"),
    recordId: recordIdSchema,
    concurrencyNumber: revisionSchema,
    values: z.record(z.string(), jsonValueSchema),
  })
  .passthrough();

export const createPageSubjectReader = (dependencies: HumanOrganizationRequestDependencies) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  return Object.freeze({
    async read(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      subject: Readonly<{ recordTypeId: string; recordId: string }>,
    ): Promise<PageSubjectReadResult> {
      const recordTypeId = recordTypeIdSchema.safeParse(subject.recordTypeId);
      const recordId = recordIdSchema.safeParse(subject.recordId);
      if (!recordTypeId.success || !recordId.success) return { kind: "refused" };

      try {
        const result = await requests.run(
          session,
          selection,
          async (transaction): Promise<PageSubjectReadResult> => {
            const rows = await transaction.query<SubjectRow>`
              select
                vortex_record.read_record(${recordTypeId.data}::uuid, ${recordId.data}::uuid) as result,
                vortex_record.read_record_capabilities(
                  ${recordTypeId.data}::uuid, ${recordId.data}::uuid
                ) as capabilities
            `;
            const stored = rows[0];
            const readable = readableSubjectSchema.safeParse(stored?.result);
            const capabilities = protectedQueryRowCapabilitiesSchema.safeParse(stored?.capabilities);
            // The same record must answer both reads; anything else is one neutral refusal.
            if (
              !readable.success ||
              !capabilities.success ||
              readable.data.recordId.toLowerCase() !== recordId.data.toLowerCase()
            )
              return { kind: "refused" };
            const row = protectedQueryRowSchema.safeParse({
              recordId: readable.data.recordId,
              values: readable.data.values,
              revision: readable.data.concurrencyNumber,
              capabilities: capabilities.data,
            });
            return row.success ? { kind: "read", row: row.data } : { kind: "refused" };
          },
        );
        if (result.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
        return result.kind === "available" ? result.value : { kind: "refused" };
      } catch {
        return { kind: "temporarily_unavailable" };
      }
    },
  });
};

export type PageSubjectReader = ReturnType<typeof createPageSubjectReader>;
