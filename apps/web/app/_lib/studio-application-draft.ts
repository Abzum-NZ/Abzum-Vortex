import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/access";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  sessionContextSchema,
  sameId,
  canonicalJson,
  type OrganizationId,
  type StoredDefinitionDraft,
} from "@vortex/contracts";
import type { DatabaseRow } from "@vortex/db";
import {
  BuilderAuthorityError,
  readApplicationDefinitionDraft,
  requireBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  createDatabaseDefinitionPublicationRepository,
  applicationSearchFieldIsSelectable,
  fingerprintCanonicalValue,
  type ModuleReleasePageCursor,
  type ResolvableModuleRelease,
} from "@vortex/definition";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

type StoredApplicationDefinitionDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

type StudioAuthorityResult<Value> =
  | Readonly<{ kind: "available"; value: Value }>
  | Readonly<{ kind: "refused" }>;

const isExpectedBuilderRefusal = (error: unknown): boolean =>
  error instanceof BuilderAuthorityError &&
  (error.code === "BUILDER_PERMISSION_REFUSED" ||
    error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED");

export type StudioApplicationLoadResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId; draft: StoredApplicationDefinitionDraft; searchMetadata: StudioApplicationSearchMetadata | null }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** Protected choices are response metadata, never part of the persisted authored draft. */
export type StudioApplicationSearchMetadata = Readonly<{
  organizationId: string; rootId: string; draftRevision: number; sourceFingerprint: string;
  bindingsSignature: string; resolutionFingerprint: string;
  modules: readonly Readonly<{
    organizationId: string; moduleRootId: string; key: string;
    releaseRevision: number; releaseVersion: string;
    contentFingerprint: string; resolutionFingerprint: string;
  }>[];
  records: readonly Readonly<{
    reference: string; label: string; recordTypeId: string;
    moduleRootId: string; releaseRevision: number; releaseVersion: string;
    contentFingerprint: string; resolutionFingerprint: string;
    fields: readonly Readonly<{ reference: string; fieldId: string; label: string }>[];
  }>[];
}>;

export type StudioApplicationCreateAccessResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

/** Mirrors the writer's protected classification; an unknown existing root is never ordinary. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const rows = await transaction.query<ClassificationRow>`
    select outcome, application_origin_kind
    from vortex_definition.read_builder_application_root_classification(${rootId}::uuid)
  `;
  const row = rows[0];
  if (
    rows.length !== 1 || row === undefined || row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  ) throw new Error("STUDIO_DRAFT_UNAVAILABLE");
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

/** Organization selection is resolved from the current signed-in human on every request. */
export const loadStudioCreateAccess = async (
  candidateOrganizationId: string,
): Promise<StudioApplicationCreateAccessResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  if (!organization.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session, { organizationId: organization.data }, async (
        transaction,
        scope,
      ): Promise<StudioAuthorityResult<OrganizationId>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change" });
        } catch (error) {
          if (isExpectedBuilderRefusal(error)) return { kind: "refused" };
          throw error;
        }
        return { kind: "available", value: scope.organizationId };
      },
    );
    return result.kind === "available"
      ? result.value.kind === "available"
        ? { kind: "available", organizationId: result.value.value }
        : { kind: "refused" }
      : result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
};

