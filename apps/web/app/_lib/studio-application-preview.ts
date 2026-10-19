import "server-only";
import { cache, cacheSignal } from "react";

import {
  BuilderAuthorityError,
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  createPreviewInstallationCoordinator,
  createPreviewInstallationRepository,
  DefinitionError,
  dropRetiredPreviewStorage,
  previewApplicationKey,
  readApplicationDefinitionDraft,
  requireBuilderAuthority,
  type BuilderTargetFactsReader,
  type DatabaseRow,
  type StoredApplicationDefinitionDraft,
  type InstalledRuntimeContext,
  runtimePreviewOf,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  describeFailure,
  organizationIdSchema,
  revisionSchema,
  sameId,
  type ApplicationRootId,
  type BuilderPreviewInstallation,
  type IdentitySession,
  type OrganizationId,
  type PreviewDemand,
  type PageDefinition,
} from "@vortex/platform/schema";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { loadOrganizationLauncher } from "./organization-context";
import { organizationAddressPath } from "./address-paths";
import {
  studioDraftTargetFacts,
  studioPreviewShapeFingerprint,
  pageCompiledSlotsFor,
} from "./studio-application-draft";

import { compiledStudioDraft } from "./studio-compiled-drafts";
import { collectPlacements } from "./application-page/placement-helpers";
import {
  studioPreviewDemand,
  studioPreviewReaderSchema,
  type StudioPreviewReader,
} from "./studio-preview-demand";

const previewRequestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
  })
  .strict();

/** The running preview of a saved draft: where it opens, which draft it runs and until when. */
export type StudioApplicationPreviewResult =
  | Readonly<{ kind: "provisioned"; href: string; draftRevision: number; expiresAt: string }>
  | Readonly<{
      kind: "refused";
      reason: "invalid_request" | "permission_refused";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

type PreviewFailure = Exclude<StudioApplicationPreviewResult, { kind: "provisioned" }>;

/** The builder's preview that a read of the saved draft runs on, or why there is none. */
export type StudioPreviewResult =
  | Readonly<{
      kind: "available";
      previewInstallationId: string;
      organizationId: string;
      draftRevision: number;
      expiresAt: string;
      /** Its copied live records are due to be decided again by the builder's live access. */
      reconcileDue: boolean;
    }>
  | PreviewFailure;

/** The saved draft at one revision and the builder's current preview of its Application. */
export type StudioPreviewState =
  | Readonly<{
      kind: "read";
      draft: StoredApplicationDefinitionDraft;
      preview: BuilderPreviewInstallation | undefined;
    }>
  | PreviewFailure;

type ClassificationRow = DatabaseRow & { outcome: unknown; application_origin_kind: unknown };

class ContextRefused extends Error {}

/** No default classification exists for an addressed root, including an unknown root. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new ContextRefused();
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
    throw new ContextRefused();
  return { isSystemApplication: row.application_origin_kind === "platform_system_application" };
};

const coordinator = () =>
  createPreviewInstallationCoordinator({
    installerRequests: humanOrganizationRequests(),
    releaseCatalogue: installedReleaseCatalogue,
    builderAuthority: (transaction, scope) =>
      createBuilderAuthority({
        transaction,
        scope,
        targetFacts,
        permissions: platformPermissionSource,
      }),
    draftPlanner: (transaction, authority) =>
      createDatabaseDefinitionPublicationService(installedReleaseCatalogue, transaction, authority),
  });

const failure = (error: unknown): PreviewFailure => {
  console.error("[studio] preview provisioning failed", error);
  const code = error instanceof DefinitionError ? error.code : undefined;
  switch (code) {
    case "PREVIEW_INSTALLATION_STALE":
      return { kind: "conflict" };
    case "PREVIEW_INSTALLATION_PERMISSION_REFUSED":
    case "PREVIEW_INSTALLATION_REFUSED":
      return { kind: "refused", reason: "permission_refused" };
    case "INVALID_PREVIEW_INSTALLATION_COMMAND":
      return { kind: "refused", reason: "invalid_request" };
    case "PREVIEW_INSTALLATION_TEMPORARILY_UNAVAILABLE":
      return { kind: "temporarily_unavailable" };
  }
  return { kind: "temporarily_unavailable" };
};

/**
 * Reads, in one request under the builder's draft authority, the saved draft at exactly the
 * requested revision and the builder's current preview of its Application. It reads in the
 * installed Application's own scope, which an organisation-wide change (such as a preview's
 * rehearsed publication) does not hold up, and in the organisation's scope for an Application
 * with no installation yet.
 */
export const readStudioPreviewState = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  draftRevision: number,
): Promise<StudioPreviewState> => {
  try {
    const selection = { organizationId, applicationRootId: rootId };
    const readOnceMoreOnSerializationConflict = async (
      selected: Readonly<{ organizationId: OrganizationId; applicationRootId?: ApplicationRootId }>,
    ) => {
      const first = await readPreviewStateIn(
        session,
        selected,
        organizationId,
        rootId,
        draftRevision,
      );
      if (first.kind !== "temporarily_unavailable" || first.databaseCode !== "40001") return first;
      // A preview move can invalidate this transaction's snapshot. The request service already
      // logged the SQLSTATE and cause; start one fresh protected transaction for this known race.
      console.info(
        "[studio] retrying preview state after serialization conflict: STUDIO_PREVIEW_STATE_RETRY",
      );
      return readPreviewStateIn(session, selected, organizationId, rootId, draftRevision);
    };
    const inApplication = await readOnceMoreOnSerializationConflict(selection);
    const read =
      inApplication.kind === "temporarily_unavailable" ||
      (inApplication.kind === "available" && inApplication.value.kind !== "refused")
        ? inApplication
        : await readOnceMoreOnSerializationConflict({ organizationId });
    if (read.kind === "available") return read.value;
    return read.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused", reason: "permission_refused" };
  } catch (error) {
    if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
      return { kind: "conflict" };
    console.error(
      `[studio] preview state unavailable: STUDIO_PREVIEW_STATE_FAILED cause=${describeFailure(error)}`,
    );
    return { kind: "temporarily_unavailable" };
  }
};

