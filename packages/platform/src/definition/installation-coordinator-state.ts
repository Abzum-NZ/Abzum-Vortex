import "server-only";

import type { RequestDatabaseTransaction } from "../db/request-transaction";
import type { PreparedApplicationRoleTemplates } from "../access/organization-access-catalogue";
import type {
  PermissionRegistryDefinitionRelease,
  PermissionRegistryEntryCandidate,
} from "../access/permission-registry";
import {
  applicationRootIdSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  type ApplicationRootId,
  type ModuleRootId,
  type OrganizationId,
} from "../catalogue/identifiers";
import { sameId } from "../catalogue/runtime-primitives";
import {
  moduleInstallationBindingSchema,
  type ApplicationInstallationLifecycleResult,
  type ModuleInstallationBinding,
  type ModuleInstallationStorageResult,
} from "../files/storage";
import type { SystemApplicationBoundReleaseSetResult } from "./definition-consumer-read";
import { canonicalJson } from "./canonical-json";
import { BuilderAuthorityError } from "./builder-authority";
import { InstallationProblem } from "./installation-authority";
import {
  changeModuleContributionStorage,
  provisionModuleInstallationStorage,
  type ResolvedContributionBinding,
} from "./storage-provisioning";
import { z } from "zod";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";
import {
  applicationInstallationCoordinatorErrorCodes,
  type ApplicationInstallationCoordinatorErrorCode,
  type ActiveApplicationInstallationSummary,
  type InstallationReleaseTarget,
} from "./installation-coordinator-contracts";

type BindingRow = Readonly<{ bindings: unknown }>;
type AccessRow = Readonly<{ access_change: unknown }>;

const installationBindingsSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registeredReleaseRevision: revisionSchema.nullable(),
    moduleBindings: z.array(moduleInstallationBindingSchema).max(10_000),
  })
  .strict();

export const accessChangeSchema = z
  .object({
    outcome: z.enum(["changed", "unchanged"]),
    operation: z.enum(["register", "update", "reactivate", "withdraw"]),
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registrationState: z.enum(["active", "withdrawn"]),
    registrationRevision: revisionSchema,
    accessVersion: revisionSchema,
  })
  .strict();

export type InstallationBindings = z.infer<typeof installationBindingsSchema>;
type ExpectedModuleBinding = Readonly<{ moduleRootId: ModuleRootId; bindingRevision: number }>;
type ModulePin = Readonly<{ moduleRootId: ModuleRootId; moduleReleaseRevision: number }>;
export type ContributionGroup = ModulePin &
  Readonly<{
    contributions: readonly ResolvedContributionBinding[];
  }>;
export type ExactStorageRelease = Readonly<{
  releaseSet: SystemApplicationBoundReleaseSetResult;
  pins: readonly ModulePin[];
  contributionGroups: readonly ContributionGroup[];
}>;
export type ExactRelease = ExactStorageRelease &
  Readonly<{
    preparedTemplates: PreparedApplicationRoleTemplates;
  }>;
export type ReleaseTarget = InstallationReleaseTarget;

export const canonicalModuleRootId = (value: string): ModuleRootId =>
  moduleRootIdSchema.parse(value.toLowerCase());

export const byModuleRoot = <Value extends { readonly moduleRootId: string }>(
  values: Value[],
): Value[] =>
  values.sort((left, right) =>
    left.moduleRootId < right.moduleRootId ? -1 : left.moduleRootId > right.moduleRootId ? 1 : 0,
  );

export const fail = (code: ApplicationInstallationCoordinatorErrorCode, cause?: unknown) =>
  new DefinitionError(code, cause === undefined ? undefined : { cause });

export const isCoordinatorError = (
  error: unknown,
): error is DefinitionError<ApplicationInstallationCoordinatorErrorCode> =>
  error instanceof DefinitionError &&
  (applicationInstallationCoordinatorErrorCodes as readonly string[]).includes(error.code);