/** Classification, permission and detached draft read share one verified request transaction. */
export const loadStudioApplicationDraft = async (
  candidateOrganizationId: string,
  candidateRootId: string,
): Promise<StudioApplicationLoadResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session, { organizationId: organization.data }, async (
        transaction,
        scope,
        issuedAt,
      ): Promise<StudioAuthorityResult<Readonly<{
        organizationId: OrganizationId;
        draft: StoredApplicationDefinitionDraft;
        searchMetadata: StudioApplicationSearchMetadata | null;
      }>>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
        } catch (error) {
          if (isExpectedBuilderRefusal(error)) return { kind: "refused" };
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data });
        let searchMetadata: StudioApplicationSearchMetadata | null = null;
        try {
          const readContext = async () => {
            const contextRows = await transaction.query<DatabaseRow>`select vortex_access.validated_human_request_context() as context`;
            const transport = contextRows[0]?.context;
            if (contextRows.length !== 1 || transport === null || typeof transport !== "object" || Array.isArray(transport) ||
                !("channel" in transport) || transport.channel !== "web") throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
            const context = sessionContextSchema.parse(Object.fromEntries(Object.entries(transport).filter(([key]) => key !== "channel")));
            const now = Date.now();
            const from = Date.parse(context.issuedAt);
            const until = Date.parse(context.expiresAt);
            if (context.callerKind !== "human" || Object.hasOwn(scope, "applicationRootId") || Object.hasOwn(context, "applicationRootId") ||
                context.delegatedContext !== undefined || context.supportContext !== undefined ||
                !sameId(context.organizationId, scope.organizationId) || !sameId(context.organizationAccountId, scope.organizationAccountId) ||
                context.accessVersion !== scope.accessVersion || !sameId(context.tenantId, scope.tenantId) ||
                !sameId(context.identityId, resolved.session.identityId) || !sameId(context.sessionId, resolved.session.sessionId) ||
                context.authenticationStrength !== resolved.session.authenticationStrength || context.issuedAt !== issuedAt ||
                context.expiresAt !== resolved.session.accessTokenExpiresAt || context.accessTokenIssuedAt !==
                  (resolved.session.primaryAuthenticatedAt !== undefined || resolved.session.multiFactorAuthenticatedAt !== undefined
                    ? resolved.session.accessTokenIssuedAt : undefined) ||
                context.primaryAuthenticatedAt !== resolved.session.primaryAuthenticatedAt ||
                context.multiFactorAuthenticatedAt !== resolved.session.multiFactorAuthenticatedAt ||
                !Number.isFinite(now) || !Number.isFinite(from) || !Number.isFinite(until) || from > now || until <= now || from >= until)
              throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
            return context;
          };
          const context = await readContext();
          const compiled = await createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority)
            .compileApplicationDraft(context, { rootId: draft.rootId, expectedDraftRevision: draft.draftRevision });
          const envelope = compiled.compilation.canonical.envelope;
          if (!sameId(envelope.rootId, draft.rootId) || !sameId(envelope.organizationId, draft.organizationId) || envelope.key !== draft.key ||
              envelope.draftRevision !== draft.draftRevision || envelope.publishedRevision !== draft.publishedRevision ||
              envelope.createdAt !== draft.createdAt || !sameId(envelope.createdBy, draft.createdBy) ||
              envelope.updatedAt !== draft.updatedAt || !sameId(envelope.updatedBy, draft.updatedBy) ||
              compiled.currentReleaseRevision !== (draft.publishedRevision ?? null) ||
              compiled.compilation.artifact.contentFingerprint !== fingerprintCanonicalValue(compiled.compilation.canonical.content) ||
              compiled.compilation.artifact.resolutionFingerprint !== compiled.compilation.resolutionFingerprint)
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          const records: StudioApplicationSearchMetadata["records"][number][] = [];
          const modules = new Map<string, StudioApplicationSearchMetadata["modules"][number]>();
          await createDatabaseDefinitionPublicationRepository(transaction).read(context, async (reader) => {
            for (const binding of compiled.compilation.canonical.content.moduleBindings) {
              const selections = compiled.compilation.resolvedDependencies.filter((dependency) => dependency.kind === "module" &&
                sameId(dependency.rootId, binding.moduleRootId) && dependency.exactVersion === binding.resolvedVersion);
              const selection = selections[0];
              if (selections.length !== 1 || selection === undefined) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
              let cursor: ModuleReleasePageCursor | undefined;
              let release: ResolvableModuleRelease | undefined;
              let previous: number | null = null;
              let count = 0;
              do {
                const page = await reader.readModuleReleasePage(scope.organizationId, selection.key, cursor);
                if (page.rootId === null || page.anchorReleaseRevision === null || !sameId(page.rootId, binding.moduleRootId) || page.entries.length === 0 ||
                    (cursor !== undefined && (page.anchorReleaseRevision !== cursor.anchorReleaseRevision || !sameId(page.rootId, cursor.rootId))))
                  throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                for (const entry of page.entries) {
                  if (++count > 10_000 || entry.previousReleaseRevision !== previous || entry.release.releaseRevision <= (previous ?? 0))
                    throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                  previous = entry.release.releaseRevision;
                  if (entry.release.releaseVersion === binding.resolvedVersion) {
                    if (release !== undefined) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                    release = entry.release;
                  }
                }
                if (page.nextAfterReleaseRevision === null) {
                  if (previous !== page.anchorReleaseRevision) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                  break;
                }
                if (page.nextAfterReleaseRevision !== previous) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                cursor = { rootId: page.rootId, anchorReleaseRevision: page.anchorReleaseRevision, afterReleaseRevision: page.nextAfterReleaseRevision };
              } while (true);
              if (release === undefined || !sameId(release.organizationId, scope.organizationId) ||
                  !sameId(release.rootId, binding.moduleRootId) || release.key !== selection.key ||
                  release.releaseVersion !== binding.resolvedVersion)
                throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
              // All exact compiled bindings supply navigation, including Modules with no Search records.
              const module = { organizationId: release.organizationId, moduleRootId: release.rootId, key: release.key,
                releaseRevision: release.releaseRevision, releaseVersion: release.releaseVersion,
                contentFingerprint: release.contentFingerprint, resolutionFingerprint: release.resolutionFingerprint };
              const identity = release.rootId.toLowerCase();
              const prior = modules.get(identity);
              if (prior !== undefined && canonicalJson(prior) !== canonicalJson(module))
                throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
              modules.set(identity, module);
              for (const record of release.compilationOutput.canonical.content.recordTypes) {
                const fields = record.fields.filter((field) => applicationSearchFieldIsSelectable(record.fields, String(field.fieldId)))
                  .map((field) => ({ reference: `${release!.key}:${record.key}.${field.key}`, fieldId: String(field.fieldId), label: field.label }));
                if (fields.length === 0) continue;
                // A Page may retain a supported record alias. Field references use the exact
                // release's canonical record scope; compilation proves their permanent owner.
                const references = new Set(compiled.conditionContexts.filter((context) =>
                  sameId(context.module.rootId, release!.rootId) && context.module.releaseRevision === release!.releaseRevision &&
                  context.module.contentFingerprint === release!.contentFingerprint && context.module.resolutionFingerprint === release!.resolutionFingerprint &&
                  sameId(context.recordTypeId, record.recordTypeId))
                  .map((context) => context.recordReference));
                for (const reference of references) records.push({ reference, label: record.singularLabel, recordTypeId: String(record.recordTypeId),
                    moduleRootId: release.rootId, releaseRevision: release.releaseRevision, releaseVersion: release.releaseVersion,
                    contentFingerprint: release.contentFingerprint, resolutionFingerprint: release.resolutionFingerprint, fields });
              }
            }
          });
          const final = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data, expectedDraftRevision: draft.draftRevision });
          if (canonicalJson(final) !== canonicalJson(draft)) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          if (canonicalJson(await readContext()) !== canonicalJson(context)) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          if (JSON.stringify({ records, modules: [...modules.values()] }).length > 999_000)
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          searchMetadata = { organizationId: scope.organizationId, rootId: draft.rootId, draftRevision: draft.draftRevision,
            sourceFingerprint: draft.sourceFingerprint, bindingsSignature: JSON.stringify(draft.source.body.module_bindings),
            resolutionFingerprint: compiled.compilation.resolutionFingerprint, records, modules: [...modules.values()] };
        } catch {
          // A failed metadata refresh never makes old choices authoritative or changes the draft.
          searchMetadata = null;
        }
        return { kind: "available", value: { organizationId: scope.organizationId, draft, searchMetadata } };
      },
    );
    return result.kind === "available"
      ? result.value.kind === "available"
        ? { kind: "available", ...result.value.value }
        : { kind: "refused" }
      : result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" } : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
};