const readPreviewStateIn = (
  session: IdentitySession,
  selection: Readonly<{ organizationId: OrganizationId; applicationRootId?: ApplicationRootId }>,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  draftRevision: number,
) =>
  humanOrganizationRequests().run(session, selection, async (transaction, scope) => {
    const authority = createBuilderAuthority({
      transaction,
      scope,
      targetFacts: studioDraftTargetFacts,
      permissions: platformPermissionSource,
    });
    try {
      await requireBuilderAuthority(authority, { kind: "draft_change", rootId });
    } catch (error) {
      if (error instanceof BuilderAuthorityError)
        return { kind: "refused", reason: "permission_refused" } as const;
      throw error;
    }
    let draft: StoredApplicationDefinitionDraft;
    try {
      draft = await readApplicationDefinitionDraft(transaction, scope, {
        rootId,
        expectedDraftRevision: draftRevision,
      });
    } catch (error) {
      if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
        return { kind: "conflict" } as const;
      throw error;
    }
    const preview =
      await createPreviewInstallationRepository(transaction).readBuilderPreview(rootId);
    if (
      preview !== undefined &&
      (!sameId(preview.applicationRootId, rootId) ||
        !sameId(preview.organizationId, organizationId))
    )
      throw new Error("STUDIO_PREVIEW_LOOKUP_MISMATCH");
    return { kind: "read", draft, preview } as const;
  });

/** A preview reused for a new read keeps at least this long, so it does not expire while Studio reads it. */
const reuseMarginMs = 60 * 60 * 1000;

const available = (
  preview: Readonly<{
    previewInstallationId: string;
    organizationId: string;
    draftRevision: number;
    expiresAt: string;
  }>,
  reconcileDue: boolean,
): StudioPreviewResult => ({
  kind: "available",
  previewInstallationId: preview.previewInstallationId,
  organizationId: preview.organizationId,
  draftRevision: preview.draftRevision,
  expiresAt: preview.expiresAt,
  reconcileDue,
});

/**
 * Provisionings and refreshes in flight, by builder, Application and draft revision. Studio's
 * canvas areas and Data tab ask for the same preview together; one operation serves them all. It
 * holds only the pending operation, never an access decision: every read in the preview is still
 * decided by the database for the requesting builder.
 */
