import "server-only";

import {
  builderPreviewInstallationSchema,
  previewApplicationIdentitySchema,
  previewInstallationSchema,
  previewSeedResultSchema,
  type BuilderPreviewInstallation,
  type PreviewApplicationIdentity,
  type PreviewDemand,
  type PreviewInstallation,
  type PreviewInstallationCreateRequest,
  type PreviewInstallationRefreshRequest,
  type PreviewSeedResult,
} from "./preview-installation-contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import {
  DefinitionError,
  classifyDatabaseError,
  databaseErrorCode,
  unexpectedDefinitionFailure,
} from "./definition-error";
import type { PreviewReleasePlan } from "./preview-release-plan";

export const previewInstallationRepositoryErrorCodes = [
  "INVALID_PREVIEW_INSTALLATION_COMMAND",
  "PREVIEW_INSTALLATION_NOT_FOUND",
  "PREVIEW_INSTALLATION_STALE",
  "PREVIEW_INSTALLATION_AUTHORITY_REFUSED",
  "PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE",
  "PREVIEW_INSTALLATION_FAILED",
] as const;

export type PreviewInstallationRepositoryErrorCode =
  (typeof previewInstallationRepositoryErrorCodes)[number];

type PreviewRow = DatabaseRow & { readonly preview_installation: unknown };
type IdentityRow = DatabaseRow & { readonly preview_identity: unknown };
type SeedRow = DatabaseRow & { readonly seeded: unknown };

const mapFailure = (error: unknown): DefinitionError<PreviewInstallationRepositoryErrorCode> => {
  if (error instanceof DefinitionError) return error;
  // The preview's records cannot take the draft's change; a new preview is provisioned instead.
  if (databaseErrorCode(error) === "V3201")
    return new DefinitionError("PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE", { cause: error });
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

/** One identity row parsed by its schema, or undefined when the database returned none. */
const parsedRow = <Value>(
  rows: readonly IdentityRow[],
  schema: {
    safeParse(value: unknown): { success: true; data: Value } | { success: false; error: unknown };
  },
): Value | undefined => {
  if (rows.length !== 1) throw new DefinitionError("PREVIEW_INSTALLATION_FAILED");
  const value = rows[0]?.preview_identity;
  if (value === null || value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw unexpectedDefinitionFailure(
      "PREVIEW_INSTALLATION_FAILED",
      parsed.error,
      "preview-installation-repository",
    );
  return parsed.data;
};

/** In the organisation's context: the preview, its registration and its empty storage. */
export const createPreviewInstallation = async (
  transaction: RequestDatabaseTransaction,
  request: PreviewInstallationCreateRequest,
  releases: PreviewReleasePlan,
): Promise<PreviewInstallation> => {
  try {
    const rows = await transaction.query<PreviewRow>`
      select vortex_definition.create_preview_installation(
        ${request.applicationRootId}::uuid,
        ${request.expectedDraftRevision}::bigint,
        ${JSON.stringify(releases)}::text::jsonb,
        ${request.shapeFingerprint}::text
      ) as preview_installation
    `;
    const parsed = previewInstallationSchema.safeParse(
      rows.length === 1 ? rows[0]?.preview_installation : undefined,
    );
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
};

/**
 * In the preview's own context: moves it to the current draft revision in place, keeping the
 * records it holds. A change those records cannot take is PREVIEW_INSTALLATION_SHAPE_INCOMPATIBLE.
 */
export const refreshPreviewInstallation = async (
  transaction: RequestDatabaseTransaction,
  request: PreviewInstallationRefreshRequest,
  releases: PreviewReleasePlan,
): Promise<PreviewInstallation> => {
  try {
    const rows = await transaction.query<PreviewRow>`
      select vortex_definition.refresh_preview_installation(
        ${request.previewInstallationId}::uuid,
        ${request.expectedDraftRevision}::bigint,
        ${JSON.stringify(releases)}::text::jsonb,
        ${request.shapeFingerprint}::text
      ) as preview_installation
    `;
    const parsed = previewInstallationSchema.safeParse(
      rows.length === 1 ? rows[0]?.preview_installation : undefined,
    );
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
};

/**
 * In the installed Application's own context: seeds each record type the demand needs that the
 * preview does not hold yet with the live records, and only the fields of them, that its builder
 * reads there. The database decides what the demand needs.
 */
export const seedPreviewInstallation = async (
  transaction: RequestDatabaseTransaction,
  previewInstallationId: string,
  demand: PreviewDemand,
): Promise<PreviewSeedResult> => {
  try {
    const rows = await transaction.query<SeedRow>`
      select vortex_definition.seed_preview_installation(
        ${previewInstallationId}::uuid,
        ${JSON.stringify(demand)}::text::jsonb
      ) as seeded
    `;
    const parsed = previewSeedResultSchema.safeParse(
      rows.length === 1 ? rows[0]?.seeded : undefined,
    );
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
};

/**
 * In the installed Application's own context: decides the preview's copied records again by
 * the builder's current live access, removing what they can no longer read.
 */
export const reconcilePreviewInstallation = async (
  transaction: RequestDatabaseTransaction,
  previewInstallationId: string,
): Promise<void> => {
  try {
    const rows = await transaction.query<DatabaseRow & { readonly reconciled: unknown }>`
      select vortex_definition.reconcile_preview_installation(
        ${previewInstallationId}::uuid
      ) as reconciled
    `;
    if (rows.length !== 1 || typeof rows[0]?.reconciled !== "boolean")
      throw new DefinitionError("PREVIEW_INSTALLATION_FAILED");
  } catch (error) {
    throw mapFailure(error);
  }
};

/** The application a preview installation previews, read in the preview's context. */
export const readPreviewApplicationIdentity = async (
  transaction: RequestDatabaseTransaction,
  previewInstallationId: string,
): Promise<PreviewApplicationIdentity | undefined> => {
  try {
    return parsedRow<PreviewApplicationIdentity>(
      await transaction.query<IdentityRow>`
      select vortex_definition.read_preview_application_identity(
        ${previewInstallationId}::uuid
      ) as preview_identity
    `,
      previewApplicationIdentitySchema,
    );
  } catch (error) {
    throw mapFailure(error);
  }
};

/** In the organisation's context: this builder's current runnable preview of one Application. */
export const readBuilderPreviewInstallation = async (
  transaction: RequestDatabaseTransaction,
  applicationRootId: string,
): Promise<BuilderPreviewInstallation | undefined> => {
  try {
    return parsedRow<BuilderPreviewInstallation>(
      await transaction.query<IdentityRow>`
      select vortex_definition.read_builder_preview_installation(
        ${applicationRootId}::uuid
      ) as preview_identity
    `,
      builderPreviewInstallationSchema,
    );
  } catch (error) {
    throw mapFailure(error);
  }
};
