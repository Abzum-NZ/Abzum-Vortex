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
  | Readonly<{ kind: "preparation_failed"; code: string }>
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
  return { kind: "preparation_failed", code: code ?? "STUDIO_PREVIEW_PREPARATION_FAILED" };
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

type Target = Readonly<{
  session: IdentitySession;
  organizationId: OrganizationId;
  rootId: ApplicationRootId;
  draftRevision: number;
  shapeFingerprint: string;
}>;

/** A new preview of the draft, replacing the builder's previous one and its records. */
const provision = (target: Target): Promise<StudioPreviewResult> =>
  coordinator()
    .create(target.session, { organizationId: target.organizationId, applicationRootId: target.rootId,
      expectedDraftRevision: target.draftRevision, shapeFingerprint: target.shapeFingerprint })
    .then((preview) => {
      // Retired storage is dropped in short background transactions after provisioning commits.
      void dropRetiredPreviewStorage().catch((error: unknown) => {
        console.error("[studio] retired preview storage drop failed", error);
      });
      return available(preview, false);
    }, failure);

/**
 * The builder's preview moved to the draft in place, keeping its records; a new one only when
 * its records cannot take the draft's change.
 */
const follow = (target: Target, previewInstallationId: string): Promise<StudioPreviewResult> =>
  coordinator()
    .refresh(target.session, { organizationId: target.organizationId, applicationRootId: target.rootId,
      previewInstallationId, expectedDraftRevision: target.draftRevision, shapeFingerprint: target.shapeFingerprint })
    .then((preview) => available(preview, false), (error: unknown) =>
      error instanceof DefinitionError && error.code === "PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE"
        ? provision(target) : failure(error));

/** Explicit preparation only: reads never create, follow, renew or reconcile a preview. */
export const currentStudioPreview = async (
  session: IdentitySession,
  organizationId: OrganizationId,
  draft: StoredApplicationDefinitionDraft,
  preview: BuilderPreviewInstallation | undefined,
): Promise<StudioPreviewResult> => {
  const target: Target = { session, organizationId, rootId: draft.rootId as ApplicationRootId,
    draftRevision: draft.draftRevision, shapeFingerprint: draft.sourceFingerprint };
  if (preview === undefined) return provision(target);
  // A preview of a newer saved revision means this request's draft revision is no longer current.
  if (preview.draftRevision > draft.draftRevision) return { kind: "conflict" };
  const lasting = Date.parse(preview.expiresAt) - Date.now() > reuseMarginMs;
  if (lasting && preview.draftRevision === draft.draftRevision) return available(preview, preview.reconcileDue);
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
const prepareCurrentPreview = async (
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
  const preview = await currentStudioPreview(session, organization.data, state.draft, state.preview);
  if (preview.kind !== "available") return preview;
  if (preview.reconcileDue) {
    const reconciled = await humanOrganizationRequests().runChange(session,
      { organizationId: organization.data, applicationRootId: request.data.rootId }, async (transaction) => {
        await createPreviewInstallationRepository(transaction).reconcile(preview.previewInstallationId);
        return true;
      });
    if (reconciled.kind !== "available") return reconciled.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" } : { kind: "refused", reason: "permission_refused" };
  }
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

export type StudioPreviewStatus =
  | Readonly<{ kind: "ready"; draftRevision: number; sourceFingerprint: string }>
  | Readonly<{ kind: "preparing" }>
  | PreviewFailure;

export const readStudioPreviewStatus = async (
  session: IdentitySession, candidateOrganizationId: string, candidate: unknown,
): Promise<StudioPreviewStatus> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success) return { kind: "refused", reason: "invalid_request" };
  const state = await readStudioPreviewState(session, organization.data, request.data.rootId, request.data.draftRevision);
  if (state.kind !== "read") return state;
  const preview = state.preview;
  if (preview === undefined || preview.draftRevision !== request.data.draftRevision || preview.reconcileDue ||
    Date.parse(preview.expiresAt) - Date.now() <= reuseMarginMs) return { kind: "preparing" };
  return { kind: "ready", draftRevision: state.draft.draftRevision, sourceFingerprint: state.draft.sourceFingerprint };
};

type Preparation = {
  revision: number;
  run: () => Promise<StudioApplicationPreviewResult>;
  promise: Promise<StudioApplicationPreviewResult>;
  resolve: (result: StudioApplicationPreviewResult) => void;
};
type PreparationQueue = { active: Preparation; next?: Preparation };
// Pending work only, never retained results or access decisions. One active and one newest waiting
// revision per builder/Application. Transactions finish even if their browser disconnects.
const preparations = new Map<string, PreparationQueue>();

export const provisionStudioApplicationPreview = async (
  session: IdentitySession, candidateOrganizationId: string, candidate: unknown,
): Promise<StudioApplicationPreviewResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const request = previewRequestSchema.safeParse(candidate);
  if (!organization.success || !request.success) return { kind: "refused", reason: "invalid_request" };
  const key = `${session.identityId}|${organization.data}|${request.data.rootId}`.toLowerCase();
  let queue = preparations.get(key);
  if (queue !== undefined) {
    // Joining work still checks this caller's current authority. A new operation checks it in
    // prepareCurrentPreview, avoiding a duplicate full saved-source read for the usual case.
    const authorized = await readStudioPreviewState(session, organization.data, request.data.rootId, request.data.draftRevision);
    if (authorized.kind !== "read") return authorized;
    queue = preparations.get(key);
  }
  const revision = request.data.draftRevision;
  if (queue !== undefined) {
    if (queue.active.revision === revision) return queue.active.promise;
    if (queue.active.revision > revision || (queue.next !== undefined && queue.next.revision > revision)) return { kind: "conflict" };
    if (queue.next?.revision === revision) return queue.next.promise;
  }
  let resolve!: Preparation["resolve"];
  const promise = new Promise<StudioApplicationPreviewResult>((done) => { resolve = done; });
  const job: Preparation = { revision, promise, resolve,
    run: () => prepareCurrentPreview(session, organization.data, request.data) };
  if (queue !== undefined) {
    queue.next?.resolve({ kind: "conflict" });
    queue.next = job;
    return promise;
  }
  const started: PreparationQueue = { active: job };
  preparations.set(key, started);
  void (async () => {
    for (;;) {
      const current = started.active;
      try { current.resolve(await current.run()); }
      catch (error) { current.resolve(failure(error)); }
      if (started.next === undefined) { preparations.delete(key); return; }
      started.active = started.next;
      delete started.next;
    }
  })();
  return promise;
};