type PendingPreview = {
  controller: AbortController;
  consumers: number;
  result: Promise<unknown>;
};
// Explicit Preview actions and canvas routes must join the same pending operation even though
// Next loads them in separate module runtimes. Completed results are never kept here.
const pendingPreviewsKey = Symbol.for("vortex.web.studio-preview-operations");
const processPreviews = globalThis as typeof globalThis & {
  [pendingPreviewsKey]?: Map<string, PendingPreview>;
};
const pending = (processPreviews[pendingPreviewsKey] ??= new Map<string, PendingPreview>());

const once = async <Result>(
  key: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  signal?.throwIfAborted();
  let operation = pending.get(key);
  if (operation === undefined || operation.controller.signal.aborted) {
    const controller = new AbortController();
    operation = {
      controller,
      consumers: 0,
      result: Promise.resolve().then(() => run(controller.signal)),
    };
    pending.set(key, operation);
    const started = operation;
    void operation.result
      .finally(() => {
        if (pending.get(key) === started) pending.delete(key);
      })
      .catch(() => {}); // Each consumer observes the original rejection below.
  }
  const current = operation;
  current.consumers += 1;
  let release: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    release = () => reject(signal?.reason);
    signal?.addEventListener("abort", release, { once: true });
  });
  try {
    // Each operation kind owns its key and result type; completed results are never retained.
    return (await Promise.race([current.result, cancelled])) as Result;
  } finally {
    if (release !== undefined) signal?.removeEventListener("abort", release);
    current.consumers -= 1;
    // Several visible areas may share one move. Only the last departing reader cancels it.
    if (current.consumers === 0) current.controller.abort();
  }
};

type Target = Readonly<{
  session: IdentitySession;
  organizationId: OrganizationId;
  rootId: ApplicationRootId;
  draftRevision: number;
  shapeFingerprint: string;
}>;

const keyOf = (target: Target): string =>
  `${target.session.identityId}|${target.organizationId}|${target.rootId}|${target.draftRevision}`.toLowerCase();

/** A new preview of the draft, replacing the builder's previous one and its records. */
const provision = (target: Target, signal?: AbortSignal): Promise<StudioPreviewResult> =>
  once(`${keyOf(target)}|create`, signal, (demand) =>
    coordinator()
      .create(
        target.session,
        {
          organizationId: target.organizationId,
          applicationRootId: target.rootId,
          expectedDraftRevision: target.draftRevision,
          shapeFingerprint: target.shapeFingerprint,
        },
        demand,
      )
      .then(
        (preview) => {
          // Retired storage is dropped in short background transactions after provisioning commits.
          void dropRetiredPreviewStorage().catch((error: unknown) => {
            console.error("[studio] retired preview storage drop failed", error);
          });
          return available(preview, false);
        },
        (error: unknown) => {
          demand.throwIfAborted();
          return failure(error);
        },
      ),
  );

/**
 * The builder's preview moved to the draft in place, keeping its records; a new one only when
 * its records cannot take the draft's change.
 */
const follow = (
  target: Target,
  previewInstallationId: string,
  signal?: AbortSignal,
): Promise<StudioPreviewResult> =>
  once(`${keyOf(target)}|follow`, signal, (demand) =>
    coordinator()
      .refresh(
        target.session,
        {
          organizationId: target.organizationId,
          applicationRootId: target.rootId,
          previewInstallationId,
          expectedDraftRevision: target.draftRevision,
          shapeFingerprint: target.shapeFingerprint,
        },
        demand,
      )
      .then(
        (preview) => available(preview, false),
        (error: unknown) => {
          demand.throwIfAborted();
          return error instanceof DefinitionError &&
            error.code === "PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE"
            ? provision(target, demand)
            : failure(error);
        },
      ),
  );

const targetOf = (
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: StoredApplicationDefinitionDraft,
): Target => ({
  session,
  organizationId,
  rootId: draft.rootId as ApplicationRootId,
  draftRevision: draft.draftRevision,
  shapeFingerprint: studioPreviewShapeFingerprint(draft.source),
});

const lasting = (preview: BuilderPreviewInstallation): boolean =>
  Date.parse(preview.expiresAt) - Date.now() > reuseMarginMs;

