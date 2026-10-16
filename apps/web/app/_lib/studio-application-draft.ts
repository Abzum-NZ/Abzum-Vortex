import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  sameId,
  canonicalJson,
  describeFailure,
  placementSlotSchema,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  sourcePlacementSlotSchema,
  type OrganizationId,
  type PageSlotAddress,
  type StoredDefinitionDraft,
} from "@vortex/platform/schema";
import type { DatabaseRow } from "@vortex/platform/server";
import {
  BuilderAuthorityError,
  DefinitionError,
  readApplicationDefinitionDraft,
  readLiveHumanContext,
  requireBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  createDatabaseDefinitionPublicationRepository,
  applicationSearchFieldIsSelectable,
  fingerprintCanonicalValue,
  DefinitionCompilationError,
  type ModuleReleasePageCursor,
  type ResolvableModuleRelease,
} from "@vortex/platform/server";
import type { StudioCompileFailure } from "@vortex/ui/studio";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { studioCanvasFramesFor, type StudioApplicationCanvasFrames } from "./studio-canvas-frames";

export type { StudioApplicationCanvasFrames } from "./studio-canvas-frames";

type StoredApplicationDefinitionDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

type StudioAuthorityResult<Value> =
  | Readonly<{ kind: "available"; value: Value }>
  | Readonly<{ kind: "refused"; reason: string }>;

const builderRefusalReason = (error: unknown): string | undefined =>
  !(error instanceof BuilderAuthorityError) ? undefined
    : error.code === "BUILDER_PERMISSION_REFUSED" ? "permission_missing"
      : error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED" ? "recent_authentication_required" : undefined;

/** `reason` is the stable code logged on the server and mapped to a message for the person. */
type StudioApplicationFailure =
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable"; reason: string }>;

/** One log line with the stable reason code and, when there is one, the cause. */
const declined = (operation: string, failure: StudioApplicationFailure, error?: unknown): StudioApplicationFailure => {
  console.error(`[studio] ${operation} ${failure.kind} reason=${failure.reason}` +
    (error === undefined ? "" : ` cause=${describeFailure(error)}`));
  return failure;
};

/** Expected builder refusals keep their own reason; anything else is a platform failure, never a permission message. */
const loadFailure = (operation: string, error: unknown): StudioApplicationFailure => {
  const reason = builderRefusalReason(error);
  if (reason !== undefined) return declined(operation, { kind: "refused", reason }, error);
  if (error instanceof DefinitionError && error.code === "DEFINITION_ROOT_MISSING")
    return declined(operation, { kind: "refused", reason: "draft_missing" }, error);
  if (error instanceof Error && error.message === "STUDIO_DRAFT_UNAVAILABLE")
    return declined(operation, { kind: "refused", reason: "draft_missing" }, error);
  return declined(operation, { kind: "temporarily_unavailable", reason: "request_failed" }, error);
};

type StudioApplicationLoadResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId; draft: StoredApplicationDefinitionDraft; searchMetadata: StudioApplicationSearchMetadata | null; pageCompiledSlots: StudioApplicationCompiledPageSlots | null; canvasFrames: StudioApplicationCanvasFrames | null; compileFailure: StudioCompileFailure | null }>
  | StudioApplicationFailure;

type SourcePage = StoredApplicationDefinitionDraft["source"]["body"]["pages"][number];
type CompiledSlot = ReturnType<typeof placementSlotSchema.parse>;
type AuthoredSlot = ReturnType<typeof sourcePlacementSlotSchema.parse>;

/** Exact compiled page slots keyed by authored page alias, then by page slot address key. */
export type StudioApplicationCompiledPageSlots = Readonly<
  Record<string, Readonly<Record<string, CompiledSlot>>>
>;

