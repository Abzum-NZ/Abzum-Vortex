import "server-only";

import { moduleQueryFilterEdits } from "@vortex/platform/server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequestDependencies } from "./server-composition";

const edits = () =>
  moduleQueryFilterEdits({
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
    console.error("[studio] query filter session failed", error);
    return { kind: "temporarily_unavailable" };
  }
};

export const loadStudioModuleQueryFilter = async (
  organizationId: string,
  rootId: string,
  queryAlias?: string,
) =>
  withSession((session) =>
    edits().loadStudioModuleQueryFilter(organizationId, rootId, queryAlias, session),
  );

export const validateStudioModuleQueryFilter = async (organizationId: string, candidate: unknown) =>
  withSession((session) =>
    edits().validateStudioModuleQueryFilter(organizationId, candidate, session),
  );

export const saveStudioModuleQueryFilter = (organizationId: string, candidate: unknown) =>
  withSession((session) => edits().saveStudioModuleQueryFilter(organizationId, candidate, session));
