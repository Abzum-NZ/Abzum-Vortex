import "server-only";

import {
  BuilderAuthorityError,
  requireBuilderAuthority,
  type BuilderAuthority,
  type createHumanOrganizationRequestService,
} from "../access/index";
import {
  identitySessionSchema,
  previewInstallationAddressSchema,
  previewInstallationCandidateSchema,
  previewInstallationCreateRequestSchema,
  previewInstallationExpiryRequestSchema,
  sessionContextSchema,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
  type PreviewInstallation,
  type PreviewInstallationAddress,
  type PreviewInstallationCandidate,
  type PreviewInstallationCreateRequest,
  type PreviewInstallationDiscardResult,
  type PreviewInstallationExpiryRequest,
  type PreviewInstallationExpiryResult,
  type SelectedOrganizationScope,
  type SessionContext,
} from "../schema";
import { createPreviewInstallationRepository } from "./module-index";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import { DefinitionError, unexpectedDefinitionFailure } from "./definition-error";

type InstallerRequests = Pick<
  ReturnType<typeof createHumanOrganizationRequestService>,
  "run" | "runChange"
>;

type PreviewInstallationDraftCompiler = Readonly<{
  compileApplicationDraft(
    context: SessionContext,
    command: Readonly<{ rootId: string; expectedDraftRevision: number }>,
  ): Promise<PreviewInstallationCandidate>;
}>;

type ContextRow = DatabaseRow & { readonly request_context: unknown };

export const previewInstallationCoordinatorErrorCodes = [
  "INVALID_PREVIEW_INSTALLATION_COMMAND",
  "PREVIEW_INSTALLATION_REFUSED",
  "PREVIEW_INSTALLATION_PERMISSION_REFUSED",
  "PREVIEW_INSTALLATION_STALE",
  "PREVIEW_INSTALLATION_NOT_FOUND",
  "PREVIEW_INSTALLATION_TEMPORARILY_UNAVAILABLE",
  "PREVIEW_INSTALLATION_FAILED",
] as const;

export type PreviewInstallationCoordinatorErrorCode =
  (typeof previewInstallationCoordinatorErrorCodes)[number];

export type PreviewInstallationCoordinatorDependencies = Readonly<{
  installerRequests: InstallerRequests;
  builderAuthority(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ): BuilderAuthority;
  /**
   * Builds the Definition publication compiler over the same human request transaction and its
   * builder authority. The compiler must call compileApplicationDraft for the requested revision.
   */
  draftCompiler(
    transaction: RequestDatabaseTransaction,
    authority: BuilderAuthority,
  ): PreviewInstallationDraftCompiler;
}>;

const sameId = (left: unknown, right: string): boolean =>
  typeof left === "string" && left.toLowerCase() === right.toLowerCase();

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
    return new DefinitionError("PREVIEW_INSTALLATION_PERMISSION_REFUSED", {
      cause: error,
    });
  if (error instanceof DefinitionError) {
    switch (error.code) {
      case "INVALID_PREVIEW_INSTALLATION_COMMAND":
        return new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND", {
          cause: error,
        });
      case "PREVIEW_INSTALLATION_NOT_FOUND":
        return new DefinitionError("PREVIEW_INSTALLATION_NOT_FOUND", {
          cause: error,
        });
      case "PREVIEW_INSTALLATION_STALE":
        return new DefinitionError("PREVIEW_INSTALLATION_STALE", {
          cause: error,
        });
      case "PREVIEW_INSTALLATION_AUTHORITY_REFUSED":
        return new DefinitionError("PREVIEW_INSTALLATION_PERMISSION_REFUSED", {
          cause: error,
        });
      case "PREVIEW_INSTALLATION_FAILED":
        return new DefinitionError("PREVIEW_INSTALLATION_FAILED", {
          cause: error,
        });
    }
  }
  switch (errorCode(error)) {
    case "DEFINITION_DRAFT_STALE_OR_MISSING":
    case "DEFINITION_SOURCE_EVIDENCE_MISMATCH":
    case "40001":
    case "23514":
      return new DefinitionError("PREVIEW_INSTALLATION_STALE", {
        cause: error,
      });
    case "BUILDER_PERMISSION_REFUSED":
    case "42501":
      return new DefinitionError("PREVIEW_INSTALLATION_PERMISSION_REFUSED", {
        cause: error,
      });
    default:
      return unexpectedDefinitionFailure(
        "PREVIEW_INSTALLATION_FAILED",
        error,
        "preview-installation-coordinator",
      );
  }
};

const readHumanContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  session: IdentitySession,
): Promise<SessionContext> => {
  const rows = await transaction.query<ContextRow>`
    select vortex_access.validated_human_request_context() - 'channel' as request_context
  `;
  const parsed =
    rows.length === 1 ? sessionContextSchema.safeParse(rows[0]?.request_context) : undefined;
  if (
    parsed === undefined ||
    !parsed.success ||
    parsed.data.callerKind !== "human" ||
    !sameId(parsed.data.organizationId, scope.organizationId) ||
    !sameId(parsed.data.organizationAccountId, scope.organizationAccountId) ||
    !sameId(parsed.data.identityId, session.identityId) ||
    (scope.applicationRootId !== undefined &&
      !sameId(parsed.data.applicationRootId, scope.applicationRootId))
  )
    throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
  return parsed.data;
};

