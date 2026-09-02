import { z } from "zod";
import {
  applicationRootIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  storageContractIdSchema,
} from "./identifiers";

const sharedScopeFields = {
  organizationId: organizationIdSchema,
  moduleRootId: moduleRootIdSchema,
  recordTypeId: recordTypeIdSchema,
  storageContractId: storageContractIdSchema,
  recordId: recordIdSchema,
};

export const organizationSharedRecordScopeSchema = z
  .object({ storageScope: z.literal("organization_shared"), ...sharedScopeFields })
  .strict();

export const applicationContainedRecordScopeSchema = z
  .object({
    storageScope: z.literal("application_contained"),
    ...sharedScopeFields,
    applicationRootId: applicationRootIdSchema,
  })
  .strict();

export const recordScopeSchema = z.discriminatedUnion("storageScope", [
  organizationSharedRecordScopeSchema,
  applicationContainedRecordScopeSchema,
]);

export type RecordScope = z.infer<typeof recordScopeSchema>;
