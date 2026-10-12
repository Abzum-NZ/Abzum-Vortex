import "server-only";

import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { createDefinitionConsumerReadService } from "./definition-consumer-read-definition";
import { createDatabaseDefinitionConsumerReadRepository } from "./definition-consumer-read-repository";
import type { RequestDatabaseTransaction } from "../db/index";

export const createDatabaseDefinitionConsumerReadService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createDefinitionConsumerReadService(
    createDatabaseDefinitionConsumerReadRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
