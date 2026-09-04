import "server-only";

import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import {
  createDatabaseDefinitionPublicationRepository,
  type DefinitionPublicationTransactionRunner,
} from "./definition-publication-repository";
import { createDefinitionPublicationService } from "./definition-publication";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";

/** Builds the production publication service from the database repository and one platform release catalogue. */
export const createDatabaseDefinitionPublicationService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  runInTransaction?: DefinitionPublicationTransactionRunner,
) =>
  createDefinitionPublicationService(
    createDatabaseDefinitionPublicationRepository(runInTransaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
