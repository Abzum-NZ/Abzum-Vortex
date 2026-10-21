import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  canonicalJson,
  sameId,
  systemApplicationBoundReleaseSetResultSchema,
  type ApplicationRootId,
  type OrganizationId,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import { DefinitionError, classifyDatabaseError } from "./definition-error";
import { createDatabaseFirstInstallApplicationReleaseSetService } from "./application-bound-release-set";
import {
  installationProblem,
  refuseInstallationAuthority,
  type InstallationHumanContext,
} from "./installation-authority";
import { releaseSetModuleTuples, type InstallationBindings } from "./installation-binding-reader";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";

type FirstInstallUnavailableReason =
  | "release_not_published"
  | "already_installed"
  | "installation_incomplete"
  | "setup_unavailable"
  | "unsupported_root";

/** The first install cannot proceed; `code` is the reason because describeFailure logs the class and code. */
export class FirstInstallUnavailable extends Error {
  readonly code: string;
  constructor(readonly reason: FirstInstallUnavailableReason) {
    super(reason);
    this.name = "FirstInstallUnavailable";
    this.code = reason;
  }
}

export const firstInstallUnavailable = (reason: FirstInstallUnavailableReason): never => {
  throw new FirstInstallUnavailable(reason);
};

export type FirstInstallSelector = Readonly<{
  organizationId: OrganizationId;
  rootId: ApplicationRootId;
  releaseRevision: number;
}>;

/**
 * The application's latest published version, which an install is anchored to. It is read under
 * the installation authority alone: installing never needs a right on the application's draft.
 */
export type ApplicationLatestRelease = Readonly<{
  definitionKey: string;
  releaseRevision: number;
  releaseVersion: string;
  releaseNote: string;
}>;

export type FirstInstallRegistrationState =
  | "unprepared"
  | "registration_aligned_partial"
  | "provisioned_inactive"
  | "active_exact";

const sameContent = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/** Whether two bound release sets are the same release, ignoring each read's request correlation. */
export const sameFirstInstallRelease = (
  left: SystemApplicationBoundReleaseSetResult,
  right: SystemApplicationBoundReleaseSetResult,
): boolean => {
  const withoutCorrelation = (value: SystemApplicationBoundReleaseSetResult) => {
    const omit = (entry: object) =>
      Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "correlationId"));
    return { application: omit(value.application), modules: value.modules.map(omit) };
  };
  return sameContent(withoutCorrelation(left), withoutCorrelation(right));
};

