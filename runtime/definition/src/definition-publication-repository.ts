import "server-only";

import {
  actorIdSchema,
  definitionCompilationOutputSchema,
  definitionKindSchema,
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
  exactDefinitionDependencySchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  publishDefinitionResultSchema,
  publishedApplicationDefinitionSchema,
  publishedApplicationReferenceSchema,
  publishedModuleDefinitionSchema,
  publishedModuleReferenceSchema,
  revisionSchema,
  semanticVersionSchema,
  stableDefinitionReleaseVersionSchema,
  sourceIdentityAssignmentSchema,
  storedDefinitionDraftSchema,
  timestampSchema,
  versionImpactReasonSchema,
  type PublishedDefinitionHistory,
  type PublishDefinitionResult,
  type SessionContext,
} from "@vortex/contracts";
import {
  withRequestTransaction,
  type DatabaseRow,
  type RequestDatabaseTransaction,
} from "@vortex/db";
import { z } from "zod";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import {
  hasAuthenticResolutionFingerprint,
  hasAuthenticStoredCustomerDefinitionRelease,
  sameCanonicalJson,
} from "./definition-release-integrity";
import {
  DefinitionPublicationError,
  type DefinitionPublicationCandidate,
  type DefinitionPublicationReader,
  type DefinitionPublicationRepository,
  type DefinitionPublicationTransaction,
  type DefinitionReleaseAppend,
  type ResolvableModuleRelease,
} from "./definition-publication";
import { extractSourceIdentityRequirements } from "./source-identities";

export type DefinitionPublicationTransactionRunner = <Result>(
  context: SessionContext,
  operation: (transaction: RequestDatabaseTransaction) => Promise<Result>,
) => Promise<Result>;

const safeRevisionSchema = z.preprocess(
  (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
  revisionSchema.max(Number.MAX_SAFE_INTEGER),
);
const databaseTimestampSchema = z.preprocess(
  (value) =>
    value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString() : value,
  timestampSchema,
);
const nullableRevisionSchema = z.union([safeRevisionSchema, z.null()]);
const requiredJsonSchema = z.unknown().refine((value) => value !== undefined);
const exactManifestSchema = z
  .array(exactDefinitionDependencySchema)
  .max(10_000)
  .superRefine((entries, context) => {
    const subjects = entries.map((entry) =>
      entry.kind === "platform_theme"
        ? `${entry.kind}:${entry.catalogueThemeId}`
        : `${entry.kind}:${entry.key}`,
    );
    if (new Set(subjects).size !== subjects.length)
      context.addIssue({ code: "custom", message: "Dependency subjects must be unique" });
    if (subjects.some((subject, index) => index > 0 && subjects[index - 1]! > subject))
      context.addIssue({ code: "custom", message: "Dependency subjects must be ordered" });
  });
const databaseStoredDraftSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const draft = value as Record<string, unknown>;
  if (draft.publishedRevision !== null) return value;
  return Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "publishedRevision"));
}, storedDefinitionDraftSchema);

const publicationRootSchema = z
  .object({
    rootId: platformIdSchema,
    organizationId: organizationIdSchema,
    kind: definitionKindSchema,
    key: namespacedKeySchema,
    currentReleaseRevision: nullableRevisionSchema,
    createdAt: timestampSchema,
    createdBy: actorIdSchema,
  })
  .strict();

const storedReleaseEvidenceSchema = z
  .object({
    authoredSource: definitionSourceDocumentSchema,
    authoredSourceFingerprint: fingerprintSchema,
    sourceContractVersion: semanticVersionSchema,
    compilationOutput: definitionCompilationOutputSchema,
    resolutionSnapshot: definitionResolutionSnapshotSchema,
    resolutionFingerprint: fingerprintSchema,
    comparisonFingerprint: fingerprintSchema,
    impactReasons: z.array(versionImpactReasonSchema),
  })
  .strict();

const storedHistoryReleaseSchema = z
  .object({
    publication: z.union([publishedModuleReferenceSchema, publishedApplicationReferenceSchema]),
    content: requiredJsonSchema,
    dependencyManifest: z.array(publishedModuleReferenceSchema).max(10_000),
    releaseNote: z.string().min(1).max(2_000),
    evidence: storedReleaseEvidenceSchema,
  })
  .strict();

