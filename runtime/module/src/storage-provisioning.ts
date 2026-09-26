import "server-only";

import {
  moduleInstallationStorageCommandSchema,
  moduleInstallationStorageResultSchema,
  type ModuleInstallationStorageCommand,
  type ModuleInstallationStorageErrorCode,
  type ModuleInstallationStorageResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export class ModuleInstallationStorageError extends Error {
  readonly code: ModuleInstallationStorageErrorCode;

  constructor(code: ModuleInstallationStorageErrorCode) {
    super(code);
    this.name = "ModuleInstallationStorageError";
    this.code = code;
  }
}

type ProvisionRow = DatabaseRow & {
  readonly state: unknown;
  readonly changed: unknown;
  readonly binding_revision: unknown;
  readonly application_root_id: unknown;
  readonly application_release_revision: unknown;
  readonly module_root_id: unknown;
  readonly module_release_revision: unknown;
  readonly storage_contract_ids: unknown;
};

const safeRevision = (value: unknown): number | undefined => {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  if (typeof value === "bigint") {
    const candidate = Number(value);
    return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : undefined;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) ? candidate : undefined;
};

const parseResult = (row: ProvisionRow): ModuleInstallationStorageResult => {
  const result = moduleInstallationStorageResultSchema.safeParse({
    state: row.state,
    changed: row.changed,
    bindingRevision: safeRevision(row.binding_revision),
    applicationRootId: row.application_root_id,
    applicationReleaseRevision: safeRevision(row.application_release_revision),
    moduleRootId: row.module_root_id,
    moduleReleaseRevision: safeRevision(row.module_release_revision),
    storageContractIds: row.storage_contract_ids,
  });
  if (!result.success)
    throw new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
  return result.data;
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): ModuleInstallationStorageError => {
  if (error instanceof ModuleInstallationStorageError) return error;
  switch (databaseCode(error)) {
    case "22023":
      return new ModuleInstallationStorageError("INVALID_MODULE_INSTALLATION_STORAGE_COMMAND");
    case "42501":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_AUTHORITY_REFUSED");
    case "P0002":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_RELEASE_UNAVAILABLE");
    case "23514":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_RELEASE_MISMATCH");
    case "40001":
      return new ModuleInstallationStorageError("MODULE_INSTALLATION_BINDING_CONFLICT");
    case "55000":
      return new ModuleInstallationStorageError("RECORD_STORAGE_INCOMPATIBLE");
    default:
      return new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
  }
};

/**
 * One resolved additive contribution binding, exactly as the definition tier's
 * #717 resolver emits it. The storage tier consumes an already-resolved binding
 * and re-validates it in the database; it never invents an identity from input.
 */
export type ResolvedContributionBinding = Readonly<{
  contributionId: string;
  kind: "field" | "action";
  contributorModuleRootId: string;
  contributorReleaseVersion: string;
  targetModuleRootId: string;
  targetModuleReleaseVersion: string;
  targetExtensionPointId: string;
  targetRecordTypeId: string;
  recordTypeId?: string;
  fieldId?: string;
  actionId?: string;
}>;

/** Attach or detach one contributor Module's resolved bindings on its target storage. */
export type ModuleContributionStorageCommand = Readonly<{
  applicationRootId: string;
  applicationReleaseRevision: number;
  moduleRootId: string;
  moduleReleaseRevision: number;
  expectedBindingRevision: number | null;
  mode: "attach" | "detach";
  contributions: readonly ResolvedContributionBinding[];
}>;

export type ModuleContributionStorageResult = Readonly<{
  state: "attached" | "detached";
  changed: boolean;
  bindingRevision: number;
  applicationRootId: string;
  applicationReleaseRevision: number;
  moduleRootId: string;
  moduleReleaseRevision: number;
  contributionIds: readonly string[];
}>;

type ContributionRow = DatabaseRow & {
  readonly state: unknown;
  readonly changed: unknown;
  readonly binding_revision: unknown;
  readonly application_root_id: unknown;
  readonly application_release_revision: unknown;
  readonly module_root_id: unknown;
  readonly module_release_revision: unknown;
  readonly contribution_ids: unknown;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isNonNilUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  uuidPattern.test(value) &&
  value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";

const isSafeRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const parseContributionBinding = (
  candidate: unknown,
): ResolvedContributionBinding | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const binding = candidate as Record<string, unknown>;
  if (
    !isNonNilUuid(binding.contributionId) ||
    (binding.kind !== "field" && binding.kind !== "action") ||
    !isNonNilUuid(binding.contributorModuleRootId) ||
    typeof binding.contributorReleaseVersion !== "string" ||
    binding.contributorReleaseVersion.length === 0 ||
    !isNonNilUuid(binding.targetModuleRootId) ||
    typeof binding.targetModuleReleaseVersion !== "string" ||
    binding.targetModuleReleaseVersion.length === 0 ||
    !isNonNilUuid(binding.targetExtensionPointId) ||
    !isNonNilUuid(binding.targetRecordTypeId)
  )
    return undefined;
  if (binding.kind === "field") {
    if (
      !isNonNilUuid(binding.recordTypeId) ||
      !isNonNilUuid(binding.fieldId) ||
      binding.fieldId.toLowerCase() !== binding.contributionId.toLowerCase()
    )
      return undefined;
    return Object.freeze({
      contributionId: binding.contributionId,
      kind: "field",
      contributorModuleRootId: binding.contributorModuleRootId,
      contributorReleaseVersion: binding.contributorReleaseVersion,
      targetModuleRootId: binding.targetModuleRootId,
      targetModuleReleaseVersion: binding.targetModuleReleaseVersion,
      targetExtensionPointId: binding.targetExtensionPointId,
      targetRecordTypeId: binding.targetRecordTypeId,
      recordTypeId: binding.recordTypeId,
      fieldId: binding.fieldId,
    });
  }
  if (
    !isNonNilUuid(binding.actionId) ||
    binding.actionId.toLowerCase() !== binding.contributionId.toLowerCase()
  )
    return undefined;
  return Object.freeze({
    contributionId: binding.contributionId,
    kind: "action",
    contributorModuleRootId: binding.contributorModuleRootId,
    contributorReleaseVersion: binding.contributorReleaseVersion,
    targetModuleRootId: binding.targetModuleRootId,
    targetModuleReleaseVersion: binding.targetModuleReleaseVersion,
    targetExtensionPointId: binding.targetExtensionPointId,
    targetRecordTypeId: binding.targetRecordTypeId,
    actionId: binding.actionId,
  });
};

const parseContributionCommand = (
  candidate: unknown,
): ModuleContributionStorageCommand | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const command = candidate as Record<string, unknown>;
  if (
    !isNonNilUuid(command.applicationRootId) ||
    !isSafeRevision(command.applicationReleaseRevision) ||
    !isNonNilUuid(command.moduleRootId) ||
    !isSafeRevision(command.moduleReleaseRevision) ||
    (command.expectedBindingRevision !== null &&
      !isSafeRevision(command.expectedBindingRevision)) ||
    (command.mode !== "attach" && command.mode !== "detach") ||
    !Array.isArray(command.contributions) ||
    command.contributions.length < 1 ||
    command.contributions.length > 100
  )
    return undefined;
  const contributions: ResolvedContributionBinding[] = [];
  const identities = new Set<string>();
  for (const candidateBinding of command.contributions) {
    const binding = parseContributionBinding(candidateBinding);
    if (binding === undefined) return undefined;
    const identity = binding.contributionId.toLowerCase();
    if (
      identities.has(identity) ||
      binding.contributorModuleRootId.toLowerCase() !== command.moduleRootId.toLowerCase() ||
      binding.targetModuleRootId.toLowerCase() === command.moduleRootId.toLowerCase()
    )
      return undefined;
    identities.add(identity);
    contributions.push(binding);
  }
  return Object.freeze({
    applicationRootId: command.applicationRootId as string,
    applicationReleaseRevision: command.applicationReleaseRevision as number,
    moduleRootId: command.moduleRootId as string,
    moduleReleaseRevision: command.moduleReleaseRevision as number,
    expectedBindingRevision: command.expectedBindingRevision as number | null,
    mode: command.mode as "attach" | "detach",
    contributions: Object.freeze(contributions),
  });
};

