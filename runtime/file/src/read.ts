import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  applicationRootIdSchema,
  correlationIdSchema,
  downloadGrantSchema,
  fieldIdSchema,
  fileIdSchema,
  fileRecordSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  timestampSchema,
  verifiedFileActorSchema,
  type ApplicationRootId,
  type CorrelationId,
  type DownloadGrant,
  type FieldId,
  type FileId,
  type FileRecord,
  type OrganizationAccountId,
  type OrganizationId,
  type PlatformId,
  type RecordId,
  type RecordTypeId,
  type SessionContext,
  type VerifiedFileActor,
} from "@vortex/contracts";
import { isExecutableContent, normalizeFileExtension } from "./content-safety";
import { sanitizeFileDisplayName } from "./file-metadata";
import { resolveVerifiedFileActor, verifyAttachmentFieldAuthority } from "./attachment-authority";
import type {
  ResolveCurrentStorageAuthority,
  StorageCredentialBridge,
  StorageCredentialRequest,
  StorageOperationCredential,
} from "./storage-credentials";
import type { FileRemovalCoordinator, FileRemovalResult } from "./object-removal";
import type { FileRemovalEligibilityService } from "./removal-eligibility";

/** Closed refusal reasons for private file download, range and preview requests. */
export type FileReadRefusalReason =
  | "malformed_request"
  | "authority_unavailable"
  | "file_not_found"
  | "field_not_readable"
  | "file_not_available"
  | "range_not_satisfiable"
  | "preview_not_supported"
  | "preview_unavailable"
  | "storage_unavailable";

/**
 * Canonical HTTP status of each refusal. A file outside the caller's current
 * organisation, share or owning record is reported as not found, so a copied
 * route reveals nothing about another organisation's files.
 */
export const fileReadRefusalHttpStatus: Readonly<Record<FileReadRefusalReason, number>> =
  Object.freeze({
    malformed_request: 400,
    authority_unavailable: 403,
    file_not_found: 404,
    field_not_readable: 403,
    file_not_available: 410,
    range_not_satisfiable: 416,
    preview_not_supported: 406,
    preview_unavailable: 503,
    storage_unavailable: 503,
  });

const REFUSAL_MESSAGES = {
  malformed_request: "The file request is malformed",
  authority_unavailable: "Current access to this file could not be confirmed",
  file_not_found: "The file was not found",
  field_not_readable: "The attachment field is not readable under current access",
  file_not_available: "The file is not available",
  range_not_satisfiable: "The requested byte range cannot be served",
  preview_not_supported: "This file cannot be previewed; download it instead",
  preview_unavailable: "The preview is temporarily unavailable",
  storage_unavailable: "The file is temporarily unavailable",
} as const satisfies Record<FileReadRefusalReason, string>;

export type FileReadPurpose = "download" | "preview";

/**
 * The verified viewer of one request, taken from the Access-resolved protected
 * request context of the organisation the viewer is acting in. For a shared
 * record that is the recipient organisation, never the source organisation.
 */
export type FileReadViewer = Readonly<{
  organizationId: OrganizationId;
  actor: VerifiedFileActor;
  applicationRootId?: ApplicationRootId;
}>;

/**
 * The current sharing grant that lets a recipient organisation read one
 * attachment field of a source record. It is resolved by trusted server wiring
 * from the live grant on every request and is never built from request input.
 * A grant that does not name the attachment field exposes neither metadata nor
 * content, and the bytes remain owned by the source organisation.
 */
export type SharedRecordFileGrant = Readonly<{
  grantId: PlatformId;
  sourceOrganizationId: OrganizationId;
  sourceRecordTypeId: RecordTypeId;
  sourceRecordId: RecordId;
  recipientOrganizationId: OrganizationId;
  /** Set when the grant names one recipient organisation account. */
  recipientOrganizationAccountId?: OrganizationAccountId;
  /** Set when the grant is bound to one recipient application. */
  recipientApplicationRootId?: ApplicationRootId;
  readableFieldIds: readonly FieldId[];
  expiresAt: string;
  revoked: boolean;
}>;

/**
 * Current record and attachment-field viewer authority for the file's owning
 * record, produced by the ordinary Access-resolved record read inside the
 * request's protected transaction. Every request, including each range and
 * preview request, supplies a fresh one; `validUntil` bounds how long the
 * decision may be relied on.
 */
export type CurrentReadAuthority = Readonly<{
  viewer: FileReadViewer;
  recordTypeId: RecordTypeId;
  recordId: RecordId;
  fieldId: FieldId;
  readableFieldIds: readonly FieldId[];
  sharedRecordGrant?: SharedRecordFileGrant;
  validUntil: string;
}>;

export type FileReadRequest = Readonly<{
  fileId: FileId;
  purpose: FileReadPurpose;
  rangeHeader?: string;
  ifRangeHeader?: string;
}>;

/**
 * Derives the file viewer from a trusted, already-resolved session context. A
 * public, anonymous or federated caller has no local private-file viewer: a
 * federated read is served by the source File service's own gateway.
 */
