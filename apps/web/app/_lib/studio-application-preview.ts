import "server-only";

import {
  BuilderAuthorityError,
  createBuilderAuthority,
  createDatabaseDefinitionPublicationService,
  createPreviewInstallationCoordinator,
  createPreviewInstallationRepository,
  DefinitionError,
  dropRetiredPreviewStorage,
  fingerprintCanonicalValue,
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
} from "@vortex/platform/schema";
import { z } from "zod";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { humanOrganizationRequests } from "./server-composition";
import { platformPermissionSource } from "./platform-permission-source";
import { loadOrganizationLauncher } from "./organization-context";
import { organizationAddressPath } from "./address-paths";
import { studioDraftTargetFacts } from "./studio-application-draft";

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
      /**
       * It still runs an older saved revision whose records, queries or access differ from this
       * one's; it is moving to this revision in the background, so read again shortly.
       */
      behind: boolean;
    }>
  | PreviewFailure;

/** The saved draft at one revision and the builder's current preview of its Application. */
export type StudioPreviewState =
  | Readonly<{ kind: "read"; draft: StoredApplicationDefinitionDraft; preview: BuilderPreviewInstallation | undefined }>
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
 * The parts of a saved Application draft a preview's records, queries and access depend on. A
 * draft edit that leaves them as they are is presentation only (pages, layouts, the menu, the
 * theme, names and blocks), so the preview's data and access are still the draft's.
 */