export const toCoordinatorError = (
  error: unknown,
): DefinitionError<ApplicationInstallationCoordinatorErrorCode> => {
  if (isCoordinatorError(error)) return error;
  // A stale sign-in keeps its meaning, so the person is told to sign in again.
  if (error instanceof InstallationProblem && error.problem.kind === "authentication_required")
    return fail("APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED", error);
  if (error instanceof InstallationProblem && error.problem.kind === "multi_factor_required")
    return fail("APPLICATION_INSTALLATION_MULTI_FACTOR_REQUIRED", error);
  // A refusal stays a refusal, never a generic failure.
  if (error instanceof InstallationProblem && error.problem.kind === "refused")
    return fail("APPLICATION_INSTALLATION_REFUSED", error);
  if (error instanceof BuilderAuthorityError)
    return fail(
      error.code === "BUILDER_MULTI_FACTOR_REQUIRED"
        ? "APPLICATION_INSTALLATION_MULTI_FACTOR_REQUIRED"
        : error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
          ? "APPLICATION_INSTALLATION_RECENT_AUTHENTICATION_REQUIRED"
          : "APPLICATION_INSTALLATION_PERMISSION_REFUSED",
      error,
    );
  if (error instanceof DefinitionError)
    switch (error.code) {
      case "INVALID_MODULE_INSTALLATION_STORAGE_COMMAND":
        return fail("INVALID_APPLICATION_INSTALLATION_COMMAND", error);
      case "MODULE_INSTALLATION_AUTHORITY_REFUSED":
        return fail("APPLICATION_INSTALLATION_REFUSED", error);
      case "MODULE_INSTALLATION_RELEASE_UNAVAILABLE":
      case "MODULE_INSTALLATION_RELEASE_MISMATCH":
        return fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
      case "MODULE_INSTALLATION_BINDING_CONFLICT":
        return fail("APPLICATION_INSTALLATION_STALE", error);
      case "RECORD_STORAGE_INCOMPATIBLE":
        return fail("APPLICATION_INSTALLATION_STORAGE_INCOMPATIBLE", error);
      case "RECORD_STORAGE_PROVISIONING_FAILED":
        return fail("APPLICATION_INSTALLATION_FAILED", error);
    }
  if (error instanceof DefinitionError)
    switch (error.code) {
      case "INVALID_APPLICATION_INSTALLATION_LIFECYCLE_COMMAND":
        return fail("INVALID_APPLICATION_INSTALLATION_COMMAND", error);
      case "APPLICATION_INSTALLATION_AUTHORITY_REFUSED":
        return fail("APPLICATION_INSTALLATION_REFUSED", error);
      case "APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE":
        return fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
      case "APPLICATION_INSTALLATION_BINDING_CONFLICT":
        return fail("APPLICATION_INSTALLATION_STALE", error);
      case "APPLICATION_INSTALLATION_BINDINGS_INCOMPLETE":
        return fail("APPLICATION_INSTALLATION_INCOMPLETE", error);
      case "APPLICATION_INSTALLATION_CHANGE_FAILED":
        return fail("APPLICATION_INSTALLATION_FAILED", error);
    }
  switch (classifyDatabaseError(error)) {
    case "invalid":
      return fail("INVALID_APPLICATION_INSTALLATION_COMMAND", error);
    case "refused":
      return fail("APPLICATION_INSTALLATION_REFUSED", error);
    case "not_found":
      return fail("APPLICATION_INSTALLATION_RELEASE_UNAVAILABLE", error);
    case "conflict":
    case "reference_missing":
    case "duplicate":
    case "constraint_failed":
    case "wrong_state":
      return fail("APPLICATION_INSTALLATION_STALE", error);
    default:
      return unexpectedDefinitionFailure(
        "APPLICATION_INSTALLATION_FAILED",
        error,
        "application installation",
      );
  }
};

