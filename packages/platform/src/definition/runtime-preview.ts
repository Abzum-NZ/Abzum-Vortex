import "server-only";

import type { OrganizationSelectionCandidate } from "../access/identity-access";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";

/**
 * The deliberate preview bound: a preview's storage holds at most this many records of one record
 * type, the first the builder can read live. The database seed applies the same number.
 */
export const PREVIEW_SEED_RECORD_BOUND = 2000;

/**
 * What marks a runtime context as a preview: its address, draft revision and expiry, and the
 * record types whose seed reached the preview bound.
 */
export type RuntimePreview = Readonly<{
  previewInstallationId: string;
  draftRevision: number;
  expiresAt: string;
  seedBoundedRecordTypeIds: readonly string[];
}>;

const runtimePreviews = new WeakMap<object, RuntimePreview>();

/** Associates a genuine context with the preview already verified by its protected loader. */
export const registerRuntimePreview = (
  context: InstalledRuntimeContext,
  preview: RuntimePreview,
): void => {
  runtimePreviews.set(requireInstalledRuntimeContext(context), preview);
};

/** The preview a runtime context runs, or undefined for an installed Application. */
export const runtimePreviewOf = (contextCandidate: unknown): RuntimePreview | undefined =>
  runtimePreviews.get(requireInstalledRuntimeContext(contextCandidate));

/**
 * The request selection of a runtime context: its organisation and Application, and the preview
 * it runs, so every request a page makes reads the same preview as the page itself.
 */
export const runtimeContextSelection = (
  contextCandidate: unknown,
): OrganizationSelectionCandidate => {
  const context = requireInstalledRuntimeContext(contextCandidate);
  const preview = runtimePreviews.get(context);
  return {
    organizationId: context.organizationId,
    applicationRootId: context.applicationRootId,
    ...(preview === undefined ? {} : { previewInstallationId: preview.previewInstallationId }),
  };
};