/**
 * Whether the builder's preview already runs this saved revision's data shape, so its records are
 * this revision's: it is not newer than the revision, has the same shape and does not expire soon. Demand readiness is checked separately.
 */
export const studioPreviewRunsDraft = (
  draft: StoredApplicationDefinitionDraft,
  preview: BuilderPreviewInstallation | undefined,
): "ready" | "behind" | "newer" =>
  preview === undefined
    ? "behind"
    : preview.draftRevision > draft.draftRevision
      ? "newer"
      : lasting(preview) &&
          (preview.draftRevision === draft.draftRevision ||
            preview.shapeFingerprint === studioPreviewShapeFingerprint(draft.source))
        ? "ready"
        : "behind";

/**
 * The builder's preview moved to the saved draft, or a new one. `prepare` asks for the draft's data
 * shape only: presentation edits reuse the current records without rehearsing a publication.
 * `open` (the Preview button) asks for the exact revision, so its pages and menu are the draft's.
 */
export async function currentStudioPreview(
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: StoredApplicationDefinitionDraft,
  preview: BuilderPreviewInstallation | undefined,
  purpose: "prepare" | "open",
  signal?: AbortSignal,
): Promise<StudioPreviewResult> {
  signal?.throwIfAborted();
  const target = targetOf(session, organizationId, draft);
  if (preview === undefined) return provision(target, signal);
  if (preview.draftRevision > draft.draftRevision) return { kind: "conflict" };
  if (
    lasting(preview) &&
    (preview.draftRevision === draft.draftRevision ||
      (purpose === "prepare" && preview.shapeFingerprint === target.shapeFingerprint))
  )
    return available(preview, preview.reconcileDue);
  const followed = await follow(target, preview.previewInstallationId, signal);
  return followed.kind === "available" &&
    sameId(followed.previewInstallationId, preview.previewInstallationId)
    ? { ...followed, reconcileDue: preview.reconcileDue }
    : followed;
}

/**
 * Saves whose preview is being moved, by builder and Application: the newest saved revision a move
 * is wanted for and the move under way. A save that arrives while a move runs only raises the
 * wanted revision, so a burst of saves costs one move to the newest. It holds only pending work,
 * never an access decision or a result.
 */
type ScheduledMove = { session: IdentitySession; wanted: number; idle: Promise<void> };
const scheduledMovesKey = Symbol.for("vortex.web.studio-preview-moves");
const processMoves = globalThis as typeof globalThis & {
  [scheduledMovesKey]?: Map<string, ScheduledMove>;
};
const scheduled = (processMoves[scheduledMovesKey] ??= new Map<string, ScheduledMove>());

const moveKeyOf = (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
): string => `${session.identityId}|${organizationId}|${rootId}`.toLowerCase();

/** One move of the builder's existing preview to a saved revision's data shape. */
const moveToSaved = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  draftRevision: number,
): Promise<void> => {
  const state = await readStudioPreviewState(session, organizationId, rootId, draftRevision);
  // A conflict is a newer save, whose own move follows; a refusal leaves the preview as it is.
  if (state.kind !== "read") {
    if (state.kind === "temporarily_unavailable")
      console.error(
        `[studio] preview move skipped: STUDIO_PREVIEW_MOVE_STATE_UNAVAILABLE revision=${draftRevision}`,
      );
    return;
  }
  // The first preview is created for a reader that shows records, never by a save.
  if (
    state.preview === undefined ||
    studioPreviewRunsDraft(state.draft, state.preview) !== "behind"
  )
    return;
  const moved = await follow(
    targetOf(session, organizationId, state.draft),
    state.preview.previewInstallationId,
  );
  if (moved.kind !== "available" && moved.kind !== "conflict")
    console.error(
      `[studio] preview move failed: STUDIO_PREVIEW_MOVE_FAILED kind=${moved.kind} revision=${draftRevision}`,
    );
};

/**
 * Moves the builder's preview to a committed save's data shape on the server, after the save has
 * answered, so Studio's readers find the preview ready instead of moving it themselves. Only a
 * preview the builder already has is moved, and only when the save changed its data shape.
 */
