import "server-only";

import { moduleBeforeSaveConditionEdits } from "@vortex/platform/server";
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

const withSession = async <Result>(
  operation: (session: Awaited<ReturnType<typeof resolveIdentitySession>>) => Promise<Result>,
): Promise<Result | Readonly<{ kind: "temporarily_unavailable" }>> => {
  try {
    return await operation(await resolveIdentitySession());
  } catch (error) {
    console.error("[studio] before-save condition session failed", error);
    return { kind: "temporarily_unavailable" };
  }
};

export const loadStudioModuleBeforeSaveCondition = async (
  organizationId: string,
  rootId: string,
  flowAlias?: string,
  taskId?: string,
) =>
  withSession((session) =>
    edits().loadStudioModuleBeforeSaveCondition(organizationId, rootId, flowAlias, taskId, session),
  );

export const validateStudioModuleBeforeSaveCondition = async (
  organizationId: string,
  candidate: unknown,
) =>
  withSession((session) =>
    edits().validateStudioModuleBeforeSaveCondition(organizationId, candidate, session),
  );

export const saveStudioModuleBeforeSaveCondition = async (
  organizationId: string,
  candidate: unknown,
) =>
  withSession((session) =>
    edits().saveStudioModuleBeforeSaveCondition(organizationId, candidate, session),
  );
