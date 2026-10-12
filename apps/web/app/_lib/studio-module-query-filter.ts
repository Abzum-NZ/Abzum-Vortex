import "server-only";

import { moduleQueryFilterEdits } from "@web/platform-server";
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

export const loadStudioModuleQueryFilter = async (
  organizationId: string,
  rootId: string,
  queryAlias?: string,
) => {
  const session = await resolveIdentitySession();
  return edits().loadStudioModuleQueryFilter(organizationId, rootId, queryAlias, session);
};

export const validateStudioModuleQueryFilter = async (
  organizationId: string,
  candidate: unknown,
) => {
  const session = await resolveIdentitySession();
  return edits().validateStudioModuleQueryFilter(organizationId, candidate, session);
};

export const saveStudioModuleQueryFilter = async (organizationId: string, candidate: unknown) => {
  const session = await resolveIdentitySession();
  return edits().saveStudioModuleQueryFilter(organizationId, candidate, session);
};
