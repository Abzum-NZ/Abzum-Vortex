import "server-only";

import { z } from "zod";
import { createBuilderAuthority } from "../access/index";
import {
  applicationRootIdSchema,
  canonicalJson,
  moduleInstallationBindingEvidenceSchema,
  organizationIdSchema,
  revisionSchema,
  sameId,
  type IdentitySession,
} from "../schema";
import {
  installationProblem,
  installationTargetFacts,
  readBuilderOperationDeadlines,
  readInstallationDatabaseTime,
  readInstallationHumanContext,
  readInstallationOrdinaryRoot,
  requireInstallationAuthority,
} from "./installation-authority";
import { readInstallationBindings, sortedBindingTuples } from "./installation-binding-reader";
import { createApplicationInstallationCoordinator } from "./installation-coordinator";
import type { FirstInstallCoordinatorEnvironment } from "./installation-first-install-coordinator";
import { readFirstInstallReleaseSet } from "./installation-first-install";
import { resolveModuleContributions } from "./extension-contributions";
import { DefinitionError } from "./definition-error";

const removalExpectedSchema = z
  .object({
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
    moduleBindings: z.array(moduleInstallationBindingEvidenceSchema).min(1).max(10_000),
  })
  .strict();

type RemovalExpected = z.infer<typeof removalExpectedSchema>;

const removalOperation = (rootId: string, containsCustomComponents: boolean) => ({
  kind: "installation" as const,
  applicationRootId: rootId,
  change: "uninstall" as const,
  containsCustomComponents,
  acceptedPermissions: [],
});

/** Reads only a complete active ordinary installation under the installer's current authority. */
export const readApplicationRemoval = async (
  environment: FirstInstallCoordinatorEnvironment,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  rootId: z.infer<typeof applicationRootIdSchema>,
) => {
  let failure: unknown;
  const result = await environment.requests.runChange(
    session,
    { organizationId },
    async (transaction, scope, issuedAt) => {
      try {
        const context = await readInstallationHumanContext(transaction, scope, session, issuedAt, {
          organizationId,
        });
        await readInstallationOrdinaryRoot(transaction, rootId);
        const bindings = await readInstallationBindings(transaction, rootId);
        const revision = bindings.registeredReleaseRevision;
        if (
          revision === null ||
          bindings.moduleBindings.length === 0 ||
          bindings.moduleBindings.some(
            (binding) =>
              binding.state !== "detached" &&
              (binding.state !== "active" || binding.applicationReleaseRevision !== revision),
          )
        )
          installationProblem("removal_not_active", "conflict");
        const active = bindings.moduleBindings.filter((binding) => binding.state === "active");
        if (active.length === 0) installationProblem("removal_not_active", "conflict");
        const releaseSet = await readFirstInstallReleaseSet(
          transaction,
          environment.catalogue,
          {
            organizationId,
            rootId,
            releaseRevision: revision,
          },
          context,
        );
        const operation = removalOperation(
          rootId,
          environment.containsCustomComponents(releaseSet),
        );
        await requireInstallationAuthority(transaction, scope, environment.permissions, operation);
        const deadlines = await readBuilderOperationDeadlines(
          transaction,
          scope,
          context,
          environment.permissions,
          operation,
        );
        const checkedAt = await readInstallationDatabaseTime(transaction);
        if (
          Date.parse(checkedAt) >=
          Math.min(
            Date.parse(context.expiresAt),
            ...deadlines.map((deadline) => Date.parse(deadline)),
          )
        )
          installationProblem("removal_authority_lapsed", "refused");
        return {
          releaseSet,
          expected: removalExpectedSchema.parse({
            organizationId,
            applicationRootId: rootId,
            applicationReleaseRevision: revision,
            moduleBindings: bindings.moduleBindings,
          }),
        };
      } catch (error) {
        failure = error;
        throw error;
      }
    },
  );
  if (result.kind === "available") return result.value;
  if (failure !== undefined) throw failure;
  installationProblem(
    "removal_read_unavailable",
    result.kind === "unavailable" ? "refused" : "temporarily_unavailable",
  );
};