export const fileReadViewerFromSessionContext = (
  context: SessionContext,
): FileReadViewer | null => {
  const actor = resolveVerifiedFileActor(context, context.organizationId);
  if (!actor.authorized) return null;
  return Object.freeze({
    organizationId: context.organizationId,
    actor: actor.actor,
    ...(context.applicationRootId === undefined
      ? {}
      : { applicationRootId: context.applicationRootId }),
  });
};

export type ParsedByteRange = Readonly<{ start: number; end: number }>;

export type RangeParseResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "satisfiable"; range: ParsedByteRange }>
  | Readonly<{ kind: "unsatisfiable" }>;

const MAXIMUM_RANGE_HEADER_LENGTH = 200;

/**
 * Applies RFC 9110 single-range semantics. A missing, malformed, multi-range or
 * non-byte Range header is ignored and the complete representation is served; a
 * well-formed byte range that selects nothing is unsatisfiable.
 */
export const parseRangeHeader = (
  rangeHeader: string | undefined,
  totalBytes: number,
): RangeParseResult => {
  if (rangeHeader === undefined) return { kind: "none" };
  const candidate = rangeHeader.trim();
  if (candidate.length === 0 || candidate.length > MAXIMUM_RANGE_HEADER_LENGTH) {
    return { kind: "none" };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(candidate);
  if (match === null) return { kind: "none" };
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return { kind: "none" };

  if (startText === "") {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength)) return { kind: "none" };
    if (suffixLength === 0 || totalBytes === 0) return { kind: "unsatisfiable" };
    return {
      kind: "satisfiable",
      range: { start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 },
    };
  }

  const start = Number(startText);
  const end = endText === "" ? undefined : Number(endText);
  if (!Number.isSafeInteger(start) || (end !== undefined && !Number.isSafeInteger(end))) {
    return { kind: "none" };
  }
  if (end !== undefined && end < start) return { kind: "none" };
  if (start >= totalBytes) return { kind: "unsatisfiable" };
  return {
    kind: "satisfiable",
    range: { start, end: end === undefined ? totalBytes - 1 : Math.min(end, totalBytes - 1) },
  };
};

const ACTIVE_BROWSER_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/xslt+xml",
  "application/rdf+xml",
  "application/mathml+xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/json",
  "application/wasm",
  "application/pdf",
  "application/hta",
  "application/x-shockwave-flash",
  "text/cache-manifest",
  "multipart/x-mixed-replace",
]);

const ACTIVE_BROWSER_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".shtml",
  ".xhtml",
  ".xht",
  ".svg",
  ".svgz",
  ".xml",
  ".xsl",
  ".xslt",
  ".js",
  ".mjs",
  ".json",
  ".wasm",
  ".pdf",
  ".swf",
  ".hta",
]);

const normalizeMediaType = (mediaType: string): string =>
  (mediaType.split(";")[0] ?? "").trim().toLowerCase();

/**
 * Reports content a browser could execute or render actively if served under
 * its own type: markup, scripts, SVG, PDF and executables. Such content is only
 * ever downloaded as an opaque attachment.
 */
export const isExecutableOrActiveBrowserContent = (
  mediaType: string,
  extension: string,
): boolean => {
  const normalized = normalizeMediaType(mediaType);
  const normalizedExtension = normalizeFileExtension(extension);
  return (
    isExecutableContent(mediaType, normalizedExtension) ||
    ACTIVE_BROWSER_MEDIA_TYPES.has(normalized) ||
    normalized.endsWith("+xml") ||
    ACTIVE_BROWSER_EXTENSIONS.has(normalizedExtension)
  );
};

/**
 * Passive media a browser may display inline from the original bytes. Anything
 * else is previewed only through an isolated rendition, or not at all.
 */
const INLINE_PREVIEW_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "text/plain",
]);

/** The only rendition types an isolated preview renderer may return. */
const PREVIEW_RENDITION_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
]);

const canPreviewOriginalInline = (fileRecord: FileRecord): boolean =>
  !isExecutableOrActiveBrowserContent(fileRecord.detectedMediaType, fileRecord.extension) &&
  INLINE_PREVIEW_MEDIA_TYPES.has(normalizeMediaType(fileRecord.detectedMediaType));

