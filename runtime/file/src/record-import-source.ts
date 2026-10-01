import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  PRIVATE_FILE_BUCKET,
  STRUCTURED_RECORD_IMPORT_FORMAT,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES,
  correlationIdSchema,
  fileIdSchema,
  fileRecordSchema,
  fingerprintSchema,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  type CorrelationId,
  type FileRecord,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecordImportSourceRefusalReason,
  type RecordImportSourceResult,
} from "@vortex/contracts";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "@vortex/access";
import {
  createStorageCredentialBridge,
  type StorageCredentialBridgeConfig,
} from "./storage-credentials";
import {
  composeStorageAuthorityResolvers,
  createFileReadCoordinator,
  createReadStorageAuthorityResolver,
  type UpstreamStorageReader,
} from "./read";
import {
  createSqlFileReadRepository,
  decideFileRead,
  locateFileApplication,
} from "./read-repository";
import {
  decodeStructuredRecordImport,
  type StructuredRecordImportDecodeResult,
} from "./structured-record-import-decoder";

const FILE_IMPORT_DECISION_WINDOW_SECONDS = 30;

type SigningConfiguration = Pick<
  StorageCredentialBridgeConfig,
  "destinationProject" | "issuer" | "activeKeyId" | "keys"
>;

export type FileRecordImportSourceDependencies = Readonly<
  Omit<HumanOrganizationRequestDependencies, "correlationId"> &
    SigningConfiguration &
    Readonly<{ upstreamStorageReader: UpstreamStorageReader }>
>;

export type FileRecordImportSourceService = Readonly<{
  read(
    session: IdentitySession,
    organizationCandidate: OrganizationSelectionCandidate,
    fileIdCandidate: string,
  ): Promise<RecordImportSourceResult>;
}>;

type TimedResult<Result> =
  Readonly<{ kind: "completed"; value: Result }> | Readonly<{ kind: "expired" }>;

const expiredAt = (clock: () => Date, deadlineMilliseconds: number): boolean => {
  const now = clock().getTime();
  return !Number.isFinite(now) || now >= deadlineMilliseconds;
};

const cancelStream = (stream: ReadableStream<Uint8Array>): void => {
  try {
    const reader = stream.getReader();
    void reader
      .cancel()
      .catch(() => undefined)
      .finally(() => {
        try {
          reader.releaseLock();
        } catch {
          // Cancellation is best-effort after the protected decision closes.
        }
      });
  } catch {
    if (!stream.locked) void stream.cancel().catch(() => undefined);
  }
};

/** Observe a late upstream result so a stream arriving after expiry is closed. */
const waitUntil = <Result>(
  pending: Promise<Result>,
  deadlineMilliseconds: number,
  clock: () => Date,
  closeLateResult: (value: Result) => void,
): Promise<TimedResult<Result>> =>
  new Promise((resolve) => {
    let settled = false;
    const remainingMilliseconds = deadlineMilliseconds - clock().getTime();
    if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0) {
      void pending.then(closeLateResult, () => undefined);
      resolve({ kind: "expired" });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "expired" });
    }, remainingMilliseconds);

    void pending.then(
      (value) => {
        if (settled) {
          closeLateResult(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (expiredAt(clock, deadlineMilliseconds)) {
          closeLateResult(value);
          resolve({ kind: "expired" });
          return;
        }
        resolve({ kind: "completed", value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "expired" });
      },
    );
  });

const boundedUpstreamReader =
  (
    upstreamStorageReader: UpstreamStorageReader,
    clock: () => Date,
    deadlineMilliseconds: number,
  ): UpstreamStorageReader =>
  async (options) => {
    if (expiredAt(clock, deadlineMilliseconds)) throw new Error("FILE_IMPORT_SOURCE_EXPIRED");
    const pending = Promise.resolve().then(() => upstreamStorageReader(options));
    const result = await waitUntil(pending, deadlineMilliseconds, clock, (late) =>
      cancelStream(late.stream),
    );
    if (result.kind !== "completed") throw new Error("FILE_IMPORT_SOURCE_EXPIRED");
    return result.value;
  };

type ReaderReadResult =
  | Readonly<{ kind: "read"; value: ReadableStreamReadResult<Uint8Array> }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "failed" }>;

