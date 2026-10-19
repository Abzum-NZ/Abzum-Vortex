import "server-only";

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
  type PreviewInstallation,
} from "@vortex/platform/schema";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { loadOrganizationLauncher } from "./organization-context";
import { organizationAddressPath } from "./address-paths";
import { studioDraftTargetFacts, studioPreviewShapeFingerprint } from "./studio-application-draft";

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
  console.error("[studio] preview provisioning failed", error);
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
  result: Promise<StudioPreviewResult>;
};
// Explicit Preview actions and canvas routes must join the same pending operation even though
// Next loads them in separate module runtimes. Completed results are never kept here.
const pendingPreviewsKey = Symbol.for("vortex.web.studio-preview-operations");
const processPreviews = globalThis as typeof globalThis & {
  [pendingPreviewsKey]?: Map<string, PendingPreview>;
};
const pending = (processPreviews[pendingPreviewsKey] ??= new Map<string, PendingPreview>());

const once = async (
  key: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<StudioPreviewResult>,
): Promise<StudioPreviewResult> => {
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
    return await Promise.race([current.result, cancelled]);
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

/** The most record types one demand names. */
const demandRecordTypeLimit = 201;

/**
 * Seeds the preview with every record type it has storage for, so it holds what its builder reads
 * live; an Application with no installation has nothing to seed. Seeded record types are not
 * seeded again, and a pending backfill of derived fields is finished.
 */
const materializeEveryRecordType = async <
  Preview extends Pick<
    PreviewInstallation,
    "previewInstallationId" | "draftRevision" | "seedable" | "recordTypeIds"
  >,
>(
  target: Target,
  preview: Preview,
  signal: AbortSignal,
): Promise<Preview> => {
  if (!preview.seedable) return preview;
  for (let start = 0; start < preview.recordTypeIds.length; start += demandRecordTypeLimit)
    await coordinator().materialize(
      target.session,
      {
        organizationId: target.organizationId,
        applicationRootId: target.rootId,
        previewInstallationId: preview.previewInstallationId,
        expectedDraftRevision: preview.draftRevision,
        demand: {
          recordTypes: preview.recordTypeIds
            .slice(start, start + demandRecordTypeLimit)
            .map((recordTypeId) => ({ recordTypeId, fieldIds: [], relationshipPaths: [] })),
        },
      },
      signal,
    );
  return preview;
};

/**
 * Whether the preview holds what its builder reads live: every record type seeded and its derived
 * fields worked out. A preview whose seeding stopped (its last reader left, or the request failed)
 * runs, but is not read until it is seeded.
 */
const materialized = (preview: BuilderPreviewInstallation): boolean => {
  if (!preview.seedable) return true;
  const ready = new Set(preview.derivedReadyRecordTypeIds);
  return preview.recordTypeIds.every((recordTypeId) => ready.has(recordTypeId));
};

/** Seeds a current preview that is not seeded yet, joining a provision or move under way. */
const complete = (
  target: Target,
  preview: BuilderPreviewInstallation,
  signal?: AbortSignal,
): Promise<StudioPreviewResult> =>
  once(
    [`${keyOf(target)}|create`, `${keyOf(target)}|follow`].find((key) => pending.has(key)) ??
      `${keyOf(target)}|create`,
    signal,
    (demand) =>
      materializeEveryRecordType(target, preview, demand).then(
        (seeded) => available(seeded, seeded.reconcileDue),
        (error: unknown) => {
          demand.throwIfAborted();
          return failure(error);
        },
      ),
  );

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
      .then((preview) => materializeEveryRecordType(target, preview, demand))
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
      .then((preview) => materializeEveryRecordType(target, preview, demand))
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
 * this revision's: it is not newer than the revision, has the same shape, is seeded and does not expire soon.
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
          materialized(preview) &&
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
    return materialized(preview)
      ? available(preview, preview.reconcileDue)
      : complete(target, preview, signal);
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

/** Whether the builder's preview runs a saved revision's data shape, so its records can be read. */
export type StudioPreviewReadiness =
  | Readonly<{ kind: "ready"; draftRevision: number; previewShape: string }>
  /** A move to this revision is still under way: ask again. */
  | Readonly<{ kind: "following" }>
  | PreviewFailure;

/** How long one readiness request waits for a move under way before it answers `following`. */
const readinessWaitMs = 20_000;

const waitFor = (idle: Promise<void>, signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      settle();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      settle();
      resolve();
    }, readinessWaitMs);
    signal?.addEventListener("abort", abort, { once: true });
    void idle.finally(() => {
      settle();
      resolve();
    });
  });

/**
 * The one readiness request of Studio's visible record readers for a saved revision. It waits for
 * the move a save started; when nothing is moving the preview (the builder's first preview, one
 * about to expire, or one a failed move left behind) it prepares the preview itself, under this
 * request's demand, so leaving the last reader cancels what has not started. Record reads
 * themselves never prepare or move a preview.
 */
export const prepareStudioPreview = async (
  session: IdentitySession,
  candidateOrganizationId: string,
  candidate: unknown,
  signal?: AbortSignal,
): Promise<StudioPreviewReadiness> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success)
    return { kind: "refused", reason: "invalid_request" };
  const { rootId, draftRevision } = request.data;
  const read = () => readStudioPreviewState(session, organization.data, rootId, draftRevision);
  const ready = (draft: StoredApplicationDefinitionDraft): StudioPreviewReadiness => ({
    kind: "ready",
    draftRevision: draft.draftRevision,
    previewShape: studioPreviewShapeFingerprint(draft.source),
  });
  const state = await read();
  signal?.throwIfAborted();
  if (state.kind !== "read") return state;
  const runs = studioPreviewRunsDraft(state.draft, state.preview);
  if (runs === "ready") return ready(state.draft);
  if (runs === "newer") return { kind: "conflict" };
  const moving = scheduled.get(moveKeyOf(session, organization.data, rootId));
  if (moving !== undefined) {
    await waitFor(moving.idle, signal);
    const again = await read();
    signal?.throwIfAborted();
    if (again.kind !== "read") return again;
    const now = studioPreviewRunsDraft(again.draft, again.preview);
    return now === "ready"
      ? ready(again.draft)
      : now === "newer"
        ? { kind: "conflict" }
        : { kind: "following" };
  }
  const prepared = await currentStudioPreview(
    session,
    organization.data,
    state.draft,
    state.preview,
    "prepare",
    signal,
  );
  return prepared.kind === "available" ? ready(state.draft) : prepared;
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