/**
 * Coordinates preview installation inside the requesting person's human transaction. No live
 * installation coordinator, permission registration or external service is invoked here.
 */
export const createPreviewInstallationCoordinator = (
  dependencies: PreviewInstallationCoordinatorDependencies,
) => {
  const runRequest = async <Result>(
    mode: "read" | "change",
    sessionCandidate: IdentitySession,
    organizationId: OrganizationId,
    applicationRootId: ApplicationRootId | undefined,
    builderRootId: string | undefined,
    operation: (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      authority: BuilderAuthority,
    ) => Promise<Result>,
  ): Promise<Result> => {
    const session = identitySessionSchema.safeParse(sessionCandidate);
    if (!session.success) throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
    const captured: { failure?: DefinitionError<PreviewInstallationCoordinatorErrorCode> } = {};
    const runner: InstallerRequests["run"] =
      mode === "change"
        ? dependencies.installerRequests.runChange
        : dependencies.installerRequests.run;
    const result = await runner(
      session.data,
      { organizationId, ...(applicationRootId === undefined ? {} : { applicationRootId }) },
      async (transaction, scope) => {
        try {
          if (
            !sameId(scope.organizationId, organizationId) ||
            (applicationRootId !== undefined &&
              !sameId(scope.applicationRootId, applicationRootId))
          )
            throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
          const authority = dependencies.builderAuthority(transaction, scope);
          if (!sameId(authority.organizationId, scope.organizationId))
            throw new DefinitionError("PREVIEW_INSTALLATION_REFUSED");
          await requireBuilderAuthority(authority, {
            kind: "draft_change",
            ...(builderRootId === undefined ? {} : { rootId: builderRootId }),
          });
          return await operation(transaction, scope, authority);
        } catch (error) {
          captured.failure = toCoordinatorError(error);
          throw error;
        }
      },
    ).catch((error: unknown) => {
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
      session: IdentitySession,
      requestCandidate: PreviewInstallationCreateRequest,
    ): Promise<PreviewInstallation> {
      const parsed = previewInstallationCreateRequestSchema.safeParse(requestCandidate);
      if (!parsed.success) throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      return runRequest(
        "change",
        session,
        parsed.data.organizationId,
        parsed.data.applicationRootId,
        parsed.data.applicationRootId,
        async (transaction, scope, authority) => {
          const context = await readHumanContext(transaction, scope, session);
          const candidateValue = await dependencies
            .draftCompiler(transaction, authority)
            .compileApplicationDraft(context, {
              rootId: parsed.data.applicationRootId,
              expectedDraftRevision: parsed.data.expectedDraftRevision,
            });
          const candidate = previewInstallationCandidateSchema.safeParse(candidateValue);
          if (!candidate.success) throw new DefinitionError("PREVIEW_INSTALLATION_FAILED");
          return createPreviewInstallationRepository(transaction).create(
            parsed.data,
            candidate.data,
          );
        },
      );
    },

    async read(
      session: IdentitySession,
      addressCandidate: PreviewInstallationAddress,
    ): Promise<PreviewInstallation> {
      const address = previewInstallationAddressSchema.safeParse(addressCandidate);
      if (!address.success) throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      return runRequest(
        "read",
        session,
        address.data.organizationId,
        address.data.applicationRootId,
        address.data.applicationRootId,
        async (transaction) => {
          const found = await createPreviewInstallationRepository(transaction).read(address.data);
          if (found === undefined) throw new DefinitionError("PREVIEW_INSTALLATION_NOT_FOUND");
          return found;
        },
      );
    },

    async discard(
      session: IdentitySession,
      addressCandidate: PreviewInstallationAddress,
    ): Promise<PreviewInstallationDiscardResult> {
      const address = previewInstallationAddressSchema.safeParse(addressCandidate);
      if (!address.success) throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      return runRequest(
        "change",
        session,
        address.data.organizationId,
        address.data.applicationRootId,
        address.data.applicationRootId,
        (transaction) => createPreviewInstallationRepository(transaction).discard(address.data),
      );
    },

    async expire(
      session: IdentitySession,
      requestCandidate: PreviewInstallationExpiryRequest,
    ): Promise<PreviewInstallationExpiryResult> {
      const request = previewInstallationExpiryRequestSchema.safeParse(requestCandidate);
      if (!request.success) throw new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      return runRequest(
        "change",
        session,
        request.data.organizationId,
        undefined,
        undefined,
        (transaction) => createPreviewInstallationRepository(transaction).expire(request.data),
      );
    },
  });
};