const cancelReaderAndRelease = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  void reader
    .cancel()
    .catch(() => undefined)
    .finally(() => {
      try {
        reader.releaseLock();
      } catch {
        // A late underlying read may still be settling after cancellation.
      }
    });
};

const readUntil = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMilliseconds: number,
  clock: () => Date,
): Promise<ReaderReadResult> =>
  new Promise((resolve) => {
    let settled = false;
    const remainingMilliseconds = deadlineMilliseconds - clock().getTime();
    if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0) {
      cancelReaderAndRelease(reader);
      resolve({ kind: "expired" });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cancelReaderAndRelease(reader);
      resolve({ kind: "expired" });
    }, remainingMilliseconds);

    void reader.read().then(
      (value) => {
        if (settled) {
          try {
            reader.releaseLock();
          } catch {
            // The stream may still be cancelling after the bounded read ended.
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(
          expiredAt(clock, deadlineMilliseconds) ? { kind: "expired" } : { kind: "read", value },
        );
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "failed" });
      },
    );
  });

const consumeAuthorizedStream = async (
  stream: ReadableStream<Uint8Array>,
  sizeBytes: number,
  deadlineMilliseconds: number,
  clock: () => Date,
  exposeReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<Uint8Array | null> => {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    cancelStream(stream);
    return null;
  }
  exposeReader(reader);

  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  let release = true;
  try {
    while (true) {
      const next = await readUntil(reader, deadlineMilliseconds, clock);
      if (next.kind !== "read") {
        release = next.kind === "failed";
        if (next.kind === "expired") cancelReaderAndRelease(reader);
        else void reader.cancel().catch(() => undefined);
        return null;
      }
      if (next.value.done) break;
      const chunk = next.value.value;
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength > sizeBytes - offset ||
        expiredAt(clock, deadlineMilliseconds)
      ) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== sizeBytes || expiredAt(clock, deadlineMilliseconds)) return null;
    return bytes;
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    if (release) {
      try {
        reader.releaseLock();
      } catch {
        // A failed read or cancellation can leave a pending underlying read.
      }
    }
  }
};

const sourceRefusal = (
  reason: RecordImportSourceRefusalReason,
  position?: Readonly<{ rowNumber?: number; columnNumber?: number }>,
): RecordImportSourceResult =>
  Object.freeze({
    kind: "refused",
    reason,
    ...(position?.rowNumber === undefined ? {} : { rowNumber: position.rowNumber }),
    ...(position?.columnNumber === undefined ? {} : { columnNumber: position.columnNumber }),
  });

const isExpectedOwner = (
  file: FileRecord,
  decision: Awaited<ReturnType<typeof decideFileRead>>,
  organizationId: string,
  applicationRootId: string,
): decision is Extract<Awaited<ReturnType<typeof decideFileRead>>, { outcome: "allowed" }> =>
  decision.outcome === "allowed" &&
  decision.organizationId === organizationId &&
  decision.applicationRootId === applicationRootId &&
  file.organizationId === organizationId &&
  (file.applicationRootId === undefined || file.applicationRootId === applicationRootId) &&
  file.ownerRecordTypeId === decision.recordTypeId &&
  file.ownerRecordId === decision.recordId &&
  file.ownerFieldId === decision.fieldId;

const validCanonicalFile = (candidate: unknown): FileRecord | null => {
  const parsed = fileRecordSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const file = parsed.data;
  const checksum = fingerprintSchema.safeParse(file.checksum);
  if (
    !checksum.success ||
    file.bucketId !== PRIVATE_FILE_BUCKET ||
    file.lifecycleState !== "active" ||
    file.scannerResult !== "clean" ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes < 0
  ) {
    return null;
  }
  return file;
};

const sameCanonicalAttachment = (left: FileRecord, right: FileRecord): boolean =>
  left.fileId === right.fileId &&
  left.organizationId === right.organizationId &&
  left.applicationRootId === right.applicationRootId &&
  left.ownerRecordTypeId === right.ownerRecordTypeId &&
  left.ownerRecordId === right.ownerRecordId &&
  left.ownerFieldId === right.ownerFieldId;

const sameCanonicalContent = (left: FileRecord, right: FileRecord): boolean =>
  left.sizeBytes === right.sizeBytes && left.checksum === right.checksum;

const decodeResultToRefusal = (
  decoded: StructuredRecordImportDecodeResult,
): RecordImportSourceResult | null =>
  decoded.outcome === "refused" ? sourceRefusal(decoded.reason, decoded) : null;

