import { z } from "zod";
import { recordIdSchema, recordTypeIdSchema, revisionSchema } from "./identifiers";

/** The content-minimal identity the Human recovery reader may return to an installed page. */
export const recoverableRecordCandidateSchema = z
  .object({ recordId: recordIdSchema, revision: revisionSchema })
  .strict();
export type RecoverableRecordCandidate = z.infer<typeof recoverableRecordCandidateSchema>;

/** Recovery-only task evidence, distinct from the ordinary active page subject. */
export const recordRecoverySubjectSchema = z
  .object({
    recordTypeId: recordTypeIdSchema,
    recordId: recordIdSchema,
    revision: revisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export type RecordRecoverySubject = z.infer<typeof recordRecoverySubjectSchema>;
