import "server-only";

import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import { createDatabaseDefinitionPublicationRepository } from "./definition-publication-repository";
import { createDefinitionPublicationService } from "./definition-publication";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import type { RequestDatabaseTransaction } from "@vortex/db";

/** Builds the production publication service from the database repository and one platform release catalogue. */
export const createDatabaseDefinitionPublicationService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createDefinitionPublicationService(
    createDatabaseDefinitionPublicationRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
  );
