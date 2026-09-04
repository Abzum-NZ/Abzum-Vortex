import "server-only";

import {
  organizationIdSchema,
  type IdentitySession,
  type OrganizationLauncherEntry,
  type OrganizationLauncherResolution,
} from "@vortex/contracts";
import { createHumanOrganizationRequestService } from "@vortex/access";
import { listOrganizationLauncher } from "@vortex/identity";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";

export const loadOrganizationLauncher = async (
  session: IdentitySession,
): Promise<OrganizationLauncherResolution> => listOrganizationLauncher(session);

export type SelectedOrganizationResult =
  | Readonly<{ kind: "available"; entry: OrganizationLauncherEntry }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export const loadSelectedOrganization = async (
  session: IdentitySession,
  organizationIdCandidate: string,
): Promise<SelectedOrganizationResult> => {
  const organizationId = organizationIdSchema.safeParse(organizationIdCandidate);
  if (!organizationId.success) return { kind: "unavailable" };

  let authorityId;
  try {
    authorityId = getIdentityAuthorityConfiguration().authorityId;
  } catch {
    return { kind: "temporarily_unavailable" };
  }

  const protectedResult = await createHumanOrganizationRequestService({
    identityAuthorityId: authorityId,
  }).resolve(session, { organizationId: organizationId.data });
  if (protectedResult.kind !== "available") return protectedResult;

  const launcher = await loadOrganizationLauncher(session);
  if (launcher.kind === "temporarily_unavailable") return launcher;
  if (launcher.kind === "invalid_session_state") return { kind: "unavailable" };
  const entry = launcher.entries.find(
    (candidate) => candidate.organizationId === protectedResult.value.organizationId,
  );
  return entry ? { kind: "available", entry } : { kind: "unavailable" };
};
