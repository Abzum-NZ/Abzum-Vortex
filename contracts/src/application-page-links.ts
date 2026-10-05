import { z } from "zod";
import {
  applicationRootIdSchema,
  builderKeySchema,
  fingerprintSchema,
  namespacedKeySchema,
  organizationIdSchema,
  pageIdSchema,
  revisionSchema,
  semanticVersionSchema,
} from "./identifiers";

/** A selector contains no address, authority or installed release evidence. */
export const applicationPageLinkSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("application"), applicationKey: namespacedKeySchema }).strict(),
  z
    .object({
      kind: z.literal("page"),
      applicationKey: namespacedKeySchema,
      pageKey: builderKeySchema,
    })
    .strict(),
]);

const availableTargetFields = {
  availability: z.literal("available"),
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationKey: namespacedKeySchema,
  pageId: pageIdSchema,
  pageKey: builderKeySchema,
  applicationReleaseRevision: revisionSchema,
  releaseVersion: semanticVersionSchema,
  contentFingerprint: fingerprintSchema,
  resolutionFingerprint: fingerprintSchema,
  label: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(120),
  tenantShortName: builderKeySchema,
  organizationShortName: builderKeySchema,
};

/** Detached display and navigation candidates; this value never authorizes activation. */
export const applicationPageLinkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ ...availableTargetFields, kind: z.literal("application") }).strict(),
  z.object({ ...availableTargetFields, kind: z.literal("page") }).strict(),
]);

export const applicationPageLinkResultSchema = z.union([
  applicationPageLinkTargetSchema,
  z.object({ availability: z.literal("unavailable") }).strict(),
]);

export type ApplicationPageLinkSelector = z.infer<typeof applicationPageLinkSelectorSchema>;
export type ApplicationPageLinkTarget = z.infer<typeof applicationPageLinkTargetSchema>;
export type ApplicationPageLinkResult = z.infer<typeof applicationPageLinkResultSchema>;
