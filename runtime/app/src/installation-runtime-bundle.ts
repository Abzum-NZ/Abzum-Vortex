import "server-only";

import {
  canonicalJson,
  installationRuntimeBundleFormatVersion,
  installationRuntimeBundleSections,
  installationRuntimeBundleSourceManifestSchema,
  installationRuntimeBundleWriteCommandSchema,
  jsonValueSchema,
  resolvePageComposition,
  systemApplicationBoundReleaseSetResultSchema,
  type InstallationRuntimeBundleIndex,
  type PreparedInstallationRuntimeSource,
  type InstallationRuntimeBundleWriteCommand,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { createInstallationRuntimeBundleRepository } from "@vortex/module";


const compareCanonical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export type PreparedInstallationRuntimeSourceReader = (
  transaction: RequestDatabaseTransaction,
  input: Readonly<{
    organizationId: string;
    applicationRootId: string;
    applicationReleaseRevision: number;
    moduleBindings: readonly Readonly<{
      moduleRootId: string;
      moduleReleaseRevision: number;
      bindingRevision: number;
      state: "provisioned";
    }>[];
  }>,
) => Promise<PreparedInstallationRuntimeSource>;

export const installationRuntimeBundleKey = (
  applicationRootId: string,
  applicationReleaseRevision: number,
) => ({
  applicationRootId,
  applicationReleaseRevision,
  bundleFormatVersion: installationRuntimeBundleFormatVersion,
});

export const buildInstallationRuntimeBundleWriteCommand = (
  sourceCandidate: PreparedInstallationRuntimeSource,
): InstallationRuntimeBundleWriteCommand => {
  const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse(
    sourceCandidate.sourceManifest,
  );
  const releaseSet = systemApplicationBoundReleaseSetResultSchema.parse(
    sourceCandidate.releaseSet,
  );
  const application = releaseSet.application;
  const content = application.content;
  const expectedApplicationIdentity = {
    rootId: application.rootId,
    definitionKey: application.definitionKey,
    releaseRevision: application.releaseRevision,
    releaseVersion: application.releaseVersion,
    validationContractVersion: application.validationContractVersion,
    contentFingerprint: application.contentFingerprint,
    resolutionFingerprint: application.resolutionFingerprint,
  };
  const expectedModuleIdentities = [...releaseSet.modules]
    .sort((left, right) => compareCanonical(left.rootId, right.rootId))
    .map((module) => ({
      rootId: module.rootId,
      definitionKey: module.definitionKey,
      releaseRevision: module.releaseRevision,
      releaseVersion: module.releaseVersion,
      validationContractVersion: module.validationContractVersion,
      contentFingerprint: module.contentFingerprint,
      resolutionFingerprint: module.resolutionFingerprint,
    }));
  if (
    canonicalJson(sourceManifest.application) !== canonicalJson(expectedApplicationIdentity) ||
    canonicalJson(sourceManifest.modules) !== canonicalJson(expectedModuleIdentities) ||
    sourceManifest.preparedRecordAccessPlan.planKey !== sourceCandidate.preparedRecordAccessPlan.planKey ||
    sourceManifest.preparedRecordAccessPlan.mappingFingerprint !==
      sourceCandidate.preparedRecordAccessPlan.mappingFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
  const {
    navigation,
    flows,
    flowBindings,
    theme,
    platformBlockDependencies,
    pages,
    shells,
    ...pageContent
  } = content;
  const modules = [...releaseSet.modules]
    .sort((left, right) => compareCanonical(left.rootId, right.rootId))
    .map((module) => ({
      identity: {
        rootId: module.rootId,
        definitionKey: module.definitionKey,
        releaseRevision: module.releaseRevision,
        releaseVersion: module.releaseVersion,
        validationContractVersion: module.validationContractVersion,
        contentFingerprint: module.contentFingerprint,
        resolutionFingerprint: module.resolutionFingerprint,
      },
      content: module.content,
    }));
  const sections = {
    pages: {
      application: {
        identity: {
          rootId: application.rootId,
          definitionKey: application.definitionKey,
          releaseRevision: application.releaseRevision,
          releaseVersion: application.releaseVersion,
          validationContractVersion: application.validationContractVersion,
          contentFingerprint: application.contentFingerprint,
          resolutionFingerprint: application.resolutionFingerprint,
        },
        content: pageContent,
        shells,
        pages,
      },
      modules,
      resolvedCompositions: pages.map((page) => ({
        pageId: page.pageId,
        roots: resolvePageComposition(page, shells).roots,
      })),
    },
    navigation,
    flows: { flows, flowBindings },
    trigger_index: flows
      .flatMap((flow) => flow.triggers.map((trigger) => ({
        flowId: flow.id,
        trigger,
      })))
      .sort((left, right) =>
        compareCanonical(left.flowId, right.flowId) ||
        compareCanonical(left.trigger.id, right.trigger.id),
      ),
    theme,
    component_registry: platformBlockDependencies,
    access_plan: {
      preparedRecordAccessPlan: sourceCandidate.preparedRecordAccessPlan,
      declaredPermissions: {
        application: content.permissions,
        modules: releaseSet.modules
          .map((module) => ({ rootId: module.rootId, permissions: module.content.permissions }))
          .sort((left, right) => compareCanonical(left.rootId, right.rootId)),
      },
    },
    tool_bundle: application.toolBundle,
  } satisfies Record<(typeof installationRuntimeBundleSections)[number], unknown>;

  return installationRuntimeBundleWriteCommandSchema.parse({
    applicationRootId: application.rootId,
    applicationReleaseRevision: application.releaseRevision,
    bundleFormatVersion: installationRuntimeBundleFormatVersion,
    pinFingerprint: sourceManifest.pinFingerprint,
    sections: Object.fromEntries(
      installationRuntimeBundleSections.map((section) => [
        section,
        jsonValueSchema.parse(sections[section]),
      ]),
    ),
  });
};

export const assertPreparedInstallationRuntimeBundleMatches = async (
  transaction: RequestDatabaseTransaction,
  sourceCandidate: PreparedInstallationRuntimeSource,
  moduleBindings: readonly Readonly<{
    moduleRootId: string;
    moduleReleaseRevision: number;
    bindingRevision: number;
    state: "provisioned";
  }>[],
): Promise<InstallationRuntimeBundleIndex> => {
  const command = buildInstallationRuntimeBundleWriteCommand(sourceCandidate);
  const repository = createInstallationRuntimeBundleRepository(transaction);
  const key = installationRuntimeBundleKey(
    command.applicationRootId,
    command.applicationReleaseRevision,
  );
  const index = await repository.readIndex(key);
  if (
    canonicalJson(index.sourceManifest) !== canonicalJson(sourceCandidate.sourceManifest) ||
    index.pinFingerprint !== command.pinFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  const stored = await repository.readSections(key, installationRuntimeBundleSections);
  for (const section of installationRuntimeBundleSections)
    if (canonicalJson(stored[section]) !== canonicalJson(command.sections[section]))
      throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  const rows = await transaction.query<{ readonly asserted: unknown }>`
    select vortex_module.assert_prepared_installation_runtime_bundle(
      ${command.applicationRootId}::uuid,
      ${command.applicationReleaseRevision}::bigint,
      ${JSON.stringify(moduleBindings)}::text::jsonb,
      ${command.pinFingerprint}::text
    ) as asserted
  `;
  if (rows.length !== 1 || rows[0]?.asserted === null || rows[0]?.asserted === undefined)
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  return index;
};

export const writePreparedInstallationRuntimeBundle = async (
  transaction: RequestDatabaseTransaction,
  sourceCandidate: PreparedInstallationRuntimeSource,
): Promise<InstallationRuntimeBundleIndex> => {
  const command = buildInstallationRuntimeBundleWriteCommand(sourceCandidate);
  const repository = createInstallationRuntimeBundleRepository(transaction);
  const index = await repository.write(command);
  if (
    canonicalJson(index.sourceManifest) !== canonicalJson(sourceCandidate.sourceManifest) ||
    index.pinFingerprint !== command.pinFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  const stored = await repository.readSections(
    installationRuntimeBundleKey(command.applicationRootId, command.applicationReleaseRevision),
    installationRuntimeBundleSections,
  );
  for (const section of installationRuntimeBundleSections)
    if (canonicalJson(stored[section]) !== canonicalJson(command.sections[section]))
      throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  return index;
};