const moduleSetFingerprint = (releaseSet: SystemApplicationBoundReleaseSetResult): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify(["application-first-install-module-set-v1", releaseSetModuleTuples(releaseSet)]),
      "utf8",
    )
    .digest("hex")}`;

export const firstInstallSelectedIdentity = (releaseSet: SystemApplicationBoundReleaseSetResult) => ({
  definitionKey: releaseSet.application.definitionKey,
  releaseRevision: releaseSet.application.releaseRevision,
  releaseVersion: releaseSet.application.releaseVersion,
  validationContractVersion: releaseSet.application.validationContractVersion,
  contentFingerprint: releaseSet.application.contentFingerprint,
  resolutionFingerprint: releaseSet.application.resolutionFingerprint,
  moduleSetFingerprint: moduleSetFingerprint(releaseSet),
});

/** Classifies the application's registration against the selected release's module set. */
export const firstInstallState = (
  selector: FirstInstallSelector,
  releaseSet: SystemApplicationBoundReleaseSetResult,
  bindings: InstallationBindings,
): FirstInstallRegistrationState => {
  const pinned = new Map(releaseSet.modules.map((module) => [module.rootId.toLowerCase(), module]));
  if (pinned.size !== releaseSet.modules.length || pinned.size === 0)
    firstInstallUnavailable("setup_unavailable");
  if (
    bindings.moduleBindings.some(
      (binding) =>
        !sameId(binding.organizationId, selector.organizationId) ||
        !sameId(binding.applicationRootId, selector.rootId) ||
        binding.state === "draining",
    )
  )
    firstInstallUnavailable("installation_incomplete");
  if (bindings.registeredReleaseRevision === null) {
    if (bindings.moduleBindings.some((binding) => binding.state !== "detached"))
      firstInstallUnavailable("installation_incomplete");
    return "unprepared";
  }
  if (bindings.registeredReleaseRevision !== selector.releaseRevision)
    firstInstallUnavailable("already_installed");

  const nonDetached = bindings.moduleBindings.filter((binding) => binding.state !== "detached");
  if (
    new Set(nonDetached.map((binding) => binding.moduleRootId.toLowerCase())).size !==
      nonDetached.length ||
    nonDetached.some((binding) => !pinned.has(binding.moduleRootId.toLowerCase()))
  )
    firstInstallUnavailable("installation_incomplete");
  const expected = releaseSet.modules;
  const exactState = (state: "active" | "provisioned") =>
    expected.every((module) => {
      const matches = nonDetached.filter(
        (binding) =>
          sameId(binding.moduleRootId, module.rootId) &&
          binding.applicationReleaseRevision === selector.releaseRevision &&
          binding.moduleReleaseRevision === module.releaseRevision &&
          binding.state === state,
      );
      return matches.length === 1;
    }) && nonDetached.length === expected.length;
  if (
    nonDetached.some((binding) => {
      const module = pinned.get(binding.moduleRootId.toLowerCase());
      return (
        module === undefined ||
        binding.state !== "provisioned" ||
        binding.applicationReleaseRevision !== selector.releaseRevision ||
        binding.moduleReleaseRevision !== module.releaseRevision
      );
    })
  ) {
    if (exactState("active")) return "active_exact";
    firstInstallUnavailable("installation_incomplete");
  }
  if (exactState("active")) return "active_exact";
  if (exactState("provisioned")) return "provisioned_inactive";
  return "registration_aligned_partial";
};

const latestReleaseSchema = z
  .object({
    definitionKey: z.string().min(1),
    releaseRevision: z.number().int().positive(),
    releaseVersion: z.string().min(1),
    releaseNote: z.string(),
  })
  .strict();

/**
 * The latest published version of the application, as a person who may manage the organisation's
 * installations reads it. An application with no published version cannot be installed.
 */
export const readApplicationLatestRelease = async (
  transaction: RequestDatabaseTransaction,
  rootId: ApplicationRootId,
): Promise<ApplicationLatestRelease> => {
  let rows: readonly DatabaseRow[];
  try {
    rows = await transaction.query<DatabaseRow>`
      select vortex_definition.read_application_latest_release(${rootId}::uuid) as latest
    `;
  } catch (error) {
    // The database reads the latest release only for a person who may manage applications.
    if (classifyDatabaseError(error) === "refused") return refuseInstallationAuthority(error);
    throw error;
  }
  if (rows.length !== 1) return installationProblem("latest_release_unreadable", "temporarily_unavailable");
  if (rows[0]?.latest === null) return firstInstallUnavailable("release_not_published");
  const parsed = latestReleaseSchema.safeParse(rows[0]?.latest);
  if (!parsed.success)
    return installationProblem("latest_release_invalid", "temporarily_unavailable", undefined, {
      cause: parsed.error,
    });
  return parsed.data;
};

/** Proves the latest published version is still the one the first install was anchored to. */
export const firstInstallLatestReleaseMatches = async (
  transaction: RequestDatabaseTransaction,
  selector: FirstInstallSelector,
  anchored: ApplicationLatestRelease,
): Promise<void> => {
  const current = await readApplicationLatestRelease(transaction, selector.rootId);
  if (!sameContent(current, anchored) || selector.releaseRevision > current.releaseRevision)
    installationProblem("first_install_latest_release_moved", "conflict");
};

/**
 * Reads the selected release's bound release set for a first install and proves it belongs to this
 * organisation and request correlation and names this application and revision.
 */
export const readFirstInstallReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition,
  selector: FirstInstallSelector,
  context: InstallationHumanContext,
): Promise<SystemApplicationBoundReleaseSetResult> => {
  let candidate: unknown;
  try {
    candidate = await createDatabaseFirstInstallApplicationReleaseSetService(
      catalogue,
      transaction,
    ).read({
      applicationRootId: selector.rootId,
      applicationReleaseRevision: selector.releaseRevision,
    });
  } catch (error) {
    if (!(error instanceof DefinitionError))
      installationProblem(
        "first_install_release_set_read_failed",
        "temporarily_unavailable",
        undefined,
        { cause: error },
      );
    if (error.code === "DEFINITION_RELEASE_NOT_FOUND")
      firstInstallUnavailable("release_not_published");
    if (error.code === "DEFINITION_CONTEXT_REFUSED" || error.code === "DEFINITION_RELEASE_INTEGRITY_FAILED")
      installationProblem("first_install_release_set_refused", "refused", undefined, {
        cause: error,
      });
    installationProblem(
      "first_install_release_set_read_failed",
      "temporarily_unavailable",
      undefined,
      { cause: error },
    );
  }
  const parsed = systemApplicationBoundReleaseSetResultSchema.safeParse(candidate);
  if (
    !parsed.success ||
    parsed.data.application.kind !== "application" ||
    !sameId(parsed.data.application.organizationId, context.organizationId) ||
    !sameId(parsed.data.application.rootId, selector.rootId) ||
    parsed.data.application.releaseRevision !== selector.releaseRevision ||
    !sameId(parsed.data.application.correlationId, context.correlationId) ||
    parsed.data.modules.some(
      (module) =>
        !sameId(module.organizationId, context.organizationId) ||
        !sameId(module.correlationId, context.correlationId),
    )
  )
    installationProblem("first_install_release_set_mismatch", "refused", undefined, {
      cause: parsed.success ? undefined : parsed.error,
    });
  return parsed.data;
};

/** Whether the bound release set is the selected release of the application the install is anchored to. */
export const firstInstallSetMatchesLatest = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  latest: ApplicationLatestRelease,
  selector: FirstInstallSelector,
): boolean =>
  sameId(releaseSet.application.rootId, selector.rootId) &&
  releaseSet.application.releaseRevision === selector.releaseRevision &&
  releaseSet.application.definitionKey === latest.definitionKey &&
  (selector.releaseRevision !== latest.releaseRevision ||
    releaseSet.application.releaseVersion === latest.releaseVersion);