const RFC5987_UNRESERVED = /[A-Za-z0-9!#$&+\-.^_`|~]/;

const encodeRfc5987 = (value: string): string =>
  Array.from(Buffer.from(value, "utf8"))
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return byte < 0x80 && RFC5987_UNRESERVED.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

/**
 * Builds an RFC 6266 Content-Disposition value. The quoted fallback is plain
 * printable ASCII without quotes or backslashes; the exact sanitised name
 * travels in the RFC 5987 extended parameter.
 */
export const buildContentDisposition = (
  disposition: "attachment" | "inline",
  displayName: string,
  extension: string,
): string => {
  const safeName = sanitizeFileDisplayName(displayName, extension);
  const asciiFallback =
    safeName
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/["\\%;]/g, "_")
      .trim() || `download${extension}`;
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
};

/** A strong validator derived from the immutable verified content checksum. */
const entityTag = (fileRecord: FileRecord): string => `"${fileRecord.checksum}"`;

/**
 * Response headers shared by every private file response: never stored by a
 * browser or intermediary, never sniffed, never scriptable and never embeddable
 * by another origin.
 */
export const privateFileResponseHeaders = (): Record<string, string> => ({
  "Cache-Control": "private, no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Download-Options": "noopen",
});

/**
 * Durable File-service store for read grants. Every write runs server-side,
 * scoped to the file's owning organisation; there is no in-memory production
 * implementation.
 */
export type FileReadRepository = Readonly<{
  /** Loads the canonical file record; null when no such file exists. */
  readFile(fileId: FileId): Promise<FileRecord | null>;
  /** Persists one unclaimed, short-lived read grant for this request. */
  recordDownloadGrant(
    input: Readonly<{
      grant: DownloadGrant;
      correlationId: CorrelationId;
      purpose: FileReadPurpose;
    }>,
  ): Promise<void>;
  /**
   * Atomically marks an unexpired, unclaimed read grant claimed and returns it
   * with the current canonical file record. An unknown, expired or already
   * claimed grant returns null, so each grant issues exactly one credential.
   */
  claimDownloadGrant(oneTimeId: PlatformId): Promise<ClaimedDownloadGrant | null>;
}>;

export type ClaimedDownloadGrant = Readonly<{
  grant: DownloadGrant;
  fileRecord: FileRecord;
  correlationId: CorrelationId;
}>;

const sameActor = (left: VerifiedFileActor, right: VerifiedFileActor): boolean =>
  left.kind === "human" && right.kind === "human"
    ? left.organizationAccountId === right.organizationAccountId &&
      left.identityId === right.identityId
    : left.kind === "system" &&
      right.kind === "system" &&
      left.systemActorId === right.systemActorId;

const sameDownloadGrant = (left: DownloadGrant, right: DownloadGrant): boolean =>
  left.oneTimeId === right.oneTimeId &&
  left.fileId === right.fileId &&
  left.organizationId === right.organizationId &&
  left.recordTypeId === right.recordTypeId &&
  left.recordId === right.recordId &&
  left.fieldId === right.fieldId &&
  sameActor(left.actor, right.actor) &&
  Date.parse(left.expiresAt) === Date.parse(right.expiresAt);

/**
 * The Storage credential bridge's authority for reads. It claims the one-time
 * read grant, so a grant mints exactly one server-held credential, and
 * requires the canonical file to still be active, clean and attached to the
 * grant's record field.
 */
export const createReadStorageAuthorityResolver = (
  repository: Pick<FileReadRepository, "claimDownloadGrant">,
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
    if (
      !grant.success ||
      !fileRecord.success ||
      !sameDownloadGrant(grant.data, requested.data) ||
      fileRecord.data.fileId !== grant.data.fileId ||
      fileRecord.data.organizationId !== grant.data.organizationId ||
      fileRecord.data.ownerRecordTypeId !== grant.data.recordTypeId ||
      fileRecord.data.ownerRecordId !== grant.data.recordId ||
      fileRecord.data.ownerFieldId !== grant.data.fieldId ||
      fileRecord.data.lifecycleState !== "active" ||
      fileRecord.data.scannerResult !== "clean" ||
      !(clock().getTime() < Date.parse(grant.data.expiresAt))
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
 * Routes each bridge request to the one resolver that owns its operation, so a
 * read never reaches the upload resolver and vice versa. An operation without a
 * resolver is refused.
 */
export const composeStorageAuthorityResolvers = (
  resolvers: Readonly<Partial<Record<StorageCredentialRequest["operation"], ResolveCurrentStorageAuthority>>>,
): ResolveCurrentStorageAuthority => {
  const routes = Object.freeze({ ...resolvers });
  return async (request) => {
    const resolver = routes[request.operation];
    return resolver === undefined ? { authorized: false } : resolver(request);
  };
};

/** One server-side Storage read, authorised by a bridge credential that never leaves the server. */
export type UpstreamStorageReadOptions = Readonly<{
  credential: StorageOperationCredential;
  range?: ParsedByteRange;
}>;

export type UpstreamStorageReadResult = Readonly<{
  statusCode: 200 | 206;
  contentLength?: number;
  contentRange?: string;
  stream: ReadableStream<Uint8Array>;
}>;

/** Server-side reader port that streams bytes from private Storage. */
export type UpstreamStorageReader = (
  options: UpstreamStorageReadOptions,
) => Promise<UpstreamStorageReadResult>;

/**
 * Reads the exact object named by a server-held bridge credential from the
 * destination project's authenticated Storage endpoint. Redirects are refused,
 * nothing is cached, and the upstream address and bearer stay in this process.
 */
export const createDefaultUpstreamStorageReader = (
  fetchImplementation: typeof fetch = fetch,
): UpstreamStorageReader => {
  return async ({ credential, range }) => {
    const objectPath = credential.objectPath.split("/").map(encodeURIComponent).join("/");
    const url = `https://${credential.destinationProject}.supabase.co/storage/v1/object/authenticated/${encodeURIComponent(credential.bucketId)}/${objectPath}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      "Accept-Encoding": "identity",
    };
    if (range !== undefined) headers.Range = `bytes=${range.start}-${range.end}`;
    const response = await fetchImplementation(url, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
    });
    const expectedStatus = range === undefined ? 200 : 206;
    if (response.status !== expectedStatus || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("FILE_UPSTREAM_READ_REFUSED");
    }
    const declaredLength = response.headers.get("content-length");
    const contentLength =
      declaredLength !== null && /^\d+$/.test(declaredLength) ? Number(declaredLength) : undefined;
    const contentRange = response.headers.get("content-range") ?? undefined;
    return {
      statusCode: expectedStatus,
      ...(contentLength === undefined ? {} : { contentLength }),
      ...(contentRange === undefined ? {} : { contentRange }),
      stream: response.body,
    };
  };
};

/**
 * Passes exactly `expectedBytes` through (or at most `maximumBytes` when the
 * length is unknown) and errors the stream on any excess or shortfall, so a
 * wrong upstream body can never be delivered under this file's headers.
 */
const boundedByteStream = (
  source: ReadableStream<Uint8Array>,
  limit: Readonly<{ expectedBytes?: number; maximumBytes: number }>,
): ReadableStream<Uint8Array> => {
  let delivered = 0;
  const ceiling = limit.expectedBytes ?? limit.maximumBytes;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        delivered += chunk.byteLength;
        if (delivered > ceiling) {
          controller.error(new Error("FILE_STREAM_LENGTH_EXCEEDED"));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (limit.expectedBytes !== undefined && delivered !== limit.expectedBytes) {
          controller.error(new Error("FILE_STREAM_LENGTH_MISMATCH"));
        }
      },
    }),
  );
};

/**
 * Isolated preview rendering. Implementations run outside the application
 * process (a sandboxed worker or service without network or credentials), never
 * execute macros, scripts or active document content, and return one passive
 * rendition. The source is opened on demand through a server-held read.
 */
export type FilePreviewRenderer = (
  input: Readonly<{
    fileRecord: FileRecord;
    source: ReadableStream<Uint8Array>;
    maximumOutputBytes: number;
  }>,
) => Promise<
  Readonly<{
    mediaType: string;
    stream: ReadableStream<Uint8Array>;
    sizeBytes?: number;
  }>
>;

export type FileReadStreamResponse = Readonly<{
  outcome: "success";
  fileId: FileId;
  statusCode: 200 | 206;
  headers: Readonly<Record<string, string>>;
  stream: ReadableStream<Uint8Array>;
}>;

export type FileReadRefusal = Readonly<{
  outcome: "refused";
  reason: FileReadRefusalReason;
  message: string;
  statusCode: number;
  headers: Readonly<Record<string, string>>;
}>;

export type FileReadResult = FileReadStreamResponse | FileReadRefusal;

export type FileReadCoordinatorDependencies = Readonly<{
  repository: FileReadRepository;
  bridge: Pick<StorageCredentialBridge, "mintStorageOperationCredential">;
  upstreamStorageReader: UpstreamStorageReader;
  previewRenderer?: FilePreviewRenderer;
  /** Largest original a preview renderer is given; defaults to 25 MiB. */
  maximumPreviewSourceBytes?: number;
  /** Largest rendition streamed back; defaults to 10 MiB. */
  maximumPreviewOutputBytes?: number;
  clock?: () => Date;
}>;

export type FileReadCoordinator = Readonly<{
  readFile(authority: CurrentReadAuthority, request: FileReadRequest): Promise<FileReadResult>;
}>;

const DEFAULT_MAXIMUM_PREVIEW_SOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAXIMUM_PREVIEW_OUTPUT_BYTES = 10 * 1024 * 1024;

const refusal = (
  reason: FileReadRefusalReason,
  extraHeaders?: Readonly<Record<string, string>>,
): FileReadRefusal =>
  Object.freeze({
    outcome: "refused",
    reason,
    message: REFUSAL_MESSAGES[reason],
    statusCode: fileReadRefusalHttpStatus[reason],
    headers: Object.freeze({ ...privateFileResponseHeaders(), ...(extraHeaders ?? {}) }),
  });

const positiveLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

const parseAuthority = (candidate: CurrentReadAuthority): CurrentReadAuthority | null => {
  if (candidate === null || typeof candidate !== "object") return null;
  const viewer = candidate.viewer;
  const organizationId = organizationIdSchema.safeParse(viewer?.organizationId);
  const actor = verifiedFileActorSchema.safeParse(viewer?.actor);
  const applicationRootId =
    viewer?.applicationRootId === undefined
      ? undefined
      : applicationRootIdSchema.safeParse(viewer.applicationRootId);
  const recordTypeId = recordTypeIdSchema.safeParse(candidate.recordTypeId);
  const recordId = recordIdSchema.safeParse(candidate.recordId);
  const fieldId = fieldIdSchema.safeParse(candidate.fieldId);
  const readableFieldIds = Array.isArray(candidate.readableFieldIds)
    ? candidate.readableFieldIds.map((value) => fieldIdSchema.safeParse(value))
    : undefined;
  const validUntil = timestampSchema.safeParse(candidate.validUntil);
  if (
    !organizationId.success ||
    !actor.success ||
    (applicationRootId !== undefined && !applicationRootId.success) ||
    !recordTypeId.success ||
    !recordId.success ||
    !fieldId.success ||
    readableFieldIds === undefined ||
    readableFieldIds.some((value) => !value.success) ||
    !validUntil.success
  ) {
    return null;
  }

  let sharedRecordGrant: SharedRecordFileGrant | undefined;
  if (candidate.sharedRecordGrant !== undefined) {
    const grant = candidate.sharedRecordGrant;
    const grantId = platformIdSchema.safeParse(grant.grantId);
    const source = organizationIdSchema.safeParse(grant.sourceOrganizationId);
    const sourceRecordTypeId = recordTypeIdSchema.safeParse(grant.sourceRecordTypeId);
    const sourceRecordId = recordIdSchema.safeParse(grant.sourceRecordId);
    const recipient = organizationIdSchema.safeParse(grant.recipientOrganizationId);
    const recipientAccount =
      grant.recipientOrganizationAccountId === undefined
        ? undefined
        : organizationAccountIdSchema.safeParse(grant.recipientOrganizationAccountId);
    const recipientApplication =
      grant.recipientApplicationRootId === undefined
        ? undefined
        : applicationRootIdSchema.safeParse(grant.recipientApplicationRootId);
    const grantFields = Array.isArray(grant.readableFieldIds)
      ? grant.readableFieldIds.map((value) => fieldIdSchema.safeParse(value))
      : undefined;
    const expiresAt = timestampSchema.safeParse(grant.expiresAt);
    if (
      !grantId.success ||
      !source.success ||
      !sourceRecordTypeId.success ||
      !sourceRecordId.success ||
      !recipient.success ||
      (recipientAccount !== undefined && !recipientAccount.success) ||
      (recipientApplication !== undefined && !recipientApplication.success) ||
      grantFields === undefined ||
      grantFields.some((value) => !value.success) ||
      !expiresAt.success ||
      typeof grant.revoked !== "boolean"
    ) {
      return null;
    }
    sharedRecordGrant = Object.freeze({
      grantId: grantId.data,
      sourceOrganizationId: source.data,
      sourceRecordTypeId: sourceRecordTypeId.data,
      sourceRecordId: sourceRecordId.data,
      recipientOrganizationId: recipient.data,
      ...(recipientAccount !== undefined && recipientAccount.success
        ? { recipientOrganizationAccountId: recipientAccount.data }
        : {}),
      ...(recipientApplication !== undefined && recipientApplication.success
        ? { recipientApplicationRootId: recipientApplication.data }
        : {}),
      readableFieldIds: Object.freeze(grantFields.flatMap((value) => (value.success ? [value.data] : []))),
      expiresAt: expiresAt.data,
      revoked: grant.revoked,
    });
  }

  return Object.freeze({
    viewer: Object.freeze({
      organizationId: organizationId.data,
      actor: actor.data,
      ...(applicationRootId !== undefined && applicationRootId.success
        ? { applicationRootId: applicationRootId.data }
        : {}),
    }),
    recordTypeId: recordTypeId.data,
    recordId: recordId.data,
    fieldId: fieldId.data,
    readableFieldIds: Object.freeze(
      readableFieldIds.flatMap((value) => (value.success ? [value.data] : [])),
    ),
    ...(sharedRecordGrant === undefined ? {} : { sharedRecordGrant }),
    validUntil: validUntil.data,
  });
};

/**
 * Whether the viewer's organisation may read this file: its own organisation's
 * file, or a source organisation's file through a live grant that names this
 * exact source record, attachment field, recipient organisation and, where the
 * grant is narrower, recipient account and application.
 */
const organisationMayRead = (
  authority: CurrentReadAuthority,
  fileRecord: FileRecord,
  nowMilliseconds: number,
): boolean => {
  if (fileRecord.organizationId === authority.viewer.organizationId) return true;
  const grant = authority.sharedRecordGrant;
  if (grant === undefined || grant.revoked) return false;
  const actor = authority.viewer.actor;
  return (
    nowMilliseconds < Date.parse(grant.expiresAt) &&
    grant.sourceOrganizationId === fileRecord.organizationId &&
    grant.recipientOrganizationId === authority.viewer.organizationId &&
    grant.sourceRecordTypeId === fileRecord.ownerRecordTypeId &&
    grant.sourceRecordId === fileRecord.ownerRecordId &&
    grant.readableFieldIds.includes(authority.fieldId) &&
    (grant.recipientOrganizationAccountId === undefined ||
      (actor.kind === "human" && actor.organizationAccountId === grant.recipientOrganizationAccountId)) &&
    (grant.recipientApplicationRootId === undefined ||
      authority.viewer.applicationRootId === grant.recipientApplicationRootId)
  );
};

type Representation =
  | Readonly<{ kind: "original"; disposition: "attachment" | "inline"; mediaType: string }>
  | Readonly<{ kind: "rendition" }>;

const chooseRepresentation = (
  fileRecord: FileRecord,
  purpose: FileReadPurpose,
  hasRenderer: boolean,
): Representation | null => {
  const active = isExecutableOrActiveBrowserContent(
    fileRecord.detectedMediaType,
    fileRecord.extension,
  );
  if (purpose === "download") {
    return {
      kind: "original",
      disposition: "attachment",
      mediaType: active ? "application/octet-stream" : normalizeMediaType(fileRecord.detectedMediaType),
    };
  }
  if (canPreviewOriginalInline(fileRecord)) {
    return {
      kind: "original",
      disposition: "inline",
      mediaType: normalizeMediaType(fileRecord.detectedMediaType),
    };
  }
  return hasRenderer ? { kind: "rendition" } : null;
};

/**
 * Serves one private file request. Each call independently re-verifies the
 * Access-resolved viewer authority for the file's owning record and attachment
 * field, organisation or live sharing grant, file lifecycle and safety; then
 * records a one-time grant that the bridge claims to mint one server-held read
 * credential of at most 60 seconds. Bytes are streamed through this process;
 * no Storage address, bearer or redirect ever reaches the client.
 */
export const createFileReadCoordinator = (
  dependencies: FileReadCoordinatorDependencies,
): FileReadCoordinator => {
  if (
    typeof dependencies?.repository?.readFile !== "function" ||
    typeof dependencies.repository.recordDownloadGrant !== "function" ||
    typeof dependencies.repository.claimDownloadGrant !== "function"
  ) {
    throw new Error("File reads require a durable read-grant repository");
  }
  if (typeof dependencies.bridge?.mintStorageOperationCredential !== "function") {
    throw new Error("File reads require the Storage credential bridge");
  }
  if (typeof dependencies.upstreamStorageReader !== "function") {
    throw new Error("File reads require a server-side Storage reader");
  }
  const clock = dependencies.clock ?? (() => new Date());
  const maximumPreviewSourceBytes = positiveLimit(
    dependencies.maximumPreviewSourceBytes,
    DEFAULT_MAXIMUM_PREVIEW_SOURCE_BYTES,
  );
  const maximumPreviewOutputBytes = positiveLimit(
    dependencies.maximumPreviewOutputBytes,
    DEFAULT_MAXIMUM_PREVIEW_OUTPUT_BYTES,
  );

  const readFile = async (
    authorityCandidate: CurrentReadAuthority,
    request: FileReadRequest,
  ): Promise<FileReadResult> => {
    const now = clock();
    const nowMilliseconds = now.getTime();
    if (!Number.isFinite(nowMilliseconds)) return refusal("authority_unavailable");

    const fileId = fileIdSchema.safeParse(request?.fileId);
    if (!fileId.success || (request.purpose !== "download" && request.purpose !== "preview")) {
      return refusal("malformed_request");
    }

    const authority = parseAuthority(authorityCandidate);
    if (authority === null || !(nowMilliseconds < Date.parse(authority.validUntil))) {
      return refusal("authority_unavailable");
    }

    if (
      !verifyAttachmentFieldAuthority({
        fieldId: authority.fieldId,
        readableFieldIds: authority.readableFieldIds,
        changeableFieldIds: [],
        operation: "read",
      }).authorized
    ) {
      return refusal("field_not_readable");
    }

    let loaded: FileRecord | null;
    try {
      loaded = await dependencies.repository.readFile(fileId.data);
    } catch {
      return refusal("storage_unavailable");
    }
    const parsedFile = loaded === null ? null : fileRecordSchema.safeParse(loaded);
    if (parsedFile === null || !parsedFile.success || parsedFile.data.fileId !== fileId.data) {
      return refusal("file_not_found");
    }
    const fileRecord = parsedFile.data;

    // The file must be attached to exactly the record field the Access decision
    // covered, in the viewer's organisation or a live grant's source record.
    if (
      fileRecord.ownerRecordTypeId !== authority.recordTypeId ||
      fileRecord.ownerRecordId !== authority.recordId ||
      fileRecord.ownerFieldId !== authority.fieldId ||
      !organisationMayRead(authority, fileRecord, nowMilliseconds)
    ) {
      return refusal("file_not_found");
    }

    if (fileRecord.lifecycleState !== "active" || fileRecord.scannerResult !== "clean") {
      return refusal("file_not_available");
    }

    const representation = chooseRepresentation(
      fileRecord,
      request.purpose,
      dependencies.previewRenderer !== undefined,
    );
    if (representation === null) return refusal("preview_not_supported");
    if (representation.kind === "rendition" && fileRecord.sizeBytes > maximumPreviewSourceBytes) {
      return refusal("preview_not_supported");
    }

    // Ranges apply only to the original bytes, and only while the client's
    // validator still names this exact content.
    const etag = entityTag(fileRecord);
    const rangeApplies =
      representation.kind === "original" &&
      (request.ifRangeHeader === undefined || request.ifRangeHeader.trim() === etag);
    const range = rangeApplies
      ? parseRangeHeader(request.rangeHeader, fileRecord.sizeBytes)
      : ({ kind: "none" } as const);
    if (range.kind === "unsatisfiable") {
      return refusal("range_not_satisfiable", {
        "Content-Range": `bytes */${fileRecord.sizeBytes}`,
        "Accept-Ranges": "bytes",
      });
    }

    // One unclaimed grant for this request; the bridge's read resolver claims it
    // to mint exactly one credential bound to this exact object and viewer.
    let credential: StorageOperationCredential;
    try {
      const oneTimeId = platformIdSchema.parse(randomUUID());
      const correlationId = correlationIdSchema.parse(randomUUID());
      const grant = downloadGrantSchema.parse({
        kind: "download",
        organizationId: fileRecord.organizationId,
        actor: authority.viewer.actor,
        recordTypeId: authority.recordTypeId,
        recordId: authority.recordId,
        fieldId: authority.fieldId,
        fileId: fileRecord.fileId,
        oneTimeId,
        expiresAt: new Date(
          Math.min(
            nowMilliseconds + MAXIMUM_FILE_STORAGE_OPERATION_SECONDS * 1_000,
            Date.parse(authority.validUntil),
          ),
        ).toISOString(),
      });
      await dependencies.repository.recordDownloadGrant({
        grant,
        correlationId,
        purpose: request.purpose,
      });
      credential = await dependencies.bridge.mintStorageOperationCredential({
        request: { operation: "read", grant },
        ttlSeconds: MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
      });
    } catch {
      return refusal("storage_unavailable");
    }
    if (
      credential.operation !== "read" ||
      credential.organizationId !== fileRecord.organizationId ||
      credential.objectPath !== fileRecord.storageKey
    ) {
      return refusal("storage_unavailable");
    }

    const selectedRange = range.kind === "satisfiable" ? range.range : undefined;
    let upstream: UpstreamStorageReadResult;
    try {
      upstream = await dependencies.upstreamStorageReader({
        credential,
        ...(selectedRange === undefined ? {} : { range: selectedRange }),
      });
    } catch {
      return refusal("storage_unavailable");
    }

    const expectedBytes =
      selectedRange === undefined
        ? fileRecord.sizeBytes
        : selectedRange.end - selectedRange.start + 1;
    const expectedContentRange =
      selectedRange === undefined
        ? undefined
        : `bytes ${selectedRange.start}-${selectedRange.end}/${fileRecord.sizeBytes}`;
    if (
      (upstream.contentLength !== undefined && upstream.contentLength !== expectedBytes) ||
      (expectedContentRange !== undefined &&
        upstream.contentRange !== undefined &&
        upstream.contentRange.trim() !== expectedContentRange)
    ) {
      await upstream.stream.cancel().catch(() => undefined);
      return refusal("storage_unavailable");
    }
    const original = boundedByteStream(upstream.stream, {
      expectedBytes,
      maximumBytes: expectedBytes,
    });

    if (representation.kind === "rendition") {
      const renderer = dependencies.previewRenderer!;
      let rendition: Awaited<ReturnType<FilePreviewRenderer>>;
      try {
        rendition = await renderer({
          fileRecord,
          source: original,
          maximumOutputBytes: maximumPreviewOutputBytes,
        });
      } catch {
        await original.cancel().catch(() => undefined);
        return refusal("preview_unavailable");
      }
      const renditionType = normalizeMediaType(rendition.mediaType ?? "");
      if (
        !PREVIEW_RENDITION_MEDIA_TYPES.has(renditionType) ||
        (rendition.sizeBytes !== undefined &&
          (!Number.isSafeInteger(rendition.sizeBytes) ||
            rendition.sizeBytes < 0 ||
            rendition.sizeBytes > maximumPreviewOutputBytes))
      ) {
        await rendition.stream?.cancel().catch(() => undefined);
        return refusal("preview_unavailable");
      }
      return Object.freeze({
        outcome: "success",
        fileId: fileRecord.fileId,
        statusCode: 200,
        headers: Object.freeze({
          ...privateFileResponseHeaders(),
          "Content-Type": renditionType,
          "Content-Disposition": buildContentDisposition(
            "inline",
            fileRecord.originalSafeDisplayName,
            fileRecord.extension,
          ),
          ...(rendition.sizeBytes === undefined
            ? {}
            : { "Content-Length": String(rendition.sizeBytes) }),
        }),
        stream: boundedByteStream(rendition.stream, {
          ...(rendition.sizeBytes === undefined ? {} : { expectedBytes: rendition.sizeBytes }),
          maximumBytes: maximumPreviewOutputBytes,
        }),
      });
    }

    return Object.freeze({
      outcome: "success",
      fileId: fileRecord.fileId,
      statusCode: selectedRange === undefined ? 200 : 206,
      headers: Object.freeze({
        ...privateFileResponseHeaders(),
        "Content-Type": representation.mediaType,
        "Content-Disposition": buildContentDisposition(
          representation.disposition,
          fileRecord.originalSafeDisplayName,
          fileRecord.extension,
        ),
        "Content-Length": String(expectedBytes),
        "Accept-Ranges": "bytes",
        ETag: etag,
        ...(expectedContentRange === undefined ? {} : { "Content-Range": expectedContentRange }),
      }),
      stream: original,
    });
  };

  return Object.freeze({ readFile });
};

/** One pending upload whose window closed, or an abandoned upload whose removal has not finished. */
export type AbandonedUploadCandidate = Readonly<{
  fileRecord: FileRecord;
  revision: number;
  uploadExpiresAt: string;
}>;

/**
 * The owning upload store's abandonment boundary. Neither method touches a
 * record, its revision or its activity history.
 */
export type AbandonedUploadCleanupRepository = Readonly<{
  /**
   * A bounded, oldest-first batch: pending uploads whose window closed before
   * `expiredBefore`, and abandoned uploads that are not yet removed.
   */
  listAbandonmentCandidates(
    input: Readonly<{ limit: number; expiredBefore: string }>,
  ): Promise<readonly AbandonedUploadCandidate[]>;
  /**
   * Compare-and-set of an expired pending upload to abandoned, superseding every
   * upload grant so no further credential can be issued for it.
   */
  abandonExpiredUpload(
    input: Readonly<{ fileId: FileId; expectedRevision: number; abandonedAt: string }>,
  ): Promise<
    | Readonly<{ outcome: "abandoned" }>
    | Readonly<{ outcome: "refused"; reason: "not_pending" | "window_open" | "revision_conflict" }>
  >;
}>;

export type AbandonedUploadCleanupDependencies = Readonly<{
  repository: AbandonedUploadCleanupRepository;
  /** The #657 removal decision boundary; abandoned files are removal-eligible there. */
  removalEligibility: Pick<FileRemovalEligibilityService, "decideFileRemovalEligibility">;
  /** The owning removal coordinator, which deletes previews and the object through the bridge's delete authority. */
  removalCoordinator: FileRemovalCoordinator;
  clock?: () => Date;
}>;

export type AbandonedUploadCleanupOutcome = Readonly<{
  fileId: FileId;
  outcome: "removed" | "in_progress" | "skipped" | "failed";
}>;

export type AbandonedUploadCleanupResult = Readonly<{
  examined: number;
  abandoned: number;
  removed: number;
  outcomes: readonly AbandonedUploadCleanupOutcome[];
}>;

export const MAXIMUM_ABANDONED_UPLOAD_BATCH = 100;

/** A stable identifier derived from the removal decision, formatted as a version 8 UUID. */
const derivedUuid = (material: string): string => {
  const hex = createHash("sha256").update(material, "utf8").digest("hex");
  const variant = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const isTerminalRemoval = (result: FileRemovalResult): boolean => result.status === "completed";

/**
 * Removes a bounded batch of abandoned uploads. Expired pending uploads are
 * first marked abandoned in the owning upload store; each abandoned upload is
 * then removed through the #657 eligibility decision and the owning removal
 * coordinator, which cleans previews, the private object and metadata. No
 * record or record activity is touched, and a failure of one upload does not
 * stop the batch.
 */
export const cleanupAbandonedUploads = async (
  dependencies: AbandonedUploadCleanupDependencies,
  options?: Readonly<{ limit?: number }>,
): Promise<AbandonedUploadCleanupResult> => {
  const clock = dependencies.clock ?? (() => new Date());
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new Error("Abandoned upload cleanup clock is invalid");
  const limit = Math.min(
    positiveLimit(options?.limit, MAXIMUM_ABANDONED_UPLOAD_BATCH),
    MAXIMUM_ABANDONED_UPLOAD_BATCH,
  );
  const candidates = (
    await dependencies.repository.listAbandonmentCandidates({
      limit,
      expiredBefore: now.toISOString(),
    })
  ).slice(0, limit);

  let abandoned = 0;
  let removed = 0;
  const outcomes: AbandonedUploadCleanupOutcome[] = [];
  for (const candidate of candidates) {
    const parsed = fileRecordSchema.safeParse(candidate.fileRecord);
    if (!parsed.success) continue;
    const fileRecord = parsed.data;
    try {
      if (fileRecord.lifecycleState === "pending") {
        if (!(Date.parse(candidate.uploadExpiresAt) <= now.getTime())) {
          outcomes.push({ fileId: fileRecord.fileId, outcome: "skipped" });
          continue;
        }
        const marked = await dependencies.repository.abandonExpiredUpload({
          fileId: fileRecord.fileId,
          expectedRevision: candidate.revision,
          abandonedAt: now.toISOString(),
        });
        if (marked.outcome !== "abandoned") {
          outcomes.push({ fileId: fileRecord.fileId, outcome: "skipped" });
          continue;
        }
        abandoned += 1;
      } else if (fileRecord.lifecycleState !== "abandoned") {
        outcomes.push({ fileId: fileRecord.fileId, outcome: "skipped" });
        continue;
      }

      const decision = await dependencies.removalEligibility.decideFileRemovalEligibility({
        fileId: fileRecord.fileId,
      });
      if (!decision.eligible) {
        outcomes.push({ fileId: fileRecord.fileId, outcome: "skipped" });
        continue;
      }
      const material = [
        "vortex:file:abandoned-upload",
        fileRecord.fileId,
        decision.binding.authorityFingerprint,
        decision.binding.fileRevision,
        decision.decidedAt,
      ].join(":");
      const result = await dependencies.removalCoordinator.coordinateFileRemoval({
        fileId: fileRecord.fileId,
        deletionKey: `abandoned-upload:${createHash("sha256").update(material, "utf8").digest("hex")}`,
        decision,
        correlationId: derivedUuid(material),
      });
      if (isTerminalRemoval(result)) {
        removed += 1;
        outcomes.push({ fileId: fileRecord.fileId, outcome: "removed" });
      } else {
        outcomes.push({ fileId: fileRecord.fileId, outcome: "in_progress" });
      }
    } catch {
      outcomes.push({ fileId: fileRecord.fileId, outcome: "failed" });
    }
  }

  return Object.freeze({
    examined: candidates.length,
    abandoned,
    removed,
    outcomes: Object.freeze(outcomes),
  });
};
