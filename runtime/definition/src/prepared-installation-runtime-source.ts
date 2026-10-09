import "server-only";

import {
  applicationRootIdSchema,
  canonicalJson,
  correlationIdSchema,
  fingerprintSchema,
  jsonValueSchema,
  installationPreparedRecordAccessPlanSchema,
  installationRuntimeBundleSourceManifestSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  type PermissionDeclaration,
  recordTypeIdSchema,
  revisionSchema,
  systemApplicationBoundReleaseSetResultSchema,
  type InstallationRuntimeBundleSourceManifest,
  type PreparedInstallationRuntimeSource,
  type SystemApplicationBoundReleaseSetResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { z } from "zod";
import {
  projectStoredConsumerRelease,
  storedConsumerReleaseEvidenceSchema,
} from "./definition-consumer-read";
import {
  createImmutableDefinitionPublicationCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "./definition-publication-catalogue";

const compareCanonical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const preparedBindingSchema = z.object({
  moduleRootId: moduleRootIdSchema,
  moduleReleaseRevision: revisionSchema,
  bindingRevision: revisionSchema,
  state: z.literal("provisioned"),
}).strict();

const preparedSourceSchema = z.object({
  organizationId: organizationIdSchema,
  applicationRootId: applicationRootIdSchema,
  applicationReleaseRevision: revisionSchema,
  accessVersion: revisionSchema,
  correlationId: correlationIdSchema,
  pinFingerprint: fingerprintSchema,
  mappingFingerprint: fingerprintSchema,
  moduleBindings: z.array(preparedBindingSchema).min(1).max(10_000),
  application: z.unknown(),
  modules: z.array(z.unknown()).min(1).max(10_000),
  preparedRecordAccessPlan: installationPreparedRecordAccessPlanSchema,
}).strict();

type PreparedSourceRow = DatabaseRow & { readonly prepared_source: unknown };

const requirePreparedPlanMatchesReleaseSet = (
  planCandidate: PreparedInstallationRuntimeSource["preparedRecordAccessPlan"],
  releaseSet: SystemApplicationBoundReleaseSetResult,
  organizationId: string,
  applicationRootId: string,
  applicationReleaseRevision: number,
): void => {
  const plan = planCandidate.plan;
  function invalid(): never {
    throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
  }
  if (
    plan.organizationId !== organizationId ||
    plan.applicationRootId !== applicationRootId ||
    plan.applicationReleaseRevision !== applicationReleaseRevision
  ) invalid();

  const modules = [...releaseSet.modules]
    .sort((left, right) => compareCanonical(left.rootId, right.rootId));
  const expectedRecordTypeIds = new Set<string>();
  const expectedRelationships: Record<string, unknown> = {};
  for (const module of modules)
    for (const recordType of module.content.recordTypes) {
      const parsedRecordTypeId = recordTypeIdSchema.safeParse(recordType.recordTypeId.toLowerCase());
      if (!parsedRecordTypeId.success) invalid();
      const recordTypeId = parsedRecordTypeId.data;
      if (expectedRecordTypeIds.has(recordTypeId)) invalid();
      expectedRecordTypeIds.add(recordTypeId);
      const planned = plan.recordTypes[recordTypeId];
      if (
        planned === undefined ||
        planned.moduleRootId !== module.rootId ||
        planned.recordTypeId !== recordType.recordTypeId ||
        planned.storageContractId !== recordType.storageContractId ||
        planned.storageScope !== recordType.storageScope ||
        planned.ownershipMode !== recordType.ownershipMode ||
        planned.releaseRevision !== module.releaseRevision ||
        planned.validationContractVersion !== module.validationContractVersion ||
        planned.ownershipRelationshipId !== recordType.ownershipRelationshipId ||
        canonicalJson(planned.fields) !== canonicalJson(recordType.fields.map((field) => ({
          fieldId: field.fieldId,
          type: field.type,
          settings: field.settings,
        })))
      ) invalid();
      const expectedColumnIds = recordType.fields
        .map((field) => field.fieldId.toLowerCase())
        .sort(compareCanonical);
      const actualColumnIds = Object.keys(planned.columns).sort(compareCanonical);
      if (
        expectedColumnIds.length !== actualColumnIds.length ||
        expectedColumnIds.some((fieldId, index) => fieldId !== actualColumnIds[index]) ||
        recordType.fields.some((field) =>
          planned.columns[field.fieldId.toLowerCase()]?.type !== field.type)
      ) invalid();

      for (const relationship of recordType.relationships) {
        const relationshipId = relationship.relationshipId.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(expectedRelationships, relationshipId)) invalid();
        const targets = relationship.toRecordType === undefined
          ? relationship.toRecordTypes
          : [relationship.toRecordType];
        if (targets === undefined || targets.some((target) => target.state !== "resolved"))
          invalid();
        expectedRelationships[relationshipId] = {
          relationshipId: relationship.relationshipId,
          fromModuleRootId: module.rootId,
          fromRecordTypeId: recordType.recordTypeId,
          toRecordTypes: targets.map((target) => {
            if (target.state !== "resolved") invalid();
            return {
              moduleRootId: target.moduleRootId,
              recordTypeId: target.recordTypeId,
            };
          }),
        };
      }
    }
  if (Object.keys(plan.recordTypes).length !== expectedRecordTypeIds.size) invalid();
  if (canonicalJson(plan.relationships) !== canonicalJson(expectedRelationships)) invalid();

  const expectedSharingConditions = modules.flatMap((module) =>
    module.content.sharingConditions ?? [],
  );
  if (canonicalJson(plan.sharingConditions) !== canonicalJson(expectedSharingConditions)) invalid();

  const expectedPermissions: Record<string, unknown> = {};
  const addPermissions = (
    permissions: readonly PermissionDeclaration[],
    ownerKind: "application" | "module",
    ownerId: string,
  ) => {
    for (const permission of permissions) {
      if (permission.recordScope === undefined) continue;
      const permissionId = permission.permissionId.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(expectedPermissions, permissionId)) invalid();
      if (permission.recordTypeId === undefined) invalid();
      expectedPermissions[permissionId] = {
        ownerKind,
        ownerId,
        recordTypeId: permission.recordTypeId,
        actionKind: permission.actionKind,
        namedAction: permission.namedAction ?? null,
        recordScope: permission.recordScope,
      };
    }
  };
  for (const module of modules)
    addPermissions(module.content.permissions, "module", module.rootId);
  addPermissions(releaseSet.application.content.permissions, "application", applicationRootId);
  if (canonicalJson(plan.permissions) !== canonicalJson(expectedPermissions)) invalid();
};

