import "server-only";

import { definitionCompilationOutputSchema, definitionConsumerReadDependencyManifestSchema, definitionConsumerReadResultSchema, definitionResolutionSnapshotSchema, fingerprintSchema, moduleRootIdSchema, organizationIdSchema, platformIdSchema, revisionSchema, assertModuleContractPair, selectApplicationContractPair, semanticVersionSchema, stableDefinitionReleaseVersionSchema, type DefinitionConsumerReadResult, type ExactDefinitionDependency, type SessionContext } from "../schema";
import { z } from "zod";
import type { DefinitionPublicationCatalogue } from "./definition-publication-contracts";
import {
  applicationDraftFromStoredRelease,
  hasAuthenticStoredCustomerDefinitionRelease,
  releaseManifestMatchesCanonicalContent,
} from "./definition-release-integrity";
import { DefinitionError, unexpectedDefinitionFailure } from "./definition-error";

const moduleDependencyTargetSchema = z
  .object({
    rootId: moduleRootIdSchema,
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
  })
  .strict();

export const storedConsumerReleaseEvidenceSchema = z
  .object({
    organizationId: organizationIdSchema,
    kind: z.enum(["module", "application"]),
    key: z.string(),
    rootId: z.uuid(),
    releaseRevision: revisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    sourceContractVersion: semanticVersionSchema,
    validationContractVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    compilationOutput: definitionCompilationOutputSchema,
    resolutionSnapshot: definitionResolutionSnapshotSchema,
    dependencyManifest: definitionConsumerReadDependencyManifestSchema,
    moduleDependencyTargets: z.array(moduleDependencyTargetSchema).max(10_000),
  })
  .strict();

/**
 * Internal immutable-release evidence shared by consumer reads and draft restore.
 * It is deliberately not re-exported from the Definition package boundary.
 */
export type StoredConsumerReleaseEvidence = z.infer<typeof storedConsumerReleaseEvidenceSchema>;

const selectReleaseContract = (candidate: unknown): void => {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return;
  const record = candidate as Record<string, unknown>;
  if (record.kind !== "application" && record.kind !== "module") return;
  if (
    typeof record.sourceContractVersion !== "string" ||
    typeof record.validationContractVersion !== "string"
  )
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  try {
    if (record.kind === "application")
      selectApplicationContractPair(record.sourceContractVersion, record.validationContractVersion);
    else assertModuleContractPair(record.sourceContractVersion, record.validationContractVersion);
  } catch {
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  }
};

type StoredConsumerReleaseExpectation = Readonly<{
  kind: "module" | "application";
  rootId: string;
  releaseRevision?: number;
  organizationId?: string;
}>;

export const definitionReleaseManifestMatchesCanonicalContent = (
  release: StoredConsumerReleaseEvidence,
): boolean =>
  release.compilationOutput.kind !== "connection_type" &&
  releaseManifestMatchesCanonicalContent(release.compilationOutput, release.dependencyManifest);

export const definitionReleaseModuleTargetsMatch = (
  release: StoredConsumerReleaseEvidence,
): boolean => {
  const modules = release.dependencyManifest.filter((entry) => entry.kind === "module");
  if (modules.length !== release.moduleDependencyTargets.length) return false;
  const targetSubject = (target: (typeof release.moduleDependencyTargets)[number]): string =>
    `${target.rootId}:${target.releaseRevision}`;
  const targets = new Map(
    release.moduleDependencyTargets.map((target) => [targetSubject(target), target] as const),
  );
  if (targets.size !== release.moduleDependencyTargets.length) return false;
  return modules.every((dependency) => {
    const target = targets.get(`${dependency.rootId}:${dependency.releaseRevision}`);
    return (
      target !== undefined &&
      target.releaseVersion === dependency.releaseVersion &&
      target.contentFingerprint === dependency.contentFingerprint
    );
  });
};

type DefinitionCatalogueVerification = "valid" | "unavailable" | "invalid";

export const verifyDefinitionCatalogueDependencies = async (
  manifest: readonly ExactDefinitionDependency[],
  catalogue: DefinitionPublicationCatalogue,
  validationContractVersion: string,
): Promise<DefinitionCatalogueVerification> => {
  for (const dependency of manifest) {
    if (dependency.kind === "module") continue;
    if (dependency.kind === "connection_type") {
      const release = await catalogue.readConnectionTypeRelease(
        dependency.rootId,
        dependency.releaseVersion,
      );
      if (release === undefined) return "unavailable";
      if (
        release.key !== dependency.key ||
        release.rootId !== dependency.rootId ||
        release.releaseVersion !== dependency.releaseVersion ||
        release.contentFingerprint !== dependency.contentFingerprint
      )
        return "invalid";
      continue;
    }
    if (dependency.kind === "platform_block") {
      if (validationContractVersion !== "3.0.0") return "invalid";
      const release = await catalogue.readPlatformBlockRelease(
        dependency.blockId,
        dependency.releaseVersion,
      );
      if (release === undefined) return "unavailable";
      if (
        release.blockId !== dependency.blockId ||
        release.releaseVersion !== dependency.releaseVersion ||
        release.contentFingerprint !== dependency.contentFingerprint
      )
        return "invalid";
      continue;
    }
    if (
      dependency.kind === "protected_operation" &&
      dependency.operation.owner.kind === "platform_service"
    ) {
      if (validationContractVersion !== "3.0.0") return "invalid";
      const release = await catalogue.readPlatformServiceOperationRelease?.(
        dependency.operation.owner.serviceId,
        dependency.operation.operationId,
        dependency.releaseVersion,
      );
      if (release === undefined) return "unavailable";
      if (
        release.serviceId !== dependency.operation.owner.serviceId ||
        release.operationId !== dependency.operation.operationId ||
        release.releaseVersion !== dependency.releaseVersion ||
        release.contentFingerprint !== dependency.contentFingerprint
      )
        return "invalid";
      continue;
    }
    // Application-owned flows and their contained targets, plus module-owned targets, are
    // authenticated against the stored canonical release by release-integrity checks. They are
    // not platform catalogue entries and must not fall through to the platform-theme reader.
    if (
      dependency.kind === "application_flow" ||
      dependency.kind === "application_flow_node" ||
      dependency.kind === "application_query" ||
      dependency.kind === "module_query" ||
      dependency.kind === "application_form" ||
      dependency.kind === "application_workflow" ||
      dependency.kind === "application_action" ||
      dependency.kind === "protected_operation"
    )
      continue;
    // A platform-theme dependency exists only in an Application manifest, and the sole
    // Application validation contract is 3.0.0.
    if (validationContractVersion !== "3.0.0") return "invalid";
    const catalogueThemeId = platformIdSchema.safeParse(dependency.catalogueThemeId);
    if (!catalogueThemeId.success) return "invalid";
    const release = await catalogue.readPlatformThemeRelease(
      catalogueThemeId.data,
      dependency.releaseVersion,
    );
    if (release === undefined) return "unavailable";
    if (
      release.catalogueThemeId !== dependency.catalogueThemeId ||
      release.releaseVersion !== dependency.releaseVersion ||
      release.contentFingerprint !== dependency.contentFingerprint
    )
      return "invalid";
  }
  return "valid";
};