const sameRemoval = (left: RemovalExpected, right: RemovalExpected): boolean =>
  sameId(left.organizationId, right.organizationId) &&
  sameId(left.applicationRootId, right.applicationRootId) &&
  left.applicationReleaseRevision === right.applicationReleaseRevision &&
  canonicalJson(sortedBindingTuples(left.moduleBindings)) ===
    canonicalJson(sortedBindingTuples(right.moduleBindings));

/**
 * One removal step: reuse the atomic withdrawal lifecycle, with current authority and the complete
 * reviewed binding revisions checked inside its write transaction. Storage and records survive;
 * Access withdraws permissions and makes application roles and their assignments ineffective.
 */
export const removeApplication = async (
  environment: FirstInstallCoordinatorEnvironment,
  session: IdentitySession,
  organizationId: z.infer<typeof organizationIdSchema>,
  rootId: z.infer<typeof applicationRootIdSchema>,
  expectedCandidate: unknown,
) => {
  const parsed = removalExpectedSchema.safeParse(expectedCandidate);
  if (
    !parsed.success ||
    !sameId(parsed.data.organizationId, organizationId) ||
    !sameId(parsed.data.applicationRootId, rootId)
  )
    installationProblem("removal_expectation_invalid", "conflict");
  const expected = parsed.data;
  const current = await readApplicationRemoval(environment, session, organizationId, rootId);
  if (!sameRemoval(expected, current.expected)) installationProblem("removal_changed", "conflict");
  const operation = removalOperation(
    rootId,
    environment.containsCustomComponents(current.releaseSet),
  );
  const coordinator = createApplicationInstallationCoordinator({
    installerRequests: {
      runAccessChange: async (requestSession, selection, callback) => {
        let failure: unknown;
        const result = await environment.requests.runAccessChange(
          requestSession,
          selection,
          async (transaction, scope, issuedAt) => {
            try {
              const context = await readInstallationHumanContext(
                transaction,
                scope,
                requestSession,
                issuedAt,
                { organizationId },
              );
              await requireInstallationAuthority(
                transaction,
                scope,
                environment.permissions,
                operation,
              );
              const before = await readInstallationBindings(transaction, rootId);
              if (
                !sameRemoval(expected, {
                  organizationId: before.organizationId,
                  applicationRootId: before.applicationRootId,
                  applicationReleaseRevision: before.registeredReleaseRevision ?? 0,
                  moduleBindings: before.moduleBindings,
                })
              )
                throw new DefinitionError("APPLICATION_INSTALLATION_STALE");
              const deadlines = await readBuilderOperationDeadlines(
                transaction,
                scope,
                context,
                environment.permissions,
                operation,
              );
              const value = await callback(transaction, scope, issuedAt);
              const completedAt = await readInstallationDatabaseTime(transaction);
              if (
                Date.parse(completedAt) >=
                Math.min(
                  Date.parse(context.expiresAt),
                  ...deadlines.map((deadline) => Date.parse(deadline)),
                )
              )
                throw new DefinitionError("APPLICATION_INSTALLATION_REFUSED");
              return value;
            } catch (error) {
              failure = error;
              throw error;
            }
          },
        );
        if (failure !== undefined) throw failure;
        return result;
      },
    },
    resolveModuleContributions,
    containsCustomComponents: environment.containsCustomComponents,
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({
        transaction,
        scope,
        permissions: environment.permissions,
        targetFacts: installationTargetFacts,
      }),
    humanDefinitionAccess: {
      readReleaseSet: async (_session, target) => {
        if (
          !sameId(target.organizationId, organizationId) ||
          !sameId(target.applicationRootId, rootId) ||
          target.applicationReleaseRevision !== expected.applicationReleaseRevision
        )
          installationProblem("removal_release_mismatch", "refused");
        return current.releaseSet;
      },
      prepareRegistrationCandidate: async () => {
        throw new Error("REMOVAL_CANNOT_REGISTER_ACCESS");
      },
    },
  });
  await coordinator.withdraw(session, {
    organizationId,
    applicationRootId: rootId,
    applicationReleaseRevision: expected.applicationReleaseRevision,
  });
  return { application_name: current.releaseSet.application.content.name };
};
