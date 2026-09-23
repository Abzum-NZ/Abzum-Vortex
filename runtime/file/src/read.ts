import "server-only";

import { randomUUID } from "node:crypto";
import {
  PRIVATE_FILE_BUCKET,
  correlationIdSchema,
  downloadGrantSchema,
  fileIdSchema,
  fileRecordSchema,
  platformIdSchema,
  type CorrelationId,
  type FieldId,
  type FileId,
  type FileRecord,
  type OrganizationId,
  type PlatformId,
  type RecordId,
  type RecordTypeId,
  type SessionContext,
  type VerifiedFileActor,
} from "@vortex/contracts";
import {
  isExecutableContent,
  normalizeFileExtension,
} from "./content-safety";
import {
  sanitizeFileDisplayName,
  transitionFileLifecycleState,
} from "./file-metadata";
import {
  resolveVerifiedFileActor,
  verifyAttachmentFieldAuthority,
} from "./attachment-authority";
import type {
  ResolveCurrentStorageAuthority,
  StorageCredentialBridge,
} from "./storage-credentials";

/** Closed refusal reasons for file read, download, range, and preview operations. */
export type FileReadRefusalReason =
  | "unauthenticated"
  | "caller_not_authorized"
  | "file_not_found"
  | "field_not_readable"
  | "owner_mismatch"
  | "invalid_lifecycle_state"
  | "safety_check_failed"
  | "grant_expired"
  | "grant_revoked"
  | "range_not_satisfiable"
  | "malformed_request"
  | "storage_unavailable"
  | "preview_unavailable";

/** Canonical HTTP status mapping for closed refusal reasons. */
export const fileReadRefusalHttpStatus: Readonly<Record<FileReadRefusalReason, number>> =
  Object.freeze({
    unauthenticated: 401,
    caller_not_authorized: 403,
    file_not_found: 404,
    field_not_readable: 403,
    owner_mismatch: 403,
    invalid_lifecycle_state: 410,
    safety_check_failed: 403,
    grant_expired: 403,
    grant_revoked: 403,
    range_not_satisfiable: 416,
    malformed_request: 400,
    storage_unavailable: 503,
    preview_unavailable: 503,
  });

export type FileReadPurpose = "download" | "preview";

/**
 * Access-verified grant for reading an attachment on a shared record.
 * A record-sharing grant does not automatically grant file access: the grant must
 * explicitly name the attachment field as readable. Source files remain source-owned,
 * and every request rechecks source record, grant, field, recipient account and application.
 */
export type SharedRecordFileGrant = Readonly<{
  grantId: PlatformId;
  sourceOrganizationId: OrganizationId;
  sourceRecordTypeId: RecordTypeId;
  sourceRecordId: RecordId;
  recipientOrganizationId: OrganizationId;
  readableFieldIds: readonly FieldId[];
  expiresAt: string;
  revoked?: boolean;
}>;

/**
 * The current record and field viewer authority for the request. Every request,
 * including ranges and previews, must supply fresh authority resolved by trusted server wiring.
 */
export type CurrentReadAuthority = Readonly<{
  sessionContext: SessionContext;
  readableFieldIds: readonly FieldId[];
  organizationId: OrganizationId;
  recordTypeId: RecordTypeId;
  recordId: RecordId;
  fieldId: FieldId;
  sharedRecordGrant?: SharedRecordFileGrant;
}>;

export type FileReadRequest = Readonly<{
  fileId: FileId;
  purpose: FileReadPurpose;
  rangeHeader?: string;
  ifNoneMatch?: string;
}>;

export type ParsedByteRange = Readonly<{
  start: number;
  end: number;
}>;

export type RangeParseResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "satisfiable"; range: ParsedByteRange }>
  | Readonly<{ kind: "unsatisfiable" }>;

/**
 * Parses and validates standard HTTP range request headers according to RFC 9110.
 * Multi-range requests are not accepted. Unsatisfiable ranges return kind "unsatisfiable".
 */
