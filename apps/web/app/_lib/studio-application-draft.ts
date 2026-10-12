import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@web/platform-server";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  sessionContextSchema,
  sameId,
  canonicalJson,
  placementSlotSchema,
  sourcePlacementSlotSchema,
  type OrganizationId,
  type StoredDefinitionDraft,
} from "@vortex/platform/schema";
import type { DatabaseRow } from "@web/platform-server";
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
} from "@web/platform-server";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

type StoredApplicationDefinitionDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

type StudioAuthorityResult<Value> =
  Readonly<{ kind: "available"; value: Value }> | Readonly<{ kind: "refused" }>;

const isExpectedBuilderRefusal = (error: unknown): boolean =>
  error instanceof BuilderAuthorityError &&
  (error.code === "BUILDER_PERMISSION_REFUSED" ||
    error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED");

type StudioApplicationLoadResult =
  | Readonly<{
      kind: "available";
      organizationId: OrganizationId;
      draft: StoredApplicationDefinitionDraft;
      searchMetadata: StudioApplicationSearchMetadata | null;
      pageCompiledSlots: StudioApplicationCompiledPageSlots | null;
    }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type SourcePage = StoredApplicationDefinitionDraft["source"]["body"]["pages"][number];
type CompiledSlot = ReturnType<typeof placementSlotSchema.parse>;
type AuthoredSlot = ReturnType<typeof sourcePlacementSlotSchema.parse>;

/** Exact compiled page slots keyed by their authored page aliases. */
export type StudioApplicationCompiledPageSlots = Readonly<Record<string, CompiledSlot>>;

const editableSourceSlot = (
  page: SourcePage,
): Readonly<{ key: string; slot: unknown }> | undefined => {
  const composition = page.composition;
  if ("main" in composition) return { key: "main", slot: composition.main };
  if ("content" in composition) {
    const entries = Object.entries(composition.content);
    if (entries.length === 1) return { key: entries[0]![0], slot: entries[0]![1] };
  }
  return undefined;
};

const compiledPageSlot = (
  source: StoredApplicationDefinitionDraft["source"],
  page: SourcePage,
  content: unknown,
  compiledPage: unknown,
): CompiledSlot | undefined => {
  const sourceComposition = page.composition;
  const compiled = compiledPage as {
    composition?: { main?: unknown; shellId?: unknown; content?: Record<string, unknown> };
  };
  if ("main" in sourceComposition && compiled.composition?.main !== undefined)
    return placementSlotSchema.parse(compiled.composition.main);
  if (!("content" in sourceComposition) || compiled.composition?.content === undefined)
    return undefined;
  const entries = Object.entries(sourceComposition.content);
  if (entries.length !== 1 || compiled.composition.shellId === undefined) return undefined;
  const sourceShell = source.body.shells.find(
    (candidate) => candidate.id === sourceComposition.shell,
  );
  const sourceSlot = sourceShell?.content_slots.find(
    (candidate) => candidate.id === entries[0]![0],
  );
  const canonical = content as {
    shells?: readonly {
      shellId: unknown;
      contentSlots: readonly { slotId: unknown; key: string }[];
    }[];
  };
  const shells =
    canonical.shells?.filter(
      (candidate) => String(candidate.shellId) === String(compiled.composition?.shellId),
    ) ?? [];
  const contentSlots =
    shells[0]?.contentSlots.filter((candidate) => candidate.key === sourceSlot?.key) ?? [];
  if (sourceSlot === undefined || shells.length !== 1 || contentSlots.length !== 1)
    return undefined;
  const runtimeSlot = compiled.composition.content[String(contentSlots[0]!.slotId)];
  return runtimeSlot === undefined ? undefined : placementSlotSchema.parse(runtimeSlot);
};

const assertCompiledSlotMatches = (authored: unknown, compiled: CompiledSlot): void => {
  const sourceSlot: AuthoredSlot = sourcePlacementSlotSchema.parse(authored);
  const sourceIds = sourceSlot.order.desktop;
  const compiledIds = compiled.order.desktop;
  if (sourceIds.length !== compiledIds.length)
    throw new Error("Studio authored and compiled page placements do not match");
  for (const [index, alias] of sourceIds.entries()) {
    const sourcePlacement = sourceSlot.placements[alias];
    const compiledPlacement = compiled.placements[compiledIds[index]!];
    if (sourcePlacement === undefined || compiledPlacement === undefined)
      throw new Error("Studio authored and compiled page placements do not match");
    const sourceSlotKeys = Object.keys(sourcePlacement.slots);
    const compiledSlotKeys = Object.keys(compiledPlacement.slots);
    if (
      sourceSlotKeys.length !== compiledSlotKeys.length ||
      sourceSlotKeys.some((key) => !Object.hasOwn(compiledPlacement.slots, key))
    )
      throw new Error("Studio authored and compiled page slots do not match");
    for (const key of sourceSlotKeys)
      assertCompiledSlotMatches(sourcePlacement.slots[key], compiledPlacement.slots[key]!);
  }
};

const pageCompiledSlotsFor = (
  source: StoredApplicationDefinitionDraft["source"],
  canonical: unknown,
): StudioApplicationCompiledPageSlots => {
  const content = canonical as {
    pages?: readonly unknown[];
  };
  if (content.pages === undefined || content.pages.length !== source.body.pages.length)
    throw new Error("Studio compiled page list does not match its authored draft");
  const result: Record<string, CompiledSlot> = {};
  source.body.pages.forEach((page, index) => {
    const compiledPage = content.pages![index] as { key?: unknown; type?: unknown } | undefined;
    if (
      compiledPage === undefined ||
      compiledPage.key !== page.key ||
      compiledPage.type !== page.type
    )
      throw new Error("Studio compiled page does not match its authored draft");
    const authoredSlot = editableSourceSlot(page);
    const runtimeSlot = compiledPageSlot(source, page, canonical, content.pages![index]);
    if (authoredSlot === undefined) return;
    if (runtimeSlot === undefined)
      throw new Error("Studio compiled page slot does not match its authored draft");
    assertCompiledSlotMatches(authoredSlot.slot, runtimeSlot);
    result[page.id] = runtimeSlot;
  });
  return result;
};

/** Protected choices are response metadata, never part of the persisted authored draft. */
export type StudioApplicationSearchMetadata = Readonly<{
  organizationId: string;
  rootId: string;
  draftRevision: number;
  sourceFingerprint: string;
  bindingsSignature: string;
  resolutionFingerprint: string;
  modules: readonly Readonly<{
    organizationId: string;
    moduleRootId: string;
    key: string;
    releaseRevision: number;
    releaseVersion: string;
    contentFingerprint: string;
    resolutionFingerprint: string;
  }>[];
  records: readonly Readonly<{
    reference: string;
    label: string;
    recordTypeId: string;
    moduleRootId: string;
    releaseRevision: number;
    releaseVersion: string;
    contentFingerprint: string;
    resolutionFingerprint: string;
    fields: readonly Readonly<{ reference: string; fieldId: string; label: string }>[];
  }>[];
}>;

type StudioApplicationCreateAccessResult =
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
    rows.length !== 1 ||
    row === undefined ||
    row.outcome !== "available" ||
    (row.application_origin_kind !== "ordinary" &&
      row.application_origin_kind !== "platform_system_application")
  )
    throw new Error("STUDIO_DRAFT_UNAVAILABLE");
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
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session,
      { organizationId: organization.data },
      async (transaction, scope): Promise<StudioAuthorityResult<OrganizationId>> => {
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
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
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
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
    const result = await humanOrganizationRequests().run(
      resolved.session,
      { organizationId: organization.data },
      async (
        transaction,
        scope,
        issuedAt,
      ): Promise<
        StudioAuthorityResult<
          Readonly<{
            organizationId: OrganizationId;
            draft: StoredApplicationDefinitionDraft;
            searchMetadata: StudioApplicationSearchMetadata | null;
            pageCompiledSlots: StudioApplicationCompiledPageSlots | null;
          }>
        >
      > => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
        } catch (error) {
          if (isExpectedBuilderRefusal(error)) return { kind: "refused" };
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope, {
          rootId: root.data,
        });
        let searchMetadata: StudioApplicationSearchMetadata | null = null;
        let pageCompiledSlots: StudioApplicationCompiledPageSlots | null = null;
        try {
          const readContext = async () => {
            const contextRows =
              await transaction.query<DatabaseRow>`select vortex_access.validated_human_request_context() as context`;
            const transport = contextRows[0]?.context;
            if (
              contextRows.length !== 1 ||
              transport === null ||
              typeof transport !== "object" ||
              Array.isArray(transport) ||
              !("channel" in transport) ||
              transport.channel !== "web"
            )
              throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
            const context = sessionContextSchema.parse(
              Object.fromEntries(Object.entries(transport).filter(([key]) => key !== "channel")),
            );
            const now = Date.now();
            const from = Date.parse(context.issuedAt);
            const until = Date.parse(context.expiresAt);
            if (
              context.callerKind !== "human" ||
              Object.hasOwn(scope, "applicationRootId") ||
              Object.hasOwn(context, "applicationRootId") ||
              context.delegatedContext !== undefined ||
              context.supportContext !== undefined ||
              !sameId(context.organizationId, scope.organizationId) ||
              !sameId(context.organizationAccountId, scope.organizationAccountId) ||
              context.accessVersion !== scope.accessVersion ||
              !sameId(context.tenantId, scope.tenantId) ||
              !sameId(context.identityId, resolved.session.identityId) ||
              !sameId(context.sessionId, resolved.session.sessionId) ||
              context.authenticationStrength !== resolved.session.authenticationStrength ||
              context.issuedAt !== issuedAt ||
              context.expiresAt !== resolved.session.accessTokenExpiresAt ||
              context.accessTokenIssuedAt !==
                (resolved.session.primaryAuthenticatedAt !== undefined ||
                resolved.session.multiFactorAuthenticatedAt !== undefined
                  ? resolved.session.accessTokenIssuedAt
                  : undefined) ||
              context.primaryAuthenticatedAt !== resolved.session.primaryAuthenticatedAt ||
              context.multiFactorAuthenticatedAt !== resolved.session.multiFactorAuthenticatedAt ||
              !Number.isFinite(now) ||
              !Number.isFinite(from) ||
              !Number.isFinite(until) ||
              from > now ||
              until <= now ||
              from >= until
            )
              throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
            return context;
          };
          const context = await readContext();
          const compiled = await createDatabaseDefinitionPublicationService(
            installedReleaseCatalogue,
            transaction,
            authority,
          ).compileApplicationDraft(context, {
            rootId: draft.rootId,
            expectedDraftRevision: draft.draftRevision,
          });
          const envelope = compiled.compilation.canonical.envelope;
          if (
            !sameId(envelope.rootId, draft.rootId) ||
            !sameId(envelope.organizationId, draft.organizationId) ||
            envelope.key !== draft.key ||
            envelope.draftRevision !== draft.draftRevision ||
            envelope.publishedRevision !== draft.publishedRevision ||
            envelope.createdAt !== draft.createdAt ||
            !sameId(envelope.createdBy, draft.createdBy) ||
            envelope.updatedAt !== draft.updatedAt ||
            !sameId(envelope.updatedBy, draft.updatedBy) ||
            compiled.currentReleaseRevision !== (draft.publishedRevision ?? null) ||
            compiled.compilation.artifact.contentFingerprint !==
              fingerprintCanonicalValue(compiled.compilation.canonical.content) ||
            compiled.compilation.artifact.resolutionFingerprint !==
              compiled.compilation.resolutionFingerprint
          )
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          pageCompiledSlots = pageCompiledSlotsFor(
            draft.source,
            compiled.compilation.canonical.content,
          );
          const records: StudioApplicationSearchMetadata["records"][number][] = [];
          const modules = new Map<string, StudioApplicationSearchMetadata["modules"][number]>();
          await createDatabaseDefinitionPublicationRepository(transaction).read(
            context,
            async (reader) => {
              for (const binding of compiled.compilation.canonical.content.moduleBindings) {
                const selections = compiled.compilation.resolvedDependencies.filter(
                  (dependency) =>
                    dependency.kind === "module" &&
                    sameId(dependency.rootId, binding.moduleRootId) &&
                    dependency.exactVersion === binding.resolvedVersion,
                );
                const selection = selections[0];
                if (selections.length !== 1 || selection === undefined)
                  throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                let cursor: ModuleReleasePageCursor | undefined;
                let release: ResolvableModuleRelease | undefined;
                let previous: number | null = null;
                let count = 0;
                for (;;) {
                  const page = await reader.readModuleReleasePage(
                    scope.organizationId,
                    selection.key,
                    cursor,
                  );
                  if (
                    page.rootId === null ||
                    page.anchorReleaseRevision === null ||
                    !sameId(page.rootId, binding.moduleRootId) ||
                    page.entries.length === 0 ||
                    (cursor !== undefined &&
                      (page.anchorReleaseRevision !== cursor.anchorReleaseRevision ||
                        !sameId(page.rootId, cursor.rootId)))
                  )
                    throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                  for (const entry of page.entries) {
                    if (
                      ++count > 10_000 ||
                      entry.previousReleaseRevision !== previous ||
                      entry.release.releaseRevision <= (previous ?? 0)
                    )
                      throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                    previous = entry.release.releaseRevision;
                    if (entry.release.releaseVersion === binding.resolvedVersion) {
                      if (release !== undefined)
                        throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                      release = entry.release;
                    }
                  }
                  if (page.nextAfterReleaseRevision === null) {
                    if (previous !== page.anchorReleaseRevision)
                      throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                    break;
                  }
                  if (page.nextAfterReleaseRevision !== previous)
                    throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                  cursor = {
                    rootId: page.rootId,
                    anchorReleaseRevision: page.anchorReleaseRevision,
                    afterReleaseRevision: page.nextAfterReleaseRevision,
                  };
                }
                if (
                  release === undefined ||
                  !sameId(release.organizationId, scope.organizationId) ||
                  !sameId(release.rootId, binding.moduleRootId) ||
                  release.key !== selection.key ||
                  release.releaseVersion !== binding.resolvedVersion
                )
                  throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                // All exact compiled bindings supply navigation, including Modules with no Search records.
                const module = {
                  organizationId: release.organizationId,
                  moduleRootId: release.rootId,
                  key: release.key,
                  releaseRevision: release.releaseRevision,
                  releaseVersion: release.releaseVersion,
                  contentFingerprint: release.contentFingerprint,
                  resolutionFingerprint: release.resolutionFingerprint,
                };
                const identity = release.rootId.toLowerCase();
                const prior = modules.get(identity);
                if (prior !== undefined && canonicalJson(prior) !== canonicalJson(module))
                  throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
                modules.set(identity, module);
                for (const record of release.compilationOutput.canonical.content.recordTypes) {
                  const fields = record.fields
                    .filter((field) =>
                      applicationSearchFieldIsSelectable(record.fields, String(field.fieldId)),
                    )
                    .map((field) => ({
                      reference: `${release!.key}:${record.key}.${field.key}`,
                      fieldId: String(field.fieldId),
                      label: field.label,
                    }));
                  if (fields.length === 0) continue;
                  // A Page may retain a supported record alias. Field references use the exact
                  // release's canonical record scope; compilation proves their permanent owner.
                  const references = new Set(
                    compiled.conditionContexts
                      .filter(
                        (context) =>
                          sameId(context.module.rootId, release!.rootId) &&
                          context.module.releaseRevision === release!.releaseRevision &&
                          context.module.contentFingerprint === release!.contentFingerprint &&
                          context.module.resolutionFingerprint === release!.resolutionFingerprint &&
                          sameId(context.recordTypeId, record.recordTypeId),
                      )
                      .map((context) => context.recordReference),
                  );
                  for (const reference of references)
                    records.push({
                      reference,
                      label: record.singularLabel,
                      recordTypeId: String(record.recordTypeId),
                      moduleRootId: release.rootId,
                      releaseRevision: release.releaseRevision,
                      releaseVersion: release.releaseVersion,
                      contentFingerprint: release.contentFingerprint,
                      resolutionFingerprint: release.resolutionFingerprint,
                      fields,
                    });
                }
              }
            },
          );
          const final = await readApplicationDefinitionDraft(transaction, scope, {
            rootId: root.data,
            expectedDraftRevision: draft.draftRevision,
          });
          if (canonicalJson(final) !== canonicalJson(draft))
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          if (canonicalJson(await readContext()) !== canonicalJson(context))
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          if (JSON.stringify({ records, modules: [...modules.values()] }).length > 999_000)
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          searchMetadata = {
            organizationId: scope.organizationId,
            rootId: draft.rootId,
            draftRevision: draft.draftRevision,
            sourceFingerprint: draft.sourceFingerprint,
            bindingsSignature: JSON.stringify(draft.source.body.module_bindings),
            resolutionFingerprint: compiled.compilation.resolutionFingerprint,
            records,
            modules: [...modules.values()],
          };
        } catch (error) {
          // A failed metadata refresh never makes old choices authoritative or changes the draft.
          console.error("Failed to compile Studio application page settings", error);
          searchMetadata = null;
        }
        return {
          kind: "available",
          value: { organizationId: scope.organizationId, draft, searchMetadata, pageCompiledSlots },
        };
      },
    );
    return result.kind === "available"
      ? result.value.kind === "available"
        ? { kind: "available", ...result.value.value }
        : { kind: "refused" }
      : result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable" }
        : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
};
