import "server-only";

import {
  previewApplicationIdentitySchema,
  previewInstallationSchema,
  type PreviewApplicationIdentity,
  type PreviewInstallation,
  type PreviewInstallationCreateRequest,
} from "../schema";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/index";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";
import type { RehearsedPreviewRelease } from "./application-publication";

export const previewInstallationRepositoryErrorCodes = [
  "INVALID_PREVIEW_INSTALLATION_COMMAND",
  "PREVIEW_INSTALLATION_NOT_FOUND",
  "PREVIEW_INSTALLATION_STALE",
  "PREVIEW_INSTALLATION_AUTHORITY_REFUSED",
  "PREVIEW_INSTALLATION_FAILED",
] as const;

export type PreviewInstallationRepositoryErrorCode =
  (typeof previewInstallationRepositoryErrorCodes)[number];

type PreviewRow = DatabaseRow & { readonly preview_installation: unknown };
type IdentityRow = DatabaseRow & { readonly preview_identity: unknown };
type SeedRow = DatabaseRow & { readonly seeded: unknown };

/** A new preview, and whether its builder reads live records it can be seeded with. */
export type CreatedPreviewInstallation = Readonly<{
  installation: PreviewInstallation;
  seedable: boolean;
}>;

export type PreviewInstallationRepository = Readonly<{
  /** In the organisation's context: the preview, its registration and its empty storage. */
  create(
    request: PreviewInstallationCreateRequest,
    releases: readonly RehearsedPreviewRelease[],
  ): Promise<CreatedPreviewInstallation>;
  /**
   * In the installed Application's own context: seeds the preview with the live records, and
   * only the fields of them, that its builder reads there.
   */
  seed(previewInstallationId: string): Promise<void>;
  readApplicationIdentity(
    previewInstallationId: string,
  ): Promise<PreviewApplicationIdentity | undefined>;
}>;

const mapFailure = (error: unknown): DefinitionError<PreviewInstallationRepositoryErrorCode> => {
  if (error instanceof DefinitionError) return error;
  switch (classifyDatabaseError(error)) {
    case "invalid":
      return new DefinitionError("INVALID_PREVIEW_INSTALLATION_COMMAND", { cause: error });
    case "refused":
      return new DefinitionError("PREVIEW_INSTALLATION_AUTHORITY_REFUSED", { cause: error });
    case "not_found":
      return new DefinitionError("PREVIEW_INSTALLATION_NOT_FOUND", { cause: error });
    case "conflict":
    case "constraint_failed":
      return new DefinitionError("PREVIEW_INSTALLATION_STALE", { cause: error });
    default:
      return unexpectedDefinitionFailure(
        "PREVIEW_INSTALLATION_FAILED",
        error,
        "preview-installation-repository",
      );
  }
};

/** Request-scoped adapter for the preview ledger and its isolated storage. */
export const createPreviewInstallationRepository = (
  transaction: RequestDatabaseTransaction,
): PreviewInstallationRepository =>
  Object.freeze({
    async create(request, releases) {
      try {
        const rows = await transaction.query<PreviewRow>`
          select vortex_definition.create_preview_installation(
            ${request.applicationRootId}::uuid,
            ${request.expectedDraftRevision}::bigint,
            ${JSON.stringify(releases)}::text::jsonb
          ) as preview_installation
        `;
        const value = rows.length === 1 ? rows[0]?.preview_installation : undefined;
        const { seedable, ...installation } =
          typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
        const parsed = previewInstallationSchema.safeParse(installation);
        if (!parsed.success || typeof seedable !== "boolean")
          throw unexpectedDefinitionFailure(
            "PREVIEW_INSTALLATION_FAILED",
            parsed.error ?? new Error("Preview seed availability is missing"),
            "preview-installation-repository",
          );
        return { installation: parsed.data, seedable };
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async seed(previewInstallationId) {
      try {
        const rows = await transaction.query<SeedRow>`
          select vortex_definition.seed_preview_installation(
            ${previewInstallationId}::uuid
          ) as seeded
        `;
        if (rows.length !== 1 || rows[0]?.seeded === null || rows[0]?.seeded === undefined)
          throw new DefinitionError("PREVIEW_INSTALLATION_FAILED");
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async readApplicationIdentity(previewInstallationId) {
      try {
        const rows = await transaction.query<IdentityRow>`
          select vortex_definition.read_preview_application_identity(
            ${previewInstallationId}::uuid
          ) as preview_identity
        `;
        if (rows.length !== 1) throw new DefinitionError("PREVIEW_INSTALLATION_FAILED");
        const value = rows[0]?.preview_identity;
        if (value === null || value === undefined) return undefined;
        const parsed = previewApplicationIdentitySchema.safeParse(value);
        if (!parsed.success)
          throw unexpectedDefinitionFailure(
            "PREVIEW_INSTALLATION_FAILED",
            parsed.error,
            "preview-installation-repository",
          );
        return parsed.data;
      } catch (error) {
        throw mapFailure(error);
      }
    },
  });
