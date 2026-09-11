import "server-only";

import {
  applicationBoundReleaseSetCommandSchema,
  applicationBoundReleaseSetResultSchema,
  correlationIdSchema,
  type ApplicationBoundReleaseSetCommand,
  type ApplicationBoundReleaseSetResult,
  type DefinitionConsumerReadResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";
import {
  DefinitionConsumerReadError,
  isDefinitionContextFailure,
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

type ApplicationRead = Extract<DefinitionConsumerReadResult, { kind: "application" }>;
type ModuleRead = Extract<DefinitionConsumerReadResult, { kind: "module" }>;
type BoundReleaseSetRow = DatabaseRow & { readonly bound_release_set: unknown };

export interface ApplicationBoundReleaseSetRepository {
  read(command: ApplicationBoundReleaseSetCommand): Promise<unknown | undefined>;
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
    const storedSet = storedSetSchema.safeParse(candidate);
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
        rootId: storedApplication.data.rootId,
        releaseRevision: command.data.applicationReleaseRevision,
      },
      storedSet.data.correlationId,
      catalogue,
    )) as ApplicationRead;

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

    const result = applicationBoundReleaseSetResultSchema.safeParse({ application, modules });
    if (!result.success)
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
    return result.data;
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
