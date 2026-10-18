import "server-only";

import { createBuilderAuthority, type BuilderTargetFactsReader } from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  sameId,
  canonicalJson,
  describeFailure,
  compiledItemSlots,
  type ApplicationContent,
  type CompiledItem,
  type PageComposition,
  sourcePageSlotAddresses,
  sourceItemChildSlots,
  sourcePageShell,
  sourcePageSlotAt,
  type OrganizationId,
  type PageSlotAddress,
  type SourceItem,
  type SourcePageZone,
  type StoredDefinitionDraft,
  type ModuleField,
  type PeopleDirectoryOwner,
} from "@vortex/platform/schema";
import type { DatabaseRow } from "@vortex/platform/server";
import {
  BuilderAuthorityError,
  DefinitionError,
  readApplicationDefinitionDraft,
  readLiveHumanContext,
  requireBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  fingerprintCanonicalValue,
  DefinitionCompilationError,
} from "@vortex/platform/server";
import { studioUsesSignature, type StudioActionChoice, type StudioBorrowedChoices, type StudioCompileFailure, type StudioQueryChoice,
  type StudioRelationshipChoice } from "@vortex/ui/studio";
import { installedReleaseCatalogue } from "./definition-catalogue";
import type { StudioCompiledFields, StudioDataModule, StudioPublishedData } from "../studio/_lib/studio-data-model";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { studioCanvasFramesFor, type StudioApplicationCanvasFrames } from "./studio-canvas-frames";
import { rememberCompiledDraft } from "./studio-compiled-drafts";

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
  | Readonly<{ kind: "available"; organizationId: OrganizationId; draft: StoredApplicationDefinitionDraft; compiledFields: StudioCompiledFields | null; borrowedChoices: StudioBorrowedChoices | null; usedModules: readonly StudioDataModule[] | null; published: StudioPublishedData | null; peopleDirectory: PeopleDirectoryOwner | null; pageCompiledSlots: StudioApplicationCompiledPageSlots | null; canvasFrames: StudioApplicationCanvasFrames | null; compileFailure: StudioCompileFailure | null }>
  | StudioApplicationFailure;

type SourcePage = StoredApplicationDefinitionDraft["source"]["body"]["pages"][number];
/** One compiled content area: its items in desktop order, exactly as the release holds them. */
type CompiledSlot = readonly CompiledItem[];

/** Exact compiled page slots keyed by authored page alias, then by page slot address key. */
export type StudioApplicationCompiledPageSlots = Readonly<
  Record<string, Readonly<Record<string, CompiledSlot>>>
>;

const compiledPageSlot = (
  source: StoredApplicationDefinitionDraft["source"],
  page: SourcePage,
  content: ApplicationContent,
  compiledPage: ApplicationContent["pages"][number],
  at: PageSlotAddress,
): CompiledSlot | undefined => {
  const sourceComposition = page.composition;
  const composition = compiledPage.composition;
  let data: PageComposition | undefined;
  if ("stepContent" in composition) {
    const stepIndex = "steps" in page ? page.steps.findIndex((step) => step.id === at.step) : -1;
    const compiledStepId = "steps" in compiledPage ? compiledPage.steps[stepIndex]?.id : undefined;
    data = compiledStepId === undefined ? undefined : composition.stepContent[String(compiledStepId)];
  } else data = composition;
  if (data === undefined) return undefined;
  const shellAlias = sourcePageShell(sourceComposition);
  const shellId = data.root.props.vortex.shellId;
  if (shellAlias === null) return shellId === null ? data.content : undefined;
  if (shellId === null || at.slot === undefined) return undefined;
  const sourceShell = source.body.shells.find((candidate) => candidate.id === shellAlias);
  const sourceSlot = sourceShell?.content_slots.find((candidate) => candidate.id === at.slot);
  const shells = content.shells.filter((candidate) => String(candidate.shellId) === String(shellId));
  const contentSlots =
    shells[0]?.contentSlots.filter((candidate) => candidate.key === sourceSlot?.key) ?? [];
  if (sourceSlot === undefined || shells.length !== 1 || contentSlots.length !== 1)
    return undefined;
  const items = data.root.props[String(contentSlots[0]!.slotId)];
  return items === undefined ? [] : (items as CompiledSlot);
};

/**
 * The authored zone and its compiled slot hold the same items in the same desktop order, with the
 * same child slots: both are item arrays in desktop order. A child slot the author left empty
 * compiles to an empty slot.
 */
