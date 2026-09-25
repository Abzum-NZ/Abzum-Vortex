import "server-only";

import type { RequestDatabaseTransaction } from "@vortex/db";
import type { BuilderAuthority } from "./builder-authority";
import { createApplicationPreviewService } from "./application-preview";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./definition-publication-catalogue";
import { createDatabaseDefinitionPublicationService } from "./definition-publication-composition";

/**
 * Builds the production exact-draft preview service over one request transaction and the platform
 * release catalogue. The transaction must already be bound to the caller's live system context;
 * every draft read is organisation-scoped by the Definition publication repository.
 */
export const createDatabaseApplicationPreviewService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
) =>
  createApplicationPreviewService(
    createDatabaseDefinitionPublicationService(catalogueDefinition, transaction, authority),
  );