export const parseRangeHeader = (
  rangeHeader: string | undefined,
  totalBytes: number,
): RangeParseResult => {
  if (rangeHeader === undefined || rangeHeader.trim() === "") {
    return { kind: "none" };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) {
    if (!rangeHeader.trim().toLowerCase().startsWith("bytes=")) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "none" };
  }

  const [, startStr, endStr] = match;
  if (startStr === "" && endStr === "") {
    return { kind: "unsatisfiable" };
  }

  let start: number;
  let end: number;

  if (startStr === "") {
    const suffixLength = parseInt(endStr, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" };
    }
    if (totalBytes === 0) {
      return { kind: "unsatisfiable" };
    }
    start = Math.max(0, totalBytes - suffixLength);
    end = totalBytes - 1;
  } else if (endStr === "") {
    start = parseInt(startStr, 10);
    if (!Number.isSafeInteger(start) || start < 0) {
      return { kind: "unsatisfiable" };
    }
    if (totalBytes === 0 || start >= totalBytes) {
      return { kind: "unsatisfiable" };
    }
    end = totalBytes - 1;
  } else {
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end
    ) {
      return { kind: "unsatisfiable" };
    }
    if (totalBytes === 0 || start >= totalBytes) {
      return { kind: "unsatisfiable" };
    }
    end = Math.min(end, totalBytes - 1);
  }

  return { kind: "satisfiable", range: { start, end } };
};

/**
 * Browser-executable or active content types that must never be served inline
 * to a browser. This includes HTML, SVG, script formats, executables, etc.
 */
export const isExecutableOrActiveBrowserContent = (
  mediaType: string,
  extension: string,
): boolean => {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = normalizeFileExtension(extension);

  if (isExecutableContent(mediaType, ext)) return true;

  const activeBrowserTypes = [
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/xml",
    "application/xml",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "text/ecmascript",
    "application/hta",
    "application/x-shockwave-flash",
  ];

  if (activeBrowserTypes.includes(normalized)) return true;
  if (
    ext === ".html" ||
    ext === ".htm" ||
    ext === ".svg" ||
    ext === ".xhtml" ||
    ext === ".xml"
  ) {
    return true;
  }

  return false;
};

/**
 * Resolves safe content disposition and media type.
 * Where browser display could execute content, disposition is forced to "attachment"
 * and safe media type "application/octet-stream".
 */
