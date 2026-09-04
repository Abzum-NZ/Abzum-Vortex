import "server-only";

import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import { createDefinitionHistoryService } from "./definition-history";
import { createDatabaseDefinitionHistoryRepository } from "./definition-history-repository";

/** Builds the production history and restore service from the private database and immutable catalogue. */
export const createDatabaseDefinitionHistoryService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
) =>
  createDefinitionHistoryService(
    createDatabaseDefinitionHistoryRepository(),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