const storedPublishedHistorySchema = z
  .object({
    kind: definitionKindSchema,
    definitionKey: namespacedKeySchema,
    history: z.array(storedHistoryReleaseSchema).max(10_000),
  })
  .strict();

const publicationStateSchema = z
  .object({
    root: publicationRootSchema,
    draft: databaseStoredDraftSchema,
    identities: z.array(sourceIdentityAssignmentSchema),
    history: storedPublishedHistorySchema,
  })
  .strict();

const rawPublishedModuleSchema = z
  .object({
    publication: publishedModuleReferenceSchema,
    content: requiredJsonSchema,
    dependencyManifest: z.array(publishedModuleReferenceSchema).max(10_000),
    releaseNote: z.string().min(1).max(2_000),
  })
  .strict();

const rawModuleReleaseSchema = z
  .object({
    organizationId: organizationIdSchema,
    key: namespacedKeySchema,
    rootId: moduleRootIdSchema,
    releaseRevision: safeRevisionSchema,
    releaseVersion: stableDefinitionReleaseVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    compilationOutput: definitionCompilationOutputSchema,
    resolutionSnapshot: definitionResolutionSnapshotSchema,
    identities: z.array(sourceIdentityAssignmentSchema),
    published: rawPublishedModuleSchema,
  })
  .strict();

const publicationStateRowSchema = z.object({ publication_state: z.unknown() }).strict();
const moduleReleaseListRowSchema = z.object({ module_releases: z.unknown() }).strict();
const moduleReleaseRowSchema = z.object({ module_release: z.unknown() }).strict();
const rawModuleReleaseListSchema = z.array(rawModuleReleaseSchema).max(10_000);
const appendReleaseRowSchema = z
  .object({
    root_id: platformIdSchema,
    release_revision: safeRevisionSchema,
    release_version: stableDefinitionReleaseVersionSchema,
    content_fingerprint: fingerprintSchema,
    resolution_fingerprint: fingerprintSchema,
    comparison_fingerprint: fingerprintSchema,
    dependency_manifest: exactManifestSchema,
    published_at: databaseTimestampSchema,
    published_by: actorIdSchema,
  })
  .strict();

type RawModuleRelease = z.infer<typeof rawModuleReleaseSchema>;
type StoredHistoryRelease = z.infer<typeof storedHistoryReleaseSchema>;

const invalidStorage = (): never => {
  throw new DefinitionPublicationError("DEFINITION_PUBLICATION_FAILED");
};

const parseOneRow = <Value>(rows: readonly DatabaseRow[], schema: z.ZodType<Value>): Value => {
  if (rows.length !== 1) return invalidStorage();
  const result = schema.safeParse(rows[0]);
  if (!result.success) return invalidStorage();
  return result.data;
};

const dependencyReferencesMatch = (
  output: Exclude<z.infer<typeof definitionCompilationOutputSchema>, { kind: "connection_type" }>,
  references: readonly z.infer<typeof publishedModuleReferenceSchema>[],
): boolean => {
  const expected = new Set(
    (output.kind === "module"
      ? output.canonical.content.dependencies
      : output.canonical.content.moduleBindings
    ).map((dependency) => `${dependency.moduleRootId}:${dependency.resolvedVersion}`),
  );
  const actual = new Set(
    references.map((reference) => `${reference.rootId}:${reference.releaseVersion}`),
  );
  return (
    expected.size ===
      (output.kind === "module"
        ? output.canonical.content.dependencies.length
        : output.canonical.content.moduleBindings.length) &&
    actual.size === references.length &&
    expected.size === actual.size &&
    [...expected].every((dependency) => actual.has(dependency)) &&
    references.every((reference) => reference.kind === "module")
  );
};

const currentIdentityLookupMatches = (
  source: z.infer<typeof definitionSourceDocumentSchema>,
  identities: readonly z.infer<typeof sourceIdentityAssignmentSchema>[],
): boolean => {
  const expected = extractSourceIdentityRequirements(source).flatMap((requirement) =>
    requirement.aliases.map((alias) =>
      canonicalJson([
        requirement.definitionKey,
        requirement.scope,
        requirement.kind,
        requirement.componentOwner,
        alias,
      ]),
    ),
  );
  const actual = identities.map((identity) =>
    canonicalJson([
      identity.definitionKey,
      identity.scope,
      identity.kind,
      identity.componentOwner,
      identity.alias,
    ]),
  );
  const actualLookups = new Set(actual);
  return (
    new Set(expected).size === expected.length &&
    actualLookups.size === actual.length &&
    expected.length === actual.length &&
    expected.every((lookup) => actualLookups.has(lookup))
  );
};

