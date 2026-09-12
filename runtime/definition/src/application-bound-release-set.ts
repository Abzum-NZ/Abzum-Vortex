import "server-only";

import {
  applicationBoundReleaseSetCommandSchema,
  applicationBoundReleaseSetResultSchema,
  correlationIdSchema,
  sessionContextSchema,
  systemApplicationBoundReleaseSetCommandSchema,
  systemApplicationBoundReleaseSetResultSchema,
  type ApplicationBoundReleaseSetCommand,
  type ApplicationBoundReleaseSetResult,
  type DefinitionConsumerReadResult,
  type SessionContext,
  type SystemApplicationBoundReleaseSetCommand,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";
import {
  DefinitionConsumerReadError,
  isDefinitionContextFailure,
  isLiveDefinitionSystemContext,
  projectStoredConsumerRelease,
  storedConsumerReleaseEvidenceSchema,
} from "./definition-consumer-read";
import {
  createImmutableDefinitionPublicationCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "./definition-publication-catalogue";
import type { DefinitionPublicationCatalogue } from "./definition-publication";

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

export interface ApplicationBoundReleaseSetRepository {
  read(command: ApplicationBoundReleaseSetCommand): Promise<unknown | undefined>;
}

export interface SystemApplicationBoundReleaseSetRepository {
  read(
    context: SessionContext,
    command: SystemApplicationBoundReleaseSetCommand,
  ): Promise<unknown | undefined>;
}

export const createDatabaseApplicationBoundReleaseSetRepository = (
  transaction: RequestDatabaseTransaction,
): ApplicationBoundReleaseSetRepository => ({
  async read(command) {
    const rows = await transaction.query<BoundReleaseSetRow>`
      select vortex_definition.read_application_bound_release_set(
        ${command.applicationReleaseRevision}::bigint
      ) as bound_release_set
    `;
    if (rows.length !== 1) throw new Error("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
    return rows[0]!.bound_release_set === null ? undefined : rows[0]!.bound_release_set;
  },
});

export const createDatabaseSystemApplicationBoundReleaseSetRepository = (
  transaction: RequestDatabaseTransaction,
): SystemApplicationBoundReleaseSetRepository => ({
  async read(_context, command) {
    const rows = await transaction.query<BoundReleaseSetRow>`
      select vortex_definition.read_system_application_bound_release_set(
        ${command.applicationRootId}::uuid,
        ${command.applicationReleaseRevision}::bigint
      ) as bound_release_set
    `;
    if (rows.length !== 1) throw new Error("APPLICATION_BOUND_RELEASE_SET_STORAGE_INVALID");
    return rows[0]!.bound_release_set === null ? undefined : rows[0]!.bound_release_set;
  },
});

type BoundProjectionExpectation = Readonly<{
  applicationReleaseRevision: number;
  applicationRootId?: string;
  organizationId?: string;
  correlationId?: string;
  allowEmptyModules: boolean;
}>;

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const projectBoundReleaseSet = async (
  candidate: unknown,
  expectation: BoundProjectionExpectation,
  catalogue: DefinitionPublicationCatalogue,
): Promise<ApplicationBoundReleaseSetResult | SystemApplicationBoundReleaseSetResult> => {
  const storedSet = (
    expectation.allowEmptyModules ? storedSystemSetSchema : storedSetSchema
  ).safeParse(candidate);
  if (!storedSet.success)
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  const storedApplication = storedConsumerReleaseEvidenceSchema.safeParse(
    storedSet.data.application,
  );
  if (!storedApplication.success || storedApplication.data.kind !== "application")
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
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
      !sameUuid(storedSet.data.correlationId, expectation.correlationId)) ||
    (expectation.applicationRootId !== undefined &&
      !sameUuid(application.rootId, expectation.applicationRootId))
  )
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  const modules: ModuleRead[] = [];
  for (const moduleCandidate of storedSet.data.modules) {
    const storedModule = storedConsumerReleaseEvidenceSchema.safeParse(moduleCandidate);
    if (!storedModule.success || storedModule.data.kind !== "module")
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
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

  const schema = expectation.allowEmptyModules
    ? systemApplicationBoundReleaseSetResultSchema
    : applicationBoundReleaseSetResultSchema;
  const result = schema.safeParse({ application, modules });
  if (!result.success) throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  return result.data;
};

export const createApplicationBoundReleaseSetService = (
  repository: ApplicationBoundReleaseSetRepository,
  catalogue: DefinitionPublicationCatalogue,
) => ({
  async read(commandCandidate: unknown): Promise<ApplicationBoundReleaseSetResult> {
    const command = applicationBoundReleaseSetCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionConsumerReadError("INVALID_DEFINITION_READ_COMMAND");

    let candidate: unknown | undefined;
    try {
      candidate = await repository.read(command.data);
    } catch (error) {
      throw new DefinitionConsumerReadError(
        isDefinitionContextFailure(error) ? "DEFINITION_CONTEXT_REFUSED" : "DEFINITION_READ_FAILED",
      );
    }
    if (candidate === undefined)
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_NOT_FOUND");
    return (await projectBoundReleaseSet(
      candidate,
      {
        applicationReleaseRevision: command.data.applicationReleaseRevision,
        allowEmptyModules: false,
      },
      catalogue,
    )) as ApplicationBoundReleaseSetResult;
  },
});

export const createSystemApplicationBoundReleaseSetService = (
  repository: SystemApplicationBoundReleaseSetRepository,
  catalogue: DefinitionPublicationCatalogue,
) => ({
  async read(
    contextCandidate: SessionContext,
    commandCandidate: unknown,
  ): Promise<SystemApplicationBoundReleaseSetResult> {
    const context = sessionContextSchema.safeParse(contextCandidate);
    const command = systemApplicationBoundReleaseSetCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionConsumerReadError("INVALID_DEFINITION_READ_COMMAND");
    if (!context.success || !isLiveDefinitionSystemContext(context.data))
      throw new DefinitionConsumerReadError("DEFINITION_CONTEXT_REFUSED");
    if (
      context.data.applicationRootId !== undefined &&
      !sameUuid(context.data.applicationRootId, command.data.applicationRootId)
    )
      throw new DefinitionConsumerReadError("DEFINITION_CONTEXT_REFUSED");

    let candidate: unknown | undefined;
    try {
      candidate = await repository.read(context.data, command.data);
    } catch (error) {
      throw new DefinitionConsumerReadError(
        isDefinitionContextFailure(error) ? "DEFINITION_CONTEXT_REFUSED" : "DEFINITION_READ_FAILED",
      );
    }
    if (candidate === undefined)
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_NOT_FOUND");
    return (await projectBoundReleaseSet(
      candidate,
      {
        applicationReleaseRevision: command.data.applicationReleaseRevision,
        applicationRootId: command.data.applicationRootId,
        organizationId: context.data.organizationId,
        correlationId: context.data.correlationId,
        allowEmptyModules: true,
      },
      catalogue,
    )) as SystemApplicationBoundReleaseSetResult;
  },
});

export const createDatabaseApplicationBoundReleaseSetService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createApplicationBoundReleaseSetService(
    createDatabaseApplicationBoundReleaseSetRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );

export const createDatabaseSystemApplicationBoundReleaseSetService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createSystemApplicationBoundReleaseSetService(
    createDatabaseSystemApplicationBoundReleaseSetRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
