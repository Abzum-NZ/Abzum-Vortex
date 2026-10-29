import "server-only";
import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  createBuilderAuthority,
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE,
  FIELD_INPUT_CONTROL_RELEASES,
  type BuilderTargetFactsReader,
  readBuilderApplicationOrigin,
  compileFlowPlans,
  type FlowPlan,
} from "@vortex/platform/server";
import type { FieldInputControlReleaseMap, PlatformThemeTokens } from "@vortex/ui";
import { studioThemeOptions } from "../studio/_lib/studio-theme-catalogue";
import type { StudioThemeOptions } from "../studio/_lib/studio-theme-options";
import { findPinnedPlatformThemeRelease } from "../studio/_lib/pinned-platform-theme-release";
import {
  studioViewRequestSchema,
  type StudioViewRequest,
} from "../studio/_lib/studio-view-request";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  sameId,
  peopleDirectory as directory,
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
  moduleQueryBorrowable,
  queryTotalLabel,
  definitionValidationEntry,
  translateDefinitionRuleFailures,
  optionsSourceNarrowing,
  flowTaskChildLists,
  type FlowDefinition,
  type FlowTask,
} from "@vortex/platform/schema";
import {
  BuilderAuthorityError,
  DefinitionError,
  readApplicationDefinitionDraft,
  readSourceIdentityReservations,
  requireApplicationDefinitionDraftConsistency,
  readLiveHumanContext,
  requireBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  fingerprintCanonicalValue,
  DefinitionCompilationError,
} from "@vortex/platform/server";
import { studioUsesSignature } from "@vortex/ui/studio/contextual-palette";
import type {
  StudioActionChoice,
  StudioBorrowedChoices,
  StudioCompileFailure,
  StudioQueryChoice,
  StudioQueryInput,
  StudioRelationshipChoice,
} from "@vortex/ui/studio";
import { installedReleaseCatalogue } from "./definition-catalogue";
import type {
  StudioCompiledFields,
  StudioDataModule,
  StudioPublishedData,
} from "../studio/_lib/studio-data-model";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { studioCanvasFramesFor, type StudioApplicationCanvasFrames } from "./studio-canvas-frames";

export type { StudioApplicationCanvasFrames } from "./studio-canvas-frames";

type StoredApplicationDefinitionDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

type FlowPlacement = Readonly<{
  tasks: Readonly<Record<string, "page" | "server" | "backend">>;
  bands: readonly Readonly<{ id: string; taskIds: readonly string[] }>[];
}>;
/** Compiled placements by owner key and flow key. */
export type StudioFlowPlacements = Readonly<
  Record<string, Readonly<Record<string, FlowPlacement>>>
>;

const flowPlacements = (
  flow: FlowDefinition,
  plan: FlowPlan,
): StudioFlowPlacements[string][string] => {
  const tasks: Record<string, "page" | "server" | "backend"> = {};
  const initialise = (task: FlowTask) => {
    tasks[task.id] = "page";
    for (const list of flowTaskChildLists(task)) for (const child of list.tasks) initialise(child);
  };
  for (const task of [...flow.tasks, ...flow.errors, ...flow.finally]) initialise(task);
  const bands: { id: string; taskIds: string[] }[] = [];
  for (const segment of plan.segments) {
    const ids = new Set(segment.guard.map((guard) => guard.taskId));
    const visit = (task: FlowTask) => {
      tasks[task.id] = task.type === "backend.run" ? "backend" : segment.kind;
      ids.add(task.id);
      for (const list of flowTaskChildLists(task)) for (const child of list.tasks) visit(child);
    };
    for (const task of segment.tasks) visit(task);
    if (segment.kind === "server") bands.push({ id: segment.id, taskIds: [...ids] });
  }
  return { tasks, bands };
};

type StudioAuthorityResult<Value> =
  Readonly<{ kind: "available"; value: Value }> | Readonly<{ kind: "refused"; reason: string }>;

const builderRefusalReason = (error: unknown): string | undefined =>
  !(error instanceof BuilderAuthorityError)
    ? undefined
    : error.code === "BUILDER_PERMISSION_REFUSED"
      ? "permission_missing"
      : error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED"
        ? "recent_authentication_required"
        : undefined;

/** `reason` is the stable code logged on the server and mapped to a message for the person. */
type StudioApplicationFailure =
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "temporarily_unavailable"; reason: string }>;

