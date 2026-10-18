import "server-only";

import { z } from "zod";
import {
  activeApplicationInstallationEvidenceSchema,
  correlationIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  sameId,
  systemApplicationBoundReleaseSetResultSchema,
  timestampSchema,
  type OrganizationSelectionCandidate,
  type SystemApplicationBoundReleaseSetResult,
} from "../schema";
import type { PreparedApplicationPermissionRegistration } from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  assembleHumanInstalledRuntimeContext,
  requireInstalledRuntimeContext,
  type HumanInstalledRuntimeContextDependencies,
  type InstalledRuntimeContext,
} from "./installed-runtime-context";
import { DefinitionError } from "./definition-error";
import {
  projectStoredConsumerRelease,
  storedConsumerReleaseEvidenceSchema,
} from "./definition-consumer-read-definition";
import {
  createImmutableDefinitionPublicationCatalogue,
  type ImmutableDefinitionPublicationCatalogueDefinition,
} from "./publication/read";

const previewRuntimeSourceSchema = z
  .object({
    installation: activeApplicationInstallationEvidenceSchema,
    draftRevision: revisionSchema,
    expiresAt: timestampSchema,
    correlationId: correlationIdSchema,
    releaseSet: z.unknown(),
    seedBoundedRecordTypeIds: z.array(recordTypeIdSchema).max(201),
  })
  .strict();

/**
 * The deliberate preview bound: a preview's storage holds at most this many records of one record
 * type, the first the builder can read live. The database seed applies the same number.
 */
export const PREVIEW_SEED_RECORD_BOUND = 2000;

/**
 * What marks a runtime context as a preview: its address, draft revision and expiry, and the
 * record types whose seed reached the preview bound.
 */
export type RuntimePreview = Readonly<{
  previewInstallationId: string;
  draftRevision: number;
  expiresAt: string;
  seedBoundedRecordTypeIds: readonly string[];
}>;

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(Reflect.get(value, key));
  Object.freeze(value);
  return value;
};

/**
 * A preview's release set is written once for each draft revision it follows, so it is read and
 * parsed once per preview and draft revision and then shared, with the permission registration
 * prepared from it. The database sends the set only when this cache does not hold the revision the
 * preview runs. Preparation is a pure function of the frozen release content, organisation,
 * Application and release revision, so a cached registration is exactly the one a request would
 * prepare; it decides nothing, and every request still checks its installation against the set.
 */
type CachedPreviewRelease = {
  readonly draftRevision: number;
  readonly releaseSet: SystemApplicationBoundReleaseSetResult;
  registration?: PreparedApplicationPermissionRegistration;
};
const previewReleaseSetCacheSize = 16;
const previewReleaseSets = new Map<string, CachedPreviewRelease>();

const cachedPreviewRelease = (previewInstallationId: string): CachedPreviewRelease | undefined =>
  previewReleaseSets.get(previewInstallationId.toLowerCase());

const previewRelease = (
  previewInstallationId: string,
  draftRevision: number,
  candidate: unknown,
): CachedPreviewRelease => {
  const key = previewInstallationId.toLowerCase();
  const cached = previewReleaseSets.get(key);
  if (cached !== undefined && cached.draftRevision === draftRevision && candidate === null) {
    previewReleaseSets.delete(key);
    previewReleaseSets.set(key, cached);
    return cached;
  }
  const entry: CachedPreviewRelease = {
    draftRevision,
    releaseSet: deepFreeze(systemApplicationBoundReleaseSetResultSchema.parse(candidate)),
  };
  previewReleaseSets.delete(key);
  previewReleaseSets.set(key, entry);
  for (const oldest of previewReleaseSets.keys()) {
    if (previewReleaseSets.size <= previewReleaseSetCacheSize) break;
    previewReleaseSets.delete(oldest);
  }
  return entry;
};

const runtimePreviews = new WeakMap<object, RuntimePreview>();

/**
 * Builds the HUMAN runtime context of the preview this request's transaction runs. The database
 * reads the preview only for a builder of its Application and only while it is unexpired; the
 * context is then assembled and permission-registered exactly like an installed one.
 */