export const scheduleStudioPreviewMove = (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  draftRevision: number,
): Promise<void> => {
  const key = moveKeyOf(session, organizationId, rootId);
  const current = scheduled.get(key);
  if (current !== undefined) {
    current.wanted = Math.max(current.wanted, draftRevision);
    current.session = session;
    return current.idle;
  }
  const move: ScheduledMove = { session, wanted: draftRevision, idle: Promise.resolve() };
  move.idle = (async () => {
    let moved = 0;
    try {
      while (move.wanted > moved) {
        moved = move.wanted;
        try {
          await moveToSaved(move.session, organizationId, rootId, moved);
        } catch (error) {
          console.error(
            `[studio] preview move failed: STUDIO_PREVIEW_MOVE_FAILED cause=${describeFailure(error)}`,
          );
        }
      }
    } finally {
      if (scheduled.get(key) === move) scheduled.delete(key);
    }
  })();
  scheduled.set(key, move);
  return move.idle;
};

/** Readiness includes the database-derived demand, never identities supplied by the browser. */
export type StudioPreviewReadiness =
  | Readonly<{
      kind: "ready";
      draftRevision: number;
      previewShape: string;
      requiredRecordTypeIds: readonly string[];
      readyRecordTypeIds: readonly string[];
    }>
  | Readonly<{ kind: "following" }>
  | PreviewFailure;

/** Resolve authored reader addresses against the same retained compilation used by the canvas. */
export const readStudioPreviewDemand = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: StoredApplicationDefinitionDraft,
  reader: StudioPreviewReader,
) => {
  const compiled = await compiledStudioDraft(session, organizationId, draft);
  if (compiled === "refused") return { kind: "refused" } as const;
  if (compiled === "conflict") return { kind: "conflict" } as const;
  if (compiled === "temporarily_unavailable") return { kind: "temporarily_unavailable" } as const;
  const content = compiled.compilation.canonical.content;
  const modules = compiled.moduleReleases.map((release) => ({
    key: release.key,
    content: release.compilationOutput.canonical.content,
  }));
  try {
    if (reader.kind === "records")
      return {
        kind: "derived",
        demand: studioPreviewDemand(content, modules, reader),
        compiled,
      } as const;
    const pageIndex = draft.source.body.pages.findIndex((page) => page.id === reader.pageAlias);
    const page = content.pages[pageIndex];
    const slots = pageCompiledSlotsFor(draft.source, content, reader.pageAlias)[reader.pageAlias];
    if (
      page === undefined ||
      slots === undefined ||
      reader.areas.some((area) => slots[area] === undefined)
    )
      return { kind: "refused" } as const;
    const placements = collectPlacements({
      ...page,
      composition: {
        root: { props: {} },
        content: [...new Set(reader.areas)].flatMap((area) => slots[area]!),
      },
    });
    return {
      kind: "derived",
      demand: studioPreviewDemand(content, modules, {
        kind: "placements",
        page,
        readSubject: page.type === "detail",
        placements,
      }),
      compiled,
    } as const;
  } catch (error) {
    if (error instanceof Error && error.message === "STUDIO_PREVIEW_READER_INVALID")
      return { kind: "refused" } as const;
    throw error;
  }
};

/** A fresh authority-checked closure read. It never seeds or creates a preview. */
export const readStudioDemandReadiness = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  preview: Readonly<{ previewInstallationId: string; draftRevision: number }>,
  demand: PreviewDemand | undefined,
) => {
  if (demand === undefined)
    return {
      kind: "checked",
      ready: true,
      requiredRecordTypeIds: [],
      readyRecordTypeIds: [],
    } as const;
  const readIn = (
    selection: Readonly<{ organizationId: OrganizationId; applicationRootId?: ApplicationRootId }>,
  ) =>
    humanOrganizationRequests().run(session, selection, (transaction) =>
      createPreviewInstallationRepository(transaction).readDemand(
        preview.previewInstallationId,
        demand,
      ),
    );
  const installed = await readIn({ organizationId, applicationRootId: rootId });
  const result =
    installed.kind === "available" || installed.kind === "temporarily_unavailable"
      ? installed
      : await readIn({ organizationId });
  if (result.kind !== "available")
    return result.kind === "temporarily_unavailable"
      ? ({ kind: "temporarily_unavailable" } as const)
      : ({ kind: "refused" } as const);
  if (result.value.draftRevision !== preview.draftRevision) return { kind: "conflict" } as const;
  const ready = new Set(result.value.readyRecordTypeIds);
  return {
    kind: "checked",
    ready: result.value.closure.every((id) => ready.has(id)),
    requiredRecordTypeIds: result.value.closure,
    readyRecordTypeIds: result.value.readyRecordTypeIds,
  } as const;
};