/** One log line with the stable reason code and, when there is one, the cause. */
const declined = (
  operation: string,
  failure: StudioApplicationFailure,
  error?: unknown,
): StudioApplicationFailure => {
  console.error(
    `[studio] ${operation} ${failure.kind} reason=${failure.reason}` +
      (error === undefined ? "" : ` cause=${describeFailure(error)}`),
  );
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

/**
 * The parts of a saved Application draft a preview's records, queries and access depend on. A
 * draft edit that leaves them as they are is presentation only (pages, layouts, the menu, the
 * theme, names and blocks), so the preview's data and access are still the draft's.
 */
const presentationKeys: ReadonlySet<string> = new Set([
  "name",
  "description",
  "icon",
  "home_page",
  "navigation",
  "shells",
  "pages",
  "theme",
  "platform_block_dependencies",
]);
export const studioPreviewShapeFingerprint = (
  source: StoredApplicationDefinitionDraft["source"],
): string =>
  fingerprintCanonicalValue({
    key: source.key,
    body: Object.fromEntries(
      Object.entries(source.body).filter(([key]) => !presentationKeys.has(key)),
    ),
  });

export type StudioViewResources = Readonly<{
  request: StudioViewRequest;
  themeOptions: StudioThemeOptions | null;
  fieldInputControlReleases: FieldInputControlReleaseMap | null;
  platformThemeTokens: PlatformThemeTokens | null;
}>;

/** What one requested editor view draws from, projected from the saved revision's one compile. */
type StudioLoadedView = StudioViewResources &
  Readonly<{
    identityReservations: Awaited<ReturnType<typeof readSourceIdentityReservations>> | null;
    compiledFields: StudioCompiledFields | null;
    borrowedChoices: StudioBorrowedChoices | null;
    usedModules: readonly StudioDataModule[] | null;
    published: StudioPublishedData | null;
    peopleDirectory: PeopleDirectoryOwner | null;
    pageCompiledSlots: StudioApplicationCompiledPageSlots | null;
    canvasFrames: StudioApplicationCanvasFrames | null;
    flowPlacements: StudioFlowPlacements | null;
    compileFailure: StudioCompileFailure | null;
  }>;

/** The most views one read projects: one per rail tab. */
const maximumViewsPerRead = 9;

type StudioApplicationLoadResult =
  | Readonly<{
      kind: "available";
      organizationId: OrganizationId;
      draft: StoredApplicationDefinitionDraft;
      /** The draft's data shape: Studio reads its records once the builder's preview runs this shape. */
      previewShape: string;
      /** The immutable block catalogue, once for every view; complete when any view uses its releases. */
      catalogue: typeof IMMUTABLE_PLATFORM_BLOCK_CATALOGUE;
      /** One view per request, in request order. */
      views: readonly StudioLoadedView[];
    }>
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
    data =
      compiledStepId === undefined ? undefined : composition.stepContent[String(compiledStepId)];
  } else data = composition;
  if (data === undefined) return undefined;
  const shellAlias = sourcePageShell(sourceComposition);
  const shellId = data.root.props.vortex.shellId;
  if (shellAlias === null) return shellId === null ? data.content : undefined;
  if (shellId === null || at.slot === undefined) return undefined;
  const sourceShell = source.body.shells.find((candidate) => candidate.id === shellAlias);
  const sourceSlot = sourceShell?.content_slots.find((candidate) => candidate.id === at.slot);
  const shells = content.shells.filter(
    (candidate) => String(candidate.shellId) === String(shellId),
  );
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
    if (
      filled.length !== sourceSlots.size ||
      filled.some(([key]) => !sourceSlots.has(key)) ||
      compiledSlots.some(
        ([key, children]) =>
          children.length === 0 &&
          !(Array.isArray(item.props[key]) && (item.props[key] as unknown[]).length === 0),
      )
    )
      throw new Error("Studio authored and compiled page slots do not match");
    const compiledByKey = new Map(compiledSlots);
    for (const [key, children] of sourceSlots)
      assertCompiledSlotMatches(children, compiledByKey.get(key)!);
  }
};