const compiledPageSlot = (
  source: StoredApplicationDefinitionDraft["source"],
  page: SourcePage,
  content: unknown,
  compiledPage: unknown,
  at: PageSlotAddress,
): CompiledSlot | undefined => {
  const sourceComposition = page.composition;
  const compiled = compiledPage as {
    composition?: {
      main?: unknown;
      shellId?: unknown;
      content?: Record<string, unknown>;
      stepContent?: Record<string, unknown>;
    };
    steps?: readonly { id: unknown }[];
  };
  const composition = compiled.composition;
  if (composition === undefined) return undefined;
  if ("main" in sourceComposition)
    return composition.main === undefined ? undefined : placementSlotSchema.parse(composition.main);

  let stepContent: unknown = undefined;
  if ("step_content" in sourceComposition) {
    const stepIndex = "steps" in page ? page.steps.findIndex((step) => step.id === at.step) : -1;
    const compiledStepId = compiled.steps?.[stepIndex]?.id;
    if (compiledStepId === undefined || composition.stepContent === undefined) return undefined;
    stepContent = composition.stepContent[String(compiledStepId)];
    if (sourceComposition.shell_kind === "default")
      return stepContent === undefined ? undefined : placementSlotSchema.parse(stepContent);
  }

  if (!("shell" in sourceComposition) || composition.shellId === undefined || at.slot === undefined)
    return undefined;
  const sourceShell = source.body.shells.find((candidate) => candidate.id === sourceComposition.shell);
  const sourceSlot = sourceShell?.content_slots.find((candidate) => candidate.id === at.slot);
  const canonical = content as {
    shells?: readonly {
      shellId: unknown;
      contentSlots: readonly { slotId: unknown; key: string }[];
    }[];
  };
  const shells = canonical.shells?.filter(
    (candidate) => String(candidate.shellId) === String(composition.shellId),
  ) ?? [];
  const contentSlots = shells[0]?.contentSlots.filter(
    (candidate) => candidate.key === sourceSlot?.key,
  ) ?? [];
  if (sourceSlot === undefined || shells.length !== 1 || contentSlots.length !== 1)
    return undefined;
  const slotId = String(contentSlots[0]!.slotId);
  const runtimeSlot = (
    "step_content" in sourceComposition
      ? (stepContent as Record<string, unknown> | undefined)
      : composition.content
  )?.[slotId];
  return runtimeSlot === undefined ? undefined : placementSlotSchema.parse(runtimeSlot);
};

const assertCompiledSlotMatches = (
  authored: unknown,
  compiled: CompiledSlot,
): void => {
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
    if (sourceSlotKeys.length !== compiledSlotKeys.length ||
      sourceSlotKeys.some((key) => !Object.hasOwn(compiledPlacement.slots, key)))
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
  const result: Record<string, Record<string, CompiledSlot>> = {};
  source.body.pages.forEach((page, index) => {
    const compiledPage = content.pages![index] as { key?: unknown; type?: unknown } | undefined;
    if (compiledPage === undefined || compiledPage.key !== page.key || compiledPage.type !== page.type)
      throw new Error("Studio compiled page does not match its authored draft");
    const slots: Record<string, CompiledSlot> = {};
    for (const at of sourcePageSlotAddresses(page)) {
      const runtimeSlot = compiledPageSlot(source, page, canonical, content.pages![index], at);
      if (runtimeSlot === undefined)
        throw new Error("Studio compiled page slot does not match its authored draft");
      assertCompiledSlotMatches(sourcePageSlotAt(page, at), runtimeSlot);
      slots[at.key] = runtimeSlot;
    }
    result[page.id] = slots;
  });
  return result;
};

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

type StudioApplicationCreateAccessResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId }>
  | StudioApplicationFailure;

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
  if (!organization.success) return declined("create-access", { kind: "refused", reason: "request_invalid" });
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return declined("create-access", resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable", reason: "session_unavailable" }
        : { kind: "refused", reason: "session_ended" });
    const result = await humanOrganizationRequests().run(
      resolved.session, { organizationId: organization.data }, async (
        transaction,
        scope,
      ): Promise<StudioAuthorityResult<OrganizationId>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts, permissions: platformPermissionSource });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change" });
        } catch (error) {
          const reason = builderRefusalReason(error);
          if (reason !== undefined) return { kind: "refused", reason };
          throw error;
        }
        return { kind: "available", value: scope.organizationId };
      },
    );
    if (result.kind === "available")
      return result.value.kind === "available"
        ? { kind: "available", organizationId: result.value.value }
        : declined("create-access", result.value);
    return declined("create-access", result.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable", reason: "request_failed" }
      : { kind: "refused", reason: "organization_unavailable" });
  } catch (error) {
    return loadFailure("create-access", error);
  }
};

