import "server-only";

import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";
import { createImmutableDefinitionPublicationCatalogue } from "./publication/read";
import type { BuilderAuthority } from "./builder-authority";
import { createDefinitionHistoryService } from "./definition-history";
import { createDatabaseDefinitionHistoryRepository } from "./definition-history-repository";
import type { RequestDatabaseTransaction } from "../db/index";

/** Builds the production history and restore service from the private database and immutable catalogue. */
export const createDatabaseDefinitionHistoryService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
) =>
  createDefinitionHistoryService(
    createDatabaseDefinitionHistoryRepository(transaction, catalogueDefinition.permissions),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
    authority,
  );