export const pageCompiledSlotsFor = (
  source: StoredApplicationDefinitionDraft["source"],
  canonical: ApplicationContent,
  pageAlias: string,
): StudioApplicationCompiledPageSlots => {
  const content = canonical;
  if (content.pages.length !== source.body.pages.length)
    throw new Error("Studio compiled page list does not match its authored draft");
  const result: Record<string, Record<string, CompiledSlot>> = {};
  source.body.pages.forEach((page, index) => {
    if (page.id !== pageAlias) return;
    const compiledPage = content.pages[index];
    if (
      compiledPage === undefined ||
      compiledPage.key !== page.key ||
      compiledPage.type !== page.type
    )
      throw new Error("Studio compiled page does not match its authored draft");
    const slots: Record<string, CompiledSlot> = {};
    for (const at of sourcePageSlotAddresses(page)) {
      const runtimeSlot = compiledPageSlot(source, page, canonical, compiledPage, at);
      if (runtimeSlot === undefined)
        throw new Error("Studio compiled page slot does not match its authored draft");
      const zone: SourcePageZone | undefined = sourcePageSlotAt(page, at);
      if (zone === undefined) throw new Error("Studio authored page slot is missing");
      assertCompiledSlotMatches(zone.items, runtimeSlot);
      slots[at.key] = runtimeSlot;
    }
    result[page.id] = slots;
  });
  return result;
};

type StudioApplicationCreateAccessResult =
  Readonly<{ kind: "available"; organizationId: OrganizationId }> | StudioApplicationFailure;

/** Mirrors the writer's protected classification; an unknown existing root is never ordinary. */
export const studioDraftTargetFacts: BuilderTargetFactsReader = async (
  transaction,
  _scope,
  rootId,
) => {
  if (rootId === undefined) return { isSystemApplication: false };
  const origin = await readBuilderApplicationOrigin(transaction, rootId);
  if (origin === undefined) throw new Error("STUDIO_DRAFT_UNAVAILABLE");
  return { isSystemApplication: origin === "platform_system_application" };
};

/** Organization selection is resolved from the current signed-in human on every request. */
export const loadStudioCreateAccess = async (
  candidateOrganizationId: string,
): Promise<StudioApplicationCreateAccessResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  if (!organization.success)
    return declined("create-access", { kind: "refused", reason: "request_invalid" });
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return declined(
        "create-access",
        resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable", reason: "session_unavailable" }
          : { kind: "refused", reason: "session_ended" },
      );
    const result = await humanOrganizationRequests().run(
      resolved.session,
      { organizationId: organization.data },
      async (transaction, scope): Promise<StudioAuthorityResult<OrganizationId>> => {
        const authority = createBuilderAuthority({
          transaction,
          scope,
          targetFacts: studioDraftTargetFacts,
          permissions: platformPermissionSource,
        });
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
    // A person without builder authority is the expected answer for most people: the launcher and
    // every application frame ask it on each read, so the refusal is returned and not logged.
    if (result.kind === "available")
      return result.value.kind === "available"
        ? { kind: "available", organizationId: result.value.value }
        : result.value;
    return declined(
      "create-access",
      result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable", reason: "request_failed" }
        : { kind: "refused", reason: "organization_unavailable" },
    );
  } catch (error) {
    return loadFailure("create-access", error);
  }
};

/** A compiler refusal names its rule, family and location; anything else is reported as unexpected. */
export const studioCompileFailure = (error: unknown): StudioCompileFailure => {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof DefinitionCompilationError) {
      const segments = current.location?.segments ?? [];
      const block = segments.find((segment) => segment.kind === "block");
      const setting = segments.filter((segment) => segment.kind === "setting").at(-1);
      const keyOf = (kind: string) => segments.find((segment) => segment.kind === kind)?.key;
      const located = {
        moduleKey: keyOf("module"),
        recordTypeKey: keyOf("record_type"),
        fieldKey: keyOf("field"),
        queryKey: keyOf("query"),
        flowKey: keyOf("flow"),
        taskId: keyOf("flow_node"),
      };
      const entry =
        current.code !== undefined
          ? definitionValidationEntry(current.code)
          : current.location === undefined
            ? undefined
            : translateDefinitionRuleFailures(
                [
                  {
                    ruleCode: current.ruleCode,
                    family: current.family,
                    location: current.location,
                  },
                ],
                { correlationId: randomUUID(), rootLocation: current.location },
              ).errors[0];
      const sentence = current.sentence ?? entry?.message;
      return {
        reasonCode: current.ruleCode,
        family: current.family,
        moduleKeys: segments
          .filter((segment) => segment.kind === "module")
          .map((segment) => segment.key),
        ...(sentence === undefined ? {} : { sentence }),
        ...(entry === undefined ? {} : { guidance: entry.guidance }),
        ...(block === undefined ? {} : { blockAlias: block.key }),
        ...(setting === undefined || setting.key === "theme" ? {} : { tokenKey: setting.key }),
        ...Object.fromEntries(Object.entries(located).filter(([, key]) => key !== undefined)),
      };
    }
    current = current.cause;
  }
  return { reasonCode: "STUDIO_DRAFT_COMPILE_UNEXPECTED", family: "unexpected" };
};

