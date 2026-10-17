import "server-only";

import {
  BuilderAuthorityError,
  requireBuilderAuthority,
  type BuilderAuthority,
  type createHumanOrganizationRequestService,
} from "../access/index";
import {
  identitySessionSchema,
  previewInstallationCreateRequestSchema,
  previewInstallationRefreshRequestSchema,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type PreviewInstallation,
  type PreviewInstallationCreateRequest,
  type PreviewInstallationRefreshRequest,
  type SelectedOrganizationScope,
  type SessionContext,
  sameId,
} from "../schema";
import { readLiveHumanContext } from "../access/live-context";
import { createPreviewInstallationRepository } from "./module-index";
import type { RehearsedPreviewRelease } from "./application-publication";
import { writePreviewRuntimeReleaseSet } from "./preview-runtime-context";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

type InstallerRequests = Pick<
  ReturnType<typeof createHumanOrganizationRequestService>,
  "runChange"
>;

type PreviewInstallationDraftRehearsal = Readonly<{
  rehearseApplicationPreview(
    context: SessionContext,
    command: Readonly<{ rootId: string; expectedDraftRevision: number }>,
  ): Promise<readonly RehearsedPreviewRelease[]>;
}>;

const previewInstallationCoordinatorErrorCodes = [
  "INVALID_PREVIEW_INSTALLATION_COMMAND",
  "PREVIEW_INSTALLATION_REFUSED",
  "PREVIEW_INSTALLATION_PERMISSION_REFUSED",
  "PREVIEW_INSTALLATION_STALE",
  "PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE",
  "PREVIEW_INSTALLATION_TEMPORARILY_UNAVAILABLE",
  "PREVIEW_INSTALLATION_FAILED",
] as const;

type PreviewInstallationCoordinatorErrorCode =
  (typeof previewInstallationCoordinatorErrorCodes)[number];

type PreviewInstallationCoordinatorDependencies = Readonly<{
  installerRequests: InstallerRequests;
  /** The platform release catalogue the preview's release set is projected against. */
  releaseCatalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  builderAuthority(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ): BuilderAuthority;
  /**
   * Builds the Definition publication service over the same human request transaction and its
   * builder authority. It rehearses the publication of the requested draft revision.
   */
  draftRehearsal(
    transaction: RequestDatabaseTransaction,
    authority: BuilderAuthority,
  ): PreviewInstallationDraftRehearsal;
}>;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const toCoordinatorError = (
  error: unknown,
): DefinitionError<PreviewInstallationCoordinatorErrorCode> => {
  if (
    error instanceof DefinitionError &&
    (previewInstallationCoordinatorErrorCodes as readonly string[]).includes(error.code)
  )
    return error;
  if (error instanceof BuilderAuthorityError)
    return new DefinitionError("PREVIEW_INSTALLATION_PERMISSION_REFUSED", { cause: error });
  switch (errorCode(error)) {
    case "PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE":
      return new DefinitionError("PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE", { cause: error });
    case "PREVIEW_INSTALLATION_STALE":
    case "DEFINITION_DRAFT_STALE_OR_MISSING":
    case "DEFINITION_SOURCE_EVIDENCE_MISMATCH":
      return new DefinitionError("PREVIEW_INSTALLATION_STALE", { cause: error });
    // An expired or mismatched live request context is a refusal, not a preview failure.
    case "PREVIEW_INSTALLATION_AUTHORITY_REFUSED":
    case "DEFINITION_CONTEXT_REFUSED":
    case "BUILDER_PERMISSION_REFUSED":
      return new DefinitionError("PREVIEW_INSTALLATION_PERMISSION_REFUSED", { cause: error });
    case "INVALID_PREVIEW_INSTALLATION_COMMAND":
      return new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND", { cause: error });
  }
  switch (classifyDatabaseError(error)) {
    case "conflict":
    case "constraint_failed":
      return new DefinitionError("PREVIEW_INSTALLATION_STALE", { cause: error });
    case "refused":
      return new DefinitionError("PREVIEW_INSTALLATION_PERMISSION_REFUSED", { cause: error });
    default:
      return unexpectedDefinitionFailure(
        "PREVIEW_INSTALLATION_FAILED",
        error,
        "preview-installation-coordinator",
      );
  }
};

/**
 * Provisions the preview of an Application draft for the requesting builder in a series of human
 * requests, each checking the builder's authority:
 * 1. An organisation request rehearses the draft's publication, which only it may. It writes the
 *    inline Modules' drafts, as preparing a publication does, and returns the release rows the
 *    undone rehearsal wrote.
 * 2. A second organisation request creates the preview from exactly those rows. It refuses them
 *    unless the draft is still at the revision they were rehearsed from. It writes the preview's
 *    own permission registration (the draft's roles, which only this builder holds) and empty
 *    storage. The Application may not be installed yet.
 * 3. When the Application is installed, a request in its own context seeds the storage. The seed
 *    holds only the live records the builder reads there, with only the fields the builder reads.
 * 4. A request in the preview writes the release set it runs.
 * A refresh moves the builder's existing preview to the current draft revision instead:
 * 1. An organisation request rehearses the draft's publication, as above.
 * 2. One request in the preview itself replaces its releases, pins and registration, evolves its
 *    Record storage in place, keeping the records it holds, and writes the release set it runs.
 *    A change those records cannot take refuses with PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE.
 * No live installation, live registration or external service is touched.
 */