class DatabasePublicationReader implements DefinitionPublicationReader {
  constructor(
    protected readonly transaction: RequestDatabaseTransaction,
    private readonly context: SessionContext,
  ) {}

  async readCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined> {
    const rows = await this.transaction.query`
      select vortex_definition.read_publication_state(${rootId}) as publication_state
    `;
    const row = parseOneRow(rows, publicationStateRowSchema);
    if (row.publication_state === null) return undefined;
    const parsed = publicationStateSchema.safeParse(row.publication_state);
    if (!parsed.success) return invalidStorage();
    const state = parsed.data;
    if (
      String(state.root.rootId) !== rootId ||
      state.root.organizationId !== this.context.organizationId ||
      String(state.root.rootId) !== String(state.draft.rootId) ||
      state.root.organizationId !== state.draft.organizationId ||
      state.root.kind !== state.draft.kind ||
      state.root.key !== state.draft.key ||
      state.root.currentReleaseRevision !== (state.draft.publishedRevision ?? null) ||
      !currentIdentityLookupMatches(state.draft.source, state.identities)
    )
      return invalidStorage();

    if (state.history.kind !== state.draft.kind || state.history.definitionKey !== state.draft.key)
      return invalidStorage();
    const history = this.materializeHistory(
      state.history.history,
      state.draft.kind,
      state.draft.key,
      state.draft.rootId,
    );
    return { draft: state.draft, identities: state.identities, history };
  }

  async listModuleReleases(
    organizationId: typeof this.context.organizationId,
    key: string,
  ): Promise<readonly ResolvableModuleRelease[]> {
    const rows = await this.transaction.query`
      select vortex_definition.list_module_releases(${key}) as module_releases
    `;
    const row = parseOneRow(rows, moduleReleaseListRowSchema);
    const releases = rawModuleReleaseListSchema.safeParse(row.module_releases);
    if (!releases.success) return invalidStorage();
    const materialized: ResolvableModuleRelease[] = [];
    for (const release of releases.data) {
      if (release.organizationId !== organizationId || release.key !== key) return invalidStorage();
      materialized.push(this.materializeModuleRelease(release));
    }
    return materialized;
  }

  async readModuleRelease(
    organizationId: typeof this.context.organizationId,
    rootId: Parameters<DefinitionPublicationReader["readModuleRelease"]>[1],
    releaseRevision: number,
  ): Promise<ResolvableModuleRelease | undefined> {
    const rows = await this.transaction.query`
      select vortex_definition.read_module_release(
        ${rootId},
        ${releaseRevision}
      ) as module_release
    `;
    const row = parseOneRow(rows, moduleReleaseRowSchema);
    if (row.module_release === null) return undefined;
    const parsed = rawModuleReleaseSchema.safeParse(row.module_release);
    if (!parsed.success) return invalidStorage();
    const release = this.materializeModuleRelease(parsed.data);
    if (release !== undefined && release.organizationId !== organizationId) return invalidStorage();
    return release;
  }