/**
 * Classification, permission and detached draft read share one verified request transaction. The
 * visible editor asks for its own view, projected from the saved revision's single compile.
 */
export const loadStudioApplicationDraft = async (
  candidateOrganizationId: string,
  candidateRootId: string,
  requests: readonly StudioViewRequest[] = [{ kind: "source" }],
  expectedDraftRevision?: number,
): Promise<StudioApplicationLoadResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (
    !organization.success ||
    !root.success ||
    !z.array(studioViewRequestSchema).min(1).max(maximumViewsPerRead).safeParse(requests).success
  )
    return declined("application-draft", { kind: "refused", reason: "request_invalid" });
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind !== "active")
      return declined(
        "application-draft",
        resolved.kind === "temporarily_unavailable"
          ? { kind: "temporarily_unavailable", reason: "session_unavailable" }
          : { kind: "refused", reason: "session_ended" },
      );
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
            previewShape: string;
            catalogue: typeof IMMUTABLE_PLATFORM_BLOCK_CATALOGUE;
            views: readonly StudioLoadedView[];
          }>
        >
      > => {
        const authority = createBuilderAuthority({
          transaction,
          scope,
          targetFacts: studioDraftTargetFacts,
          permissions: platformPermissionSource,
        });
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
        const compiles = !requests.every(
          (request) => request.kind === "source" && request.creation !== "record_page",
        );
        const publishedOf = (request: StudioViewRequest) =>
          request.kind === "data" || request.creation === "record_page";
        // A compile request reads the saved draft once, through the platform's own snapshot, which
        // returns it beside the compile; a source-only request reads the draft alone.
        const context = compiles
          ? await readLiveHumanContext(transaction, {
              scope,
              session: resolved.session,
              issuedAt,
            })
          : null;
        const snapshot =
          context === null
            ? null
            : await createDatabaseDefinitionPublicationService(
                installedReleaseCatalogue,
                transaction,
                authority,
              ).readApplicationDraftSnapshot(
                context,
                {
                  rootId: root.data,
                  ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
                },
                { publication: requests.some(publishedOf), releasable: false },
              );
        const draft =
          snapshot === null
            ? await readApplicationDefinitionDraft(transaction, scope, {
                rootId: root.data,
                ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision }),
              })
            : snapshot.draft;
        if (draft.kind !== "application") throw new Error("STUDIO_DRAFT_UNAVAILABLE");
        const identityReservations = requests.some((request) => request.kind === "access")
          ? await readSourceIdentityReservations(transaction, draft.rootId)
          : null;
        if (
          requests.some(
            (request) =>
              request.pageAlias !== undefined &&
              !draft.source.body.pages.some((page) => page.id === request.pageAlias),
          )
        )
          return { kind: "refused", reason: "page_missing" };
        const canvasOf = (request: StudioViewRequest) =>
          request.kind === "canvas" || request.kind === "theme";
        const dataOf = (request: StudioViewRequest) => request.kind === "data";
        const choicesOf = (request: StudioViewRequest) =>
          dataOf(request) ||
          request.kind === "flows" ||
          request.kind === "authoring" ||
          canvasOf(request);
        // The compile is read once for the union of the requested views; each view gets its own part.
        const canvas = requests.some(canvasOf);
        const data = requests.some(dataOf);
        const choices = requests.some(choicesOf);
        const themeRelease = canvas
          ? findPinnedPlatformThemeRelease(draft.source.body.theme.base)
          : undefined;
        if (canvas && themeRelease === undefined) throw new Error("STUDIO_THEME_RELEASE_MISSING");
        const catalogue = requests.some(
          (request) => choicesOf(request) || request.creation !== undefined,
        )
          ? IMMUTABLE_PLATFORM_BLOCK_CATALOGUE
          : {
              compositionPolicy: IMMUTABLE_PLATFORM_BLOCK_CATALOGUE.compositionPolicy,
              releases: [],
            };
        const resourcesOf = (request: StudioViewRequest): StudioViewResources => ({
          request,
          themeOptions: request.kind === "theme" ? studioThemeOptions : null,
          fieldInputControlReleases: canvasOf(request) ? FIELD_INPUT_CONTROL_RELEASES : null,
          platformThemeTokens: canvasOf(request) ? (themeRelease?.tokens ?? null) : null,
        });
        let compiledFields: StudioCompiledFields | null = null;
        let pageCompiledSlots: (StudioApplicationCompiledPageSlots | null)[] = requests.map(
          () => null,
        );
        let canvasFrames: (StudioApplicationCanvasFrames | null)[] = requests.map(() => null);
        let placements: StudioFlowPlacements | null = null;
        let compileFailure: StudioCompileFailure | null = null;
        let borrowedChoices: StudioBorrowedChoices | null = null;
        let usedModules: StudioDataModule[] | null = null;
        let published: StudioPublishedData | null = null;
        let peopleDirectory: PeopleDirectoryOwner | null = null;
        if (snapshot !== null && requests.some(publishedOf)) published = snapshot.publication;
        if (context !== null && snapshot !== null)
          try {
            if (snapshot.compilation === null) throw snapshot.failure;
            const compiled = snapshot.compilation;
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
              throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
            pageCompiledSlots = requests.map((request) =>
              canvasOf(request) && request.pageAlias !== undefined
                ? pageCompiledSlotsFor(
                    draft.source,
                    compiled.compilation.canonical.content,
                    request.pageAlias,
                  )
                : null,
            );
            canvasFrames = requests.map((request) =>
              canvasOf(request) || request.kind === "access"
                ? studioCanvasFramesFor(
                    draft.source.body.pages,
                    compiled.compilation.canonical.content,
                    request.pageAlias,
                  )
                : null,
            );
            if (requests.some((request) => request.kind === "flows")) {
              const owners = [
                ["", compiled.compilation.canonical.content.flows] as const,
                ...compiled.moduleReleases.map(
                  (release) =>
                    [release.key, release.compilationOutput.canonical.content.flows] as const,
                ),
              ];
              const plans = compileFlowPlans(owners.flatMap(([, flows]) => flows)).plans;
              placements = Object.fromEntries(
                owners.map(([key, flows]) => [
                  key,
                  Object.fromEntries(
                    flows.map((flow) => {
                      const plan = plans.get(String(flow.id));
                      if (plan === undefined) throw new Error("STUDIO_FLOW_PLAN_MISSING");
                      return [flow.key, flowPlacements(flow, plan)];
                    }),
                  ),
                ]),
              );
            }
            const fieldsByRecord: Record<string, readonly ModuleField[]> = {};
            const borrowed: StudioQueryChoice[] = [];
            const resolvedRecordTypes: string[] = [];
            const borrowedActions: StudioActionChoice[] = [];
            const borrowedRelationships: StudioRelationshipChoice[] = [];
            const used: StudioDataModule[] = [];
            // Explicit reads distinguish directory authoring from a Person link's name-only access.
            const declaredReads = new Set(
              draft.source.body.permissions
                .filter((permission) => permission.action_kind === "read")
                .map((permission) => permission.record_type),
            );
            // Every record type of the compiled Module releases by identity, as `<module>:<record>`,
            // for the record types a borrowed query's record inputs accept.
            const recordTypeKeys = new Map(
              compiled.moduleReleases.flatMap((release) =>
                release.compilationOutput.canonical.content.recordTypes.map(
                  (record) =>
                    [String(record.recordTypeId), `${release.key}:${record.key}`] as const,
                ),
              ),
            );
            const queryInputs = (
              query: (typeof compiled.moduleReleases)[number]["compilationOutput"]["canonical"]["content"]["queries"][number],
            ): StudioQueryInput[] =>
              query.inputs.map((input) => ({
                key: input.key,
                label: input.label,
                type: input.type,
                required: input.required,
                ...(input.type === "text" && input.validation?.choices !== undefined
                  ? { choices: input.validation.choices }
                  : {}),
                ...(input.type === "record_reference"
                  ? {
                      recordTypes: input.recordTypes.flatMap((type) =>
                        type.state === "resolved" && recordTypeKeys.has(String(type.recordTypeId))
                          ? [recordTypeKeys.get(String(type.recordTypeId))!]
                          : [],
                      ),
                    }
                  : {}),
              }));
            // The exact Module releases the draft compiled against, its own inline Modules included.
            {
              for (const binding of choices
                ? compiled.compilation.canonical.content.moduleBindings
                : []) {
                const selections = compiled.compilation.resolvedDependencies.filter(
                  (dependency) =>
                    dependency.kind === "module" &&
                    sameId(dependency.rootId, binding.moduleRootId) &&
                    dependency.exactVersion === binding.resolvedVersion,
                );
                const selection = selections[0];
                if (selections.length !== 1 || selection === undefined)
                  throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
                const matches = compiled.moduleReleases.filter(
                  (candidate) =>
                    sameId(candidate.rootId, binding.moduleRootId) &&
                    candidate.releaseVersion === binding.resolvedVersion,
                );
                const release = matches.length === 1 ? matches[0] : undefined;
                if (
                  release === undefined ||
                  !sameId(release.organizationId, scope.organizationId) ||
                  !sameId(release.rootId, binding.moduleRootId) ||
                  release.key !== selection.key ||
                  release.releaseVersion !== binding.resolvedVersion
                )
                  throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
                const use = draft.source.body.uses.find(
                  (candidate) => candidate.module === release!.key,
                );
                const content = release.compilationOutput.canonical.content;
                const linkable = (record: (typeof content.recordTypes)[number]) =>
                  record.systemProjection === undefined ||
                  `${release.key}:${record.key}` === directory.recordType;
                // A Person link does not expose unrelated administration projections. Explicit
                // read declarations keep deliberately authored administrative data available.
                const records =
                  use === undefined
                    ? content.recordTypes
                    : content.recordTypes.filter(
                        (record) =>
                          linkable(record) || declaredReads.has(`${release.key}:${record.key}`),
                      );
                const person = records.find(
                  (record) => `${release.key}:${record.key}` === directory.recordType,
                );
                if (release.key === directory.module && person === undefined)
                  throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
                const moduleName =
                  records.length === 1 && person !== undefined ? person.pluralLabel : content.name;
                // A used Module is shown read-only in the Data tab, as its installed release defines it.
                if (
                  data &&
                  use !== undefined &&
                  !used.some((module) => module.key === release!.key)
                )
                  used.push({
                    key: release.key,
                    name: moduleName,
                    ownerApplication: use.application,
                    recordTypes: records.map((record) => ({
                      key: record.key,
                      name: record.singularLabel,
                      pluralName: record.pluralLabel,
                      linkable: linkable(record),
                      ownershipMode: record.ownershipMode,
                      titleFieldKey:
                        record.fields.find((field) =>
                          sameId(String(field.fieldId), String(record.titleFieldId)),
                        )?.key ?? "",
                      fields: record.fields.map((field) => ({
                        key: field.key,
                        label: field.label,
                        type: field.type,
                        required: field.required,
                        unique: field.unique,
                        description: field.helpText ?? "",
                        filterable: field.filterable,
                        sortable: field.sortable,
                        personalData: field.personalData,
                        ...(field.searchPriority === undefined
                          ? {}
                          : { searchPriority: field.searchPriority }),
                      })),
                    })),
                    // Only the queries its Module exposes: the others are its own application's.
                    queries: content.queries.filter(moduleQueryBorrowable).flatMap((query) => {
                      const recordType =
                        query.recordType.state === "resolved"
                          ? records.find((candidate) =>
                              sameId(
                                String(candidate.recordTypeId),
                                String((query.recordType as { recordTypeId: string }).recordTypeId),
                              ),
                            )
                          : undefined;
                      return recordType === undefined
                        ? []
                        : [
                            {
                              key: query.key,
                              recordKey: recordType.key,
                              label:
                                query.label ??
                                query.key
                                  .replaceAll("_", " ")
                                  .replace(/^./u, (first) => first.toUpperCase()),
                              summary:
                                query.groupByFieldIds.length > 0 || query.aggregates.length > 0,
                              exposure: query.exposure,
                              inputs: queryInputs(query),
                            },
                          ];
                    }),
                  });
                // A used Module's exposed queries are offered as they are: they belong to its own application.
                if (
                  use !== undefined &&
                  !borrowed.some((query) => query.reference.startsWith(`${release!.key}:`))
                ) {
                  for (const query of content.queries.filter(moduleQueryBorrowable)) {
                    const recordType =
                      query.recordType.state === "resolved"
                        ? records.find((candidate) =>
                            sameId(
                              String(candidate.recordTypeId),
                              String((query.recordType as { recordTypeId: string }).recordTypeId),
                            ),
                          )
                        : undefined;
                    if (recordType === undefined) continue;
                    const allFields: StudioQueryChoice["allFields"] = recordType.fields.map(
                      (field) => {
                        const options =
                          field.type === "choice" ? field.settings.options : undefined;
                        return {
                          reference: `${release!.key}:${recordType.key}.${field.key}`,
                          label: field.label,
                          type: field.type,
                          sortable: field.sortable,
                          filterable: field.filterable,
                          searchable: field.searchPriority !== undefined,
                          linkTargetResolved:
                            field.type !== "link" || field.settings.target.state === "resolved",
                          ...(options === undefined
                            ? {}
                            : {
                                choiceCount: options.length,
                                choiceValues: options.map((option) => option.value),
                              }),
                          ...(field.type === "calculation" || field.type === "total"
                            ? { resultType: field.settings.resultType }
                            : {}),
                          // A one-record link from the record type to itself names each
                          // record's parent, judged as publication judges it.
                          ...(field.type === "link" &&
                          recordType.relationships.some(
                            (relationship) =>
                              sameId(String(relationship.fromFieldId), String(field.fieldId)) &&
                              relationship.cardinality === "many_to_one" &&
                              relationship.toRecordType?.state === "resolved" &&
                              sameId(
                                String(relationship.toRecordType.recordTypeId),
                                String(recordType.recordTypeId),
                              ),
                          )
                            ? { parentLink: true }
                            : {}),
                          ...((field.type === "link" || field.type === "choice") &&
                          optionsSourceNarrowing(field.settings.optionsSource) !== undefined
                            ? {
                                dependsOn: `${release!.key}:${recordType.key}.${recordType.fields.find((candidate) => sameId(String(candidate.fieldId), String(optionsSourceNarrowing(field.settings.optionsSource)!.parentFieldId)))?.key ?? ""}`,
                              }
                            : {}),
                        };
                      },
                    );
                    borrowed.push({
                      reference: `${release.key}:${query.key}`,
                      borrowedFrom: moduleName,
                      label:
                        query.label ??
                        query.key
                          .replaceAll("_", " ")
                          .replace(/^./u, (first) => first.toUpperCase()),
                      recordType: `${release.key}:${recordType.key}`,
                      recordTypeLabel: recordType.singularLabel,
                      allFields,
                      fields: query.selectedFieldIds.flatMap((fieldId) => {
                        const field = recordType.fields.find((candidate) =>
                          sameId(String(candidate.fieldId), String(fieldId)),
                        );
                        const reference = `${release!.key}:${recordType.key}.${field?.key ?? ""}`;
                        return allFields.filter((candidate) => candidate.reference === reference);
                      }),
                      grouped: query.groupByFieldIds.length > 0 || query.aggregates.length > 0,
                      totals: query.aggregates.map((total) => ({
                        alias: total.alias,
                        label: queryTotalLabel(
                          total.operation,
                          recordType.fields.find((field) =>
                            sameId(String(field.fieldId), String(total.fieldId)),
                          )?.label,
                        ),
                      })),
                      groupBy: query.groupByFieldIds.flatMap((fieldId) => {
                        const field = recordType.fields.find((candidate) =>
                          sameId(String(candidate.fieldId), String(fieldId)),
                        );
                        return field === undefined
                          ? []
                          : [`${release!.key}:${recordType.key}.${field.key}`];
                      }),
                      inputs: queryInputs(query),
                      pageSize: query.pageSize,
                      exposure: query.exposure,
                      exportable: recordType.standardActions.some((action) => action === "export"),
                    });
                  }
                  // Its actions and relationships are chosen as they are too: they belong to its own application.
                  for (const action of content.actions.filter((action) =>
                    records.some((record) =>
                      sameId(String(record.recordTypeId), String(action.subjectRecordTypeId)),
                    ),
                  ))
                    borrowedActions.push({
                      reference: action.key,
                      label: action.label,
                      recordType: recordTypeKeys.get(String(action.subjectRecordTypeId)) ?? "",
                      acceptsSelection: action.inputs.every((input) => !input.required),
                      borrowedFrom: use.application,
                    });
                  for (const record of records)
                    for (const relationship of record.relationships) {
                      const from = record.fields.find((field) =>
                        sameId(String(field.fieldId), String(relationship.fromFieldId)),
                      );
                      // Targets may belong to another installed module, as query inputs do.
                      const targets = [
                        ...(relationship.toRecordType === undefined
                          ? []
                          : [relationship.toRecordType]),
                        ...(relationship.toRecordTypes ?? []),
                      ].flatMap((target) => {
                        const linked =
                          target.state === "resolved"
                            ? recordTypeKeys.get(String(target.recordTypeId))
                            : undefined;
                        return linked === undefined ? [] : [linked];
                      });
                      borrowedRelationships.push({
                        reference: `${release.key}:${record.key}.${relationship.key}`,
                        label: `${record.singularLabel}: ${from?.label ?? relationship.key}`,
                        recordType: `${release.key}:${record.key}`,
                        targets,
                        borrowedFrom: use.application,
                      });
                    }
                }
                resolvedRecordTypes.push(
                  ...records.map((record) => `${release.key}:${record.key}`),
                );
                // The compiled fields of every record type the draft binds, for the typed condition
                // controls of a query filter and of a Records table's formatting rules.
                if (data || canvas)
                  for (const record of records)
                    fieldsByRecord[`${release.key}:${record.key}`] = record.fields;
              }
            }
            borrowedChoices = choices
              ? {
                  usesSignature: studioUsesSignature(draft.source),
                  recordTypes: resolvedRecordTypes,
                  queries: borrowed,
                  actions: borrowedActions,
                  relationships: borrowedRelationships,
                }
              : null;
            usedModules = data ? used : null;
            peopleDirectory = data ? compiled.peopleDirectory : null;
            compiledFields =
              data || canvas
                ? { draftRevision: draft.draftRevision, recordTypes: fieldsByRecord }
                : null;
          } catch (error) {
            // A failed metadata refresh never makes old choices authoritative or changes the draft.
            // The draft stays open: the person sees the stable reason and can correct or remove the edit.
            compileFailure = studioCompileFailure(error);
            console.error(
              "STUDIO_DRAFT_COMPILE_FAILED",
              compileFailure.reasonCode,
              compileFailure.family,
              error,
            );
            compiledFields = null;
            pageCompiledSlots = requests.map(() => null);
            canvasFrames = requests.map(() => null);
            placements = null;
          }
        if (context !== null) {
          // Publication facts remain visible after a compile refusal, so they need the same
          // current revision and authority checks as a successful compilation.
          await requireApplicationDefinitionDraftConsistency(transaction, scope, draft);
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId: root.data });
          if (
            canonicalJson(
              await readLiveHumanContext(transaction, {
                scope,
                session: resolved.session,
                issuedAt,
              }),
            ) !== canonicalJson(context)
          )
            throw new Error("STUDIO_DRAFT_COMPILE_MISMATCH");
        }
        return {
          kind: "available",
          value: {
            organizationId: scope.organizationId,
            draft,
            previewShape: studioPreviewShapeFingerprint(draft.source),
            catalogue,
            views: requests.map((request, index) => ({
              ...resourcesOf(request),
              identityReservations: request.kind === "access" ? identityReservations : null,
              compiledFields: dataOf(request) || canvasOf(request) ? compiledFields : null,
              borrowedChoices: choicesOf(request) ? borrowedChoices : null,
              usedModules: dataOf(request) ? usedModules : null,
              published: publishedOf(request) ? published : null,
              peopleDirectory: dataOf(request) ? peopleDirectory : null,
              pageCompiledSlots: pageCompiledSlots[index] ?? null,
              canvasFrames: canvasFrames[index] ?? null,
              flowPlacements: request.kind === "flows" ? placements : null,
              compileFailure,
            })),
          },
        };
      },
    );
    if (result.kind === "available")
      return result.value.kind === "available"
        ? { kind: "available", ...result.value.value }
        : declined("application-draft", result.value);
    return declined(
      "application-draft",
      result.kind === "temporarily_unavailable"
        ? { kind: "temporarily_unavailable", reason: "request_failed" }
        : { kind: "refused", reason: "organization_unavailable" },
    );
  } catch (error) {
    return loadFailure("application-draft", error);
  }
};
