import "server-only";

import { z } from "zod";
import {
  activeApplicationInstallationEvidenceSchema,
  applicationRootIdSchema,
  canonicalJson,
  moduleInstallationBindingEvidenceSchema,
  organizationIdSchema,
  sameId,
  type ActiveApplicationInstallationErrorCode,
  type ActiveApplicationInstallationEvidence,
  type ModuleInstallationBindingEvidence,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { createDatabaseApplicationReleaseAdoptionReleaseSetService } from "./application-bound-release-set";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";
import { InstallationProblem, installationProblem } from "./installation-authority";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

type ActiveInstallationRow = DatabaseRow & { readonly active_installation: unknown };

const mapFailure = (error: unknown): DefinitionError<ActiveApplicationInstallationErrorCode> => {
  if (error instanceof DefinitionError) return error;
  switch (classifyDatabaseError(error)) {
    case "refused":
    case "invalid":
      return new DefinitionError("ACTIVE_APPLICATION_CONTEXT_REFUSED", { cause: error });
    case "not_found":
      return new DefinitionError("ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE", { cause: error });
    case "constraint_failed":
    case "wrong_state":
      return new DefinitionError("ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE", { cause: error });
    default:
      return unexpectedDefinitionFailure(
        "ACTIVE_APPLICATION_INSTALLATION_READ_FAILED",
        error,
        "active installation read",
      );
  }
};

export interface ActiveApplicationInstallationRepository {
  readCurrent(): Promise<ActiveApplicationInstallationEvidence>;
}

/** Reads only the active installation selected by trusted human application context. */
export const createActiveApplicationInstallationRepository = (
  transaction: RequestDatabaseTransaction,
): ActiveApplicationInstallationRepository =>
  Object.freeze({
    async readCurrent() {
      try {
        const rows = await transaction.query<ActiveInstallationRow>`
          select vortex_definition.read_current_active_installation() as active_installation
        `;
        if (rows.length !== 1 || rows[0] === undefined || rows[0].active_installation === null)
          throw new DefinitionError("ACTIVE_APPLICATION_INSTALLATION_UNAVAILABLE");
        const result = activeApplicationInstallationEvidenceSchema.safeParse(
          rows[0].active_installation,
        );
        if (!result.success)
          throw unexpectedDefinitionFailure(
            "ACTIVE_APPLICATION_INSTALLATION_INCOMPLETE",
            result.error,
            "installation-binding-reader",
          );
        return result.data;
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });

export const installationBindingsSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    registeredReleaseRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).max(10_000),
  })
  .strict();

export type InstallationBindings = z.infer<typeof installationBindingsSchema>;

/** The module bindings registered for one application, read through the database's own reader. */
export const readInstallationBindings = async (
  transaction: RequestDatabaseTransaction,
  rootId: string,
): Promise<InstallationBindings> => {
  // The reader takes the installation authority lock; its refusal is the installer lacking the
  // delegated management of the organisation catalogue. Manage applications is proved before it
  // (the latest release read), so the first missing piece is named in that order.
  const rows = await transaction.query<DatabaseRow>`
      select vortex_definition.read_application_installation_bindings(${rootId}::uuid) as bindings
    `.catch((error: unknown) => {
    if (classifyDatabaseError(error) === "refused")
      throw new InstallationProblem(
        { kind: "refused", memberRoleRefusal: "member_role_delegation" },
        "installation_delegation_refused",
        { cause: error },
      );
    throw error;
  });
  if (rows.length !== 1)
    installationProblem("bindings_row_missing", "refused", "installation_incomplete");
  const parsed = installationBindingsSchema.safeParse(rows[0]?.bindings);
  if (!parsed.success || !sameId(parsed.data.applicationRootId, rootId))
    installationProblem("bindings_unreadable", "refused", "installation_incomplete", {
      cause: parsed.success ? undefined : parsed.error,
    });
  return parsed.data;
};

const bindingTuple = (binding: ModuleInstallationBindingEvidence): readonly unknown[] => [
  binding.organizationId.toLowerCase(),
  binding.applicationRootId.toLowerCase(),
  binding.moduleRootId.toLowerCase(),
  binding.bindingRevision,
  binding.applicationReleaseRevision,
  binding.moduleReleaseRevision,
  binding.state,
];

/** Bindings as order-independent tuples, so two binding sets compare by exact content. */
export const sortedBindingTuples = (
  bindings: readonly ModuleInstallationBindingEvidence[],
): readonly (readonly unknown[])[] =>
  bindings.map(bindingTuple).sort((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

/** Release-set modules as order-independent tuples, so two sets compare by exact content. */
export const releaseSetModuleTuples = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
): readonly unknown[][] =>
  releaseSet.modules
    .map((module) => [
      module.organizationId.toLowerCase(),
      module.rootId.toLowerCase(),
      module.definitionKey,
      module.releaseRevision,
      module.releaseVersion,
      module.validationContractVersion,
      module.contentFingerprint,
      module.resolutionFingerprint,
    ])
    .sort((left, right) =>
      String(left[1]) < String(right[1]) ? -1 : String(left[1]) > String(right[1]) ? 1 : 0,
    );

export const sameActiveBindings = (
  candidate: unknown,
  expected: readonly ModuleInstallationBindingEvidence[],
): boolean => {
  const parsed = z.array(moduleInstallationBindingEvidenceSchema).max(10_000).safeParse(candidate);
  return (
    parsed.success &&
    canonicalJson(sortedBindingTuples(parsed.data)) === canonicalJson(sortedBindingTuples(expected))
  );
};

/**
 * Reads one application release's bound release set and proves it belongs to this organisation
 * and request correlation, names this application and revision, and lists each module root once.
 */
export const readInstallationReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition,
  rootId: string,
  releaseRevision: number,
  organizationId: string,
  correlationId: string,
  purpose: "consume" | "replace_or_remove" = "consume",
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let releaseSet: SystemApplicationBoundReleaseSetResult;
  try {
    // The read returns the release set already parsed against its result schema.
    releaseSet = await createDatabaseApplicationReleaseAdoptionReleaseSetService(
      catalogue,
      transaction,
      purpose,
    ).read({ applicationRootId: rootId, applicationReleaseRevision: releaseRevision });
  } catch (error) {
    if (error instanceof DefinitionError && error.code === "DEFINITION_DEPENDENCY_SUPERSEDED")
      installationProblem("DEFINITION_DEPENDENCY_SUPERSEDED", "refused", "republish_required", {
        cause: error,
      });
    if (!(error instanceof DefinitionError) || error.code === "DEFINITION_READ_FAILED")
      installationProblem("release_set_read_failed", "temporarily_unavailable", undefined, {
        cause: error,
      });
    installationProblem("release_set_refused", "refused", undefined, { cause: error });
  }
  if (
    releaseSet.modules.length === 0 ||
    releaseSet.application.kind !== "application" ||
    !sameId(releaseSet.application.organizationId, organizationId) ||
    !sameId(releaseSet.application.rootId, rootId) ||
    releaseSet.application.releaseRevision !== releaseRevision ||
    !sameId(releaseSet.application.correlationId, correlationId)
  )
    installationProblem("release_set_mismatch", "refused");
  const roots = new Set<string>();
  for (const module of releaseSet.modules) {
    if (
      !sameId(module.organizationId, organizationId) ||
      !sameId(module.correlationId, correlationId) ||
      roots.has(module.rootId.toLowerCase())
    )
      installationProblem("release_set_module_mismatch", "refused");
    roots.add(module.rootId.toLowerCase());
  }
  return releaseSet;
};