export const readInstallationBindings = async (
  transaction: RequestDatabaseTransaction,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
): Promise<InstallationBindings> => {
  const rows = await transaction.query<BindingRow>`
    select vortex_definition.read_application_installation_bindings(
      ${applicationRootId}::uuid
    ) as bindings
  `;
  const parsed = rows.length === 1 ? installationBindingsSchema.safeParse(rows[0]?.bindings) : null;
  if (
    parsed === null ||
    !parsed.success ||
    !sameId(parsed.data.applicationRootId, applicationRootId) ||
    parsed.data.moduleBindings.some(
      (binding) =>
        !sameId(binding.organizationId, parsed.data.organizationId) ||
        !sameId(binding.applicationRootId, applicationRootId),
    )
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  // The installer's trusted request context selects the organisation; a different one is refused.
  if (!sameId(parsed.data.organizationId, organizationId))
    throw fail("APPLICATION_INSTALLATION_REFUSED");
  return parsed.data;
};

/** The single active release, if any. Mixed active releases are never guessed between. */
export const activeRelease = (
  state: InstallationBindings,
): Readonly<{ releaseRevision: number; bindings: ModuleInstallationBinding[] }> | null => {
  const active = state.moduleBindings.filter((binding) => binding.state === "active");
  if (active.length === 0) return null;
  const releaseRevision = active[0]!.applicationReleaseRevision;
  if (active.some((binding) => binding.applicationReleaseRevision !== releaseRevision))
    throw fail("APPLICATION_INSTALLATION_STALE");
  return { releaseRevision, bindings: active };
};

export const expectedBindings = (
  bindings: readonly Pick<ModuleInstallationBinding, "moduleRootId" | "bindingRevision">[],
): ExpectedModuleBinding[] =>
  byModuleRoot(
    bindings.map((binding) => ({
      moduleRootId: canonicalModuleRootId(binding.moduleRootId),
      bindingRevision: binding.bindingRevision,
    })),
  );

export const currentBindingRevisions = (state: InstallationBindings): Map<ModuleRootId, number> =>
  new Map(
    state.moduleBindings.map((binding) => [
      canonicalModuleRootId(binding.moduleRootId),
      binding.bindingRevision,
    ]),
  );

export const changeAccess = async (
  transaction: RequestDatabaseTransaction,
  activityId: string,
  applicationRootId: ApplicationRootId,
  change: "prepare" | "withdraw",
  preparedTemplates: PreparedApplicationRoleTemplates | null,
): Promise<z.infer<typeof accessChangeSchema>> => {
  const rows = await transaction.query<AccessRow>`
    select vortex_access.change_application_installation_access(
      ${activityId}::uuid,
      ${applicationRootId}::uuid,
      ${change}::text,
      ${preparedTemplates === null ? null : JSON.stringify(preparedTemplates)}::text::jsonb
    ) as access_change
  `;
  const parsed = rows.length === 1 ? accessChangeSchema.safeParse(rows[0]?.access_change) : null;
  if (
    parsed === null ||
    !parsed.success ||
    !sameId(parsed.data.applicationRootId, applicationRootId) ||
    (change === "prepare"
      ? parsed.data.registrationState !== "active" || parsed.data.operation === "withdraw"
      : parsed.data.registrationState !== "withdrawn" || parsed.data.operation !== "withdraw")
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  return parsed.data;
};

export const recordOutcome = async (
  transaction: RequestDatabaseTransaction,
  activityId: string,
  applicationRootId: ApplicationRootId,
  applicationReleaseRevision: number,
  state: "active" | "detached",
): Promise<void> => {
  await transaction.query`
    select vortex_definition.record_application_installation_outcome(
      ${activityId}::uuid,
      ${applicationRootId}::uuid,
      ${applicationReleaseRevision}::bigint,
      ${state}::text
    )
  `;
};

/** Storage for every pinned Module release; commits only inactive, idempotent bindings. */
export const provisionPins = async (
  transaction: RequestDatabaseTransaction,
  target: ReleaseTarget,
  pins: readonly ModulePin[],
  current: ReadonlyMap<ModuleRootId, number>,
): Promise<ModuleInstallationStorageResult[]> => {
  const provisioned: ModuleInstallationStorageResult[] = [];
  for (const pin of pins) {
    const result = await provisionModuleInstallationStorage(transaction, {
      applicationRootId: target.applicationRootId,
      applicationReleaseRevision: target.applicationReleaseRevision,
      moduleRootId: pin.moduleRootId,
      moduleReleaseRevision: pin.moduleReleaseRevision,
      expectedBindingRevision: current.get(pin.moduleRootId) ?? null,
    });
    if (
      !sameId(result.applicationRootId, target.applicationRootId) ||
      !sameId(result.moduleRootId, pin.moduleRootId) ||
      result.moduleReleaseRevision !== pin.moduleReleaseRevision ||
      result.applicationReleaseRevision !== target.applicationReleaseRevision
    )
      throw fail("APPLICATION_INSTALLATION_FAILED");
    provisioned.push(result);
  }
  return provisioned;
};

export const summary = (
  result: ApplicationInstallationLifecycleResult,
): ActiveApplicationInstallationSummary => ({
  organizationId: result.organizationId,
  applicationRootId: result.applicationRootId,
  applicationReleaseRevision: result.applicationReleaseRevision,
  moduleBindings: result.moduleBindings,
});

/** Prove the complete exact pin set before changing any contribution mapping. */
export const requireExactBindings = (
  target: ReleaseTarget,
  pins: readonly ModulePin[],
  bindings: readonly ModuleInstallationBinding[],
  state: "active" | "detached" | "provisioned",
): void => {
  const byRoot = new Map(
    bindings.map((binding) => [canonicalModuleRootId(binding.moduleRootId), binding]),
  );
  if (
    bindings.length !== pins.length ||
    byRoot.size !== pins.length ||
    pins.some((pin) => {
      const binding = byRoot.get(pin.moduleRootId);
      return (
        binding === undefined ||
        binding.state !== state ||
        !sameId(binding.organizationId, target.organizationId) ||
        !sameId(binding.applicationRootId, target.applicationRootId) ||
        binding.applicationReleaseRevision !== target.applicationReleaseRevision ||
        binding.moduleReleaseRevision !== pin.moduleReleaseRevision
      );
    })
  )
    throw fail("APPLICATION_INSTALLATION_STALE");
};

/** Compare complete sets without collapsing duplicate identities into a map. */
export const sameUniqueEvidence = <Value>(
  left: readonly Value[],
  right: readonly Value[],
  identity: (value: Value) => string,
  evidence: (value: Value) => string,
): boolean => {
  if (left.length !== right.length) return false;
  const ordered = (values: readonly Value[]) =>
    values
      .map((value) => ({ identity: identity(value), evidence: evidence(value) }))
      .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const oldEntries = ordered(left);
  const newEntries = ordered(right);
  return (
    new Set(oldEntries.map((entry) => entry.identity)).size === left.length &&
    new Set(newEntries.map((entry) => entry.identity)).size === right.length &&
    oldEntries.every(
      (entry, index) =>
        entry.identity === newEntries[index]!.identity &&
        entry.evidence === newEntries[index]!.evidence,
    )
  );
};

/** The full immutable release evidence; request-specific correlation is not release identity. */
export const releaseEvidenceKey = (release: PermissionRegistryDefinitionRelease): string =>
  JSON.stringify([
    release.kind,
    release.rootId,
    release.definitionKey,
    release.releaseRevision,
    release.releaseVersion,
    release.validationContractVersion,
    release.contentFingerprint,
    release.resolutionFingerprint,
  ]);

const permissionIdentity = (entry: PermissionRegistryEntryCandidate): string =>
  JSON.stringify([
    entry.applicationRootId,
    entry.ownerKind,
    entry.ownerId,
    entry.permission.permissionId,
  ]);

/** Used only after each candidate has been verified against its own exact release. */
const permissionAuthorityKey = (entry: PermissionRegistryEntryCandidate): string =>
  JSON.stringify([
    permissionIdentity(entry),
    canonicalJson({
      key: entry.permission.key,
      recordTypeId: entry.permission.recordTypeId ?? null,
      actionKind: entry.permission.actionKind,
      namedAction: entry.permission.namedAction ?? null,
      administrative: entry.permission.administrative,
      recordScope: entry.permission.recordScope ?? null,
      fieldPolicy: entry.permission.fieldPolicy ?? null,
    }),
    entry.ownerKind === "application"
      ? [
          entry.sourceRelease.kind,
          entry.sourceRelease.rootId,
          entry.sourceRelease.definitionKey,
          entry.sourceRelease.validationContractVersion,
        ]
      : releaseEvidenceKey(entry.sourceRelease),
  ]);

export const samePermissionAuthority = (
  left: readonly PermissionRegistryEntryCandidate[],
  right: readonly PermissionRegistryEntryCandidate[],
): boolean => sameUniqueEvidence(left, right, permissionIdentity, permissionAuthorityKey);

export const changeContributions = async (
  transaction: RequestDatabaseTransaction,
  target: ReleaseTarget,
  groups: readonly ContributionGroup[],
  bindings: readonly Pick<
    ModuleInstallationBinding,
    "moduleRootId" | "bindingRevision" | "applicationReleaseRevision" | "moduleReleaseRevision"
  >[],
  mode: "attach" | "detach",
): Promise<boolean> => {
  const byRoot = new Map(
    bindings.map((binding) => [canonicalModuleRootId(binding.moduleRootId), binding]),
  );
  if (byRoot.size !== bindings.length) throw fail("APPLICATION_INSTALLATION_FAILED");
  let changed = false;
  for (const group of groups) {
    const binding = byRoot.get(group.moduleRootId);
    if (
      binding === undefined ||
      binding.applicationReleaseRevision !== target.applicationReleaseRevision ||
      binding.moduleReleaseRevision !== group.moduleReleaseRevision
    )
      throw fail("APPLICATION_INSTALLATION_FAILED");
    const command = {
      applicationRootId: target.applicationRootId,
      applicationReleaseRevision: target.applicationReleaseRevision,
      moduleRootId: group.moduleRootId,
      moduleReleaseRevision: group.moduleReleaseRevision,
      expectedBindingRevision: binding.bindingRevision,
      mode,
      contributions: group.contributions,
    };
    const result = await changeModuleContributionStorage(transaction, command, mode);
    const expectedIds = new Set(
      group.contributions.map((item) => item.contributionId.toLowerCase()),
    );
    const actualIds = result.contributionIds.map((id) => id.toLowerCase());
    if (
      !sameId(result.applicationRootId, target.applicationRootId) ||
      result.applicationReleaseRevision !== target.applicationReleaseRevision ||
      !sameId(result.moduleRootId, group.moduleRootId) ||
      result.moduleReleaseRevision !== group.moduleReleaseRevision ||
      result.state !== (mode === "attach" ? "attached" : "detached") ||
      result.bindingRevision !== binding.bindingRevision ||
      actualIds.length !== expectedIds.size ||
      new Set(actualIds).size !== expectedIds.size ||
      actualIds.some((id) => !expectedIds.has(id))
    )
      throw fail("APPLICATION_INSTALLATION_FAILED");
    changed = changed || result.changed;
  }
  return changed;
};

export const requireLifecycleResult = (
  result: ApplicationInstallationLifecycleResult,
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
  applicationReleaseRevision: number,
  state: "active" | "detached",
): ApplicationInstallationLifecycleResult => {
  if (
    !sameId(result.organizationId, organizationId) ||
    !sameId(result.applicationRootId, applicationRootId) ||
    result.applicationReleaseRevision !== applicationReleaseRevision ||
    result.state !== state
  )
    throw fail("APPLICATION_INSTALLATION_FAILED");
  return result;
};
