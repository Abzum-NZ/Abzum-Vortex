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
  type IdentitySession,
  type PreviewInstallation,
  type PreviewInstallationCreateRequest,
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

type InstallerRequests = Pick<ReturnType<typeof createHumanOrganizationRequestService>, "runChange">;

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
 * Provisions the preview of an Application draft inside the requesting builder's human
 * transaction: the draft's publication is rehearsed, and the preview runs the releases it wrote.
 * No live installation, permission registration or external service is touched.
 */
export const createPreviewInstallationCoordinator = (
  dependencies: PreviewInstallationCoordinatorDependencies,
) =>
  Object.freeze({
    async create(
      sessionCandidate: IdentitySession,
      requestCandidate: PreviewInstallationCreateRequest,
    ): Promise<PreviewInstallation> {
      const session = identitySessionSchema.safeParse(sessionCandidate);
      const request = previewInstallationCreateRequestSchema.safeParse(requestCandidate);
      if (!session.success || !request.success)
        throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      const captured: { failure?: DefinitionError<PreviewInstallationCoordinatorErrorCode> } = {};
      const result = await dependencies.installerRequests
        .runChange(
          session.data,
          {
            organizationId: request.data.organizationId,
            applicationRootId: request.data.applicationRootId,
          },
          async (transaction, scope, issuedAt) => {
            try {
              if (
                !sameId(scope.organizationId, request.data.organizationId) ||
                scope.applicationRootId === undefined ||
                !sameId(scope.applicationRootId, request.data.applicationRootId)
              )
                throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
              const authority = dependencies.builderAuthority(transaction, scope);
              if (!sameId(authority.organizationId, scope.organizationId))
                throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
              await requireBuilderAuthority(authority, {
                kind: "publication",
                rootId: request.data.applicationRootId,
              });
              const context = await readLiveHumanContext(transaction, {
                scope,
                session: session.data,
                issuedAt,
              });
              const releases = await dependencies
                .draftRehearsal(transaction, authority)
                .rehearseApplicationPreview(context, {
                  rootId: request.data.applicationRootId,
                  expectedDraftRevision: request.data.expectedDraftRevision,
                });
              const preview = await createPreviewInstallationRepository(transaction).create(
                request.data,
                releases,
              );
              await writePreviewRuntimeReleaseSet(
                transaction,
                dependencies.releaseCatalogue,
                preview.previewInstallationId,
              );
              return preview;
            } catch (error) {
              captured.failure = toCoordinatorError(error);
              throw error;
            }
          },
        )
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
    },
  });