const parseContributionResult = (
  row: ContributionRow,
  mode: "attach" | "detach",
): ModuleContributionStorageResult => {
  const expectedState = mode === "attach" ? "attached" : "detached";
  const contributionIds =
    Array.isArray(row.contribution_ids) &&
    row.contribution_ids.every((value): value is string => isNonNilUuid(value))
      ? Object.freeze(row.contribution_ids as string[])
      : undefined;
  if (
    row.state !== expectedState ||
    typeof row.changed !== "boolean" ||
    safeRevision(row.binding_revision) === undefined ||
    !isNonNilUuid(row.application_root_id) ||
    safeRevision(row.application_release_revision) === undefined ||
    !isNonNilUuid(row.module_root_id) ||
    safeRevision(row.module_release_revision) === undefined ||
    contributionIds === undefined
  )
    throw new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
  return Object.freeze({
    state: expectedState,
    changed: row.changed,
    bindingRevision: safeRevision(row.binding_revision)!,
    applicationRootId: row.application_root_id,
    applicationReleaseRevision: safeRevision(row.application_release_revision)!,
    moduleRootId: row.module_root_id,
    moduleReleaseRevision: safeRevision(row.module_release_revision)!,
    contributionIds,
  });
};

export interface ModuleInstallationStorageRepository {
  provision(command: ModuleInstallationStorageCommand): Promise<ModuleInstallationStorageResult>;
  attachContributions(
    command: ModuleContributionStorageCommand,
  ): Promise<ModuleContributionStorageResult>;
  detachContributions(
    command: ModuleContributionStorageCommand,
  ): Promise<ModuleContributionStorageResult>;
}