export const loadHumanPreviewRuntimeContext = async (
  transaction: RequestDatabaseTransaction,
  scope: HumanInstalledRuntimeContextDependencies["scope"],
): Promise<InstalledRuntimeContext> => {
  const held = scope.previewInstallationId === undefined
    ? undefined : cachedPreviewRelease(scope.previewInstallationId);
  const rows = await transaction.query<DatabaseRow & { readonly source: unknown }>`
    select vortex_definition.read_preview_runtime_source(
      ${held?.draftRevision ?? null}::bigint
    ) as source
  `;
  const source = previewRuntimeSourceSchema.safeParse(
    rows.length === 1 ? rows[0]?.source : undefined,
  );
  if (!source.success)
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", {
      cause: source.error,
    });
  const { installation, correlationId } = source.data;
  if (
    installation.previewInstallationId === undefined ||
    scope.previewInstallationId === undefined ||
    !sameId(installation.previewInstallationId, scope.previewInstallationId) ||
    !sameId(installation.organizationId, scope.organizationId) ||
    !sameId(installation.applicationRootId, scope.applicationRootId)
  )
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_REFUSED");
  // The set left out is the cached one of exactly this revision; one evicted meanwhile is read again.
  const kept = source.data.releaseSet === null ? cachedPreviewRelease(installation.previewInstallationId) : undefined;
  if (source.data.releaseSet === null && kept?.draftRevision !== source.data.draftRevision) {
    previewReleaseSets.delete(installation.previewInstallationId.toLowerCase());
    return loadHumanPreviewRuntimeContext(transaction, scope);
  }
  const release = previewRelease(
    installation.previewInstallationId,
    source.data.draftRevision,
    source.data.releaseSet,
  );
  const { releaseSet } = release;
  const context = assembleHumanInstalledRuntimeContext(
    installation,
    {
      application: Object.freeze({ ...releaseSet.application, correlationId }),
      modules: releaseSet.modules.map((module) => Object.freeze({ ...module, correlationId })),
    },
    scope,
    (validated, prepare) => {
      if (release.registration !== undefined) return release.registration;
      const prepared = deepFreeze(prepare(validated));
      release.registration = prepared;
      return prepared;
    },
  );
  runtimePreviews.set(context, {
    previewInstallationId: installation.previewInstallationId,
    draftRevision: source.data.draftRevision,
    expiresAt: source.data.expiresAt,
    seedBoundedRecordTypeIds: Object.freeze([...source.data.seedBoundedRecordTypeIds]),
  });
  return context;
};

/** The preview a runtime context runs, or undefined for an installed Application. */
export const runtimePreviewOf = (contextCandidate: unknown): RuntimePreview | undefined =>
  runtimePreviews.get(requireInstalledRuntimeContext(contextCandidate));

/**
 * The request selection of a runtime context: its organisation and Application, and the preview
 * it runs, so every request a page makes reads the same preview as the page itself.
 */
export const runtimeContextSelection = (
  contextCandidate: unknown,
): OrganizationSelectionCandidate => {
  const context = requireInstalledRuntimeContext(contextCandidate);
  const preview = runtimePreviews.get(context);
  return {
    organizationId: context.organizationId,
    applicationRootId: context.applicationRootId,
    ...(preview === undefined ? {} : { previewInstallationId: preview.previewInstallationId }),
  };
};

const previewReleaseEvidenceSchema = z
  .object({
    installation: activeApplicationInstallationEvidenceSchema,
    correlationId: correlationIdSchema,
    application: storedConsumerReleaseEvidenceSchema,
    modules: z.array(storedConsumerReleaseEvidenceSchema).min(1).max(10_000),
  })
  .strict();

/**
 * Projects the release set a new preview runs from its exact release evidence, through the same
 * projection an installation's runtime source uses, and stores it with the preview. It runs in
 * the transaction that provisioned the preview, addressed to that preview.
 */
export const writePreviewRuntimeReleaseSet = async (
  transaction: RequestDatabaseTransaction,
  catalogueDefinition: ImmutableDefinitionPublicationCatalogueDefinition,
  previewInstallationId: string,
): Promise<void> => {
  await transaction.query`
    select pg_catalog.set_config(
      'vortex_record.preview_installation_id', ${previewInstallationId}, true
    )
  `;
  const rows = await transaction.query<DatabaseRow & { readonly evidence: unknown }>`
    select vortex_definition.read_preview_release_evidence() as evidence
  `;
  const evidence = previewReleaseEvidenceSchema.parse(
    rows.length === 1 ? rows[0]?.evidence : undefined,
  );
  const { installation, correlationId } = evidence;
  const catalogue = createImmutableDefinitionPublicationCatalogue(catalogueDefinition);
  const application = await projectStoredConsumerRelease(
    evidence.application,
    {
      kind: "application",
      rootId: installation.applicationRootId,
      releaseRevision: installation.applicationReleaseRevision,
      organizationId: installation.organizationId,
    },
    correlationId,
    catalogue,
  );
  const modules = [];
  for (const module of evidence.modules)
    modules.push(
      await projectStoredConsumerRelease(
        module,
        {
          kind: "module",
          rootId: module.rootId,
          releaseRevision: module.releaseRevision,
          organizationId: installation.organizationId,
        },
        correlationId,
        catalogue,
      ),
    );
  const releaseSet = systemApplicationBoundReleaseSetResultSchema.parse({ application, modules });
  const written = await transaction.query<DatabaseRow & { readonly written: unknown }>`
    select vortex_definition.write_preview_runtime_release_set(
      ${JSON.stringify(releaseSet)}::text::jsonb
    ) as written
  `;
  if (written.length !== 1 || written[0]?.written !== true)
    throw new DefinitionError("PREVIEW_INSTALLATION_FAILED");
};
