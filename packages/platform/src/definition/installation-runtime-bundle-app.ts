import "server-only";

import {
  applicationRootIdSchema,
  canonicalJson,
  installationRuntimeBundleFormatVersion,
  installationRuntimeBundlePagesSectionSchema,
  installationRuntimeBundleSections,
  installationRuntimeBundleSourceManifestSchema,
  installationRuntimeBundleWriteCommandSchema,
  jsonValueSchema,
  resolvePageComposition,
  type InstallationRuntimeBundleIndex,
  type PreparedInstallationRuntimeSource,
  type InstallationRuntimeBundleWriteCommand,
} from "../schema";
import type { RequestDatabaseTransaction } from "../db/index";
import { createInstallationRuntimeBundleRepository } from "./module-index";


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

const installationRuntimeBundleKey = (
  applicationRootId: string,
  applicationReleaseRevision: number,
) => {
  const parsedApplicationRootId = applicationRootIdSchema.safeParse(applicationRootId);
  if (!parsedApplicationRootId.success)
    throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
  return {
    applicationRootId: parsedApplicationRootId.data,
    applicationReleaseRevision,
    bundleFormatVersion: installationRuntimeBundleFormatVersion,
  };
};

const buildInstallationRuntimeBundleWriteCommand = (
  sourceCandidate: PreparedInstallationRuntimeSource,
): InstallationRuntimeBundleWriteCommand => {
  const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse(
    sourceCandidate.sourceManifest,
  );
  // The prepared runtime source holds the release set already parsed and checked.
  const releaseSet = sourceCandidate.releaseSet;
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
        kind: module.kind,
        organizationId: module.organizationId,
        rootId: module.rootId,
        definitionKey: module.definitionKey,
        releaseRevision: module.releaseRevision,
        releaseVersion: module.releaseVersion,
        validationContractVersion: module.validationContractVersion,
        contentFingerprint: module.contentFingerprint,
        resolutionFingerprint: module.resolutionFingerprint,
        dependencyManifest: module.dependencyManifest,
      },
      content: module.content,
    }));
  const pageSource = installationRuntimeBundlePagesSectionSchema.parse({
    application: {
      identity: {
        kind: application.kind,
        organizationId: application.organizationId,
        rootId: application.rootId,
        definitionKey: application.definitionKey,
        releaseRevision: application.releaseRevision,
        releaseVersion: application.releaseVersion,
        validationContractVersion: application.validationContractVersion,
        contentFingerprint: application.contentFingerprint,
        resolutionFingerprint: application.resolutionFingerprint,
        dependencyManifest: application.dependencyManifest,
        platformCompatibilityVersion: application.platformCompatibilityVersion,
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
  });
  const sections = {
    pages: pageSource,
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
  const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse(
    sourceCandidate.sourceManifest,
  );
  const repository = createInstallationRuntimeBundleRepository(transaction);
  const index = await repository.readIndex(
    installationRuntimeBundleKey(
      sourceManifest.application.rootId,
      sourceManifest.application.releaseRevision,
    ),
  );
  if (
    canonicalJson(index.sourceManifest) !== canonicalJson(sourceManifest) ||
    index.pinFingerprint !== sourceManifest.pinFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  const rows = await transaction.query<{ readonly asserted: unknown }>`
    select vortex_definition.assert_prepared_installation_runtime_bundle(
      ${sourceManifest.application.rootId}::uuid,
      ${sourceManifest.application.releaseRevision}::bigint,
      ${JSON.stringify(moduleBindings)}::text::jsonb,
      ${sourceManifest.pinFingerprint}::text
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
  const index = await createInstallationRuntimeBundleRepository(transaction).write(command);
  if (
    canonicalJson(index.sourceManifest) !== canonicalJson(sourceCandidate.sourceManifest) ||
    index.pinFingerprint !== command.pinFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  return index;
};
