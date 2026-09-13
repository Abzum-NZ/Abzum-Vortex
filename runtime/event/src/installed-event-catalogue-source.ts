import "server-only";

import type {
  ApplicationBoundReleaseSetCommand,
  ApplicationBoundReleaseSetResult,
  ActiveApplicationInstallationEvidence,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import {
  createDatabaseApplicationBoundReleaseSetService,
  projectInstalledEventCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
  type InstalledEventCatalogue,
} from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";

export interface InstalledEventDefinitionSetReader {
  read(command: ApplicationBoundReleaseSetCommand): Promise<ApplicationBoundReleaseSetResult>;
}

export interface InstalledEventActiveInstallationReader {
  readCurrent(): Promise<ActiveApplicationInstallationEvidence>;
}

export type InstalledEventCatalogueSourceDependencies = Readonly<{
  definitionSetReader: InstalledEventDefinitionSetReader;
  activeInstallationReader: InstalledEventActiveInstallationReader;
}>;

/**
 * Combines Definition-owned dependency evidence and Module-owned active-binding
 * evidence. The protected active installation is selected first; its exact
 * Application revision is the only input to the protected human Definition
 * read. Neither Module roots nor readiness are caller supplied.
 */
export const createInstalledEventCatalogueSource = (
  dependencies: InstalledEventCatalogueSourceDependencies,
) =>
  Object.freeze({
    async readCurrent(): Promise<InstalledEventCatalogue> {
      const installation = await dependencies.activeInstallationReader.readCurrent();
      const definitions = await dependencies.definitionSetReader.read({
        applicationReleaseRevision: installation.applicationReleaseRevision,
      });
      return projectInstalledEventCatalogue({ definitions, installation });
    },
  });

/** Wires both owner reads to one already-resolved human request transaction. */
export const createDatabaseInstalledEventCatalogueSource = (
  definitionCatalogue: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) =>
  createInstalledEventCatalogueSource({
    activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
    definitionSetReader: createDatabaseApplicationBoundReleaseSetService(
      definitionCatalogue,
      transaction,
    ),
  });