/** The sole materialization call, shared by Studio and runtime preview readers. */
export const materializeStudioPreviewDemand = (
  session: IdentitySession,
  organizationId: OrganizationId,
  rootId: ApplicationRootId,
  preview: Extract<StudioPreviewResult, { kind: "available" }>,
  demand: PreviewDemand,
  signal?: AbortSignal,
): Promise<Readonly<{ kind: "materialized"; closure: readonly string[] }> | PreviewFailure> =>
  once(
    `${session.identityId}|${organizationId}|${rootId}|${preview.draftRevision}|${preview.previewInstallationId}|${JSON.stringify(demand)}`.toLowerCase(),
    signal,
    async (pendingSignal) => {
      try {
        const seeded = await coordinator().materialize(
          session,
          {
            organizationId,
            applicationRootId: rootId,
            previewInstallationId: preview.previewInstallationId,
            expectedDraftRevision: preview.draftRevision,
            demand,
          },
          pendingSignal,
        );
        return { kind: "materialized" as const, closure: seeded.closure };
      } catch (error) {
        if (pendingSignal.aborted)
          console.info("[studio] preview demand cancelled: STUDIO_PREVIEW_DEMAND_CANCELLED");
        pendingSignal.throwIfAborted();
        return failure(error);
      }
    },
  );

/** The frame and page share this request-owned preparation of the opened preview page. */
export const prepareRuntimePreviewPage = cache(
  async (
    session: IdentitySession,
    context: InstalledRuntimeContext,
    page: PageDefinition,
    readSubject: boolean,
    projected: Readonly<Record<string, unknown>> | undefined,
    selectedPlacementIds: ReadonlySet<string> | undefined,
  ): Promise<boolean> => {
    const preview = runtimePreviewOf(context);
    if (preview === undefined) return true;
    const signal = cacheSignal() as AbortSignal | null;
    const content = context.releaseSet.application.content;
    const demand = studioPreviewDemand(
      content,
      context.releaseSet.modules.map((module) => ({
        key: module.definitionKey,
        content: module.content,
      })),
      {
        kind: "placements",
        page,
        readSubject,
        placements:
          projected === undefined
            ? []
            : collectPlacements(projected).filter(
                (placement) =>
                  selectedPlacementIds === undefined ||
                  selectedPlacementIds.has(placement.placementId.toLowerCase()),
              ),
      },
    );
    return prepareRuntimeDemand(session, context, demand, signal ?? undefined);
  },
);