export const resolveSafeContentDisposition = (
  fileRecord: FileRecord,
  purpose: FileReadPurpose,
): Readonly<{
  disposition: "attachment" | "inline";
  contentDispositionHeader: string;
  safeMediaType: string;
}> => {
  const isExecutable = isExecutableOrActiveBrowserContent(
    fileRecord.detectedMediaType,
    fileRecord.extension,
  );

  const safeFilename = sanitizeFileDisplayName(
    fileRecord.originalSafeDisplayName,
    fileRecord.extension,
  );
  const encodedFilename = encodeURIComponent(safeFilename);

  if (isExecutable) {
    return Object.freeze({
      disposition: "attachment",
      contentDispositionHeader: `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
      safeMediaType: "application/octet-stream",
    });
  }

  if (purpose === "preview") {
    return Object.freeze({
      disposition: "inline",
      contentDispositionHeader: `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
      safeMediaType: fileRecord.detectedMediaType,
    });
  }

  return Object.freeze({
    disposition: "attachment",
    contentDispositionHeader: `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
    safeMediaType: fileRecord.detectedMediaType,
  });
};

export type ClaimedDownloadGrant = Readonly<{
  grant: ReturnType<typeof downloadGrantSchema.parse>;
  fileRecord: FileRecord;
  correlationId: CorrelationId;
}>;

export type FileReadRepository = Readonly<{
  readFile(fileId: FileId): Promise<FileRecord | null>;
  claimDownloadGrant(oneTimeId: PlatformId): Promise<ClaimedDownloadGrant | null>;
  recordDownloadGrant?(
    grant: ReturnType<typeof downloadGrantSchema.parse>,
    correlationId: CorrelationId,
  ): Promise<void>;
}>;

const sameDownloadGrant = (
  left: ReturnType<typeof downloadGrantSchema.parse>,
  right: ReturnType<typeof downloadGrantSchema.parse>,
): boolean =>
  left.kind === "download" &&
  right.kind === "download" &&
  left.oneTimeId === right.oneTimeId &&
  left.fileId === right.fileId &&
  left.organizationId === right.organizationId &&
  left.recordTypeId === right.recordTypeId &&
  left.recordId === right.recordId &&
  left.fieldId === right.fieldId;

/**
 * Storage credential bridge authority resolver for download/read operations.
 * It claims and verifies the one-time short-lived download grant, rechecking that
 * the file is active, clean, and not expired.
 */
export const createReadStorageAuthorityResolver = (
  repository: FileReadRepository,
  clock: () => Date = () => new Date(),
): ResolveCurrentStorageAuthority => {
  return async (request) => {
    if (request.operation !== "read") return { authorized: false };
    const requested = downloadGrantSchema.safeParse(request.grant);
    if (!requested.success) return { authorized: false };

    const claimed = await repository.claimDownloadGrant(requested.data.oneTimeId);
    if (claimed === null) return { authorized: false };

    const grant = downloadGrantSchema.safeParse(claimed.grant);
    const fileRecord = fileRecordSchema.safeParse(claimed.fileRecord);
    const now = clock().getTime();

    if (
      !grant.success ||
      !fileRecord.success ||
      !sameDownloadGrant(grant.data, requested.data) ||
      fileRecord.data.lifecycleState !== "active" ||
      fileRecord.data.scannerResult !== "clean" ||
      !(now < Date.parse(grant.data.expiresAt))
    ) {
      return { authorized: false };
    }

    return {
      authorized: true,
      operation: "read",
      organizationId: fileRecord.data.organizationId,
      fileId: fileRecord.data.fileId,
      fileRecord: fileRecord.data,
      actor: grant.data.actor,
      correlationId: claimed.correlationId,
      validUntil: grant.data.expiresAt,
      transferGrantId: grant.data.oneTimeId,
    };
  };
};

/**
 * Composes multiple Storage authority resolvers into one fallback chain.
 */
export const composeStorageAuthorityResolvers = (
  ...resolvers: readonly ResolveCurrentStorageAuthority[]
): ResolveCurrentStorageAuthority => {
  return async (request) => {
    for (const resolver of resolvers) {
      const resolution = await resolver(request);
      if (resolution.authorized) return resolution;
    }
    return { authorized: false };
  };
};

export type UpstreamStorageReadOptions = Readonly<{
  destinationProject: string;
  bucketId: string;
  objectPath: string;
  token: string;
  range?: ParsedByteRange;
  ifNoneMatch?: string;
}>;

export type UpstreamStorageReadResult = Readonly<{
  statusCode: number;
  contentLength: number;
  contentType?: string;
  contentRange?: string;
  etag?: string;
  stream: ReadableStream<Uint8Array>;
}>;

/** Server-side reader port that streams bytes from the upstream Storage service. */
export type UpstreamStorageReader = (
  options: UpstreamStorageReadOptions,
) => Promise<UpstreamStorageReadResult>;

/** Creates a default upstream storage reader using server-side fetch. */
export const createDefaultUpstreamStorageReader = (
  fetchImpl: typeof fetch = fetch,
): UpstreamStorageReader => {
  return async (options) => {
    const encodedPath = options.objectPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const url = `https://${options.destinationProject}.supabase.co/storage/v1/object/authenticated/${options.bucketId}/${encodedPath}`;
    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
    };
    if (options.range !== undefined) {
      reqHeaders["Range"] = `bytes=${options.range.start}-${options.range.end}`;
    }
    if (options.ifNoneMatch !== undefined) {
      reqHeaders["If-None-Match"] = options.ifNoneMatch;
    }
    const res = await fetchImpl(url, {
      method: "GET",
      headers: reqHeaders,
      cache: "no-store",
    });
    if (!res.ok && res.status !== 206 && res.status !== 304) {
      throw new Error(`Upstream storage returned HTTP ${res.status}`);
    }
    const bodyStream = res.body ?? new ReadableStream<Uint8Array>();
    return {
      statusCode: res.status,
      contentLength: Number(res.headers.get("content-length") ?? 0),
      contentType: res.headers.get("content-type") ?? undefined,
      contentRange: res.headers.get("content-range") ?? undefined,
      etag: res.headers.get("etag") ?? undefined,
      stream: bodyStream,
    };
  };
};

