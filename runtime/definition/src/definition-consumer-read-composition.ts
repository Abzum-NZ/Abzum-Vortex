import "server-only";

import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { createDefinitionConsumerReadService } from "./definition-consumer-read";
import { createDatabaseDefinitionConsumerReadRepository } from "./definition-consumer-read-repository";

export const createDatabaseDefinitionConsumerReadService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
) =>
  createDefinitionConsumerReadService(
    createDatabaseDefinitionConsumerReadRepository(),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
