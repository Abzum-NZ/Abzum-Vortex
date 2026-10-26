import "server-only";
import { platformPins } from "../platform-pins";

import type { SessionContext } from "../../access/identity-access";
import {
  actorIdSchema,
  fingerprintSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  semanticVersionSchema,
  timestampSchema,
} from "../../catalogue/identifiers";
import { selectApplicationContractPair } from "../application-contract-versions";
import {
  publishedApplicationDefinitionSchema,
  type ApplicationDraft,
} from "../application-contracts";
import {
  definitionCompilationOutputSchema,
  definitionPublicationHistoryEvidenceSchema,
  definitionResolutionSnapshotSchema,
  sourceIdentityAssignmentSchema,
  type PublishedDefinitionHistory,
  type DefinitionResolutionSnapshot,
} from "../definition-compilation-contracts";
import {
  assertModuleContractPair,
  type ApplicationSourceDocument,
  type ModuleSourceDocument,
} from "../definition-source";
import {
  storedDefinitionSourceSchema,
  exactDefinitionDependencySchema,
  publishDefinitionResultSchema,
  storedDefinitionDraftSchema,
  type PublishDefinitionResult,
  type StoredDefinitionSource,
} from "../definition-store-contracts";
import {
  definitionKindSchema,
  publishedApplicationReferenceSchema,
  publishedModuleReferenceSchema,
} from "../definitions";
import { savedSharingConditionSchema } from "../module-contracts";
import { moduleExtensionPointUseSchema } from "../module-extension-point-shape";
import {
  moduleVersionImpactHistoryEntrySchema,
  stableDefinitionReleaseVersionSchema,
  versionImpactReasonSchema,
  type VersionImpactReason,
} from "../version-impact";
import type { DatabaseRow, RequestDatabaseTransaction } from "../../db/request-transaction";
import { z } from "zod";
import {
  canonicalJson,
  fingerprintCanonicalValue,
  sameCanonicalValue,
} from "../canonical-json-definition";
import {
  applicationDraftFromStoredRelease,
  hasAuthenticResolutionFingerprint,
  hasAuthenticStoredCustomerDefinitionRelease,
} from "../definition-release-integrity";
import type { BuilderAuthority } from "../builder-authority";
import {
  createImmutableDefinitionPublicationCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "./read";
import { createDefinitionPublicationService } from "../definition-publication";
import type {
  DefinitionDraftCandidate,
  DefinitionPublicationCandidate,
  DefinitionPublicationReader,
  DefinitionPublicationRepository,
  DefinitionPublicationTransaction,
  DefinitionReleaseAppend,
  OwnedModuleRoot,
  ModuleReleasePageCursor,
  ResolvableModuleReleasePage,
  ResolvableModuleRelease,
} from "../definition-publication-contracts";
import { extractStoredSourceIdentityRequirements } from "../source-identities";
import { identityRetiredFailure } from "../identity-retired";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "../definition-error";

const safeRevisionSchema = z.preprocess(
  (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
  revisionSchema,
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
        : entry.kind === "platform_block"
          ? `${entry.kind}:${entry.blockId}@${entry.releaseVersion}`
          : entry.kind === "application_flow"
            ? `${entry.kind}:${entry.applicationRootId}:${entry.flowId}`
            : entry.kind === "application_flow_node"
              ? `${entry.kind}:${entry.applicationRootId}:${entry.flowId}:${entry.nodeId}`
              : entry.kind === "application_query"
                ? `${entry.kind}:${entry.applicationRootId}:${entry.queryId}`
                : entry.kind === "module_query"
                  ? `${entry.kind}:${entry.moduleRootId}:${entry.queryId}`
                  : entry.kind === "application_form"
                    ? `${entry.kind}:${entry.applicationRootId}:${entry.formId}`
                    : entry.kind === "application_workflow"
                      ? `${entry.kind}:${entry.applicationRootId}:${entry.workflowId}`
                      : entry.kind === "application_action"
                        ? `${entry.kind}:${entry.applicationRootId}:${entry.actionId}`
                        : entry.kind === "protected_operation"
                          ? `${entry.kind}:${entry.operation.owner.kind}:${
                              entry.operation.owner.kind === "application"
                                ? entry.operation.owner.applicationRootId
                                : entry.operation.owner.kind === "module"
                                  ? entry.operation.owner.moduleRootId
                                  : entry.operation.owner.serviceId
                            }:${entry.operation.operationId}`
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
    authoredSource: storedDefinitionSourceSchema,
    authoredSourceFingerprint: fingerprintSchema,
    sourceContractVersion: semanticVersionSchema,
    compilationOutput: definitionCompilationOutputSchema,
    resolutionSnapshot: definitionResolutionSnapshotSchema,
    resolutionFingerprint: fingerprintSchema,
    impactReasons: z.array(versionImpactReasonSchema),
  })
  .strict();

const storedHistoryReleaseSchema = z
  .object({
    publication: z.union([publishedModuleReferenceSchema, publishedApplicationReferenceSchema]),
    content: requiredJsonSchema,
    dependencyManifest: z
      .array(z.union([publishedModuleReferenceSchema, exactDefinitionDependencySchema]))
      .max(10_000),
    releaseNote: z.string().min(1).max(2_000),
    evidence: storedReleaseEvidenceSchema,
  })
  .strict();

const publicationStateSchema = z
  .object({
    root: publicationRootSchema,
    draft: databaseStoredDraftSchema,
    identities: z.array(sourceIdentityAssignmentSchema),
    historyLatestReleaseRevision: nullableRevisionSchema,
    historyLatestReleaseVersion: semanticVersionSchema.nullable(),
  })
  .strict();
const publicationHistoryPageSchema = z
  .object({
    anchorReleaseRevision: safeRevisionSchema,
    entries: z
      .array(
        z
          .object({
            previousReleaseRevision: nullableRevisionSchema,
            release: storedHistoryReleaseSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    nextAfterReleaseRevision: nullableRevisionSchema,
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
    releaseVersion: semanticVersionSchema,
    contentFingerprint: fingerprintSchema,
    resolutionFingerprint: fingerprintSchema,
    authoredSource: storedDefinitionSourceSchema,
    authoredSourceFingerprint: fingerprintSchema,
    sourceContractVersion: semanticVersionSchema,
    compilationOutput: definitionCompilationOutputSchema,
    resolutionSnapshot: definitionResolutionSnapshotSchema,
    identities: z.array(sourceIdentityAssignmentSchema),
    published: rawPublishedModuleSchema,
  })
  .strict();

const publicationStateRowSchema = z.object({ publication_state: z.unknown() }).strict();
const publicationHistoryPageRowSchema = z
  .object({ publication_history_page: z.unknown() })
  .strict();
const savedConditionHistoryRowSchema = z.object({ saved_condition_history: z.unknown() }).strict();
const rawModuleReleasePageSchema = z
  .object({
    rootId: z.union([moduleRootIdSchema, z.null()]),
    anchorReleaseRevision: nullableRevisionSchema,
    entries: z
      .array(
        z
          .object({
            previousReleaseRevision: nullableRevisionSchema,
            releaseRevision: safeRevisionSchema,
          })
          .strict(),
      )
      .max(100),
    nextAfterReleaseRevision: nullableRevisionSchema,
  })
  .strict();
const moduleReleasePageRowSchema = z.object({ module_release_page: z.unknown() }).strict();
const moduleReleaseRowSchema = z.object({ module_release: z.unknown() }).strict();
const parseModuleReleasePage = (row: DatabaseRow, cursor?: ModuleReleasePageCursor) => {
  const transport = parseOneRow([row], moduleReleasePageRowSchema);
  const parsed = rawModuleReleasePageSchema.safeParse(transport.module_release_page);
  if (!parsed.success) return invalidStorage(parsed.error);
  const page = parsed.data;
  if (page.rootId === null || page.anchorReleaseRevision === null) {
    if (
      page.rootId !== null ||
      page.anchorReleaseRevision !== null ||
      page.entries.length !== 0 ||
      page.nextAfterReleaseRevision !== null ||
      cursor !== undefined
    )
      return invalidStorage("readModuleReleasePage found inconsistent stored evidence");
  } else if (
    page.entries.length === 0 ||
    (cursor !== undefined &&
      (page.rootId !== cursor.rootId ||
        page.anchorReleaseRevision !== cursor.anchorReleaseRevision))
  )
    return invalidStorage("readModuleReleasePage found inconsistent stored evidence");
  return page;
};
const appendReleaseRowSchema = z
  .object({
    root_id: platformIdSchema,
    release_revision: safeRevisionSchema,
    release_version: stableDefinitionReleaseVersionSchema,
    content_fingerprint: fingerprintSchema,
    resolution_fingerprint: fingerprintSchema,
    dependency_manifest: exactManifestSchema,
    published_at: databaseTimestampSchema,
    published_by: actorIdSchema,
  })
  .strict();

type RawModuleRelease = z.infer<typeof rawModuleReleaseSchema>;
type StoredHistoryRelease = z.infer<typeof storedHistoryReleaseSchema>;
type SourceIdentityAssignment = z.infer<typeof sourceIdentityAssignmentSchema>;
type StoredApplicationCompilationOutput = Extract<
  z.infer<typeof definitionCompilationOutputSchema>,
  { kind: "application" }
>;
type ProjectedApplicationCompilationOutput = Omit<
  StoredApplicationCompilationOutput,
  "canonical"
> & { canonical: ApplicationDraft };

/** Authenticated immutable Application evidence for one ordinary same-root comparison. */
export type AuthenticatedApplicationPageAdoptionRelease = Readonly<{
  organizationId: string;
  rootId: string;
  key: string;
  publication: z.infer<typeof publishedApplicationReferenceSchema>;
  authoredSource: ApplicationSourceDocument;
  authoredSourceFingerprint: string;
  compilationOutput: ProjectedApplicationCompilationOutput;
  resolutionSnapshot: DefinitionResolutionSnapshot;
  identities: readonly SourceIdentityAssignment[];
  impactReasons: readonly VersionImpactReason[];
}>;

const invalidStorage = (cause: string | z.ZodError, underlying?: unknown): never => {
  throw unexpectedDefinitionFailure(
    "DEFINITION_PUBLICATION_FAILED",
    typeof cause === "string" ? new Error(cause, { cause: underlying }) : cause,
    "publication storage",
  );
};

const parseOneRow = <Value>(rows: readonly DatabaseRow[], schema: z.ZodType<Value>): Value => {
  if (rows.length !== 1) return invalidStorage("parseOneRow found inconsistent stored evidence");
  const result = schema.safeParse(rows[0]);
  if (!result.success) return invalidStorage(result.error);
  return result.data;
};

/**
 * Publication history and Module release readers return only the Module
 * dependency references of each stored release (no theme, block or connection
 * entries), so preparation compares exactly those Module references. The full
 * manifest check belongs to consumer reads, which receive the full manifest.
 */
const dependencyReferencesMatch = (
  output: Exclude<z.infer<typeof definitionCompilationOutputSchema>, { kind: "connection_type" }>,
  references: readonly { readonly kind: string }[],
): boolean => {
  const dependencies =
    output.kind === "module"
      ? output.canonical.content.dependencies
      : output.canonical.content.moduleBindings;
  const moduleReferences = references.filter(
    (reference): reference is { kind: "module"; rootId: string; releaseVersion: string } =>
      reference.kind === "module",
  );
  const expected = new Set(
    dependencies.map((dependency) => `${dependency.moduleRootId}:${dependency.resolvedVersion}`),
  );
  const actual = new Set(
    moduleReferences.map((reference) => `${reference.rootId}:${reference.releaseVersion}`),
  );
  return (
    expected.size === dependencies.length &&
    actual.size === moduleReferences.length &&
    expected.size === actual.size &&
    [...expected].every((reference) => actual.has(reference))
  );
};

const currentIdentityLookupMatches = (
  source: StoredDefinitionSource,
  identities: readonly z.infer<typeof sourceIdentityAssignmentSchema>[],
): boolean => {
  const expected = extractStoredSourceIdentityRequirements(source).flatMap((requirement) =>
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
  /**
   * Module release reads within this transaction. A publication pass resolves the same used
   * Modules for every inline Module and for the Application, and each read is parsed and
   * verified, so one transaction reads each exact release and each release page once. A write
   * that can move a current release forgets only the affected root's current selection.
   */
  private readonly moduleReleaseReads = new Map<
    string,
    Promise<ResolvableModuleRelease | undefined>
  >();
  private readonly moduleReleasePageReads = new Map<string, Promise<ResolvableModuleReleasePage>>();

  constructor(
    protected readonly transaction: RequestDatabaseTransaction,
    private readonly context: SessionContext,
  ) {}

  /** A new release of one root moves only that root's current release. */
  protected forgetModuleReleaseReadsOf(rootId: string, key: string): void {
    const root = String(rootId).toLowerCase();
    for (const memoKey of this.materializedModules.keys())
      if ((JSON.parse(memoKey) as unknown[])[1] === root) this.materializedModules.delete(memoKey);
    for (const memoKey of [...this.moduleReleaseReads.keys()])
      if ((JSON.parse(memoKey) as unknown[])[1] === root) this.moduleReleaseReads.delete(memoKey);
    for (const memoKey of [...this.moduleReleasePageReads.keys()])
      if ((JSON.parse(memoKey) as unknown[])[1] === key)
        this.moduleReleasePageReads.delete(memoKey);
  }

  async readOwnedModuleRoots(applicationRootId: string): Promise<readonly OwnedModuleRoot[]> {
    const rows = await this.transaction.query`
      select * from vortex_definition.read_owned_module_roots(${applicationRootId}::uuid)
    `;
    return rows.map(parseOwnedModuleRoot);
  }

  async readOwnedModulePublication(applicationRootId: string) {
    const rows = await this.transaction.query`
      select vortex_definition.read_owned_module_publication(${applicationRootId}::uuid) as publication
    `;
    return parseOneRow(
      rows,
      z
        .object({
          publication: z
            .object({
              recordTypes: z.array(z.string().min(1)),
              fields: z.array(z.string().min(1)),
              extensionPointUses: z.array(moduleExtensionPointUseSchema),
            })
            .strict(),
        })
        .strict(),
    ).publication;
  }

  /** The draft, its identities and its current release's revision and version, checked as one. */
  private async readPublicationState(
    rootId: string,
  ): Promise<z.infer<typeof publicationStateSchema> | undefined> {
    const rows = await this.transaction.query`
      select vortex_definition.read_publication_state(${rootId}) as publication_state
    `;
    const row = parseOneRow(rows, publicationStateRowSchema);
    if (row.publication_state === null) return undefined;
    const parsed = publicationStateSchema.safeParse(row.publication_state);
    if (!parsed.success) return invalidStorage(parsed.error);
    const state = parsed.data;
    if (
      String(state.root.rootId) !== rootId ||
      state.root.organizationId !== this.context.organizationId ||
      String(state.root.rootId) !== String(state.draft.rootId) ||
      state.root.organizationId !== state.draft.organizationId ||
      state.root.kind !== state.draft.kind ||
      state.root.key !== state.draft.key ||
      (state.draft.kind === "application" &&
        (state.draft.source.kind !== state.draft.kind ||
          state.draft.source.key !== state.draft.key ||
          state.draft.createdAt !== state.root.createdAt ||
          String(state.draft.createdBy).toLowerCase() !==
            String(state.root.createdBy).toLowerCase())) ||
      state.root.currentReleaseRevision !== (state.draft.publishedRevision ?? null) ||
      !currentIdentityLookupMatches(state.draft.source, state.identities) ||
      state.root.currentReleaseRevision !== state.historyLatestReleaseRevision ||
      (state.historyLatestReleaseRevision === null) !== (state.historyLatestReleaseVersion === null)
    )
      return invalidStorage("readPublicationState found inconsistent stored evidence");
    return state;
  }

  async readDraftCandidate(rootId: string): Promise<DefinitionDraftCandidate | undefined> {
    const state = await this.readPublicationState(rootId);
    return state === undefined
      ? undefined
      : {
          draft: state.draft,
          identities: state.identities,
          currentReleaseVersion: state.historyLatestReleaseVersion,
        };
  }

  async isApplicationDraftCurrent(candidate: DefinitionDraftCandidate): Promise<boolean> {
    const { draft } = candidate;
    const rows = await this.transaction.query`
      select vortex_definition.read_application_draft_consistency(
        ${draft.rootId}::uuid, ${draft.draftRevision}::bigint,
        ${draft.sourceFingerprint}::text, ${draft.publishedRevision ?? null}::bigint
      ) as consistency
    `;
    const { consistency } = parseOneRow(
      rows,
      z
        .object({
          consistency: z
            .object({
              draftRevision: safeRevisionSchema,
              sourceFingerprint: fingerprintSchema,
              publishedRevision: nullableRevisionSchema,
            })
            .strict()
            .nullable(),
        })
        .strict(),
    );
    if (consistency === null) return false;
    if (
      consistency.draftRevision !== draft.draftRevision ||
      consistency.sourceFingerprint !== draft.sourceFingerprint ||
      consistency.publishedRevision !== (draft.publishedRevision ?? null)
    )
      return invalidStorage("Draft consistency returned a substituted identity");
    return true;
  }

  async readCandidate(rootId: string): Promise<DefinitionPublicationCandidate | undefined> {
    const state = await this.readPublicationState(rootId);
    if (state === undefined) return undefined;
    const anchor = state.root.currentReleaseRevision;
    const latestApplication =
      anchor === null || state.draft.kind === "module"
        ? undefined
        : await this.readLatestRelease(
            rootId,
            anchor,
            state.draft.kind,
            state.draft.key,
            String(state.draft.rootId),
          );
    const latest =
      anchor === null
        ? undefined
        : state.draft.kind === "module"
          ? (
              await this.readModuleRelease(
                state.draft.organizationId,
                moduleRootIdSchema.parse(rootId),
                anchor,
              )
            )?.published
          : latestApplication?.published;
    if (
      (anchor !== null && latest === undefined) ||
      (latest !== undefined &&
        latest.publication.releaseVersion !== state.historyLatestReleaseVersion)
    )
      return invalidStorage("readCandidate found inconsistent stored evidence");
    const historyEvidence = definitionPublicationHistoryEvidenceSchema.safeParse({
      kind: state.draft.kind,
      definitionKey: state.draft.key,
      rootId: String(state.draft.rootId),
      anchorReleaseRevision: anchor,
      latestRelease: latest ?? null,
    });
    if (!historyEvidence.success) return invalidStorage(historyEvidence.error);
    return {
      draft: state.draft,
      identities: state.identities,
      historyEvidence: historyEvidence.data,
      savedConditionHistory:
        state.draft.kind === "module" ? await this.readSavedConditionHistory(rootId) : [],
      latestPlatformPins: platformPins(latestApplication?.stored.dependencyManifest ?? []),
    };
  }

  /**
   * Releases are immutable and the database orders and anchors them, so the latest release is
   * the only one a publication read needs. The page selector asks for exactly the anchor release.
   */
  private async readLatestRelease(
    rootId: string,
    anchor: number,
    kind: "module" | "application",
    key: string,
    draftRootId: string,
  ): Promise<{
    stored: StoredHistoryRelease;
    published: PublishedDefinitionHistory["history"][number];
  }> {
    const rows = await this.transaction.query`
      select vortex_definition.read_publication_history_page(
        ${rootId}, ${anchor}, ${anchor - 1}, ${1}
      ) as publication_history_page
    `;
    const row = parseOneRow(rows, publicationHistoryPageRowSchema);
    const page = publicationHistoryPageSchema.safeParse(row.publication_history_page);
    if (!page.success) return invalidStorage(page.error);
    const entry = page.data.entries[0];
    if (
      page.data.anchorReleaseRevision !== anchor ||
      page.data.entries.length !== 1 ||
      entry === undefined ||
      page.data.nextAfterReleaseRevision !== null
    )
      return invalidStorage("readLatestRelease found inconsistent stored evidence");
    const published = this.materializeHistory([entry.release], kind, key, draftRootId).history[0];
    if (
      published === undefined ||
      published.publication.revision !== anchor ||
      (entry.previousReleaseRevision ?? 0) >= anchor ||
      // A Module first released inside a later version of its Application starts at that version.
      (kind === "application" &&
        entry.previousReleaseRevision === null &&
        published.publication.releaseVersion !== "1.0.0")
    )
      return invalidStorage("readLatestRelease found inconsistent stored evidence");
    return { stored: entry.release, published };
  }

  /** One query: each saved condition's most recent published form across the Module's releases. */
  private async readSavedConditionHistory(
    rootId: string,
  ): Promise<readonly z.infer<typeof savedSharingConditionSchema>[]> {
    const rows = await this.transaction.query`
      select vortex_definition.read_saved_condition_history(${rootId}) as saved_condition_history
    `;
    const row = parseOneRow(rows, savedConditionHistoryRowSchema);
    const parsed = z.array(savedSharingConditionSchema).safeParse(row.saved_condition_history);
    if (!parsed.success) return invalidStorage(parsed.error);
    return parsed.data;
  }

  private pendingModulePages: {
    organizationId: SessionContext["organizationId"];
    key: string;
    cursor: ModuleReleasePageCursor | undefined;
    resolve: (page: ResolvableModuleReleasePage) => void;
    reject: (error: unknown) => void;
  }[] = [];

  async readModuleReleaseAnchors(
    organizationId: typeof this.context.organizationId,
    keys: readonly string[],
  ): Promise<readonly Pick<ResolvableModuleReleasePage, "rootId" | "anchorReleaseRevision">[]> {
    if (organizationId !== this.context.organizationId)
      return invalidStorage("Module anchors requested for another organisation");
    if (keys.length === 0) return [];
    const rows = await this.transaction.query`
      select vortex_definition.read_module_release_page(requested.key, null, null, 1)
        as module_release_page
      from pg_catalog.jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb)
        with ordinality as requested(key, ordinality)
      order by requested.ordinality
    `;
    if (rows.length !== keys.length) return invalidStorage("Module anchor frontier is incomplete");
    return rows.map((row) => {
      const page = parseModuleReleasePage(row);
      return { rootId: page.rootId, anchorReleaseRevision: page.anchorReleaseRevision };
    });
  }

  readModuleReleasePage(
    organizationId: typeof this.context.organizationId,
    key: string,
    cursor?: ModuleReleasePageCursor,
  ): Promise<ResolvableModuleReleasePage> {
    const memoKey = JSON.stringify([organizationId, key, cursor ?? null]);
    const known = this.moduleReleasePageReads.get(memoKey);
    if (known !== undefined) return known;
    const read = new Promise<ResolvableModuleReleasePage>((resolve, reject) => {
      const first = this.pendingModulePages.length === 0;
      this.pendingModulePages.push({ organizationId, key, cursor, resolve, reject });
      if (first)
        queueMicrotask(() => {
          void this.readPendingModulePages();
        });
    });
    this.moduleReleasePageReads.set(memoKey, read);
    return read;
  }

  /** Resolve one requested frontier's page locators and exact definitions in two batched queries. */
  private async readPendingModulePages(): Promise<void> {
    const requests = this.pendingModulePages;
    this.pendingModulePages = [];
    try {
      if (requests.some((request) => request.organizationId !== this.context.organizationId))
        return invalidStorage("Module page requested for another organisation");
      const rows = await this.transaction.query`
        select vortex_definition.read_module_release_page(
          requested.value ->> 'key',
          (requested.value #>> '{cursor,anchorReleaseRevision}')::bigint,
          (requested.value #>> '{cursor,afterReleaseRevision}')::bigint,
          ${100}
        ) as module_release_page
        from pg_catalog.jsonb_array_elements(${JSON.stringify(requests.map(({ key, cursor }) => ({ key, cursor })))}::text::jsonb)
          with ordinality as requested(value, ordinality)
        order by requested.ordinality
      `;
      if (rows.length !== requests.length)
        return invalidStorage("Module page frontier is incomplete");
      const pages = rows.map((row, index) => parseModuleReleasePage(row, requests[index]!.cursor));
      const releases = await this.readModuleReleases(
        this.context.organizationId,
        pages.flatMap((page) =>
          page.entries.map((entry) => ({
            rootId: page.rootId!,
            releaseRevision: entry.releaseRevision,
          })),
        ),
      );
      let offset = 0;
      const materialized = pages.map((page, index): ResolvableModuleReleasePage => ({
        rootId: page.rootId,
        anchorReleaseRevision: page.anchorReleaseRevision,
        nextAfterReleaseRevision: page.nextAfterReleaseRevision,
        entries: page.entries.map((entry) => {
          const release = releases[offset++];
          if (
            release === undefined ||
            release.organizationId !== this.context.organizationId ||
            release.key !== requests[index]!.key ||
            release.rootId !== page.rootId ||
            release.releaseRevision !== entry.releaseRevision
          )
            return invalidStorage("readModuleReleasePage found inconsistent stored evidence");
          return { previousReleaseRevision: entry.previousReleaseRevision, release };
        }),
      }));
      requests.forEach((request, index) => request.resolve(materialized[index]!));
    } catch (error) {
      requests.forEach((request) => request.reject(error));
    }
  }

  readModuleRelease(
    organizationId: typeof this.context.organizationId,
    rootId: Parameters<DefinitionPublicationReader["readModuleRelease"]>[1],
    releaseRevision: number,
  ): Promise<ResolvableModuleRelease | undefined> {
    return this.readModuleReleases(organizationId, [{ rootId, releaseRevision }]).then(
      (releases) => releases[0],
    );
  }

  /** One query per missing frontier; single, bulk and page reads share exact objects. */
  async readModuleReleases(
    organizationId: typeof this.context.organizationId,
    locators: Parameters<DefinitionPublicationReader["readModuleReleases"]>[1],
  ): Promise<(ResolvableModuleRelease | undefined)[]> {
    const keyOf = (locator: (typeof locators)[number]) =>
      JSON.stringify([
        organizationId,
        String(locator.rootId).toLowerCase(),
        locator.releaseRevision,
      ]);
    const missing = [
      ...new Map(
        locators
          .filter((locator) => !this.moduleReleaseReads.has(keyOf(locator)))
          .map((locator) => [keyOf(locator), locator]),
      ).values(),
    ];
    if (missing.length > 0) {
      const batch = this.queryModuleReleases(organizationId, missing);
      missing.forEach((locator, index) => {
        this.moduleReleaseReads.set(
          keyOf(locator),
          batch.then((releases) => releases[index]),
        );
      });
    }
    return Promise.all(locators.map((locator) => this.moduleReleaseReads.get(keyOf(locator))!));
  }

  private async queryModuleReleases(
    organizationId: typeof this.context.organizationId,
    locators: Parameters<DefinitionPublicationReader["readModuleReleases"]>[1],
  ): Promise<(ResolvableModuleRelease | undefined)[]> {
    const rows = await this.transaction.query`
      select vortex_definition.read_module_release(
        (requested.value ->> 'rootId')::uuid,
        (requested.value ->> 'releaseRevision')::bigint
      ) as module_release
      from pg_catalog.jsonb_array_elements(${JSON.stringify(locators)}::text::jsonb)
        with ordinality as requested(value, ordinality)
      order by requested.ordinality
    `;
    if (rows.length !== locators.length)
      return invalidStorage("readModuleReleases found inconsistent stored evidence");
    return rows.map((raw, index) => {
      const row = moduleReleaseRowSchema.safeParse(raw);
      if (!row.success) return invalidStorage(row.error);
      if (row.data.module_release === null) return undefined;
      const parsed = rawModuleReleaseSchema.safeParse(row.data.module_release);
      if (!parsed.success) return invalidStorage(parsed.error);
      const release = this.materializeModuleRelease(parsed.data);
      if (
        release.organizationId !== organizationId ||
        release.rootId !== locators[index]!.rootId ||
        release.releaseRevision !== locators[index]!.releaseRevision
      )
        return invalidStorage("readModuleReleases found inconsistent stored evidence");
      return release;
    });
  }

  /**
   * Returns the current Application release: the ordinary candidate reader has read and
   * checked it, and it is the only release page adoption compares against.
   */
  async readApplicationPageAdoptionRelease(
    rootId: string,
    releaseRevision: number,
    expectedAnchorReleaseRevision: number,
  ): Promise<AuthenticatedApplicationPageAdoptionRelease | undefined> {
    const candidate = await this.readCandidate(rootId);
    if (candidate === undefined) return undefined;
    if (
      candidate.draft.kind !== "application" ||
      candidate.draft.source.kind !== "application" ||
      candidate.historyEvidence.kind !== "application" ||
      candidate.historyEvidence.anchorReleaseRevision !== expectedAnchorReleaseRevision ||
      candidate.draft.publishedRevision !== expectedAnchorReleaseRevision ||
      releaseRevision !== expectedAnchorReleaseRevision
    )
      return invalidStorage(
        "readApplicationPageAdoptionRelease found inconsistent stored evidence",
      );
    const selected = (
      await this.readLatestRelease(
        rootId,
        expectedAnchorReleaseRevision,
        "application",
        candidate.draft.key,
        String(candidate.draft.rootId),
      )
    ).stored;
    const evidence = selected.evidence;
    if (
      evidence.authoredSource.kind !== "application" ||
      evidence.compilationOutput.kind !== "application" ||
      evidence.resolutionSnapshot.contractVersion !== "3.0.0"
    )
      return invalidStorage(
        "readApplicationPageAdoptionRelease found inconsistent stored evidence",
      );
    const storedOutput = definitionCompilationOutputSchema.safeParse(evidence.compilationOutput);
    if (!storedOutput.success || storedOutput.data.kind !== "application")
      return invalidStorage(
        "readApplicationPageAdoptionRelease found inconsistent stored evidence",
      );
    const canonical = applicationDraftFromStoredRelease(storedOutput.data);
    return Object.freeze({
      organizationId: candidate.draft.organizationId,
      rootId: String(candidate.draft.rootId),
      key: candidate.draft.key,
      publication: publishedApplicationReferenceSchema.parse(selected.publication),
      authoredSource: evidence.authoredSource,
      authoredSourceFingerprint: evidence.authoredSourceFingerprint,
      compilationOutput: {
        ...storedOutput.data,
        canonical,
      },
      resolutionSnapshot: evidence.resolutionSnapshot,
      identities: evidence.resolutionSnapshot.identities,
      impactReasons: evidence.impactReasons,
    });
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
      if (kind === "application") {
        if (
          release.evidence.authoredSource.kind !== "application" ||
          output.kind !== "application" ||
          release.publication.kind !== "application"
        )
          return invalidStorage("materializeHistory found inconsistent stored evidence");
        try {
          selectApplicationContractPair(
            release.evidence.sourceContractVersion,
            release.publication.validationContractVersion,
          );
        } catch (error) {
          return invalidStorage("materializeHistory found inconsistent stored evidence", error);
        }
        if (output.validationContractVersion !== "3.0.0" || resolution.contractVersion !== "3.0.0")
          return invalidStorage("materializeHistory found inconsistent stored evidence");
      }
      if (kind === "module") {
        if (
          release.evidence.authoredSource.kind !== "module" ||
          output.kind !== "module" ||
          release.publication.kind !== "module"
        )
          return invalidStorage("materializeHistory found inconsistent stored evidence");
        try {
          assertModuleContractPair(
            release.evidence.sourceContractVersion,
            release.publication.validationContractVersion,
          );
        } catch (error) {
          return invalidStorage("materializeHistory found inconsistent stored evidence", error);
        }
        if (output.validationContractVersion !== "3.0.0" || resolution.contractVersion !== "3.0.0")
          return invalidStorage("materializeHistory found inconsistent stored evidence");
      }
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
        output.artifact.contentFingerprint !== release.publication.contentFingerprint ||
        release.evidence.authoredSourceFingerprint !==
          fingerprintCanonicalValue(release.evidence.authoredSource) ||
        release.evidence.authoredSource.source_contract_version !==
          release.evidence.sourceContractVersion ||
        release.evidence.authoredSource.kind !== kind ||
        release.evidence.authoredSource.key !== key ||
        !hasAuthenticStoredCustomerDefinitionRelease({
          organizationId: this.context.organizationId,
          kind,
          key,
          rootId,
          releaseVersion: release.publication.releaseVersion,
          sourceContractVersion: release.evidence.sourceContractVersion,
          validationContractVersion: release.publication.validationContractVersion,
          contentFingerprint: release.publication.contentFingerprint,
          resolutionFingerprint: release.evidence.resolutionFingerprint,
          compilationOutput: output,
          resolutionSnapshot: resolution,
        }) ||
        !sameCanonicalValue(output.canonical.content, release.content)
      )
        return invalidStorage("materializeHistory found inconsistent stored evidence");
      if (!dependencyReferencesMatch(output, release.dependencyManifest))
        return invalidStorage("materializeHistory found inconsistent stored evidence");
      const published =
        kind === "module" && output.kind === "module" && release.publication.kind === "module"
          ? moduleVersionImpactHistoryEntrySchema.safeParse({
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
                content: applicationDraftFromStoredRelease(output).content,
                dependencyManifest: release.dependencyManifest.filter(
                  (dependency) => dependency.kind === "module",
                ),
                releaseNote: release.releaseNote,
              })
            : undefined;
      if (published === undefined || !published.success)
        return invalidStorage("materializeHistory found inconsistent stored evidence");
      history.push(published.data as never);
    }
    return kind === "module"
      ? ({ kind, definitionKey: key, history } as PublishedDefinitionHistory)
      : ({ kind, definitionKey: key, history } as PublishedDefinitionHistory);
  }

  private readonly materializedModules = new Map<string, ResolvableModuleRelease>();

  private materializeModuleRelease(release: RawModuleRelease): ResolvableModuleRelease {
    const key = JSON.stringify([
      release.organizationId,
      String(release.rootId).toLowerCase(),
      release.releaseRevision,
    ]);
    const known = this.materializedModules.get(key);
    if (known !== undefined) {
      if (
        known.key !== release.key ||
        known.releaseVersion !== release.releaseVersion ||
        known.contentFingerprint !== release.contentFingerprint ||
        known.resolutionFingerprint !== release.resolutionFingerprint
      )
        return invalidStorage("One snapshot contains substituted release evidence");
      return known;
    }
    const output = release.compilationOutput;
    const snapshot = release.resolutionSnapshot;
    if (output.kind !== "module")
      return invalidStorage("materializeModuleRelease found inconsistent stored evidence");
    const validationContractVersion = output.validationContractVersion;
    const sourceContractVersion = release.sourceContractVersion;
    try {
      assertModuleContractPair(sourceContractVersion, validationContractVersion);
    } catch (error) {
      return invalidStorage("materializeModuleRelease found inconsistent stored evidence", error);
    }
    const ownResolution = snapshot.definitions.filter(
      (definition) =>
        definition.kind === "module" &&
        definition.key === release.key &&
        definition.rootId === release.rootId &&
        definition.exactVersion === release.releaseVersion,
    );
    if (
      release.authoredSource.kind !== "module" ||
      release.authoredSource.key !== release.key ||
      release.authoredSource.source_contract_version !== sourceContractVersion ||
      fingerprintCanonicalValue(release.authoredSource) !== release.authoredSourceFingerprint ||
      ownResolution.length !== 1 ||
      release.organizationId !== this.context.organizationId ||
      release.published.publication.rootId !== release.rootId ||
      release.published.publication.revision !== release.releaseRevision ||
      release.published.publication.releaseVersion !== release.releaseVersion ||
      release.published.publication.validationContractVersion !== validationContractVersion ||
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
      !hasAuthenticStoredCustomerDefinitionRelease({
        organizationId: release.organizationId,
        kind: "module",
        key: release.key,
        rootId: release.rootId,
        releaseVersion: release.releaseVersion,
        sourceContractVersion,
        validationContractVersion,
        contentFingerprint: release.contentFingerprint,
        resolutionFingerprint: release.resolutionFingerprint,
        compilationOutput: output,
        resolutionSnapshot: snapshot,
      }) ||
      !sameCanonicalValue(snapshot.identities, release.identities) ||
      !sameCanonicalValue(output.canonical.content, release.published.content) ||
      !dependencyReferencesMatch(output, release.published.dependencyManifest)
    )
      return invalidStorage("materializeModuleRelease found inconsistent stored evidence");
    const published = moduleVersionImpactHistoryEntrySchema.safeParse({
      publication: release.published.publication,
      content: output.canonical.content,
      dependencyManifest: release.published.dependencyManifest,
      releaseNote: release.published.releaseNote,
    });
    if (
      !published.success ||
      fingerprintCanonicalValue(published.data.content) !== release.contentFingerprint
    )
      return invalidStorage("materializeModuleRelease found inconsistent stored evidence");
    const materialized: ResolvableModuleRelease = {
      organizationId: release.organizationId,
      key: release.key,
      rootId: release.rootId,
      releaseRevision: release.releaseRevision,
      releaseVersion: release.releaseVersion,
      contentFingerprint: release.contentFingerprint,
      resolutionFingerprint: release.resolutionFingerprint,
      sourceFingerprint: release.authoredSourceFingerprint,
      compilationOutput: output,
      resolutionSnapshot: snapshot,
      published: published.data,
    };
    this.materializedModules.set(key, materialized);
    this.moduleReleaseReads.set(key, Promise.resolve(materialized));
    return materialized;
  }
}

const ownedModuleRootRowSchema = z
  .object({
    root_id: moduleRootIdSchema,
    definition_key: namespacedKeySchema,
    draft_revision: safeRevisionSchema,
    current_release_revision: nullableRevisionSchema,
    source_fingerprint: fingerprintSchema,
  })
  .strict();

const parseOwnedModuleRoot = (row: DatabaseRow): OwnedModuleRoot => {
  const parsed = ownedModuleRootRowSchema.safeParse(row);
  if (!parsed.success) return invalidStorage(parsed.error);
  return {
    rootId: parsed.data.root_id,
    key: parsed.data.definition_key,
    draftRevision: parsed.data.draft_revision as OwnedModuleRoot["draftRevision"],
    currentReleaseRevision: parsed.data
      .current_release_revision as OwnedModuleRoot["currentReleaseRevision"],
    sourceFingerprint: parsed.data.source_fingerprint,
  };
};

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

  async createOwnedModuleRoot(
    applicationRootId: string,
    source: ModuleSourceDocument,
  ): Promise<OwnedModuleRoot> {
    const rows = await this.transaction.query`
      select root_id, definition_key, draft_revision, published_revision as current_release_revision,
        source_fingerprint
      from vortex_definition.create_root(
        ${"module"},
        ${source.key},
        ${JSON.stringify(source)}::text::jsonb,
        ${fingerprintCanonicalValue(source)},
        ${JSON.stringify(extractStoredSourceIdentityRequirements(source))}::text::jsonb,
        ${null}::text,
        ${applicationRootId}::uuid
      )
    `;
    if (rows.length !== 1) return invalidStorage("createOwnedModuleRoot returned no root");
    return parseOwnedModuleRoot(rows[0]!);
  }

  async stageOwnedModuleSource(
    root: OwnedModuleRoot,
    source: ModuleSourceDocument,
  ): Promise<OwnedModuleRoot> {
    const rows = await safeRepositoryOperation(
      () => this.transaction.query`
      select root_id, definition_key, draft_revision, current_release_revision, source_fingerprint
      from vortex_definition.stage_owned_module_source(
        ${root.rootId}::uuid,
        ${root.draftRevision},
        ${JSON.stringify(source)}::text::jsonb,
        ${fingerprintCanonicalValue(source)},
        ${JSON.stringify(extractStoredSourceIdentityRequirements(source))}::text::jsonb
      )
    `,
      source,
    );
    if (rows.length === 0) throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    if (rows.length !== 1) return invalidStorage("stageOwnedModuleSource returned several roots");
    return parseOwnedModuleRoot(rows[0]!);
  }

  appendModuleRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    if (release.draft.kind !== "module" || release.compilationOutput.kind !== "module")
      return invalidStorage("appendModuleRelease received a non-Module release");
    return this.appendRoot(release);
  }

  appendRelease(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    if (release.draft.kind !== "application" || release.compilationOutput.kind !== "application")
      return invalidStorage("appendRelease received a non-Application release");
    return this.appendRoot(release);
  }

  private async appendRoot(release: DefinitionReleaseAppend): Promise<PublishDefinitionResult> {
    this.forgetModuleReleaseReadsOf(String(release.draft.rootId), release.draft.key);
    if (
      release.compilationOutput.resolutionFingerprint !== release.resolutionSnapshot.fingerprint ||
      release.compilationOutput.artifact.resolutionFingerprint !==
        release.resolutionSnapshot.fingerprint ||
      !hasAuthenticResolutionFingerprint(release.resolutionSnapshot)
    )
      return invalidStorage("appendRelease found inconsistent stored evidence");
    const evidence = {
      releaseVersion: release.assignedVersion,
      compilationOutput: release.compilationOutput,
      resolutionSnapshot: release.resolutionSnapshot,
      contentFingerprint: release.compilationOutput.artifact.contentFingerprint,
      resolutionFingerprint: release.resolutionSnapshot.fingerprint,
      validationContractVersion: release.validationContractVersion,
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
        ${JSON.stringify(evidence)}::text::jsonb
      )
    `;
    if (rows.length === 0) throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING");
    const parsed = appendReleaseRowSchema.safeParse(rows.length === 1 ? rows[0] : undefined);
    if (!parsed.success) return invalidStorage(parsed.error);
    return publishDefinitionResultSchema.parse({
      rootId: parsed.data.root_id,
      releaseRevision: parsed.data.release_revision,
      releaseVersion: parsed.data.release_version,
      contentFingerprint: parsed.data.content_fingerprint,
      resolutionFingerprint: parsed.data.resolution_fingerprint,
      dependencyManifest: parsed.data.dependency_manifest,
      publishedAt: parsed.data.published_at,
      publishedBy: parsed.data.published_by,
    });
  }
}

const safeRepositoryOperation = async <Result>(
  operation: () => Promise<Result>,
  source?: StoredDefinitionSource,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    const retired = identityRetiredFailure(error, source);
    if (retired !== undefined) throw retired;
    switch (classifyDatabaseError(error)) {
      case "conflict":
      case "duplicate":
        throw new DefinitionError("DEFINITION_DRAFT_STALE_OR_MISSING", { cause: error });
      case "refused": {
        // One SQLSTATE covers two refusals; the database message names which one.
        const message = error instanceof Error ? error.message : "";
        if (message.includes("does not belong to the context organization"))
          throw new DefinitionError("DEFINITION_ORGANIZATION_MISMATCH", { cause: error });
        if (message.includes("publication authority is unavailable"))
          throw new DefinitionError("DEFINITION_PUBLICATION_AUTHORITY_UNAVAILABLE", {
            cause: error,
          });
        throw unexpectedDefinitionFailure(
          "DEFINITION_PUBLICATION_FAILED",
          error,
          "publication repository",
        );
      }
      default:
        throw unexpectedDefinitionFailure(
          "DEFINITION_PUBLICATION_FAILED",
          error,
          "publication repository",
        );
    }
  }
};

export const createDatabaseDefinitionPublicationRepository = (
  transaction: RequestDatabaseTransaction,
): DefinitionPublicationRepository => ({
  read: (context, operation) =>
    safeRepositoryOperation(() => operation(new DatabasePublicationReader(transaction, context))),
  transaction: (context, operation) =>
    safeRepositoryOperation(() =>
      operation(new DatabasePublicationTransaction(transaction, context)),
    ),
});

/** Concrete full-evidence reader for the bounded ordinary page-adoption consumer. */
export const readAuthenticatedApplicationPageAdoptionRelease = (
  transaction: RequestDatabaseTransaction,
  context: SessionContext,
  rootId: string,
  releaseRevision: number,
  expectedAnchorReleaseRevision: number,
): Promise<AuthenticatedApplicationPageAdoptionRelease | undefined> =>
  safeRepositoryOperation(() =>
    new DatabasePublicationReader(transaction, context).readApplicationPageAdoptionRelease(
      rootId,
      releaseRevision,
      expectedAnchorReleaseRevision,
    ),
  );

/** Builds the production publication service from the database repository and one platform release catalogue. */
export const createDatabaseDefinitionPublicationService = (
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  transaction: RequestDatabaseTransaction,
  authority: BuilderAuthority,
) => {
  const service = createDefinitionPublicationService(
    createDatabaseDefinitionPublicationRepository(transaction),
    createImmutableDefinitionPublicationCatalogue(catalogueDefinition),
    authority,
  );
  const compiling = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const [settings] = await transaction.query<{ idle_timeout: string }>`
      select pg_catalog.current_setting('idle_in_transaction_session_timeout') as idle_timeout
    `;
    if (settings === undefined) throw new Error("Publication transaction settings are unavailable");
    // Compilation can legitimately spend longer than a request's idle backstop between queries.
    // Only this publication operation receives the exception; rollback clears it on failure.
    await transaction.query`
      select pg_catalog.set_config('idle_in_transaction_session_timeout', '0', true)
    `;
    const result = await operation();
    await transaction.query`
      select pg_catalog.set_config('idle_in_transaction_session_timeout', ${settings.idle_timeout}, true)
    `;
    return result;
  };
  return {
    ...service,
    prepare: (...args: Parameters<typeof service.prepare>) =>
      compiling(() => service.prepare(...args)),
    publish: (...args: Parameters<typeof service.publish>) =>
      compiling(() => service.publish(...args)),
  };
};