const presentationKeys: ReadonlySet<string> = new Set([
  "name", "description", "icon", "home_page", "navigation", "shells", "pages", "theme", "platform_block_dependencies",
]);
export const studioPreviewShapeFingerprint = (source: StoredApplicationDefinitionDraft["source"]): string =>
  fingerprintCanonicalValue({ key: source.key,
    body: Object.fromEntries(Object.entries(source.body).filter(([key]) => !presentationKeys.has(key))) });

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
    const inApplication = await readPreviewStateIn(session, { organizationId, applicationRootId: rootId },
      organizationId, rootId, draftRevision);
    const read = inApplication.kind === "available" && inApplication.value.kind !== "refused" ? inApplication
      : await readPreviewStateIn(session, { organizationId }, organizationId, rootId, draftRevision);
    if (read.kind === "available") return read.value;
    return read.kind === "temporarily_unavailable" ? { kind: "temporarily_unavailable" }
      : { kind: "refused", reason: "permission_refused" };
  } catch (error) {
    if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING") return { kind: "conflict" };
    console.error(`[studio] preview state unavailable: STUDIO_PREVIEW_STATE_FAILED cause=${describeFailure(error)}`);
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
    humanOrganizationRequests().run(session, selection,
      async (transaction, scope) => {
        const authority = createBuilderAuthority({ transaction, scope, targetFacts: studioDraftTargetFacts,
          permissions: platformPermissionSource });
        try {
          await requireBuilderAuthority(authority, { kind: "draft_change", rootId });
        } catch (error) {
          if (error instanceof BuilderAuthorityError) return { kind: "refused", reason: "permission_refused" } as const;
          throw error;
        }
        const draft = await readApplicationDefinitionDraft(transaction, scope,
          { rootId, expectedDraftRevision: draftRevision });
        const preview = await createPreviewInstallationRepository(transaction).readBuilderPreview(rootId);
        if (preview !== undefined && (!sameId(preview.applicationRootId, rootId) || !sameId(preview.organizationId, organizationId)))
          throw new Error("STUDIO_PREVIEW_LOOKUP_MISMATCH");
        return { kind: "read", draft, preview } as const;
      });

/** A preview reused for a new read keeps at least this long, so it does not expire while Studio reads it. */
const reuseMarginMs = 60 * 60 * 1000;

const available = (preview: Readonly<{ previewInstallationId: string; organizationId: string; draftRevision: number;
  expiresAt: string }>, reconcileDue: boolean, behind = false): StudioPreviewResult => ({
  kind: "available", previewInstallationId: preview.previewInstallationId, organizationId: preview.organizationId,
  draftRevision: preview.draftRevision, expiresAt: preview.expiresAt, reconcileDue, behind,
});

/**
 * Provisionings and refreshes in flight, by builder, Application and draft revision. Studio's
 * canvas areas and Data tab ask for the same preview together; one operation serves them all. It
 * holds only the pending operation, never an access decision: every read in the preview is still
 * decided by the database for the requesting builder.
 */
const pending = new Map<string, Promise<StudioPreviewResult>>();

const once = (key: string, run: () => Promise<StudioPreviewResult>): Promise<StudioPreviewResult> => {
  const running = pending.get(key);
  if (running !== undefined) return running;
  const started = run().finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
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
const provision = (target: Target): Promise<StudioPreviewResult> =>
  once(`${keyOf(target)}|create`, () => coordinator()
    .create(target.session, { organizationId: target.organizationId, applicationRootId: target.rootId,
      expectedDraftRevision: target.draftRevision, shapeFingerprint: target.shapeFingerprint })
    .then((preview) => {
      // Retired storage is dropped in short background transactions after provisioning commits.
      void dropRetiredPreviewStorage().catch((error: unknown) => {
        console.error("[studio] retired preview storage drop failed", error);
      });
      return available(preview, false);
    }, failure));

/**
 * The builder's preview moved to the draft in place, keeping its records; a new one only when
 * its records cannot take the draft's change.
 */
const follow = (target: Target, previewInstallationId: string): Promise<StudioPreviewResult> =>
  once(`${keyOf(target)}|follow`, () => coordinator()
    .refresh(target.session, { organizationId: target.organizationId, applicationRootId: target.rootId,
      previewInstallationId, expectedDraftRevision: target.draftRevision, shapeFingerprint: target.shapeFingerprint })
    .then((preview) => available(preview, false), (error: unknown) =>
      error instanceof DefinitionError && error.code === "PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE"
        ? provision(target) : failure(error)));

/**
 * Reads never wait for the preview to move: after a data-shape edit it moves to the draft in the
 * background after a short pause, so a burst of saves moves it once, to the newest revision, and
 * reads meanwhile run on the preview as it is until the move commits.
 */
const scheduled = new Map<string, Readonly<{ timer: ReturnType<typeof setTimeout>; draftRevision: number }>>();
const followLater = (target: Target, previewInstallationId: string, pauseMs: number): void => {
  const key = `${target.session.identityId}|${target.organizationId}|${target.rootId}`.toLowerCase();
  const waiting = scheduled.get(key);
  if (waiting !== undefined && waiting.draftRevision >= target.draftRevision) return;
  if (waiting !== undefined) clearTimeout(waiting.timer);
  const timer = setTimeout(() => {
    scheduled.delete(key);
    void follow(target, previewInstallationId).then((result) => {
      // A newer save already moved the draft on; its own read follows it.
      if (result.kind !== "available" && result.kind !== "conflict")
        console.error(`[studio] the preview did not follow the draft: STUDIO_PREVIEW_FOLLOW_${result.kind.toUpperCase()}`);
    });
  }, pauseMs);
  scheduled.set(key, { timer, draftRevision: target.draftRevision });
};

/**
 * The builder's one preview for the saved draft at this revision:
 * - their current preview, when it runs this revision;
 * - for a read, their current preview as it is: after a presentation-only edit it already has the
 *   draft's records, queries and access; after a data-shape edit it moves to this revision in the
 *   background, keeping its records, and is `behind` until then;
 * - for opening it, their current preview moved to this revision in place first, its pages too;
 * - and a new preview when they have none or its records cannot take the change.
 * Studio's canvas, its Data tab and its Preview button all run on this one preview.
 */
export const currentStudioPreview = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: StoredApplicationDefinitionDraft,
  preview: BuilderPreviewInstallation | undefined,
  purpose: "read" | "open",
): Promise<StudioPreviewResult> => {
  const target: Target = { session, organizationId, rootId: draft.rootId as ApplicationRootId,
    draftRevision: draft.draftRevision, shapeFingerprint: studioPreviewShapeFingerprint(draft.source) };
  if (preview === undefined) return provision(target);
  // A preview of a newer saved revision means this request's draft revision is no longer current.
  if (preview.draftRevision > draft.draftRevision) return { kind: "conflict" };
  const lasting = Date.parse(preview.expiresAt) - Date.now() > reuseMarginMs;
  if (lasting && preview.draftRevision === draft.draftRevision) return available(preview, preview.reconcileDue);
  if (purpose === "read") {
    // A presentation-only edit leaves the preview's records, queries and access the draft's: its
    // pages follow when the preview is opened. Moving it means rehearsing a publication, whose
    // transaction holds the organisation's access lock, so it is not repeated for every such save.
    if (preview.shapeFingerprint === target.shapeFingerprint) return available(preview, preview.reconcileDue);
    followLater(target, preview.previewInstallationId, 1000);
    return available(preview, preview.reconcileDue, true);
  }
  const followed = await follow(target, preview.previewInstallationId);
  // A followed preview keeps its copied records, which are due to be decided again as before.
  return followed.kind === "available" && sameId(followed.previewInstallationId, preview.previewInstallationId)
    ? { ...followed, reconcileDue: preview.reconcileDue } : followed;
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
  const state = await readStudioPreviewState(session, organization.data, request.data.rootId, request.data.draftRevision);
  if (state.kind !== "read") return state;
  const preview = await currentStudioPreview(session, organization.data, state.draft, state.preview, "open");
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
