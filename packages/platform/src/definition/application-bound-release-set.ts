import "server-only";

import { sessionContextSchema, type SessionContext } from "../access/identity-access";
import { correlationIdSchema } from "../catalogue/common";
import { applicationRootIdSchema, revisionSchema } from "../catalogue/identifiers";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { protectedOperationChannelSchema } from "./application-flow-bindings";
import { canonicalJson } from "./canonical-json";
import {
  applicationBoundReleaseSetCommandSchema,
  systemApplicationBoundReleaseSetCommandSchema,
  type ApplicationBoundReleaseSetCommand,
  type ApplicationBoundReleaseSetResult,
  type DefinitionConsumerReadResult,
  type SystemApplicationBoundReleaseSetCommand,
  type SystemApplicationBoundReleaseSetResult,
} from "./definition-consumer-read";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { z } from "zod";
import {
  isDefinitionContextFailure,
  isLiveDefinitionSystemContext,
  projectStoredConsumerRelease,
  storedConsumerReleaseEvidenceSchema,
} from "./definition-consumer-read-definition";
import {
  createImmutableDefinitionPublicationCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "./publication/read";
import type { DefinitionPublicationCatalogue } from "./definition-publication-contracts";
import { DefinitionError } from "./definition-error";

const storedSetSchema = z
  .object({
    correlationId: correlationIdSchema,
    application: z.unknown(),
    modules: z.array(z.unknown()).min(1).max(10_000),
  })
  .strict();

const storedSystemSetSchema = storedSetSchema.extend({
  modules: z.array(z.unknown()).max(10_000),
});

type ApplicationRead = Extract<DefinitionConsumerReadResult, { kind: "application" }>;
type ModuleRead = Extract<DefinitionConsumerReadResult, { kind: "module" }>;
type BoundReleaseSetRow = DatabaseRow & { readonly bound_release_set: unknown };
type FirstInstallReleaseSetRow = DatabaseRow & {
  readonly bound_release_set: unknown;
  readonly request_context: unknown;
};
type FirstInstallHumanContext = Extract<SessionContext, Readonly<{ callerKind: "human" }>>;

const firstInstallApplicationReleaseSetCommandSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

const parseFirstInstallHumanContext = (candidate: unknown): FirstInstallHumanContext => {
  if (!isRecord(candidate)) throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  const { channel: rawChannel, ...sessionContextCandidate } = candidate;
  const channel = protectedOperationChannelSchema.safeParse(rawChannel);
  const parsedContext = sessionContextSchema.safeParse(sessionContextCandidate);
  if (
    !channel.success ||
    channel.data !== "web" ||
    !parsedContext.success ||
    parsedContext.data.callerKind !== "human" ||
    parsedContext.data.applicationRootId !== undefined
  )
    throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
  return parsedContext.data;
};

const readFirstInstallReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  command: z.infer<typeof firstInstallApplicationReleaseSetCommandSchema>,
): Promise<Readonly<{ candidate: unknown; context: FirstInstallHumanContext }>> => {
  try {
    const rows = await transaction.query<FirstInstallReleaseSetRow>`
      select vortex_definition.read_first_install_application_release_set(
        ${command.applicationRootId}::uuid,
        ${command.applicationReleaseRevision}::bigint
      ) as bound_release_set,
      vortex_access.validated_human_request_context() as request_context
    `;
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) throw new Error("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
    if (row.bound_release_set === null) throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
    return {
      candidate: row.bound_release_set,
      context: parseFirstInstallHumanContext(row.request_context),
    };
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code === "22023") throw new DefinitionError("INVALID_DEFINITION_READ_COMMAND");
    if (code === "P0002") throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
    if (code === "23514") throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
    throw new DefinitionError(
      isDefinitionContextFailure(error) ? "DEFINITION_CONTEXT_REFUSED" : "DEFINITION_READ_FAILED",
    );
  }
};

type BoundProjectionExpectation = Readonly<{
  applicationReleaseRevision: number;
  applicationRootId?: string;
  organizationId?: string;
  correlationId?: string;
  allowEmptyModules: boolean;
}>;

