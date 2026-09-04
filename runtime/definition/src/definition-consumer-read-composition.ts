import "server-only";

import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { createDefinitionConsumerReadService } from "./definition-consumer-read";
import { createDatabaseDefinitionConsumerReadRepository } from "./definition-consumer-read-repository";
import type { RequestDatabaseTransaction } from "@vortex/db";

export const createDatabaseDefinitionConsumerReadService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createDefinitionConsumerReadService(
    createDatabaseDefinitionConsumerReadRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