/** Isolated preview generator: never executes scripts, macros or active content. */
export type FilePreviewGenerator = (
  input: Readonly<{
    fileRecord: FileRecord;
    stream: ReadableStream<Uint8Array>;
  }>,
) => Promise<Readonly<{
  stream: ReadableStream<Uint8Array>;
  mediaType: string;
  sizeBytes: number;
}>>;

/** Repository interface for bounded cleanup of abandoned pending uploads. */
export type FileAbandonmentCleanupRepository = Readonly<{
  listExpiredPendingUploads(input: Readonly<{
    maxBatchSize: number;
    now: Date;
  }>): Promise<readonly FileRecord[]>;
  recordUploadAbandonment(input: Readonly<{
    fileId: FileId;
    fileRecord: FileRecord;
    abandonedAt: string;
  }>): Promise<
    | Readonly<{ outcome: "abandoned"; fileRecord: FileRecord }>
    | Readonly<{ outcome: "refused"; reason: string }>
  >;
  recordAbandonedUploadRemoval(input: Readonly<{
    fileId: FileId;
    fileRecord: FileRecord;
    removedAt: string;
  }>): Promise<
    | Readonly<{ outcome: "removed"; fileRecord: FileRecord }>
    | Readonly<{ outcome: "refused"; reason: string }>
  >;
}>;

export type AbandonedObjectStorageDeleter = (
  location: Readonly<{
    organizationId: OrganizationId;
    fileId: FileId;
    bucketId: typeof PRIVATE_FILE_BUCKET;
    objectPath: string;
  }>,
) => Promise<Readonly<{ outcome: "deleted" | "already_absent" }>>;

export type CleanupAbandonedPendingObjectsDependencies = Readonly<{
  repository: FileAbandonmentCleanupRepository;
  storageDeleter: AbandonedObjectStorageDeleter;
  clock?: () => Date;
}>;

export type CleanupAbandonedPendingObjectsResult = Readonly<{
  examinedCount: number;
  abandonedCount: number;
  removedCount: number;
  errors: readonly Readonly<{ fileId: FileId; reason: string }>[];
}>;

/**
 * Removes abandoned pending uploads whose upload window has expired.
 * Emits no record activity and cleans private storage through owning ports.
 */