const projectBoundReleaseSet = async (
  candidate: unknown,
  expectation: BoundProjectionExpectation,
  catalogue: DefinitionPublicationCatalogue | undefined,
): Promise<ApplicationBoundReleaseSetResult | SystemApplicationBoundReleaseSetResult> => {
  const storedSet = (
    expectation.allowEmptyModules ? storedSystemSetSchema : storedSetSchema
  ).safeParse(candidate);
  if (!storedSet.success) throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  const storedApplication = storedConsumerReleaseEvidenceSchema.safeParse(
    storedSet.data.application,
  );
  if (!storedApplication.success || storedApplication.data.kind !== "application")
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  const application = (await projectStoredConsumerRelease(
    storedApplication.data,
    {
      kind: "application",
      rootId: expectation.applicationRootId ?? storedApplication.data.rootId,
      releaseRevision: expectation.applicationReleaseRevision,
      ...(expectation.organizationId === undefined
        ? {}
        : { organizationId: expectation.organizationId }),
    },
    storedSet.data.correlationId,
    catalogue,
  )) as ApplicationRead;
  if (
    (expectation.correlationId !== undefined &&
      !sameId(storedSet.data.correlationId, expectation.correlationId)) ||
    (expectation.applicationRootId !== undefined &&
      !sameId(application.rootId, expectation.applicationRootId))
  )
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  const modules: ModuleRead[] = [];
  for (const moduleCandidate of storedSet.data.modules) {
    const storedModule = storedConsumerReleaseEvidenceSchema.safeParse(moduleCandidate);
    if (!storedModule.success || storedModule.data.kind !== "module")
      throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
    modules.push(
      (await projectStoredConsumerRelease(
        storedModule.data,
        {
          kind: "module",
          rootId: storedModule.data.rootId,
          releaseRevision: storedModule.data.releaseRevision,
        },
        storedSet.data.correlationId,
        catalogue,
      )) as ModuleRead,
    );
  }

  // Each release above is already parsed against its consumer result schema; the set adds only
  // its own rules: an Application, Modules, at least one unless the system set allows none, and
  // one exact release per Module root.
  const roots = new Set(modules.map((module) => module.rootId.toLowerCase()));
  if (
    application.kind !== "application" ||
    modules.some((module) => module.kind !== "module") ||
    (!expectation.allowEmptyModules && modules.length === 0) ||
    roots.size !== modules.length
  )
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  const result = { application, modules };
  if (!exactModuleClosure(result)) throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  return result;
};

const exactModuleClosure = (releaseSet: SystemApplicationBoundReleaseSetResult): boolean => {
  const modulesByIdentity = new Map(
    releaseSet.modules.map(
      (module) => [`${module.rootId.toLowerCase()}:${module.releaseRevision}`, module] as const,
    ),
  );
  if (modulesByIdentity.size !== releaseSet.modules.length) return false;
  const orderedRoots = releaseSet.modules.map((module) => module.rootId.toLowerCase());
  if (
    orderedRoots.some((root, index) => {
      if (index === 0) return false;
      const previousRoot = orderedRoots[index - 1];
      return previousRoot === undefined || previousRoot >= root;
    })
  )
    return false;

  const pending = releaseSet.application.dependencyManifest.filter(
    (dependency) => dependency.kind === "module",
  );
  const visitedRoots = new Map<string, number>();
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined) return false;
    const rootKey = dependency.rootId.toLowerCase();
    const previousRevision = visitedRoots.get(rootKey);
    if (previousRevision !== undefined) {
      if (previousRevision !== dependency.releaseRevision) return false;
      continue;
    }
    visitedRoots.set(rootKey, dependency.releaseRevision);

    const module = modulesByIdentity.get(`${rootKey}:${dependency.releaseRevision}`);
    if (
      module === undefined ||
      !sameId(module.organizationId, releaseSet.application.organizationId) ||
      module.definitionKey !== dependency.key ||
      module.releaseVersion !== dependency.releaseVersion ||
      module.contentFingerprint !== dependency.contentFingerprint
    )
      return false;
    for (const nested of module.dependencyManifest)
      if (nested.kind === "module") pending.push(nested);
  }
  return visitedRoots.size === modulesByIdentity.size;
};

