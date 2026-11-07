"use server";

import { z } from "zod";
import { applicationRootIdSchema, organizationIdSchema } from "@vortex/platform/schema";
import { logRefusal } from "@vortex/platform/server";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import {
  readApplicationReleaseStanding as readStanding,
  type ApplicationReleaseStanding,
} from "../_lib/application-release-adoption";
import { loadOrganizationLauncher } from "../_lib/organization-context";
import {
  listStudioApplicationReleaseHistory,
  readStudioApplicationReleaseChanges,
  type StudioApplicationReleaseChangesResult,
  type StudioApplicationHistoryListResult,
} from "../_lib/studio-application-history";
import {
  readStudioBackendRunHistory,
  type StudioBackendRunHistoryResult,
} from "../_lib/studio-backend-run-history";
import { restoreStudioApplicationDraft } from "../_lib/studio-application-restore";
import type { StudioApplicationRestoreCommandResult } from "../_lib/studio-application-restore-contracts";

import { pageAdoptionCommandSchema } from "../_lib/studio-standard-page-adoption-plan";
import {
  loadStudioStandardPageAdoption,
  saveStudioStandardPageAdoption,
  type StudioStandardPageAdoptionLoadResult,
} from "../_lib/studio-standard-page-adoption";

/** Each command resolves its own actor, organization, root and saved revision on the server. */
export async function listApplicationReleaseHistory(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationHistoryListResult> {
  return listStudioApplicationReleaseHistory(organizationId, candidate);
}

/** What one version changed against the one before it, as rows by area and item name; never a source. */
export async function readApplicationReleaseChanges(
  organizationId: string,
  candidate: unknown,
): Promise<StudioApplicationReleaseChangesResult> {
  return readStudioApplicationReleaseChanges(organizationId, candidate);
}

const backendRunPageRequestSchema = z.union([
  z.object({ kind: z.literal("newest") }).strict(),
  z
    .object({
      kind: z.enum(["older", "newer"]),
      cursor: z
        .object({
          // The timestamp text the database wrote with the run, to the microsecond.
          createdAt: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/),
          runId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
]);

/** One page of the application's back-end runs, newest first, for its builders; never their outputs. */
export async function readBackendRunHistory(
  organizationId: string,
  rootId: string,
  candidate: unknown,
): Promise<StudioBackendRunHistoryResult> {
  const request = backendRunPageRequestSchema.safeParse(candidate);
  if (!request.success) return { kind: "refused", reason: "request_invalid" };
  return readStudioBackendRunHistory(organizationId, rootId, request.data);
}

/** Restores one published version into the draft as a new saved draft revision; nothing is published or installed. */
export async function restoreApplicationRelease(
  organizationId: string,
  command: unknown,
): Promise<StudioApplicationRestoreCommandResult> {
  return restoreStudioApplicationDraft(organizationId, command);
}

/**
 * Where the application stands in the builder's organisation (live, waiting or not installed), as
 * the App Store's review says it, with the App Store page that installs or upgrades it. It reads
 * only; the upgrade itself happens in the App Store's dialog.
 */
export async function readApplicationReleaseStanding(
  organizationId: string,
  rootId: string,
): Promise<ApplicationReleaseStanding> {
  try {
    const organization = organizationIdSchema.safeParse(organizationId);
    const root = applicationRootIdSchema.safeParse(rootId);
    if (!organization.success || !root.success) return { kind: "unknown" };
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active") return { kind: "unknown" };
    const launcher = await loadOrganizationLauncher(resolved.session);
    const entry =
      launcher.kind === "available"
        ? launcher.entries.find(
            (candidate) =>
              candidate.organizationId.toLowerCase() === organization.data.toLowerCase(),
          )
        : undefined;
    if (entry === undefined) return { kind: "unknown" };
    return await readStanding(resolved.session, {
      tenantShortName: entry.tenantShortName,
      organizationShortName: entry.organizationShortName,
      organizationId: organization.data,
      applicationRootId: root.data,
    });
  } catch (error) {
    logRefusal("studio", "release standing", "read_failed", error);
    return { kind: "unknown" };
  }
}

const textField = (formData: FormData, key: string): string | undefined => {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
};

const numberField = (formData: FormData, key: string): number | undefined => {
  const raw = textField(formData, key);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Reads the comparison for Page adoption in the Releases tab; the server resolves access afresh. */
export async function readStandardPageAdoption(
  organizationId: string,
  rootId: string,
): Promise<StudioStandardPageAdoptionLoadResult> {
  return loadStudioStandardPageAdoption(organizationId, rootId);
}

/** Returns the outcome code ("saved", "conflict", ...) for the tab to show; the tab then reloads the comparison. */
export async function submitStandardPageAdoption(formData: FormData): Promise<string> {
  const organizationId = textField(formData, "organizationId");
  const rootId = textField(formData, "rootId");
  const targetKind = textField(formData, "targetKind");
  const targetId = textField(formData, "targetId");
  const parsed = pageAdoptionCommandSchema.safeParse({
    rootId,
    expectedDraftRevision: numberField(formData, "expectedDraftRevision"),
    expectedPublicationAnchor: numberField(formData, "expectedPublicationAnchor"),
    candidateReleaseRevision: numberField(formData, "candidateReleaseRevision"),
    originalPageId: textField(formData, "originalPageId"),
    replacementPageId: textField(formData, "replacementPageId"),
    decision: textField(formData, "decision"),
    target: { kind: targetKind, id: targetId },
  });
  if (organizationId === undefined || rootId === undefined || !parsed.success) return "refused";
  const result = await saveStudioStandardPageAdoption(organizationId, parsed.data);
  return result.kind === "available" ? "saved" : result.kind;
}