/**
 * Calls the sole request-visible storage coordinator. The supplied transaction
 * already carries trusted request context; neither SQL nor physical names are inputs.
 */
export const createModuleInstallationStorageRepository = (
  transaction: RequestDatabaseTransaction,
): ModuleInstallationStorageRepository => {
  const mutateContributions = async (
    commandCandidate: ModuleContributionStorageCommand,
    mode: "attach" | "detach",
  ): Promise<ModuleContributionStorageResult> => {
    const command = parseContributionCommand(commandCandidate);
    if (command === undefined || command.mode !== mode)
      throw new ModuleInstallationStorageError("INVALID_MODULE_INSTALLATION_STORAGE_COMMAND");
    try {
      const rows = await transaction.query<ContributionRow>`
        select *
        from vortex_module.provision_module_contribution_storage(
          ${command.applicationRootId}::uuid,
          ${command.applicationReleaseRevision}::bigint,
          ${command.moduleRootId}::uuid,
          ${command.moduleReleaseRevision}::bigint,
          ${command.expectedBindingRevision}::bigint,
          ${mode}::text,
          ${JSON.stringify(command.contributions)}::text::jsonb
        )
      `;
      if (rows.length !== 1 || rows[0] === undefined)
        throw new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
      return parseContributionResult(rows[0], mode);
    } catch (error) {
      throw mapFailure(error);
    }
  };

  return Object.freeze({
    async provision(commandCandidate: ModuleInstallationStorageCommand) {
      const command = moduleInstallationStorageCommandSchema.safeParse(commandCandidate);
      if (!command.success)
        throw new ModuleInstallationStorageError("INVALID_MODULE_INSTALLATION_STORAGE_COMMAND");
      try {
        const rows = await transaction.query<ProvisionRow>`
          select *
          from vortex_module.provision_module_installation_storage(
            ${command.data.applicationRootId}::uuid,
            ${command.data.applicationReleaseRevision}::bigint,
            ${command.data.moduleRootId}::uuid,
            ${command.data.moduleReleaseRevision}::bigint,
            ${command.data.expectedBindingRevision}::bigint
          )
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new ModuleInstallationStorageError("RECORD_STORAGE_PROVISIONING_FAILED");
        return parseResult(rows[0]);
      } catch (error) {
        throw mapFailure(error);
      }
    },
    attachContributions(commandCandidate) {
      return mutateContributions(commandCandidate, "attach");
    },
    detachContributions(commandCandidate) {
      return mutateContributions(commandCandidate, "detach");
    },
  });
};