export const createDatabaseApplicationBoundReleaseSetService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) => {
  const catalogue = createImmutableDefinitionPublicationCatalogue(catalogueDefinition);
  const readStoredSet = async (
    command: ApplicationBoundReleaseSetCommand,
  ): Promise<unknown | undefined> => {
    const rows = await transaction.query<BoundReleaseSetRow>`
      select vortex_definition.read_application_bound_release_set(
        ${command.applicationReleaseRevision}::bigint
      ) as bound_release_set
    `;
    if (rows.length !== 1) throw new Error("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
    return rows[0]!.bound_release_set === null ? undefined : rows[0]!.bound_release_set;
  };
  return {
    async read(commandCandidate: unknown): Promise<ApplicationBoundReleaseSetResult> {
      const command = applicationBoundReleaseSetCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_READ_COMMAND");

      let candidate: unknown | undefined;
      try {
        candidate = await readStoredSet(command.data);
      } catch (error) {
        throw new DefinitionError(
          isDefinitionContextFailure(error)
            ? "DEFINITION_CONTEXT_REFUSED"
            : "DEFINITION_READ_FAILED",
        );
      }
      if (candidate === undefined) throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
      return (await projectBoundReleaseSet(
        candidate,
        {
          applicationReleaseRevision: command.data.applicationReleaseRevision,
          allowEmptyModules: false,
        },
        catalogue,
      )) as ApplicationBoundReleaseSetResult;
    },
  };
};

export const createDatabaseSystemApplicationBoundReleaseSetService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) => {
  const catalogue = createImmutableDefinitionPublicationCatalogue(catalogueDefinition);
  const readStoredSet = async (
    command: SystemApplicationBoundReleaseSetCommand,
  ): Promise<unknown | undefined> => {
    const rows = await transaction.query<BoundReleaseSetRow>`
      select vortex_definition.read_system_application_bound_release_set(
        ${command.applicationRootId}::uuid,
        ${command.applicationReleaseRevision}::bigint
      ) as bound_release_set
    `;
    if (rows.length !== 1) throw new Error("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
    return rows[0]!.bound_release_set === null ? undefined : rows[0]!.bound_release_set;
  };
  return {
    async read(
      contextCandidate: SessionContext,
      commandCandidate: unknown,
      purpose: "consume" | "replace_or_remove" = "consume",
    ): Promise<SystemApplicationBoundReleaseSetResult> {
      const context = sessionContextSchema.safeParse(contextCandidate);
      const command = systemApplicationBoundReleaseSetCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_READ_COMMAND");
      if (!context.success || !isLiveDefinitionSystemContext(context.data))
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
      if (
        context.data.applicationRootId !== undefined &&
        !sameId(context.data.applicationRootId, command.data.applicationRootId)
      )
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

      let candidate: unknown | undefined;
      try {
        candidate = await readStoredSet(command.data);
      } catch (error) {
        throw new DefinitionError(
          isDefinitionContextFailure(error)
            ? "DEFINITION_CONTEXT_REFUSED"
            : "DEFINITION_READ_FAILED",
        );
      }
      if (candidate === undefined) throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");
      return (await projectBoundReleaseSet(
        candidate,
        {
          applicationReleaseRevision: command.data.applicationReleaseRevision,
          applicationRootId: command.data.applicationRootId,
          organizationId: context.data.organizationId,
          correlationId: context.data.correlationId,
          allowEmptyModules: true,
        },
        purpose === "consume" ? catalogue : undefined,
      )) as SystemApplicationBoundReleaseSetResult;
    },
  };
};

const applicationReleaseAdoptionReleaseSetCommandSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    applicationReleaseRevision: revisionSchema,
  })
  .strict();

