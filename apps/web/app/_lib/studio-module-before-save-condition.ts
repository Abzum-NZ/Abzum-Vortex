import "server-only";

import { moduleBeforeSaveConditionEdits } from "@web/platform-server";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/definitions";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequestDependencies } from "./server-composition";

const edits = () =>
  moduleBeforeSaveConditionEdits({
    releaseCatalogue: installedReleaseCatalogue,
    requestDependencies: humanOrganizationRequestDependencies(),
    access: {
      permission: platformPermissionFor("platform.organization.definition_drafts.manage"),
      ownerId: platformPermissionOwnerId,
    },
  });

export const loadStudioModuleBeforeSaveCondition = async (
  organizationId: string,
  rootId: string,
  flowAlias?: string,
  taskId?: string,
) => {
  const session = await resolveIdentitySession();
  return edits().loadStudioModuleBeforeSaveCondition(
    organizationId,
    rootId,
    flowAlias,
    taskId,
    session,
  );
};

export const validateStudioModuleBeforeSaveCondition = async (
  organizationId: string,
  candidate: unknown,
) => {
  const session = await resolveIdentitySession();
  return edits().validateStudioModuleBeforeSaveCondition(organizationId, candidate, session);
};

export const saveStudioModuleBeforeSaveCondition = async (
  organizationId: string,
  candidate: unknown,
) => {
  const session = await resolveIdentitySession();
  return edits().saveStudioModuleBeforeSaveCondition(organizationId, candidate, session);
};