/** Build a protected source for one active private File attachment. */
export const createFileRecordImportSourceService = (
  dependencies: FileRecordImportSourceDependencies,
): FileRecordImportSourceService => {
  if (typeof dependencies?.upstreamStorageReader !== "function") {
    throw new Error("Structured File import requires a server-side Storage reader");
  }
  const clock = dependencies.clock ?? (() => new Date());

  const read = async (
    sessionCandidate: IdentitySession,
    organizationCandidate: OrganizationSelectionCandidate,
    fileIdCandidate: string,
  ): Promise<RecordImportSourceResult> => {
    const session = identitySessionSchema.safeParse(sessionCandidate);
    const organization = organizationSelectionCandidateSchema.safeParse(organizationCandidate);
    const fileId = fileIdSchema.safeParse(fileIdCandidate);
    if (!session.success || !organization.success || !fileId.success) {
      return sourceRefusal("malformed_request");
    }

    let correlationId: CorrelationId;
    try {
      correlationId = correlationIdSchema.parse(randomUUID());
    } catch {
      return sourceRefusal("storage_unavailable");
    }
    const protectedRequests = createHumanOrganizationRequestService({
      identityAuthorityId: dependencies.identityAuthorityId,
      ...(dependencies.channel === undefined ? {} : { channel: dependencies.channel }),
      ...(dependencies.resolvedRequestTransaction === undefined
        ? {}
        : { resolvedRequestTransaction: dependencies.resolvedRequestTransaction }),
      clock,
      correlationId: () => correlationId,
      ...(dependencies.telemetry === undefined ? {} : { telemetry: dependencies.telemetry }),
    });

    const located = await protectedRequests.run(
      session.data,
      // The optional applicationRootId on the candidate is deliberately ignored;
      // the protected File lookup below supplies the actual source application.
      { organizationId: organization.data.organizationId },
      (transaction) => locateFileApplication(transaction, fileId.data),
    );
    if (located.kind !== "available" || located.value.outcome !== "located") {
      return sourceRefusal(
        located.kind === "temporarily_unavailable" ? "storage_unavailable" : "file_not_found",
      );
    }
    const applicationRootId = located.value.applicationRootId;
    let openedReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const closeOpenedReader = (): void => {
      const reader = openedReader;
      openedReader = undefined;
      if (reader === undefined) return;
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The reader may already be closed or released after a completed body.
      }
    };

    const protectedRead = await protectedRequests.run(
      session.data,
      { organizationId: organization.data.organizationId, applicationRootId },
      async (transaction, scope, issuedAt): Promise<RecordImportSourceResult> => {
        const issuedAtMilliseconds = Date.parse(issuedAt);
        const deadlineMilliseconds =
          issuedAtMilliseconds + FILE_IMPORT_DECISION_WINDOW_SECONDS * 1_000;
        if (
          !Number.isFinite(issuedAtMilliseconds) ||
          !Number.isFinite(deadlineMilliseconds) ||
          expiredAt(clock, deadlineMilliseconds) ||
          scope.organizationId !== organization.data.organizationId ||
          scope.applicationRootId !== applicationRootId
        ) {
          return sourceRefusal("source_expired");
        }

        try {
          const decision = await decideFileRead(transaction, fileId.data);
          if (decision.outcome !== "allowed") {
            return sourceRefusal("file_not_found");
          }
          if (
            decision.organizationId !== scope.organizationId ||
            decision.applicationRootId !== applicationRootId
          ) {
            return sourceRefusal("file_not_found");
          }

          const repository = createSqlFileReadRepository(transaction);
          const initialCandidate = await repository.readFile(fileId.data);
          const initialFile =
            initialCandidate === null ? null : validCanonicalFile(initialCandidate);
          if (
            initialFile === null ||
            initialFile.fileId !== fileId.data ||
            !isExpectedOwner(initialFile, decision, scope.organizationId, applicationRootId)
          ) {
            return sourceRefusal("file_not_found");
          }
          if (initialFile.sizeBytes > STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES) {
            return sourceRefusal("source_too_large");
          }

          const validUntil = new Date(deadlineMilliseconds).toISOString();
          const deadlineReader = boundedUpstreamReader(
            dependencies.upstreamStorageReader,
            clock,
            deadlineMilliseconds,
          );
          const bridge = createStorageCredentialBridge({
            destinationProject: dependencies.destinationProject,
            issuer: dependencies.issuer,
            activeKeyId: dependencies.activeKeyId,
            keys: dependencies.keys,
            resolveCurrentAuthority: composeStorageAuthorityResolvers({
              read: createReadStorageAuthorityResolver(repository, clock),
            }),
            clock,
          });
          const coordinator = createFileReadCoordinator({
            repository,
            bridge,
            upstreamStorageReader: deadlineReader,
            correlationId: () => correlationId,
            clock,
          });
          const opened = await coordinator.readFile(
            {
              viewer: {
                organizationId: scope.organizationId,
                actor: {
                  kind: "human",
                  organizationAccountId: scope.organizationAccountId,
                  identityId: session.data.identityId,
                },
                applicationRootId,
              },
              recordTypeId: decision.recordTypeId,
              recordId: decision.recordId,
              fieldId: decision.fieldId,
              readableFieldIds: [decision.fieldId],
              validUntil,
            },
            { fileId: fileId.data, purpose: "download" },
          );
          if (opened.outcome !== "success") {
            return sourceRefusal(
              expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "storage_unavailable",
            );
          }
          openedReader = undefined;
          const bytes = await consumeAuthorizedStream(
            opened.stream,
            initialFile.sizeBytes,
            deadlineMilliseconds,
            clock,
            (reader) => {
              openedReader = reader;
            },
          );
          openedReader = undefined;
          if (bytes === null) {
            return sourceRefusal(
              expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "storage_unavailable",
            );
          }
          const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          if (bytes.byteLength !== initialFile.sizeBytes || checksum !== initialFile.checksum) {
            return sourceRefusal("source_changed");
          }

          if (expiredAt(clock, deadlineMilliseconds)) return sourceRefusal("source_expired");
          const decoded = decodeStructuredRecordImport(bytes);
          const decodeRefusal = decodeResultToRefusal(decoded);
          if (decodeRefusal !== null) return decodeRefusal;
          if (decoded.outcome !== "decoded") return sourceRefusal("invalid_document");

          if (expiredAt(clock, deadlineMilliseconds)) return sourceRefusal("source_expired");
          const finalDecision = await decideFileRead(transaction, fileId.data);
          const finalCandidate = await repository.readFile(fileId.data);
          const finalFile = finalCandidate === null ? null : validCanonicalFile(finalCandidate);
          if (
            finalFile === null ||
            !isExpectedOwner(finalFile, finalDecision, scope.organizationId, applicationRootId) ||
            !sameCanonicalAttachment(initialFile, finalFile) ||
            expiredAt(clock, deadlineMilliseconds)
          ) {
            return sourceRefusal(
              expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "file_not_found",
            );
          }
          if (!sameCanonicalContent(initialFile, finalFile)) return sourceRefusal("source_changed");
          if (expiredAt(clock, deadlineMilliseconds)) return sourceRefusal("source_expired");

          const source = Object.freeze({
            format: STRUCTURED_RECORD_IMPORT_FORMAT,
            organizationId: scope.organizationId,
            applicationRootId,
            fileId: initialFile.fileId,
            checksum: initialFile.checksum,
            sizeBytes: initialFile.sizeBytes,
            ownerRecordTypeId: decision.recordTypeId,
            ownerRecordId: decision.recordId,
            ownerFieldId: decision.fieldId,
            viewerIdentityId: session.data.identityId,
            viewerOrganizationAccountId: scope.organizationAccountId,
            correlationId,
            issuedAt: new Date(issuedAtMilliseconds).toISOString(),
            validUntil,
          });
          return Object.freeze({
            kind: "available",
            source,
            columns: decoded.columns,
            rows: decoded.rows,
          });
        } catch {
          closeOpenedReader();
          return sourceRefusal(
            expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "storage_unavailable",
          );
        }
      },
    );

    if (protectedRead.kind !== "available") {
      closeOpenedReader();
      return sourceRefusal(
        protectedRead.kind === "temporarily_unavailable" ? "storage_unavailable" : "file_not_found",
      );
    }
    if (
      protectedRead.value.kind === "available" &&
      expiredAt(clock, Date.parse(protectedRead.value.source.validUntil))
    ) {
      return sourceRefusal("source_expired");
    }
    return protectedRead.value;
  };

  return Object.freeze({ read });
};
