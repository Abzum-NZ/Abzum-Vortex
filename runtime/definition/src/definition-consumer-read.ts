import "server-only";

import {
  definitionCompilationOutputSchema,
  definitionConsumerReadCommandSchema,
  definitionConsumerReadDependencyManifestSchema,
  definitionConsumerReadResultSchema,
  definitionResolutionSnapshotSchema,
  definitionResolutionSnapshotV2Schema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  selectApplicationContractPair,
  selectModuleContractPair,
  semanticVersionSchema,
  sessionContextSchema,
  stableDefinitionReleaseVersionSchema,
  type DefinitionConsumerReadCommand,
  type DefinitionConsumerReadResult,
  type ExactDefinitionDependency,
  type SessionContext,
} from "@vortex/contracts";
import { z } from "zod";
import type { DefinitionPublicationCatalogue } from "./definition-publication";
import {
  hasAuthenticStoredCustomerDefinitionRelease,
  releaseManifestMatchesCanonicalContent,
} from "./definition-release-integrity";

export const definitionConsumerReadErrorCodes = [
  "INVALID_DEFINITION_READ_COMMAND",
  "DEFINITION_RELEASE_NOT_FOUND",
  "DEFINITION_CONTEXT_REFUSED",
  "DEFINITION_DEPENDENCY_UNAVAILABLE",
  "DEFINITION_RELEASE_INTEGRITY_FAILED",
  "DEFINITION_READ_FAILED",
] as const;

export type DefinitionConsumerReadErrorCode = (typeof definitionConsumerReadErrorCodes)[number];

export class DefinitionConsumerReadError extends Error {
  readonly code: DefinitionConsumerReadErrorCode;

  constructor(code: DefinitionConsumerReadErrorCode) {
    super(code);
    this.name = "DefinitionConsumerReadError";
    this.code = code;
  }
}

const javascriptSafeRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);
const moduleDependencyTargetSchema = z
  .object({
    rootId: moduleRootIdSchema,
    releaseRevision: javascriptSafeRevisionSchema,
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
    releaseRevision: javascriptSafeRevisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    sourceContractVersion: semanticVersionSchema,
    validationContractVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    compilationOutput: definitionCompilationOutputSchema,
    resolutionSnapshot: z.union([
      definitionResolutionSnapshotSchema,
      definitionResolutionSnapshotV2Schema,
    ]),
    dependencyManifest: definitionConsumerReadDependencyManifestSchema,
    moduleDependencyTargets: z.array(moduleDependencyTargetSchema).max(10_000),
  })
  .strict();

/**
 * Internal immutable-release evidence shared by consumer reads and draft restore.
 * It is deliberately not re-exported from the Definition package boundary.
 */
export type StoredConsumerReleaseEvidence = z.infer<typeof storedConsumerReleaseEvidenceSchema>;

/** Internal persistence boundary. It is intentionally not exported from the package root. */
export interface DefinitionConsumerReadRepository {
  read(
    context: SessionContext,
    command: DefinitionConsumerReadCommand,
  ): Promise<unknown | undefined>;
}

const selectReleaseContract = (candidate: unknown): void => {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return;
  const record = candidate as Record<string, unknown>;
  if (record.kind !== "application" && record.kind !== "module") return;
  if (
    typeof record.sourceContractVersion !== "string" ||
    typeof record.validationContractVersion !== "string"
  )
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  try {
    if (record.kind === "application")
      selectApplicationContractPair(record.sourceContractVersion, record.validationContractVersion);
    else selectModuleContractPair(record.sourceContractVersion, record.validationContractVersion);
  } catch {
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
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
      target.contentFingerprint === dependency.contentFingerprint &&
      target.resolutionFingerprint === dependency.resolutionFingerprint
    );
  });
};

export type DefinitionCatalogueVerification = "valid" | "unavailable" | "invalid";