/**
 * The installation-management release-set read: the same exact bound Application and Module
 * release set the coordinator's system reader returns, but read by root and revision through the
 * governed human read and gated by platform.organization.applications.manage. It is the read the
 * deliberate release-adoption path uses instead of a server-minted system context.
 */
export const createDatabaseApplicationReleaseAdoptionReleaseSetService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  purpose: "consume" | "replace_or_remove" = "consume",
) => {
  // Retired content is never rendered. Its stored hashes and identities still verify below.
  const catalogue =
    purpose === "consume"
      ? createImmutableDefinitionPublicationCatalogue(catalogueDefinition)
      : undefined;
  return Object.freeze({
    async read(commandCandidate: unknown): Promise<SystemApplicationBoundReleaseSetResult> {
      const command = applicationReleaseAdoptionReleaseSetCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_READ_COMMAND");

      let candidate: unknown | undefined;
      try {
        const rows = await transaction.query<BoundReleaseSetRow>`
          select vortex_definition.read_application_release_adoption_release_set(
            ${command.data.applicationRootId}::uuid,
            ${command.data.applicationReleaseRevision}::bigint
          ) as bound_release_set
        `;
        if (rows.length !== 1) throw new Error("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
        candidate = rows[0]!.bound_release_set === null ? undefined : rows[0]!.bound_release_set;
      } catch (error) {
        throw new DefinitionError(
          isDefinitionContextFailure(error)
            ? "DEFINITION_CONTEXT_REFUSED"
            : "DEFINITION_READ_FAILED",
        );
      }
      if (candidate === undefined) throw new DefinitionError("DEFINITION_RELEASE_NOT_FOUND");

      return (await projectBoundReleaseSet(
        candidate,
        {
          applicationReleaseRevision: command.data.applicationReleaseRevision,
          applicationRootId: command.data.applicationRootId,
          allowEmptyModules: true,
        },
        catalogue,
      )) as SystemApplicationBoundReleaseSetResult;
    },
  });
};

/**
 * Reads the exact published Application and complete Module closure for first installation.
 * The caller must provide its genuine org-only HUMAN request transaction; this read grants no
 * installation or mutation authority and is repeated after the asynchronous catalogue projection.
 * Its existing system result shape only permits a valid empty Module set; no system context is used.
 */
export const createDatabaseFirstInstallApplicationReleaseSetService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  purpose: "consume" | "replace_or_remove" = "consume",
) => {
  const catalogue =
    purpose === "consume"
      ? createImmutableDefinitionPublicationCatalogue(catalogueDefinition)
      : undefined;
  return Object.freeze({
    async read(commandCandidate: unknown): Promise<SystemApplicationBoundReleaseSetResult> {
      const command = firstInstallApplicationReleaseSetCommandSchema.safeParse(commandCandidate);
      if (!command.success) throw new DefinitionError("INVALID_DEFINITION_READ_COMMAND");

      const initial = await readFirstInstallReleaseSet(transaction, command.data);
      const initialSet = storedSystemSetSchema.safeParse(initial.candidate);
      if (!initialSet.success) throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
      if (!sameId(initialSet.data.correlationId, initial.context.correlationId))
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");

      const projected = await projectBoundReleaseSet(
        initialSet.data,
        {
          applicationReleaseRevision: command.data.applicationReleaseRevision,
          applicationRootId: command.data.applicationRootId,
          organizationId: initial.context.organizationId,
          correlationId: initial.context.correlationId,
          allowEmptyModules: true,
        },
        catalogue,
      );
      const result = projected as SystemApplicationBoundReleaseSetResult;
      const current = await readFirstInstallReleaseSet(transaction, command.data);
      const currentSet = storedSystemSetSchema.safeParse(current.candidate);
      if (!currentSet.success) throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
      if (
        canonicalJson(initial.context) !== canonicalJson(current.context) ||
        !sameId(currentSet.data.correlationId, current.context.correlationId)
      )
        throw new DefinitionError("DEFINITION_CONTEXT_REFUSED");
      if (canonicalJson(initialSet.data) !== canonicalJson(currentSet.data))
        throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

      return result;
    },
  });
};
