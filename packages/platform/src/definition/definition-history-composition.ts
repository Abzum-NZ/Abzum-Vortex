import "server-only";

import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { createImmutableDefinitionPublicationCatalogue } from "./definition-publication-catalogue";
import type { BuilderAuthority } from "./builder-authority";
import { createDefinitionHistoryService } from "./definition-history";
import { createDatabaseDefinitionHistoryRepository } from "./definition-history-repository";
import type { RequestDatabaseTransaction } from "@vortex/db";

/** Builds the production history and restore service from the private database and immutable catalogue. */
export const createDatabaseDefinitionHistoryService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
) =>
  createDefinitionHistoryService(
    createDatabaseDefinitionHistoryRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
    authority,
  );