export const verifyDefinitionCatalogueDependencies = async (
  manifest: readonly ExactDefinitionDependency[],
  catalogue: DefinitionPublicationCatalogue,
  validationContractVersion: string = "1.0.0",
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
        release.contentFingerprint !== dependency.contentFingerprint ||
        release.catalogueFingerprint !== dependency.catalogueFingerprint
      )
        return "invalid";
      continue;
    }
    if (dependency.kind === "platform_block") {
      if (validationContractVersion !== "2.0.0") return "invalid";
      const release = await catalogue.readPlatformBlockReleaseV2(
        dependency.blockId,
        dependency.releaseVersion,
      );
      if (release === undefined) return "unavailable";
      if (
        release.blockId !== dependency.blockId ||
        release.releaseVersion !== dependency.releaseVersion ||
        release.contentFingerprint !== dependency.contentFingerprint ||
        release.catalogueFingerprint !== dependency.catalogueFingerprint
      )
        return "invalid";
      continue;
    }
    const catalogueThemeId = platformIdSchema.safeParse(dependency.catalogueThemeId);
    if (!catalogueThemeId.success) return "invalid";
    const release =
      validationContractVersion === "2.0.0"
        ? await catalogue.readPlatformThemeReleaseV2(
            catalogueThemeId.data,
            dependency.releaseVersion,
          )
        : await catalogue.readPlatformThemeRelease(
            dependency.catalogueThemeId,
            dependency.releaseVersion,
          );
    if (release === undefined) return "unavailable";
    if (
      release.catalogueThemeId !== dependency.catalogueThemeId ||
      release.releaseVersion !== dependency.releaseVersion ||
      release.contentFingerprint !== dependency.contentFingerprint ||
      release.catalogueFingerprint !== dependency.catalogueFingerprint
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
 * select a release; its caller supplies evidence from one fixed database read.
 */
export const projectStoredConsumerRelease = async (
  candidate: unknown,
  expectation: StoredConsumerReleaseExpectation,
  correlationId: string,
  catalogue: DefinitionPublicationCatalogue,
): Promise<DefinitionConsumerReadResult> => {
  selectReleaseContract(candidate);
  const parsed = storedConsumerReleaseEvidenceSchema.safeParse(candidate);
  if (!parsed.success) throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  const release = parsed.data;
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
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");

  let catalogueVerification: DefinitionCatalogueVerification;
  try {
    catalogueVerification = await verifyDefinitionCatalogueDependencies(
      release.dependencyManifest,
      catalogue,
      release.validationContractVersion,
    );
  } catch {
    throw new DefinitionConsumerReadError("DEFINITION_READ_FAILED");
  }
  if (catalogueVerification === "unavailable")
    throw new DefinitionConsumerReadError("DEFINITION_DEPENDENCY_UNAVAILABLE");
  if (catalogueVerification === "invalid")
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");

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
    content: output.canonical.content,
    dependencyManifest: release.dependencyManifest,
    correlationId,
  });
  if (!result.success) throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  return result.data;
};

export const createDefinitionConsumerReadService = (
  repository: DefinitionConsumerReadRepository,
  catalogue: DefinitionPublicationCatalogue,
) => ({
  async read(
    contextCandidate: SessionContext,
    commandCandidate: unknown,
  ): Promise<DefinitionConsumerReadResult> {
    const command = definitionConsumerReadCommandSchema.safeParse(commandCandidate);
    if (!command.success) throw new DefinitionConsumerReadError("INVALID_DEFINITION_READ_COMMAND");
    const context = sessionContextSchema.safeParse(contextCandidate);
    if (!context.success || !isLiveDefinitionSystemContext(context.data))
      throw new DefinitionConsumerReadError("DEFINITION_CONTEXT_REFUSED");

    let candidate: unknown | undefined;
    try {
      candidate = await repository.read(context.data, command.data);
    } catch (error) {
      throw new DefinitionConsumerReadError(
        isDefinitionContextFailure(error) ? "DEFINITION_CONTEXT_REFUSED" : "DEFINITION_READ_FAILED",
      );
    }
    if (candidate === undefined)
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_NOT_FOUND");

    return projectStoredConsumerRelease(
      candidate,
      {
        kind: command.data.kind,
        rootId: command.data.rootId,
        organizationId: context.data.organizationId,
        ...(command.data.selector.selection === "revision"
          ? { releaseRevision: command.data.selector.releaseRevision }
          : {}),
      },
      context.data.correlationId,
      catalogue,
    );
  },
});