  private materializeHistory(
    releases: readonly StoredHistoryRelease[],
    kind: "module" | "application",
    key: string,
    rootId: string,
  ): PublishedDefinitionHistory {
    const history: PublishedDefinitionHistory["history"] = [];
    for (const release of releases) {
      const output = release.evidence.compilationOutput;
      const resolution = release.evidence.resolutionSnapshot;
      const ownResolution = resolution.definitions.filter(
        (definition) =>
          definition.kind === kind &&
          definition.key === key &&
          String(definition.rootId) === rootId &&
          definition.exactVersion === release.publication.releaseVersion,
      );
      if (
        output.kind !== kind ||
        release.publication.kind !== kind ||
        String(release.publication.rootId) !== rootId ||
        output.canonical.envelope.key !== key ||
        String(output.canonical.envelope.rootId) !== rootId ||
        output.canonical.envelope.organizationId !== this.context.organizationId ||
        String(output.artifact.rootId) !== rootId ||
        output.artifact.definitionKey !== key ||
        output.artifact.exactVersion !== release.publication.releaseVersion ||
        ownResolution.length !== 1 ||
        output.artifact.resolutionFingerprint !== release.evidence.resolutionFingerprint ||
        output.resolutionFingerprint !== release.evidence.resolutionFingerprint ||
        resolution.fingerprint !== release.evidence.resolutionFingerprint ||
        !hasAuthenticResolutionFingerprint(resolution) ||
        output.artifact.contentFingerprint !== release.publication.contentFingerprint ||
        fingerprintCanonicalValue(output.canonical.content) !==
          release.publication.contentFingerprint ||
        release.evidence.authoredSourceFingerprint !==
          fingerprintCanonicalValue(release.evidence.authoredSource) ||
        release.evidence.authoredSource.source_contract_version !==
          release.evidence.sourceContractVersion ||
        release.evidence.authoredSource.kind !== kind ||
        release.evidence.authoredSource.key !== key ||
        !sameCanonicalJson(output.canonical.content, release.content)
      )
        return invalidStorage();
      if (!dependencyReferencesMatch(output, release.dependencyManifest)) return invalidStorage();
      const published =
        kind === "module" && output.kind === "module" && release.publication.kind === "module"
          ? publishedModuleDefinitionSchema.safeParse({
              publication: release.publication,
              content: output.canonical.content,
              dependencyManifest: release.dependencyManifest,
              releaseNote: release.releaseNote,
            })
          : kind === "application" &&
              output.kind === "application" &&
              release.publication.kind === "application"
            ? publishedApplicationDefinitionSchema.safeParse({
                publication: release.publication,
                content: output.canonical.content,
                dependencyManifest: release.dependencyManifest,
                releaseNote: release.releaseNote,
              })
            : undefined;
      if (published === undefined || !published.success) return invalidStorage();
      history.push(published.data as never);
    }
    return kind === "module"
      ? ({ kind, definitionKey: key, history } as PublishedDefinitionHistory)
      : ({ kind, definitionKey: key, history } as PublishedDefinitionHistory);
  }

  private materializeModuleRelease(release: RawModuleRelease): ResolvableModuleRelease {
    const output = release.compilationOutput;
    const snapshot = release.resolutionSnapshot;
    const ownResolution = snapshot.definitions.filter(
      (definition) =>
        definition.kind === "module" &&
        definition.key === release.key &&
        definition.rootId === release.rootId &&
        definition.exactVersion === release.releaseVersion,
    );
    if (
      output.kind !== "module" ||
      ownResolution.length !== 1 ||
      release.organizationId !== this.context.organizationId ||
      release.published.publication.rootId !== release.rootId ||
      release.published.publication.revision !== release.releaseRevision ||
      release.published.publication.releaseVersion !== release.releaseVersion ||
      release.published.publication.contentFingerprint !== release.contentFingerprint ||
      output.artifact.rootId !== release.rootId ||
      output.canonical.envelope.key !== release.key ||
      output.canonical.envelope.rootId !== release.rootId ||
      output.canonical.envelope.organizationId !== release.organizationId ||
      output.artifact.definitionKey !== release.key ||
      output.artifact.exactVersion !== release.releaseVersion ||
      output.artifact.contentFingerprint !== release.contentFingerprint ||
      output.artifact.resolutionFingerprint !== release.resolutionFingerprint ||
      output.resolutionFingerprint !== release.resolutionFingerprint ||
      snapshot.fingerprint !== release.resolutionFingerprint ||
      !hasAuthenticResolutionFingerprint(snapshot) ||
      !hasAuthenticStoredCustomerDefinitionRelease({
        organizationId: release.organizationId,
        kind: "module",
        key: release.key,
        rootId: release.rootId,
        releaseVersion: release.releaseVersion,
        contentFingerprint: release.contentFingerprint,
        resolutionFingerprint: release.resolutionFingerprint,
        compilationOutput: output,
        resolutionSnapshot: snapshot,
      }) ||
      !sameCanonicalJson(snapshot.identities, release.identities) ||
      !sameCanonicalJson(output.canonical.content, release.published.content) ||
      !dependencyReferencesMatch(output, release.published.dependencyManifest)
    )
      return invalidStorage();
    const published = publishedModuleDefinitionSchema.safeParse({
      publication: release.published.publication,
      content: output.canonical.content,
      dependencyManifest: release.published.dependencyManifest,
      releaseNote: release.published.releaseNote,
    });
    if (
      !published.success ||
      fingerprintCanonicalValue(published.data.content) !== release.contentFingerprint
    )
      return invalidStorage();
    return {
      organizationId: release.organizationId,
      key: release.key,
      rootId: release.rootId,
      releaseRevision: release.releaseRevision,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: release.resolutionFingerprint,
      compilationOutput: output,
      resolutionSnapshot: snapshot,
      published: published.data,
    };
  }
}

