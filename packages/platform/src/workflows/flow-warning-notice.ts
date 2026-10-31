import { z } from "zod";
import { builderKeySchema } from "../catalogue/identifiers";

/** A committed save's authored warning; no record values or internal warning codes. */
export const flowWarningNoticeSchema = z
  .object({ taskId: builderKeySchema, message: z.string().min(1) })
  .strict();
export type FlowWarningNotice = z.infer<typeof flowWarningNoticeSchema>;