/** Link choices are demanded only when the picker or an initial link value is actually read. */
export const prepareRuntimePreviewChoices = (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  recordTypeIds: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> => {
  if (runtimePreviewOf(context) === undefined) return Promise.resolve(true);
  const demand = studioPreviewDemand(
    context.releaseSet.application.content,
    context.releaseSet.modules.map((module) => ({
      key: module.definitionKey,
      content: module.content,
    })),
    { kind: "choices", recordTypeIds },
  );
  return prepareRuntimeDemand(
    session,
    context,
    demand,
    signal ?? (cacheSignal() as AbortSignal | null) ?? undefined,
  );
};

const prepareRuntimeDemand = async (
  session: IdentitySession,
  context: InstalledRuntimeContext,
  demand: PreviewDemand | undefined,
  signal?: AbortSignal,
): Promise<boolean> => {
  const preview = runtimePreviewOf(context);
  if (preview === undefined) return true;
  if (demand === undefined) return true;
  const before = await readStudioDemandReadiness(
    session,
    context.organizationId,
    context.applicationRootId,
    preview,
    demand,
  );
  if (before.kind !== "checked") return false;
  if (before.ready) return true;
  const seeded = await materializeStudioPreviewDemand(
    session,
    context.organizationId,
    context.applicationRootId,
    {
      kind: "available",
      previewInstallationId: preview.previewInstallationId,
      organizationId: context.organizationId,
      draftRevision: preview.draftRevision,
      expiresAt: preview.expiresAt,
      reconcileDue: false,
    },
    demand,
    signal ?? undefined,
  );
  if (seeded.kind !== "materialized") return false;
  const after = await readStudioDemandReadiness(
    session,
    context.organizationId,
    context.applicationRootId,
    preview,
    demand,
  );
  return after.kind === "checked" && after.ready;
};

/** A visible reader owns preparation and materialization; its last consumer leaving cancels work. */
export const prepareStudioPreview = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
  signal?: AbortSignal,
): Promise<StudioPreviewReadiness> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema
    .extend({ reader: studioPreviewReaderSchema })
    .safeParse(candidate);
  if (!organization.success || !request.success)
    return { kind: "refused", reason: "invalid_request" };
  const { rootId, draftRevision, reader } = request.data;
  const state = await readStudioPreviewState(session, organization.data, rootId, draftRevision);
  signal?.throwIfAborted();
  if (state.kind !== "read") return state;
  const derived = await readStudioPreviewDemand(session, organization.data, state.draft, reader);
  if (derived.kind !== "derived")
    return derived.kind === "refused" ? { kind: "refused", reason: "invalid_request" } : derived;
  signal?.throwIfAborted();
  const answer = (
    requiredRecordTypeIds: readonly string[],
    readyRecordTypeIds: readonly string[],
  ): StudioPreviewReadiness => ({
    kind: "ready",
    draftRevision,
    previewShape: studioPreviewShapeFingerprint(state.draft.source),
    requiredRecordTypeIds,
    readyRecordTypeIds,
  });
  // Text-only areas and live system projections have no copied-record demand.
  const prepared = await currentStudioPreview(
    session,
    organization.data,
    state.draft,
    state.preview,
    "prepare",
    signal,
  );
  if (prepared.kind !== "available") return prepared;
  if (derived.demand === undefined) return answer([], []);
  const before = await readStudioDemandReadiness(
    session,
    organization.data,
    rootId,
    prepared,
    derived.demand,
  );
  if (before.kind !== "checked")
    return before.kind === "refused" ? { kind: "refused", reason: "permission_refused" } : before;
  if (before.ready) return answer(before.requiredRecordTypeIds, before.readyRecordTypeIds);
  const seeded = await materializeStudioPreviewDemand(
    session,
    organization.data,
    rootId,
    prepared,
    derived.demand,
    signal,
  );
  if (seeded.kind !== "materialized") return seeded;
  signal?.throwIfAborted();
  // Materialization committed the SQL-derived closure and its pending backfill. Learn only that
  // closure here: the ensuing Studio record read freshly checks authority, revision and readiness.
  return answer(seeded.closure, seeded.closure);
};

/**
 * The running preview of the saved Application draft at the given revision and its address: the
 * builder's preview moved to that revision, or a new one. The session is the server-resolved one;
 * the browser names only the root and the saved revision it expects.
 */
export const provisionStudioApplicationPreview = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
): Promise<StudioApplicationPreviewResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success)
    return { kind: "refused", reason: "invalid_request" };
  const state = await readStudioPreviewState(
    session,
    organization.data,
    request.data.rootId,
    request.data.draftRevision,
  );
  if (state.kind !== "read") return state;
  const preview = await currentStudioPreview(
    session,
    organization.data,
    state.draft,
    state.preview,
    "open",
  );
  if (preview.kind !== "available") return preview;
  const launcher = await loadOrganizationLauncher(session);
  if (launcher.kind !== "available") return { kind: "temporarily_unavailable" };
  const entry = launcher.entries.find((item) =>
    sameId(item.organizationId, preview.organizationId),
  );
  if (entry === undefined) return { kind: "refused", reason: "permission_refused" };
  // The preview's own address: its home page opens there, as an installed Application's does.
  return {
    kind: "provisioned",
    href: `${organizationAddressPath(entry.tenantShortName, entry.organizationShortName)}/${encodeURIComponent(previewApplicationKey(preview.previewInstallationId))}`,
    draftRevision: preview.draftRevision,
    expiresAt: preview.expiresAt,
  };
};
