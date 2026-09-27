import "server-only";

import {
  previewInstallationCandidateSchema,
  previewInstallationDiscardResultSchema,
  previewInstallationExpiryResultSchema,
  previewInstallationSchema,
  type PreviewInstallation,
  type PreviewInstallationAddress,
  type PreviewInstallationCandidate,
  type PreviewInstallationCreateRequest,
  type PreviewInstallationDiscardResult,
  type PreviewInstallationExpiryRequest,
  type PreviewInstallationExpiryResult,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";

export const previewInstallationRepositoryErrorCodes = [
  "INVALID_PREVIEW_INSTALLATION_COMMAND",
  "PREVIEW_INSTALLATION_NOT_FOUND",
  "PREVIEW_INSTALLATION_STALE",
  "PREVIEW_INSTALLATION_AUTHORITY_REFUSED",
  "PREVIEW_INSTALLATION_FAILED",
] as const;

export type PreviewInstallationRepositoryErrorCode =
  (typeof previewInstallationRepositoryErrorCodes)[number];

export class PreviewInstallationRepositoryError extends Error {
  readonly code: PreviewInstallationRepositoryErrorCode;

  constructor(code: PreviewInstallationRepositoryErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "PreviewInstallationRepositoryError";
    this.code = code;
  }
}

type PreviewRow = DatabaseRow & { readonly preview_installation: unknown };
type ExpiryRow = DatabaseRow & { readonly expired_count: unknown };

export type PreviewInstallationRepository = Readonly<{
  create(
    request: PreviewInstallationCreateRequest,
    candidate: PreviewInstallationCandidate,
  ): Promise<PreviewInstallation>;
  read(address: PreviewInstallationAddress): Promise<PreviewInstallation | undefined>;
  discard(address: PreviewInstallationAddress): Promise<PreviewInstallationDiscardResult>;
  expire(request: PreviewInstallationExpiryRequest): Promise<PreviewInstallationExpiryResult>;
}>;

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): PreviewInstallationRepositoryError => {
  if (error instanceof PreviewInstallationRepositoryError) return error;
  switch (databaseCode(error)) {
    case "22023":
      return new PreviewInstallationRepositoryError("INVALID_PREVIEW_INSTALLATION_COMMAND", {
        cause: error,
      });
    case "42501":
      return new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_AUTHORITY_REFUSED", {
        cause: error,
      });
    case "P0002":
      return new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_NOT_FOUND", {
        cause: error,
      });
    case "40001":
    case "23514":
      return new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_STALE", {
        cause: error,
      });
    default:
      return new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED", {
        cause: error,
      });
  }
};

const parsePreviewRow = (row: PreviewRow | undefined): PreviewInstallation | undefined => {
  if (row === undefined || row.preview_installation === null) return undefined;
  const parsed = previewInstallationSchema.safeParse(row.preview_installation);
  if (!parsed.success)
    throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
  return parsed.data;
};

const parseSafeCount = (candidate: unknown): number | undefined => {
  const value =
    typeof candidate === "number"
      ? candidate
      : typeof candidate === "string" && /^(0|[1-9][0-9]*)$/.test(candidate)
        ? Number(candidate)
        : undefined;
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined;
};

/** Request-scoped adapter for preview-only ledger and isolated-storage functions. */
export const createPreviewInstallationRepository = (
  transaction: RequestDatabaseTransaction,
): PreviewInstallationRepository =>
  Object.freeze({
    async create(requestCandidate, candidateValue) {
      const candidate = previewInstallationCandidateSchema.safeParse(candidateValue);
      if (!candidate.success)
        throw new PreviewInstallationRepositoryError("INVALID_PREVIEW_INSTALLATION_COMMAND");
      try {
        const rows = await transaction.query<PreviewRow>`
          select vortex_module.create_preview_installation(
            ${requestCandidate.applicationRootId}::uuid,
            ${requestCandidate.expectedDraftRevision}::bigint,
            ${JSON.stringify(candidate.data)}::text::jsonb
          ) as preview_installation
        `;
        if (rows.length !== 1) throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
        const result = parsePreviewRow(rows[0]);
        if (result === undefined) throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
        return result;
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async read(address) {
      try {
        const rows = await transaction.query<PreviewRow>`
          select vortex_module.read_preview_installation(
            ${address.previewInstallationId}::uuid
          ) as preview_installation
        `;
        if (rows.length !== 1) throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
        return parsePreviewRow(rows[0]);
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async discard(address) {
      try {
        const rows = await transaction.query<PreviewRow>`
          select vortex_module.discard_preview_installation(
            ${address.previewInstallationId}::uuid
          ) as preview_installation
        `;
        if (rows.length !== 1) throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
        const parsed = previewInstallationDiscardResultSchema.safeParse(
          rows[0]?.preview_installation,
        );
        if (!parsed.success) throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
        return parsed.data;
      } catch (error) {
        throw mapFailure(error);
      }
    },

    async expire(requestCandidate) {
      const rows = await transaction.query<ExpiryRow>`
        select vortex_module.expire_preview_installations(
          ${requestCandidate.limit ?? 100}::integer
        ) as expired_count
      `.catch((error: unknown) => {
        throw mapFailure(error);
      });
      const count = rows.length === 1 ? parseSafeCount(rows[0]?.expired_count) : undefined;
      const parsed = previewInstallationExpiryResultSchema.safeParse({ expiredCount: count });
      if (!parsed.success) throw new PreviewInstallationRepositoryError("PREVIEW_INSTALLATION_FAILED");
      return parsed.data;
    },
  });