const assertCompiledSlotMatches = (
  authored: readonly SourceItem[],
  compiled: CompiledSlot,
): void => {
  if (authored.length !== compiled.length)
    throw new Error("Studio authored and compiled page placements do not match");
  for (const [index, item] of authored.entries()) {
    const compiledItem = compiled[index]!;
    const sourceSlots = new Map(sourceItemChildSlots(item));
    const compiledSlots = compiledItemSlots(compiledItem);
    const filled = compiledSlots.filter(([, children]) => children.length > 0);
    if (filled.length !== sourceSlots.size ||
      filled.some(([key]) => !sourceSlots.has(key)) ||
      compiledSlots.some(([key, children]) => children.length === 0 &&
        !(Array.isArray(item.props[key]) && (item.props[key] as unknown[]).length === 0)))
      throw new Error("Studio authored and compiled page slots do not match");
    const compiledByKey = new Map(compiledSlots);
    for (const [key, children] of sourceSlots)
      assertCompiledSlotMatches(children, compiledByKey.get(key)!);
  }
};

export const pageCompiledSlotsFor = (
  source: StoredApplicationDefinitionDraft["source"],
  canonical: ApplicationContent,
): StudioApplicationCompiledPageSlots => {
  const content = canonical;
  if (content.pages.length !== source.body.pages.length)
    throw new Error("Studio compiled page list does not match its authored draft");
  const result: Record<string, Record<string, CompiledSlot>> = {};
  source.body.pages.forEach((page, index) => {
    const compiledPage = content.pages[index];
    if (compiledPage === undefined || compiledPage.key !== page.key || compiledPage.type !== page.type)
      throw new Error("Studio compiled page does not match its authored draft");
    const slots: Record<string, CompiledSlot> = {};
    for (const at of sourcePageSlotAddresses(page)) {
      const runtimeSlot = compiledPageSlot(source, page, canonical, compiledPage, at);
      if (runtimeSlot === undefined)
        throw new Error("Studio compiled page slot does not match its authored draft");
      const zone: SourcePageZone | undefined = sourcePageSlotAt(page, at);
      if (zone === undefined)
        throw new Error("Studio authored page slot is missing");
      assertCompiledSlotMatches(zone.items, runtimeSlot);
      slots[at.key] = runtimeSlot;
    }
    result[page.id] = slots;
  });
  return result;
};

type StudioApplicationCreateAccessResult =
  | Readonly<{ kind: "available"; organizationId: OrganizationId }>
  | StudioApplicationFailure;

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

