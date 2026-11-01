import "server-only";

import type { PlatformPermissionSource } from "../access/platform-permissions";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
  type HumanOrganizationRequestResult,
} from "../access/human-organization-request";
import type {
  IdentitySession,
  OrganizationSelectionCandidate,
  SelectedOrganizationScope,
} from "../access/identity-access";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { describeFailure } from "../catalogue/runtime-primitives";
import { BuilderAuthorityError, requireBuilderAuthority } from "./builder-authority";
import { createBuilderAuthority, type BuilderTargetFactsReader } from "../access/builder-authority";

/**
 * What the person may do with applications in this organisation, as one server decision shared by
 * every application surface: the Applications page's row actions and header, and the Landing
 * Zone's application tiles. A surface only offers what this read allows; every action it offers is
 * re-checked again where it runs.
 */
export type ApplicationSurfaceCapabilities = Readonly<{
  /** The person may change the definitions of the organisation's ordinary applications. */
  mayBuild: boolean;
  /** The person may change the definitions of the organisation's platform system applications. */
  mayBuildSystemApplications: boolean;
  /** The person may install and upgrade applications in this organisation. */
  mayInstall: boolean;
  /** The person may publish versions of the organisation's ordinary applications. */
  mayPublish: boolean;
}>;

type ApplicationSurfaceCapabilityDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** The shipped platform permission catalogue the authority's declarations are built from. */
    permissions: PlatformPermissionSource;
  }>;

const noCapabilities: ApplicationSurfaceCapabilities = Object.freeze({
  mayBuild: false,
  mayBuildSystemApplications: false,
  mayInstall: false,
  mayPublish: false,
});

const ordinaryApplicationFacts: BuilderTargetFactsReader = async () => ({
  isSystemApplication: false,
});

const systemApplicationFacts: BuilderTargetFactsReader = async () => ({
  isSystemApplication: true,
});

/** Whether the authority allows the operation; a refusal is an answer, anything else a failure. */
const allows = async (
  authority: ReturnType<typeof createBuilderAuthority>,
  operation: Parameters<typeof requireBuilderAuthority>[1],
): Promise<boolean> => {
  try {
    await requireBuilderAuthority(authority, operation);
    return true;
  } catch (error) {
    if (error instanceof BuilderAuthorityError && error.code === "BUILDER_PERMISSION_REFUSED")
      return false;
    throw error;
  }
};

/** The same capability decision for a page read and a command's current protected request. */
export const readApplicationSurfaceCapabilitiesInTransaction = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  permissions: PlatformPermissionSource,
): Promise<ApplicationSurfaceCapabilities> => {
  const ordinary = createBuilderAuthority({
    transaction,
    scope,
    targetFacts: ordinaryApplicationFacts,
    permissions,
  });
  const system = createBuilderAuthority({
    transaction,
    scope,
    targetFacts: systemApplicationFacts,
    permissions,
  });
  const mayBuild = await allows(ordinary, { kind: "draft_change" });
  return {
    mayBuild,
    mayBuildSystemApplications: mayBuild && (await allows(system, { kind: "draft_change" })),
    mayInstall: await allows(ordinary, { kind: "application_management" }),
    mayPublish: await allows(ordinary, {
      kind: "publication",
      rootId: "00000000-0000-0000-0000-000000000000",
    }),
  };
};

/**
 * The one application-capability read. It asks the same builder authority every builder operation
 * passes through, in the person's own request transaction: draft changes need
 * `platform.organization.definition_drafts.manage` (plus `system_applications.manage` for a
 * platform system application), and installation needs `platform.organization.applications.manage`.
 * A person who cannot be decided is offered nothing and the cause is logged.
 */
export const readApplicationSurfaceCapabilities = async (
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  dependencies: ApplicationSurfaceCapabilityDependencies,
): Promise<HumanOrganizationRequestResult<ApplicationSurfaceCapabilities>> => {
  const result = await createHumanOrganizationRequestService(dependencies).run(
    session,
    selection,
    (transaction, scope) =>
      readApplicationSurfaceCapabilitiesInTransaction(transaction, scope, dependencies.permissions),
  );
  if (result.kind !== "available") {
    console.error(
      `[application-surfaces] capabilities unavailable: ${result.cause ?? result.kind}`,
    );
    return { kind: "unavailable" };
  }
  return result;
};

/**
 * The capabilities of a resolved read, or none when the read could not decide: a surface then
 * offers no role-gated action rather than guessing.
 */
export const applicationSurfaceCapabilitiesOf = (
  result: HumanOrganizationRequestResult<ApplicationSurfaceCapabilities>,
): ApplicationSurfaceCapabilities => {
  if (result.kind === "available") return result.value;
  console.error(`[application-surfaces] capabilities refused: ${result.kind}`);
  return noCapabilities;
};

/** One failure in the capability read, logged with its cause and never turned into a silent allow. */
export const describeApplicationSurfaceCapabilityFailure = (error: unknown): string =>
  describeFailure(error);