/** A compiler refusal names its rule, family and location; anything else is reported as unexpected. */
const studioCompileFailure = (error: unknown): StudioCompileFailure => {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof DefinitionCompilationError) {
      const segments = current.location?.segments ?? [];
      const block = segments.find((segment) => segment.kind === "block");
      const setting = segments.filter((segment) => segment.kind === "setting").at(-1);
      return { reasonCode: current.ruleCode, family: current.family,
        ...(block === undefined ? {} : { blockAlias: block.key }),
        ...(setting === undefined || setting.key === "theme" ? {} : { tokenKey: setting.key }) };
    }
    current = current.cause;
  }
  return { reasonCode: "STUDIO_DRAFT_COMPILE_UNEXPECTED", family: "unexpected" };
};

/** Classification, permission and detached draft read share one verified request transaction. */
export const loadStudioApplicationDraft = async (
  candidateOrganizationId: string,
  candidateRootId: string,
  /** `false` reads the draft without compiling it: for checks that need only the saved source and revision. */
  options: Readonly<{ compile?: boolean }> = {},
): Promise<StudioApplicationLoadResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success)
    return declined("application-draft", { kind: "refused", reason: "request_invalid" });
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return declined("application-draft", resolved.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable", reason: "session_unavailable" }
        : { kind: "refused", reason: "session_ended" });
    const result = await humanOrganizationRequests().run(
      resolved.session, { organizationId: organization.data }, async (
        transaction,
        scope,
        issuedAt,
      ): Promise<StudioAuthorityResult<Readonly<{
        organizationId: OrganizationId;
        draft: StoredApplicationDefinitionDraft;
        searchMetadata: StudioApplicationSearchMetadata | null;
        pageCompiledSlots: StudioApplicationCompiledPageSlots | null;
        canvasFrames: StudioApplicationCanvasFrames | null;
        compileFailure: StudioCompileFailure | null;
      }>>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts, permissions: platformPermissionSource });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
        } catch (error) {
          const reason = builderRefusalReason(error);
          if (reason !== undefined) return { kind: "refused", reason };
          // The request runner replaces a thrown error with a bare failure, so the missing-root
          // marker must be answered here, inside the request, to reach the page as its real reason.
          if (error instanceof Error && error.message === "STUDIO_DRAFT_UNAVAILABLE")
            return { kind: "refused", reason: "draft_missing" };
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data });
        let searchMetadata: StudioApplicationSearchMetadata | null = null;
        let pageCompiledSlots: StudioApplicationCompiledPageSlots | null = null;
        let canvasFrames: StudioApplicationCanvasFrames | null = null;
        let compileFailure: StudioCompileFailure | null = null;
        if (options.compile !== false) try {
          const context = await readLiveHumanContext(transaction, { scope, session: resolved.session, issuedAt });
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
          pageCompiledSlots = pageCompiledSlotsFor(draft.source, compiled.compilation.canonical.content);
          canvasFrames = studioCanvasFramesFor(draft.source.body.pages, compiled.compilation.canonical.content);
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
              for (;;) {
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
              }
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
          if (canonicalJson(await readLiveHumanContext(transaction, { scope, session: resolved.session, issuedAt })) !== canonicalJson(context)) throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          if (JSON.stringify({ records, modules: [...modules.values()] }).length > 999_000)
            throw new Error("STUDIO_SEARCH_METADATA_UNAVAILABLE");
          searchMetadata = { organizationId: scope.organizationId, rootId: draft.rootId, draftRevision: draft.draftRevision,
            sourceFingerprint: draft.sourceFingerprint, bindingsSignature: JSON.stringify(draft.source.body.module_bindings),
            resolutionFingerprint: compiled.compilation.resolutionFingerprint, records, modules: [...modules.values()] };
        } catch (error) {
          // A failed metadata refresh never makes old choices authoritative or changes the draft.
          // The draft stays open: the person sees the stable reason and can correct or remove the edit.
          compileFailure = studioCompileFailure(error);
          console.error("STUDIO_DRAFT_COMPILE_FAILED", compileFailure.reasonCode, compileFailure.family, error);
          searchMetadata = null;
        }
        return { kind: "available", value: { organizationId: scope.organizationId, draft, searchMetadata, pageCompiledSlots, canvasFrames, compileFailure } };
      },
    );
    if (result.kind === "available")
      return result.value.kind === "available"
        ? { kind: "available", ...result.value.value }
        : declined("application-draft", result.value);
    return declined("application-draft", result.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable", reason: "request_failed" }
      : { kind: "refused", reason: "organization_unavailable" });
  } catch (error) {
    return loadFailure("application-draft", error);
  }
};