/** Mirrors the writer's protected classification; an unknown existing root is never ordinary. */
export const studioDraftTargetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
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
        const authority = createBuilderAuthority({ transaction, scope, targetFacts: studioDraftTargetFacts, permissions: platformPermissionSource });
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
        compiledFields: StudioCompiledFields | null;
        pageCompiledSlots: StudioApplicationCompiledPageSlots | null;
        canvasFrames: StudioApplicationCanvasFrames | null;
        compileFailure: StudioCompileFailure | null;
        borrowedChoices: StudioBorrowedChoices | null;
        usedModules: readonly StudioDataModule[] | null;
        published: StudioPublishedData | null;
        peopleDirectory: PeopleDirectoryOwner | null;
      }>>> => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts: studioDraftTargetFacts, permissions: platformPermissionSource });
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
        let compiledFields: StudioCompiledFields | null = null;
        let pageCompiledSlots: StudioApplicationCompiledPageSlots | null = null;
        let canvasFrames: StudioApplicationCanvasFrames | null = null;
        let compileFailure: StudioCompileFailure | null = null;
        let borrowedChoices: StudioBorrowedChoices | null = null;
        let usedModules: StudioDataModule[] | null = null;
        let published: StudioPublishedData | null = null;
        let peopleDirectory: PeopleDirectoryOwner | null = null;
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
            throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
          pageCompiledSlots = pageCompiledSlotsFor(draft.source, compiled.compilation.canonical.content);
          // The canvas reads this revision's records against this same compile.
          rememberCompiledDraft(scope.organizationId, draft, compiled.compilation.canonical.content);
          canvasFrames = studioCanvasFramesFor(draft.source.body.pages, compiled.compilation.canonical.content);
          const fieldsByRecord: Record<string, readonly ModuleField[]> = {};
          const borrowed: StudioQueryChoice[] = [];
          const borrowedActions: StudioActionChoice[] = [];
          const borrowedRelationships: StudioRelationshipChoice[] = [];
          const used: StudioDataModule[] = [];
          // The exact Module releases the draft compiled against, its own inline Modules included.
          {
            for (const binding of compiled.compilation.canonical.content.moduleBindings) {
              const selections = compiled.compilation.resolvedDependencies.filter((dependency) => dependency.kind === "module" &&
                sameId(dependency.rootId, binding.moduleRootId) && dependency.exactVersion === binding.resolvedVersion);
              const selection = selections[0];
              if (selections.length !== 1 || selection === undefined) throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
              const matches = compiled.moduleReleases.filter((candidate) => sameId(candidate.rootId, binding.moduleRootId) &&
                candidate.releaseVersion === binding.resolvedVersion);
              const release = matches.length === 1 ? matches[0] : undefined;
              if (release === undefined || !sameId(release.organizationId, scope.organizationId) ||
                  !sameId(release.rootId, binding.moduleRootId) || release.key !== selection.key ||
                  release.releaseVersion !== binding.resolvedVersion)
                throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
              const use = draft.source.body.uses.find((candidate) => candidate.module === release!.key);
              const content = release.compilationOutput.canonical.content;
              // A used Module is shown read-only in the Data tab, as its installed release defines it.
              if (use !== undefined && !used.some((module) => module.key === release!.key))
                used.push({ key: release.key, name: content.name, ownerApplication: use.application,
                  recordTypes: content.recordTypes.map((record) => ({
                    key: record.key, name: record.singularLabel, pluralName: record.pluralLabel,
                    titleFieldKey: record.fields.find((field) => sameId(String(field.fieldId), String(record.titleFieldId)))?.key ?? "",
                    fields: record.fields.map((field) => ({ key: field.key, label: field.label, type: field.type,
                      required: field.required, unique: field.unique, description: field.helpText ?? "",
                      filterable: field.filterable, sortable: field.sortable, personalData: field.personalData,
                      ...(field.searchPriority === undefined ? {} : { searchPriority: field.searchPriority }) })),
                  })),
                  queries: content.queries.flatMap((query) => {
                    const recordType = query.recordType.state === "resolved" ? content.recordTypes.find((candidate) =>
                      sameId(String(candidate.recordTypeId), String((query.recordType as { recordTypeId: string }).recordTypeId))) : undefined;
                    return recordType === undefined ? [] : [{ key: query.key, recordKey: recordType.key,
                      label: query.label ?? query.key.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase()),
                      summary: query.groupByFieldIds.length > 0 || query.aggregates.length > 0 }];
                  }) });
              // A used Module's queries are offered as they are: they belong to its own application.
              if (use !== undefined && !borrowed.some((query) => query.reference.startsWith(`${release!.key}:`))) {
                for (const query of content.queries) {
                  const recordType = query.recordType.state === "resolved" ? content.recordTypes.find((candidate) =>
                    sameId(String(candidate.recordTypeId), String((query.recordType as { recordTypeId: string }).recordTypeId))) : undefined;
                  if (recordType === undefined) continue;
                  borrowed.push({ reference: `${release.key}:${query.key}`, borrowedFrom: use.application,
                    label: query.key.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase()),
                    recordType: `${release.key}:${recordType.key}`,
                    fields: query.selectedFieldIds.flatMap((fieldId) => {
                      const field = recordType.fields.find((candidate) => sameId(String(candidate.fieldId), String(fieldId)));
                      return field === undefined ? [] : [{ reference: `${release!.key}:${recordType.key}.${field.key}`,
                        label: field.label, type: field.type }];
                    }) });
                }
                // Its actions and relationships are chosen as they are too: they belong to its own application.
                for (const action of content.actions)
                  borrowedActions.push({ reference: action.key, label: action.label, borrowedFrom: use.application });
                for (const record of content.recordTypes)
                  for (const relationship of record.relationships) {
                    const from = record.fields.find((field) => sameId(String(field.fieldId), String(relationship.fromFieldId)));
                    borrowedRelationships.push({ reference: `${release.key}:${record.key}.${relationship.key}`,
                      label: `${record.singularLabel}: ${from?.label ?? relationship.key}`,
                      recordType: `${release.key}:${record.key}`, borrowedFrom: use.application });
                  }
              }
              // The compiled fields of every record type the draft binds, for the query filter's typed controls.
              for (const record of content.recordTypes) fieldsByRecord[`${release.key}:${record.key}`] = record.fields;
            }
          }
          const final = await readApplicationDefinitionDraft(transaction, scope, { rootId: root.data, expectedDraftRevision: draft.draftRevision });
          if (canonicalJson(final) !== canonicalJson(draft)) throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          if (canonicalJson(await readLiveHumanContext(transaction, { scope, session: resolved.session, issuedAt })) !== canonicalJson(context)) throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
          borrowedChoices = { usesSignature: studioUsesSignature(draft.source), queries: borrowed,
            actions: borrowedActions, relationships: borrowedRelationships };
          usedModules = used;
          published = compiled.published;
          peopleDirectory = compiled.peopleDirectory;
          compiledFields = { draftRevision: draft.draftRevision, recordTypes: fieldsByRecord };
        } catch (error) {
          // A failed metadata refresh never makes old choices authoritative or changes the draft.
          // The draft stays open: the person sees the stable reason and can correct or remove the edit.
          compileFailure = studioCompileFailure(error);
          console.error("STUDIO_DRAFT_COMPILE_FAILED", compileFailure.reasonCode, compileFailure.family, error);
          compiledFields = null;
        }
        return { kind: "available", value: { organizationId: scope.organizationId, draft, compiledFields, borrowedChoices, usedModules, published, peopleDirectory, pageCompiledSlots, canvasFrames, compileFailure } };
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
