import "server-only";

import {
  definitionCompilationOutputSchema,
  definitionConsumerReadCommandSchema,
  definitionConsumerReadDependencyManifestSchema,
  definitionConsumerReadResultSchema,
  definitionResolutionSnapshotSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  organizationIdSchema,
  revisionSchema,
  selectApplicationValidationContract,
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
import { hasAuthenticStoredCustomerDefinitionRelease } from "./definition-release-integrity";

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

/** Internal persistence boundary. It is intentionally not exported from the package root. */
export interface DefinitionConsumerReadRepository {
  read(
    context: SessionContext,
    command: DefinitionConsumerReadCommand,
  ): Promise<unknown | undefined>;
}

const manifestSubject = (dependency: ExactDefinitionDependency): string =>
  dependency.kind === "platform_theme"
    ? `${dependency.kind}:${dependency.catalogueThemeId}`
    : `${dependency.kind}:${dependency.key}`;

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  (() => {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return (
      left.length === right.length &&
      leftSet.size === left.length &&
      rightSet.size === right.length &&
      left.every((subject) => rightSet.has(subject))
    );
  })();

const selectApplicationReleaseContract = (candidate: unknown): void => {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return;
  const record = candidate as Record<string, unknown>;
  if (record.kind !== "application") return;
  if (typeof record.validationContractVersion !== "string")
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  try {
    selectApplicationValidationContract(record.validationContractVersion);
  } catch {
    throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
  }
};

export const definitionReleaseManifestMatchesCanonicalContent = (
  release: StoredConsumerReleaseEvidence,
): boolean => {
  const output = release.compilationOutput;
  if (output.kind === "connection_type") return false;
  const actual = release.dependencyManifest.map(manifestSubject);
  const moduleEntries = release.dependencyManifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "module" }> =>
      entry.kind === "module",
  );
  const connectionEntries = release.dependencyManifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "connection_type" }> =>
      entry.kind === "connection_type",
  );
  const themeEntries = release.dependencyManifest.filter(
    (entry): entry is Extract<ExactDefinitionDependency, { kind: "platform_theme" }> =>
      entry.kind === "platform_theme",
  );
  let expected: string[];

  if (output.kind === "module") {
    expected = output.canonical.content.dependencies.map(
      (dependency) => `module:${dependency.moduleKey}`,
    );
    if (
      !moduleEntries.every((entry) =>
        output.canonical.content.dependencies.some(
          (dependency) =>
            dependency.moduleKey === entry.key &&
            dependency.moduleRootId === entry.rootId &&
            dependency.resolvedVersion === entry.releaseVersion,
        ),
      )
    )
      return false;
  } else {
    const canonicalTheme = output.canonical.content.theme;
    if (
      canonicalTheme.mode === "platform" &&
      !themeEntries.some(
        (entry) =>
          entry.catalogueThemeId === canonicalTheme.catalogueThemeId &&
          entry.releaseVersion === canonicalTheme.version,
      )
    )
      return false;
    expected = [
      ...output.canonical.content.moduleBindings.map(
        (binding) =>
          `module:${
            moduleEntries.find(
              (entry) =>
                entry.rootId === binding.moduleRootId &&
                entry.releaseVersion === binding.resolvedVersion,
            )?.key ?? ""
          }`,
      ),
      ...output.canonical.content.connectionBindings.map(
        (binding) =>
          `connection_type:${
            connectionEntries.find(
              (entry) =>
                entry.rootId === binding.connectionTypeId &&
                entry.releaseVersion === binding.resolvedVersion,
            )?.key ?? ""
          }`,
      ),
      ...(canonicalTheme.mode === "platform"
        ? [`platform_theme:${canonicalTheme.catalogueThemeId}`]
        : []),
    ];
  }

  return sameStringSet(expected, actual);
};

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
    const release = await catalogue.readPlatformThemeRelease(
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

    // Dispatch on trusted outer metadata before parsing canonical Application content.
    selectApplicationReleaseContract(candidate);
    const parsed = storedConsumerReleaseEvidenceSchema.safeParse(candidate);
    if (!parsed.success)
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
    const release = parsed.data;
    const output = release.compilationOutput;
    if (
      output.kind === "connection_type" ||
      release.kind !== command.data.kind ||
      release.rootId !== command.data.rootId ||
      release.organizationId !== context.data.organizationId ||
      (command.data.selector.selection === "revision" &&
        release.releaseRevision !== command.data.selector.releaseRevision) ||
      !hasAuthenticStoredCustomerDefinitionRelease({
        organizationId: release.organizationId,
        kind: release.kind,
        key: release.key,
        rootId: release.rootId,
        releaseVersion: release.releaseVersion,
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
      correlationId: context.data.correlationId,
    });
    if (!result.success)
      throw new DefinitionConsumerReadError("DEFINITION_RELEASE_INTEGRITY_FAILED");
    return result.data;
  },
});