export type PreparedInstallationRuntimeSourceCommand = Readonly<{
  organizationId: string;
  applicationRootId: string;
  applicationReleaseRevision: number;
  moduleBindings: readonly z.infer<typeof preparedBindingSchema>[];
}>;

export const createDatabasePreparedInstallationRuntimeSourceService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
) => {
  const catalogue = createImmutableDefinitionPublicationCatalogue(catalogueDefinition);

  return Object.freeze({
    async read(commandCandidate: PreparedInstallationRuntimeSourceCommand): Promise<PreparedInstallationRuntimeSource> {
      const organizationId = organizationIdSchema.parse(commandCandidate.organizationId);
      const applicationRootId = applicationRootIdSchema.parse(commandCandidate.applicationRootId);
      const applicationReleaseRevision = revisionSchema.parse(
        commandCandidate.applicationReleaseRevision,
      );
      const expectedBindings = z.array(preparedBindingSchema).min(1).max(10_000).parse(
        commandCandidate.moduleBindings,
      );
      const rows = await transaction.query<PreparedSourceRow>`
        select vortex_module.read_prepared_installation_runtime_source(
          ${applicationRootId}::uuid,
          ${applicationReleaseRevision}::bigint,
          ${JSON.stringify(expectedBindings)}::text::jsonb
        ) as prepared_source
      `;
      const parsed = rows.length === 1
        ? preparedSourceSchema.safeParse(rows[0]?.prepared_source)
        : null;
      if (
        parsed === null ||
        !parsed.success ||
        parsed.data.organizationId !== organizationId ||
        parsed.data.applicationRootId !== applicationRootId ||
        parsed.data.applicationReleaseRevision !== applicationReleaseRevision ||
        parsed.data.mappingFingerprint !== parsed.data.preparedRecordAccessPlan.mappingFingerprint ||
        parsed.data.moduleBindings.length !== expectedBindings.length ||
        parsed.data.moduleBindings.some((binding, index) => {
          const expected = expectedBindings[index];
          return expected === undefined ||
            binding.moduleRootId !== expected.moduleRootId ||
            binding.moduleReleaseRevision !== expected.moduleReleaseRevision ||
            binding.bindingRevision !== expected.bindingRevision ||
            binding.state !== "provisioned";
        })
      )
        throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");

      const applicationEvidence = storedConsumerReleaseEvidenceSchema.safeParse(
        parsed.data.application,
      );
      if (!applicationEvidence.success)
        throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
      const application = await projectStoredConsumerRelease(
        applicationEvidence.data,
        {
          kind: "application",
          rootId: applicationRootId,
          releaseRevision: applicationReleaseRevision,
          organizationId,
        },
        parsed.data.correlationId,
        catalogue,
      );
      if (application.kind !== "application")
        throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");

      const modules = [];
      for (const candidate of parsed.data.modules) {
        const evidence = storedConsumerReleaseEvidenceSchema.safeParse(candidate);
        if (!evidence.success || evidence.data.kind !== "module")
          throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
        modules.push(await projectStoredConsumerRelease(
          evidence.data,
          {
            kind: "module",
            rootId: evidence.data.rootId,
            releaseRevision: evidence.data.releaseRevision,
            organizationId,
          },
          parsed.data.correlationId,
          catalogue,
        ));
      }
      const releaseSet = systemApplicationBoundReleaseSetResultSchema.parse({
        application,
        modules,
      }) as SystemApplicationBoundReleaseSetResult;
      const expectedModuleIdentities = expectedBindings.map((binding) =>
        `${binding.moduleRootId}:${binding.moduleReleaseRevision}`,
      ).sort();
      const actualModuleIdentities = releaseSet.modules.map((module) =>
        `${module.rootId}:${module.releaseRevision}`,
      ).sort();
      if (
        expectedModuleIdentities.length !== actualModuleIdentities.length ||
        expectedModuleIdentities.some((identity, index) => identity !== actualModuleIdentities[index])
      )
        throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
      requirePreparedPlanMatchesReleaseSet(
        parsed.data.preparedRecordAccessPlan,
        releaseSet,
        organizationId,
        applicationRootId,
        applicationReleaseRevision,
      );

      const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse({
        bundleFormatVersion: 2,
        application: {
          rootId: application.rootId,
          definitionKey: application.definitionKey,
          releaseRevision: application.releaseRevision,
          releaseVersion: application.releaseVersion,
          validationContractVersion: application.validationContractVersion,
          contentFingerprint: application.contentFingerprint,
          resolutionFingerprint: application.resolutionFingerprint,
        },
        modules: [...releaseSet.modules]
          .sort((left, right) => compareCanonical(left.rootId, right.rootId))
          .map((module) => ({
            rootId: module.rootId,
            definitionKey: module.definitionKey,
            releaseRevision: module.releaseRevision,
            releaseVersion: module.releaseVersion,
            validationContractVersion: module.validationContractVersion,
            contentFingerprint: module.contentFingerprint,
            resolutionFingerprint: module.resolutionFingerprint,
          })),
        pinFingerprint: parsed.data.pinFingerprint,
        preparedRecordAccessPlan: {
          planKey: parsed.data.preparedRecordAccessPlan.planKey,
          mappingFingerprint: parsed.data.preparedRecordAccessPlan.mappingFingerprint,
        },
      }) as InstallationRuntimeBundleSourceManifest;
      return {
        releaseSet,
        sourceManifest,
        preparedRecordAccessPlan: parsed.data.preparedRecordAccessPlan,
      };
    },
  });
};