export const createPreviewInstallationCoordinator = (
  dependencies: PreviewInstallationCoordinatorDependencies,
) => {
  const builderRequest = async <Result>(
    session: IdentitySession,
    selection: OrganizationSelectionCandidate,
    rootId: string,
    operation: (
      transaction: RequestDatabaseTransaction,
      authority: BuilderAuthority,
      context: SessionContext,
    ) => Promise<Result>,
  ): Promise<Result> => {
    const captured: { failure?: DefinitionError<PreviewInstallationCoordinatorErrorCode> } = {};
    const result = await dependencies.installerRequests
      .runChange<Result>(session, selection, async (transaction, scope, issuedAt) => {
        try {
          if (
            !sameId(scope.organizationId, selection.organizationId) ||
            (selection.applicationRootId === undefined
              ? scope.applicationRootId !== undefined
              : scope.applicationRootId === undefined ||
                !sameId(scope.applicationRootId, selection.applicationRootId))
          )
            throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
          const authority = dependencies.builderAuthority(transaction, scope);
          if (!sameId(authority.organizationId, scope.organizationId))
            throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
          await requireBuilderAuthority(authority, { kind: "publication", rootId });
          const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
          return await operation(transaction, authority, context);
        } catch (error) {
          captured.failure = toCoordinatorError(error);
          throw error;
        }
      })
      .catch((error: unknown) => {
        throw captured.failure ?? toCoordinatorError(error);
      });
    if (result.kind === "available") return result.value;
    if (captured.failure !== undefined) throw captured.failure;
    throw new DefinitionError(
      result.kind === "temporarily_unavailable"
        ? "PREVIEW_INSTALLATION_TEMPORARILY_UNAVAILABLE"
        : "PREVIEW_INSTALLATION_REFUSED",
    );
  };

  return Object.freeze({
    async create(
      sessionCandidate: IdentitySession,
      requestCandidate: PreviewInstallationCreateRequest,
    ): Promise<PreviewInstallation> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const request = previewInstallationCreateRequestSchema.safeParse(requestCandidate);
      if (!session.success || !request.success)
        throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      const { organizationId, applicationRootId, expectedDraftRevision } = request.data;
      const releases = await builderRequest(
        session.data,
        { organizationId },
        applicationRootId,
        (transaction, authority, context) =>
          dependencies
            .draftRehearsal(transaction, authority)
            .rehearseApplicationPreview(context, {
              rootId: applicationRootId,
              expectedDraftRevision,
            }),
      );
      // The preview is created in the organisation's context, as its Application may not be
      // installed yet: its releases, Module pins, own permission registration and empty storage.
      const created = await builderRequest(
        session.data,
        { organizationId },
        applicationRootId,
        (transaction) =>
          createPreviewInstallationRepository(transaction).create(request.data, releases),
      );
      const { previewInstallationId } = created.installation;
      // The builder's live records are read as the builder reads them in the installed
      // Application; an Application with no installation has none to seed.
      if (created.seedable)
        await builderRequest(
          session.data,
          { organizationId, applicationRootId },
          applicationRootId,
          (transaction) => createPreviewInstallationRepository(transaction).seed(previewInstallationId),
        );
      // Last, in the preview itself: the release set it runs. A preview without it never runs.
      return builderRequest(
        session.data,
        { organizationId, applicationRootId, previewInstallationId },
        applicationRootId,
        async (transaction) => {
          await writePreviewRuntimeReleaseSet(
            transaction,
            dependencies.releaseCatalogue,
            previewInstallationId,
          );
          return created.installation;
        },
      );
    },

    async refresh(
      sessionCandidate: IdentitySession,
      requestCandidate: PreviewInstallationRefreshRequest,
    ): Promise<PreviewInstallation> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const request = previewInstallationRefreshRequestSchema.safeParse(requestCandidate);
      if (!session.success || !request.success)
        throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      const { organizationId, applicationRootId, previewInstallationId, expectedDraftRevision } =
        request.data;
      const releases = await builderRequest(
        session.data,
        { organizationId },
        applicationRootId,
        (transaction, authority, context) =>
          dependencies
            .draftRehearsal(transaction, authority)
            .rehearseApplicationPreview(context, {
              rootId: applicationRootId,
              expectedDraftRevision,
            }),
      );
      return builderRequest(
        session.data,
        { organizationId, applicationRootId, previewInstallationId },
        applicationRootId,
        async (transaction) => {
          const refreshed = await createPreviewInstallationRepository(transaction).refresh(
            request.data,
            releases,
          );
          await writePreviewRuntimeReleaseSet(
            transaction,
            dependencies.releaseCatalogue,
            previewInstallationId,
          );
          return refreshed;
        },
      );
    },
  });
};
