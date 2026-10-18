import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  PRIVATE_FILE_BUCKET,
  MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
  STRUCTURED_RECORD_IMPORT_FORMAT,
  STRUCTURED_RECORD_IMPORT_MAXIMUM_SOURCE_BYTES,
  correlationIdSchema,
  downloadGrantSchema,
  fileIdSchema,
  fileRecordSchema,
  fingerprintSchema,
  identitySessionSchema,
  organizationSelectionCandidateSchema,
  platformIdSchema,
  type CorrelationId,
  type FileRecord,
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type RecordImportSourceRefusalReason,
  type RecordImportSourceResult,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestDependencies,
} from "../access/index";
import {
  createStorageCredentialBridge,
  type StorageCredentialBridgeConfig,
} from "./storage-credentials";
import {
  composeStorageAuthorityResolvers,
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
  "destination" | "activeKeyId" | "keys"
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

/** Stream cleanup is best effort: it never changes the import outcome, but a failure is logged. */
const logStreamCleanupFailure = (code: string, error: unknown): void => {
  console.warn(code, { cause: error instanceof Error ? error.name : typeof error });
};

const cancelStream = (stream: ReadableStream<Uint8Array>): void => {
  try {
    const reader = stream.getReader();
    cancelReaderAndRelease(reader);
  } catch (error) {
    logStreamCleanupFailure("FILE_IMPORT_STREAM_CANCEL_FAILED", error);
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
    return {
      ...result.value,
      stream: deadlineOwnedStream(result.value.stream, deadlineMilliseconds, clock),
    };
  };

type ReaderReadResult =
  | Readonly<{
      kind: "read";
      value: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
    }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "failed" }>;

const cancelReaderAndRelease = (reader: ReadableStreamDefaultReader<Uint8Array>): void => {
  try {
    void reader.cancel().catch(() => undefined);
  } catch (error) {
    // A completed stream may already have released its reader.
    logStreamCleanupFailure("FILE_IMPORT_READER_CANCEL_FAILED", error);
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      // Cancellation is best-effort after the protected decision closes.
      logStreamCleanupFailure("FILE_IMPORT_READER_RELEASE_FAILED", error);
    }
  }
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
          } catch (error) {
            // The stream may still be cancelling after the bounded read ended.
            logStreamCleanupFailure("FILE_IMPORT_READER_RELEASE_FAILED", error);
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

/** Own the acquired reader without awaiting an unbounded cancellation promise. */
const deadlineOwnedStream = (
  source: ReadableStream<Uint8Array>,
  deadlineMilliseconds: number,
  clock: () => Date,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let closed = false;
  const close = (cancel: boolean): void => {
    if (closed) return;
    closed = true;
    if (cancel) {
      cancelReaderAndRelease(reader);
      return;
    }
    try {
      reader.releaseLock();
    } catch (error) {
      // The completed upstream reader may already have released its lock.
      logStreamCleanupFailure("FILE_IMPORT_READER_RELEASE_FAILED", error);
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) return;
        const next = await readUntil(reader, deadlineMilliseconds, clock);
        if (closed) return;
        if (next.kind !== "read") {
          close(true);
          controller.error(new Error("FILE_IMPORT_SOURCE_UNAVAILABLE"));
          return;
        }
        if (next.value.done) {
          close(false);
          controller.close();
          return;
        }
        controller.enqueue(next.value.value);
      },
      cancel() {
        close(true);
      },
    },
    { highWaterMark: 0 },
  );
};

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
  } catch (error) {
    logStreamCleanupFailure("FILE_IMPORT_STREAM_NOT_READABLE", error);
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
  } catch (error) {
    logStreamCleanupFailure("FILE_IMPORT_STREAM_READ_FAILED", error);
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    if (release) {
      try {
        reader.releaseLock();
      } catch (error) {
        // A failed read or cancellation can leave a pending underlying read.
        logStreamCleanupFailure("FILE_IMPORT_READER_RELEASE_FAILED", error);
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
      } catch (error) {
        // The reader may already be closed or released after a completed body.
        logStreamCleanupFailure("FILE_IMPORT_READER_CANCEL_FAILED", error);
      }
    };

    const initialRead = await protectedRequests.run(
      session.data,
      { organizationId: organization.data.organizationId, applicationRootId },
      async (transaction, scope, issuedAt) => {
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
          const bridge = createStorageCredentialBridge({
            destination: dependencies.destination,
            activeKeyId: dependencies.activeKeyId,
            keys: dependencies.keys,
            resolveCurrentAuthority: composeStorageAuthorityResolvers({
              read: createReadStorageAuthorityResolver(repository, clock),
            }),
            clock,
          });
          const oneTimeId = platformIdSchema.parse(randomUUID());
          const grant = downloadGrantSchema.parse({
            kind: "download",
            organizationId: scope.organizationId,
            actor: {
              kind: "human",
              organizationAccountId: scope.organizationAccountId,
              identityId: session.data.identityId,
            },
            recordTypeId: decision.recordTypeId,
            recordId: decision.recordId,
            fieldId: decision.fieldId,
            fileId: fileId.data,
            oneTimeId,
            expiresAt: new Date(
              Math.min(
                clock().getTime() + MAXIMUM_FILE_STORAGE_OPERATION_SECONDS * 1_000,
                deadlineMilliseconds,
              ),
            ).toISOString(),
          });
          await repository.recordDownloadGrant({ grant, correlationId, purpose: "download" });
          const credential = await bridge.mintStorageOperationCredential({
            request: { operation: "read", grant },
            ttlSeconds: MAXIMUM_FILE_STORAGE_OPERATION_SECONDS,
          });
          if (
            credential.operation !== "read" ||
            credential.organizationId !== initialFile.organizationId ||
            credential.objectPath !== initialFile.storageKey
          )
            return sourceRefusal("storage_unavailable");
          return {
            kind: "ready" as const,
            initialFile,
            decision,
            credential,
            organizationAccountId: scope.organizationAccountId,
            issuedAtMilliseconds,
            deadlineMilliseconds,
            validUntil,
          };
        } catch (error) {
          console.error("FILE_IMPORT_INITIAL_READ_FAILED", { cause: error });
          return sourceRefusal(
            expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "storage_unavailable",
          );
        }
      },
    );

    if (initialRead.kind !== "available") {
      return sourceRefusal(
        initialRead.kind === "temporarily_unavailable" ? "storage_unavailable" : "file_not_found",
      );
    }
    if (initialRead.value.kind !== "ready") return initialRead.value;
    const {
      initialFile,
      decision,
      credential,
      organizationAccountId,
      issuedAtMilliseconds,
      deadlineMilliseconds,
      validUntil,
    } = initialRead.value;

    let decoded: Extract<StructuredRecordImportDecodeResult, { outcome: "decoded" }>;
    try {
      const deadlineReader = boundedUpstreamReader(
        dependencies.upstreamStorageReader,
        clock,
        deadlineMilliseconds,
      );
      const opened = await deadlineReader({ credential });
      if (
        opened.statusCode !== 200 ||
        (opened.contentLength !== undefined && opened.contentLength !== initialFile.sizeBytes)
      ) {
        cancelStream(opened.stream);
        return sourceRefusal("storage_unavailable");
      }
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
      if (bytes === null)
        return sourceRefusal(
          expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "storage_unavailable",
        );
      const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (checksum !== initialFile.checksum) return sourceRefusal("source_changed");
      if (expiredAt(clock, deadlineMilliseconds)) return sourceRefusal("source_expired");
      const result = decodeStructuredRecordImport(bytes);
      const decodeRefusal = decodeResultToRefusal(result);
      if (decodeRefusal !== null) return decodeRefusal;
      if (result.outcome !== "decoded") return sourceRefusal("invalid_document");
      decoded = result;
    } catch (error) {
      closeOpenedReader();
      console.error("FILE_IMPORT_STREAM_FAILED", { cause: error });
      return sourceRefusal(
        expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "storage_unavailable",
      );
    }

    if (expiredAt(clock, deadlineMilliseconds)) return sourceRefusal("source_expired");
    const finalRead = await protectedRequests.run(
      session.data,
      { organizationId: organization.data.organizationId, applicationRootId },
      async (transaction, scope) => {
        const finalDecision = await decideFileRead(transaction, fileId.data);
        const repository = createSqlFileReadRepository(transaction);
        const finalCandidate = await repository.readFile(fileId.data);
        const finalFile = finalCandidate === null ? null : validCanonicalFile(finalCandidate);
        if (
          finalFile === null ||
          !isExpectedOwner(finalFile, finalDecision, scope.organizationId, applicationRootId) ||
          !sameCanonicalAttachment(initialFile, finalFile) ||
          expiredAt(clock, deadlineMilliseconds)
        )
          return sourceRefusal(
            expiredAt(clock, deadlineMilliseconds) ? "source_expired" : "file_not_found",
          );
        if (!sameCanonicalContent(initialFile, finalFile)) return sourceRefusal("source_changed");
        if (
          scope.organizationAccountId !== organizationAccountId ||
          finalDecision.recordTypeId !== decision.recordTypeId ||
          finalDecision.recordId !== decision.recordId ||
          finalDecision.fieldId !== decision.fieldId
        )
          return sourceRefusal("file_not_found");
        return { kind: "confirmed" as const };
      },
    );
    if (finalRead.kind !== "available")
      return sourceRefusal(
        finalRead.kind === "temporarily_unavailable" ? "storage_unavailable" : "file_not_found",
      );
    if (finalRead.value.kind !== "confirmed") return finalRead.value;
    if (expiredAt(clock, deadlineMilliseconds)) return sourceRefusal("source_expired");
    const source = Object.freeze({
      format: STRUCTURED_RECORD_IMPORT_FORMAT,
      organizationId: organization.data.organizationId,
      applicationRootId,
      fileId: initialFile.fileId,
      checksum: initialFile.checksum,
      sizeBytes: initialFile.sizeBytes,
      ownerRecordTypeId: decision.recordTypeId,
      ownerRecordId: decision.recordId,
      ownerFieldId: decision.fieldId,
      viewerIdentityId: session.data.identityId,
      viewerOrganizationAccountId: organizationAccountId,
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
  };

  return Object.freeze({ read });
};