export const cleanupAbandonedPendingObjects = async (
  dependencies: CleanupAbandonedPendingObjectsDependencies,
  input?: Readonly<{ maxBatchSize?: number; now?: Date }>,
): Promise<CleanupAbandonedPendingObjectsResult> => {
  const clock = dependencies.clock ?? (() => new Date());
  const now = input?.now ?? clock();
  const maxBatchSize = Math.max(1, Math.min(input?.maxBatchSize ?? 50, 500));

  const expired = await dependencies.repository.listExpiredPendingUploads({
    maxBatchSize,
    now,
  });

  let examinedCount = 0;
  let abandonedCount = 0;
  let removedCount = 0;
  const errors: Readonly<{ fileId: FileId; reason: string }>[] = [];

  for (const fileRecord of expired) {
    examinedCount++;
    try {
      if (fileRecord.lifecycleState === "pending") {
        const abandoned = transitionFileLifecycleState(
          fileRecord,
          "abandoned",
          { clock: () => now },
        );
        const abandonResult = await dependencies.repository.recordUploadAbandonment({
          fileId: fileRecord.fileId,
          fileRecord: abandoned,
          abandonedAt: now.toISOString(),
        });
        if (abandonResult.outcome === "abandoned") {
          abandonedCount++;
        } else {
          errors.push({ fileId: fileRecord.fileId, reason: abandonResult.reason });
          continue;
        }
      }

      await dependencies.storageDeleter({
        organizationId: fileRecord.organizationId,
        fileId: fileRecord.fileId,
        bucketId: fileRecord.bucketId,
        objectPath: fileRecord.storageKey,
      });

      const removed = transitionFileLifecycleState(
        { ...fileRecord, lifecycleState: "abandoned" },
        "removed",
        { clock: () => now },
      );
      const removeResult = await dependencies.repository.recordAbandonedUploadRemoval({
        fileId: fileRecord.fileId,
        fileRecord: removed,
        removedAt: now.toISOString(),
      });
      if (removeResult.outcome === "removed") {
        removedCount++;
      } else {
        errors.push({ fileId: fileRecord.fileId, reason: removeResult.reason });
      }
    } catch (err) {
      errors.push({
        fileId: fileRecord.fileId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Object.freeze({
    examinedCount,
    abandonedCount,
    removedCount,
    errors: Object.freeze(errors),
  });
};

export type FileReadStreamResponse = Readonly<{
  outcome: "success";
  fileId: FileId;
  statusCode: 200 | 206 | 304;
  headers: Record<string, string>;
  stream: ReadableStream<Uint8Array>;
  metadata: Readonly<{
    displayName: string;
    mediaType: string;
    sizeBytes: number;
    checksum: string;
    isPartial: boolean;
    contentRange?: string;
    contentLength: number;
    disposition: "attachment" | "inline";
  }>;
}>;

export type FileReadRefusal = Readonly<{
  outcome: "refused";
  reason: FileReadRefusalReason;
  message: string;
  statusCode: number;
  headers?: Record<string, string>;
}>;

export type FileReadResult = FileReadStreamResponse | FileReadRefusal;

export type FileReadCoordinatorDependencies = Readonly<{
  repository: FileReadRepository;
  bridge: StorageCredentialBridge;
  upstreamStorageReader: UpstreamStorageReader;
  previewGenerator?: FilePreviewGenerator;
  cleanupRepository?: FileAbandonmentCleanupRepository;
  abandonedStorageDeleter?: AbandonedObjectStorageDeleter;
  clock?: () => Date;
}>;

export type FileReadCoordinator = Readonly<{
  readFile(
    authority: CurrentReadAuthority,
    request: FileReadRequest,
  ): Promise<FileReadResult>;
  cleanupAbandonedPendingObjects(
    options?: Readonly<{ maxBatchSize?: number }>,
  ): Promise<CleanupAbandonedPendingObjectsResult>;
}>;

const defaultPrivateHeaders = (): Record<string, string> => ({
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Download-Options": "noopen",
  "Accept-Ranges": "bytes",
});

const refusal = (
  reason: FileReadRefusalReason,
  message: string,
  extraHeaders?: Record<string, string>,
): FileReadRefusal =>
  Object.freeze({
    outcome: "refused",
    reason,
    message,
    statusCode: fileReadRefusalHttpStatus[reason],
    headers: {
      ...defaultPrivateHeaders(),
      ...(extraHeaders ?? {}),
    },
  });

/**
 * Creates the FileReadCoordinator.
 *
 * Rechecks current organisation, record, attachment field, file and grant authority
 * on every single request including range and preview requests.
 * Uses server-held short-lived read credentials and never redirects clients to
 * reusable private Storage bearer URLs.
 */
export const createFileReadCoordinator = (
  dependencies: FileReadCoordinatorDependencies,
): FileReadCoordinator => {
  const clock = dependencies.clock ?? (() => new Date());

  const readFile = async (
    authority: CurrentReadAuthority,
    request: FileReadRequest,
  ): Promise<FileReadResult> => {
    const now = clock();
    const nowMilliseconds = now.getTime();

    // 1. Session & authentication check
    if (
      authority.sessionContext.callerKind === "public" ||
      authority.sessionContext.callerKind === "anonymous"
    ) {
      return refusal(
        "unauthenticated",
        "Public and anonymous callers confer no private file authority",
      );
    }

    // 2. Verified actor resolution
    const actorResolution = resolveVerifiedFileActor(
      authority.sessionContext,
      authority.organizationId,
    );
    if (!actorResolution.authorized) {
      return refusal("caller_not_authorized", actorResolution.reason);
    }
    const actor = actorResolution.actor;

    // 3. Attachment field readability check
    const fieldAuthority = verifyAttachmentFieldAuthority({
      fieldId: authority.fieldId,
      readableFieldIds: authority.readableFieldIds,
      changeableFieldIds: [],
      operation: "read",
    });
    if (!fieldAuthority.authorized) {
      return refusal("field_not_readable", fieldAuthority.reason);
    }

    // 4. File record load
    const fileIdParsed = fileIdSchema.safeParse(request.fileId);
    if (!fileIdParsed.success) {
      return refusal("malformed_request", "Invalid file identifier");
    }
    const fileRecord = await dependencies.repository.readFile(fileIdParsed.data);
    if (fileRecord === null) {
      return refusal("file_not_found", `File '${request.fileId}' not found`);
    }

    // 5. Organisation and shared record authority check
    if (fileRecord.organizationId !== authority.organizationId) {
      if (authority.sharedRecordGrant !== undefined) {
        const grant = authority.sharedRecordGrant;
        const grantExpiresAt = Date.parse(grant.expiresAt);
        if (grant.revoked === true) {
          return refusal("grant_revoked", "Record sharing grant has been revoked");
        }
        if (!Number.isFinite(grantExpiresAt) || grantExpiresAt <= nowMilliseconds) {
          return refusal("grant_expired", "Record sharing grant has expired");
        }
        if (grant.sourceOrganizationId !== fileRecord.organizationId) {
          return refusal(
            "caller_not_authorized",
            "Shared grant source organisation mismatch",
          );
        }
        if (grant.recipientOrganizationId !== authority.organizationId) {
          return refusal(
            "caller_not_authorized",
            "Shared grant recipient organisation mismatch",
          );
        }
        if (!grant.readableFieldIds.includes(authority.fieldId)) {
          return refusal(
            "field_not_readable",
            "Attachment field is not readable in the sharing grant",
          );
        }
      } else {
        return refusal(
          "caller_not_authorized",
          "File is not owned by the caller organisation",
        );
      }
    }

    // 6. Record owner binding match
    if (
      fileRecord.ownerRecordTypeId !== authority.recordTypeId ||
      fileRecord.ownerRecordId !== authority.recordId ||
      fileRecord.ownerFieldId !== authority.fieldId
    ) {
      return refusal(
        "owner_mismatch",
        "File is not attached to the specified record and field",
      );
    }

    // 7. Lifecycle state and safety checks
    if (fileRecord.lifecycleState !== "active") {
      return refusal(
        "invalid_lifecycle_state",
        `File is in lifecycle state '${fileRecord.lifecycleState}', not active`,
      );
    }
    if (fileRecord.scannerResult !== "clean") {
      return refusal(
        "safety_check_failed",
        `File safety check result is '${fileRecord.scannerResult}', refusing access`,
      );
    }

    // 8. Range parsing
    const rangeResult = parseRangeHeader(request.rangeHeader, fileRecord.sizeBytes);
    if (rangeResult.kind === "unsatisfiable") {
      return refusal(
        "range_not_satisfiable",
        "Requested byte range is unsatisfiable",
        {
          "Content-Range": `bytes */${fileRecord.sizeBytes}`,
        },
      );
    }

    // 9. Short-lived internal read grant minting
    const oneTimeId = randomUUID() as PlatformId;
    const correlationId = correlationIdSchema.parse(randomUUID());
    const grantExpiresAt = new Date(nowMilliseconds + 60 * 1000).toISOString();
    const downloadGrant = downloadGrantSchema.parse({
      kind: "download",
      organizationId: fileRecord.organizationId,
      actor,
      recordTypeId: fileRecord.ownerRecordTypeId!,
      recordId: fileRecord.ownerRecordId!,
      fieldId: fileRecord.ownerFieldId!,
      fileId: fileRecord.fileId,
      oneTimeId,
      expiresAt: grantExpiresAt,
    });

    if (dependencies.repository.recordDownloadGrant) {
      await dependencies.repository.recordDownloadGrant(downloadGrant, correlationId);
    }

    // 10. Mint server-held short-lived Storage operation credential
    let credential;
    try {
      credential = await dependencies.bridge.mintStorageOperationCredential({
        request: { operation: "read", grant: downloadGrant },
        ttlSeconds: 60,
      });
    } catch (err) {
      return refusal(
        "storage_unavailable",
        err instanceof Error ? err.message : "Storage credential minting failed",
      );
    }

    // 11. Upstream fetch through server-held token
    const parsedRange =
      rangeResult.kind === "satisfiable" ? rangeResult.range : undefined;

    let upstreamResult;
    try {
      upstreamResult = await dependencies.upstreamStorageReader({
        destinationProject: credential.destinationProject,
        bucketId: credential.bucketId,
        objectPath: credential.objectPath,
        token: credential.token,
        range: parsedRange,
        ifNoneMatch: request.ifNoneMatch,
      });
    } catch (err) {
      return refusal(
        "storage_unavailable",
        err instanceof Error ? err.message : "Upstream storage fetch failed",
      );
    }

    if (upstreamResult.statusCode === 304) {
      return Object.freeze({
        outcome: "success" as const,
        fileId: fileRecord.fileId,
        statusCode: 304 as const,
        headers: {
          ...defaultPrivateHeaders(),
          ...(upstreamResult.etag ? { ETag: upstreamResult.etag } : {}),
        },
        stream: upstreamResult.stream,
        metadata: Object.freeze({
          displayName: fileRecord.originalSafeDisplayName,
          mediaType: fileRecord.detectedMediaType,
          sizeBytes: fileRecord.sizeBytes,
          checksum: fileRecord.checksum,
          isPartial: false,
          contentLength: 0,
          disposition: "attachment" as const,
        }),
      });
    }

    // 12. Safe Content Disposition & Content Type
    const dispositionResolution = resolveSafeContentDisposition(
      fileRecord,
      request.purpose,
    );

    let outputStream = upstreamResult.stream;
    let effectiveMediaType = dispositionResolution.safeMediaType;
    let effectiveSizeBytes = upstreamResult.contentLength;

    // 13. Isolated preview generation (if purpose is preview and generator configured)
    if (request.purpose === "preview" && dependencies.previewGenerator) {
      try {
        const previewResult = await dependencies.previewGenerator({
          fileRecord,
          stream: outputStream,
        });
        outputStream = previewResult.stream;
        effectiveMediaType = previewResult.mediaType;
        effectiveSizeBytes = previewResult.sizeBytes;
      } catch (err) {
        return refusal(
          "preview_unavailable",
          err instanceof Error ? err.message : "Preview generation failed",
        );
      }
    }

    const isPartial = rangeResult.kind === "satisfiable";
    const statusCode = isPartial ? 206 : 200;

    const responseHeaders: Record<string, string> = {
      ...defaultPrivateHeaders(),
      "Content-Type": effectiveMediaType,
      "Content-Disposition": dispositionResolution.contentDispositionHeader,
      "Content-Length": String(effectiveSizeBytes),
      ...(upstreamResult.contentRange
        ? { "Content-Range": upstreamResult.contentRange }
        : isPartial && parsedRange
          ? {
              "Content-Range": `bytes ${parsedRange.start}-${parsedRange.end}/${fileRecord.sizeBytes}`,
            }
          : {}),
      ...(upstreamResult.etag ? { ETag: upstreamResult.etag } : {}),
    };

    return Object.freeze({
      outcome: "success" as const,
      fileId: fileRecord.fileId,
      statusCode,
      headers: Object.freeze(responseHeaders),
      stream: outputStream,
      metadata: Object.freeze({
        displayName: fileRecord.originalSafeDisplayName,
        mediaType: effectiveMediaType,
        sizeBytes: fileRecord.sizeBytes,
        checksum: fileRecord.checksum,
        isPartial,
        contentRange: responseHeaders["Content-Range"],
        contentLength: effectiveSizeBytes,
        disposition: dispositionResolution.disposition,
      }),
    });
  };

  const cleanupAbandonedPending = async (
    options?: Readonly<{ maxBatchSize?: number }>,
  ): Promise<CleanupAbandonedPendingObjectsResult> => {
    if (
      !dependencies.cleanupRepository ||
      !dependencies.abandonedStorageDeleter
    ) {
      return Object.freeze({
        examinedCount: 0,
        abandonedCount: 0,
        removedCount: 0,
        errors: Object.freeze([
          {
            fileId: "00000000-0000-0000-0000-000000000000" as FileId,
            reason: "Cleanup dependencies not configured",
          },
        ]),
      });
    }

    return cleanupAbandonedPendingObjects(
      {
        repository: dependencies.cleanupRepository,
        storageDeleter: dependencies.abandonedStorageDeleter,
        clock,
      },
      options,
    );
  };

  return Object.freeze({
    readFile,
    cleanupAbandonedPendingObjects: cleanupAbandonedPending,
  });
};