class DatabasePublicationTransaction
  extends DatabasePublicationReader
  implements DefinitionPublicationTransaction
{
  constructor(transaction: RequestDatabaseTransaction, context: SessionContext) {
    super(transaction, context);
  }

  /** The append function obtains the row locks and repeats the draft revision/fingerprint checks. */
  lockCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined> {
    return this.readCandidate(rootId);
  }

  async appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    if (
      release.compilationOutput.resolutionFingerprint !== release.resolutionSnapshot.fingerprint ||
      release.compilationOutput.artifact.resolutionFingerprint !==
        release.resolutionSnapshot.fingerprint ||
      !hasAuthenticResolutionFingerprint(release.resolutionSnapshot)
    )
      return invalidStorage();
    const evidence = {
      releaseVersion: release.assignedVersion,
      compilationOutput: release.compilationOutput,
      resolutionSnapshot: release.resolutionSnapshot,
      contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: release.resolutionSnapshot.fingerprint,
      validationContractVersion: release.validationContractVersion,
      comparisonFingerprint: release.comparisonFingerprint,
      impactReasons: release.reasons,
      releaseNote: release.releaseNote,
      dependencies: release.dependencyManifest,
    };
    const rows = await this.transaction.query`
      select *
      from vortex_definition.append_release(
        ${release.draft.rootId},
        ${release.draft.draftRevision},
        ${release.draft.sourceFingerprint},
        ${JSON.stringify(evidence)}
      )
    `;
    if (rows.length === 0)
      throw new DefinitionPublicationError("DEFINITION_DRAFT_STALE_OR_MISSING");
    const parsed = appendReleaseRowSchema.safeParse(rows.length === 1 ? rows[0] : undefined);
    if (!parsed.success) return invalidStorage();
    return publishDefinitionResultSchema.parse({
      rootId: parsed.data.root_id,
      releaseRevision: parsed.data.release_revision,
      releaseVersion: parsed.data.release_version,
      contentFingerprint: parsed.data.content_fingerprint,
      resolutionFingerprint: parsed.data.resolution_fingerprint,
      comparisonFingerprint: parsed.data.comparison_fingerprint,
      dependencyManifest: parsed.data.dependency_manifest,
      publishedAt: parsed.data.published_at,
      publishedBy: parsed.data.published_by,
    });
  }
}

const safeRepositoryOperation = async <Result>(
  operation: () => Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DefinitionPublicationError) throw error;
    const databaseCode =
      error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
    if (databaseCode === "40001" || databaseCode === "23505")
      throw new DefinitionPublicationError("DEFINITION_DRAFT_STALE_OR_MISSING");
    if (databaseCode === "42501")
      throw new DefinitionPublicationError("DEFINITION_ORGANIZATION_MISMATCH");
    throw new DefinitionPublicationError("DEFINITION_PUBLICATION_FAILED");
  }
};

export const createDatabaseDefinitionPublicationRepository = (
  runInTransaction: DefinitionPublicationTransactionRunner = withRequestTransaction,
): DefinitionPublicationRepository => ({
  read: (context, operation) =>
    safeRepositoryOperation(() =>
      runInTransaction(context, (transaction) =>
        operation(new DatabasePublicationReader(transaction, context)),
      ),
    ),
  transaction: (context, operation) =>
    safeRepositoryOperation(() =>
      runInTransaction(context, (transaction) =>
        operation(new DatabasePublicationTransaction(transaction, context)),
      ),
    ),
});

export const databaseDefinitionPublicationRepository =
  createDatabaseDefinitionPublicationRepository();
