import "server-only";

import { moduleFieldEdits } from "@vortex/platform/server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequestDependencies } from "./server-composition";

const edits = () =>
  moduleFieldEdits({
    releaseCatalogue: installedReleaseCatalogue,
    requestDependencies: humanOrganizationRequestDependencies(),
    access: {
      permission: platformPermissionFor("platform.organization.definition_drafts.manage"),
      ownerId: platformPermissionOwnerId,
    },
  });

const withSession = async <Result>(
  operation: (session: Awaited<ReturnType<typeof resolveIdentitySession>>) => Promise<Result>,
): Promise<Result | Readonly<{ kind: "temporarily_unavailable" }>> => {
  try {
    return await operation(await resolveIdentitySession());
  } catch (error) {
    console.error("[studio] module field session failed", error);
    return { kind: "temporarily_unavailable" };
  }
};

export const loadStudioModuleFieldLabel = (organizationId: string, rootId: string) =>
  withSession((session) => edits().loadStudioModuleFieldLabel(organizationId, rootId, session));

export const saveStudioModuleFieldLabel = (organizationId: string, candidate: unknown) =>
  withSession((session) => edits().saveStudioModuleFieldLabel(organizationId, candidate, session));

export const loadStudioModuleTextFieldSettings = (organizationId: string, rootId: string) =>
  withSession((session) => edits().loadStudioModuleTextFieldSettings(organizationId, rootId, session));

export const saveStudioModuleTextFieldSettings = (organizationId: string, candidate: unknown) =>
  withSession((session) =>
    edits().saveStudioModuleTextFieldSettings(organizationId, candidate, session),
  );

export const saveStudioModuleFieldChange = (organizationId: string, candidate: unknown) =>
  withSession((session) => edits().saveStudioModuleFieldChange(organizationId, candidate, session));