export const isLiveDefinitionSystemContext = (context: SessionContext): boolean => {
  if (context.callerKind !== "system") return false;
  const issuedAt = Date.parse(context.issuedAt);
  const expiresAt = Date.parse(context.expiresAt);
  const now = Date.now();
  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt <= now &&
    expiresAt > now &&
    issuedAt < expiresAt
  );
};

export const isDefinitionContextFailure = (error: unknown): boolean => {
  const code =
    error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : "";
  return (
    code === "42501" ||
    (code === "23503" && message.startsWith("Vortex context organization")) ||
    ((code === "22023" || code === "55000") &&
      (message.startsWith("Vortex request context") ||
        message.startsWith("Stored Vortex request context"))) ||
    ["INVALID_REQUEST_CONTEXT", "INVALID_REQUEST_CONTEXT_TIME", "EXPIRED_REQUEST_CONTEXT"].includes(
      message,
    )
  );
};

/**
 * Applies the existing immutable-release integrity boundary to evidence selected
 * by either protected Definition reader. This helper does not authorize or
 * select a release; its caller supplies evidence from one fixed database read,
 * already parsed against `storedConsumerReleaseEvidenceSchema`.
 */
export const projectStoredConsumerRelease = async (
  release: StoredConsumerReleaseEvidence,
  expectation: StoredConsumerReleaseExpectation,
  correlationId: string,
  catalogue: DefinitionPublicationCatalogue,
): Promise<DefinitionConsumerReadResult> => {
  selectReleaseContract(release);
  const output = release.compilationOutput;
  if (
    output.kind === "connection_type" ||
    release.kind !== expectation.kind ||
    release.rootId !== expectation.rootId ||
    (expectation.organizationId !== undefined &&
      release.organizationId !== expectation.organizationId) ||
    (expectation.releaseRevision !== undefined &&
      release.releaseRevision !== expectation.releaseRevision) ||
    !hasAuthenticStoredCustomerDefinitionRelease({
      organizationId: release.organizationId,
      kind: release.kind,
      key: release.key,
      rootId: release.rootId,
      releaseVersion: release.releaseVersion,
      sourceContractVersion: release.sourceContractVersion,
      validationContractVersion: release.validationContractVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: release.resolutionFingerprint,
      compilationOutput: output,
      resolutionSnapshot: release.resolutionSnapshot,
    }) ||
    !definitionReleaseManifestMatchesCanonicalContent(release) ||
    !definitionReleaseModuleTargetsMatch(release)
  )
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  let catalogueVerification: DefinitionCatalogueVerification;
  try {
    catalogueVerification = await verifyDefinitionCatalogueDependencies(
      release.dependencyManifest,
      catalogue,
      release.validationContractVersion,
    );
  } catch {
    throw new DefinitionError("DEFINITION_READ_FAILED");
  }
  if (catalogueVerification === "unavailable")
    throw new DefinitionError("DEFINITION_DEPENDENCY_UNAVAILABLE");
  if (catalogueVerification === "invalid")
    throw new DefinitionError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  const content =
    output.kind === "application"
      ? applicationDraftFromStoredRelease(output).content
      : output.canonical.content;
  const result = definitionConsumerReadResultSchema.safeParse({
    kind: release.kind,
    organizationId: release.organizationId,
    definitionKey: release.key,
    rootId: release.rootId,
    releaseRevision: release.releaseRevision,
    releaseVersion: release.releaseVersion,
    validationContractVersion: release.validationContractVersion,
    contentFingerprint: release.contentFingerprint,
    resolutionFingerprint: release.resolutionFingerprint,
    content,
    // An Application consumer release always carries the platform compatibility its release was
    // compiled under; the release evidence above makes the field's absence a refusal, not a gap.
    ...(release.kind === "application" && output.kind === "application"
      ? {
          toolBundle: output.toolBundle,
          platformCompatibilityVersion: output.platformCompatibilityVersion,
        }
      : {}),
    dependencyManifest: release.dependencyManifest,
    correlationId,
  });
  if (!result.success)
    throw unexpectedDefinitionFailure(
      "DEFINITION_RELEASE_INTEGRITY_FAILED",
      result.error,
      "definition-consumer-read-definition",
    );
  return result.data;
};
