import "server-only";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileTypeFromFile } from "file-type";
import { trustedFileInspectionSchema, type TrustedFileInspection } from "../schema";
import type { StorageCredentialBridge } from "./storage-credentials";
import { resolveFileStorageDestination, type FileStorageDestination } from "./storage-destination";
import type {
  IsolatedFileScanner,
  UploadedObjectInspector,
  UploadedObjectLocation,
} from "./upload";

export type FileScannerConfiguration =
  | Readonly<{ kind: "local_development_noop" }>
  | Readonly<{ kind: "clamav"; host: string; port: number; timeoutMilliseconds: number }>;

/** A complete, bounded temporary copy of bytes read under an exact-object inspect credential. */
const withStoredObject = async <Result>(
  bridge: StorageCredentialBridge,
  storageOrigin: string,
  location: UploadedObjectLocation,
  maximumBytes: number,
  fetchImplementation: typeof fetch,
  consume: (filename: string, size: number, checksum: string) => Promise<Result>,
): Promise<Result | null> => {
  const credential = await bridge.mintStorageOperationCredential({
    request: { operation: "inspect", fileId: location.fileId },
  });
  if (
    credential.storageOrigin !== storageOrigin ||
    credential.operation !== "read" ||
    credential.organizationId !== location.organizationId ||
    credential.bucketId !== location.bucketId ||
    credential.objectPath !== location.objectPath
  )
    throw new Error("FILE_INSPECTION_LOCATION_MISMATCH");
  const objectPath = credential.objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetchImplementation(
    `${credential.storageOrigin}/storage/v1/object/authenticated/${credential.bucketId}/${objectPath}`,
    {
      headers: { Authorization: `Bearer ${credential.token}`, "Accept-Encoding": "identity" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new Error("FILE_INSPECTION_STORAGE_REFUSED");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "vortex-upload-"));
  try {
    const filename = path.join(directory, "object");
    const file = await open(filename, "wx", 0o600);
    let size = 0;
    const checksum = createHash("sha256");
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximumBytes) throw new Error("FILE_INSPECTION_SIZE_EXCEEDED");
        checksum.update(chunk.value);
        // FileHandle.write can write fewer bytes than requested.
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const written = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (written.bytesWritten === 0) throw new Error("FILE_INSPECTION_WRITE_INCOMPLETE");
          offset += written.bytesWritten;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
        await file.close();
      }
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size))
      throw new Error("FILE_INSPECTION_LENGTH_MISMATCH");
    return await consume(filename, size, `sha256:${checksum.digest("hex")}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const writeSocket = (socket: Socket, bytes: Uint8Array): Promise<void> =>
  new Promise((resolve, reject) =>
    socket.write(bytes, (cause) => (cause ? reject(cause) : resolve())),
  );

/** One bounded, NUL-terminated ClamD response; unexpected closure never means clean. */
const clamavCommand = async (
  configuration: Extract<FileScannerConfiguration, { kind: "clamav" }>,
  send: (socket: Socket) => Promise<void>,
): Promise<string> => {
  const socket = connect({ host: configuration.host, port: configuration.port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = new Promise<string>((resolve, reject) => {
      let received = Buffer.alloc(0);
      timer = setTimeout(
        () => socket.destroy(new Error("FILE_SCANNER_TIMEOUT")),
        configuration.timeoutMilliseconds,
      );
      socket.on("error", reject);
      socket.on("end", () => reject(new Error("FILE_SCANNER_RESPONSE_INCOMPLETE")));
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 1024) {
          socket.destroy(new Error("FILE_SCANNER_RESPONSE_TOO_LARGE"));
          return;
        }
        const end = received.indexOf(0);
        if (end !== -1) resolve(received.subarray(0, end).toString("utf8"));
      });
    });
    // Attach a rejection handler before sending so an early disconnect is observed immediately.
    const sending = send(socket);
    const [response] = await Promise.all([reply, sending]);
    return response;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
};

/**
 * Concrete implementations of the coordinator's existing inspection and scanner ports.
 * The scanner receives the same checksum and byte count as inspection. A missing object,
 * storage error, scanner error or changed object never supplies a clean outcome.
 */
export const createStoredUploadInspection = (
  configuration: Readonly<{
    bridge: StorageCredentialBridge;
    destination: FileStorageDestination;
    maximumBytes: number;
    scanner: FileScannerConfiguration;
    fetchImplementation?: typeof fetch;
  }>,
): Readonly<{
  inspectUploadedObject: UploadedObjectInspector;
  scanUploadedObject: IsolatedFileScanner;
}> => {
  const { origin: storageOrigin } = resolveFileStorageDestination(configuration.destination);
  if (
    !Number.isSafeInteger(configuration.maximumBytes) ||
    configuration.maximumBytes < 1 ||
    configuration.maximumBytes > 5000 * 1024 * 1024
  )
    throw new Error("FILE_INSPECTION_LIMIT_INVALID");
  const scanner = configuration.scanner;
  if (scanner.kind === "local_development_noop") {
    if (configuration.destination.environment !== "local")
      throw new Error("FILE_SCANNER_NOOP_REQUIRES_LOCAL_ENVIRONMENT");
    console.warn("[files] Local development uses a no-op scanner. Malware scanning is disabled.");
  } else if (
    scanner.kind !== "clamav" ||
    scanner.host.trim().length === 0 ||
    !Number.isSafeInteger(scanner.port) ||
    scanner.port < 1 ||
    scanner.port > 65535 ||
    !Number.isSafeInteger(scanner.timeoutMilliseconds) ||
    scanner.timeoutMilliseconds < 1 ||
    scanner.timeoutMilliseconds > 60_000
  )
    throw new Error("FILE_SCANNER_CONFIGURATION_INVALID");
  const fetchImplementation = configuration.fetchImplementation ?? fetch;
  const inspectUploadedObject: UploadedObjectInspector = (location) =>
    withStoredObject(
      configuration.bridge,
      storageOrigin,
      location,
      configuration.maximumBytes,
      fetchImplementation,
      async (filename, size, checksum) => {
        const detected = await fileTypeFromFile(filename);
        // Unknown bytes remain unknown; neither a filename nor a browser Content-Type promotes them.
        return trustedFileInspectionSchema.parse({
          actualSizeBytes: size,
          checksum,
          detectedMediaType: detected?.mime ?? "application/octet-stream",
          detectedExtension: detected === undefined ? ".bin" : `.${detected.ext}`,
        });
      },
    );
  const scanUploadedObject: IsolatedFileScanner = async ({ location, inspection }) => {
    const trusted: TrustedFileInspection = trustedFileInspectionSchema.parse(inspection);
    const result = await withStoredObject(
      configuration.bridge,
      storageOrigin,
      location,
      configuration.maximumBytes,
      fetchImplementation,
      async (filename, size, checksum) => {
        if (size !== trusted.actualSizeBytes || checksum !== trusted.checksum)
          throw new Error("FILE_SCANNER_OBJECT_CHANGED");
        if (scanner.kind === "local_development_noop")
          return {
            scannerName: "local-development-noop",
            scannerVersion: "1",
            scannerResult: "clean" as const,
          };
        const version = await clamavCommand(scanner, (socket) =>
          writeSocket(socket, Buffer.from("zVERSION\0")),
        );
        if (!/^ClamAV [\x20-\x7e]{1,110}$/.test(version))
          throw new Error("FILE_SCANNER_VERSION_INVALID");
        const response = await clamavCommand(scanner, async (socket) => {
          await writeSocket(socket, Buffer.from("zINSTREAM\0"));
          for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024 })) {
            const bytes = chunk as Buffer;
            const length = Buffer.alloc(4);
            length.writeUInt32BE(bytes.byteLength);
            await writeSocket(socket, length);
            await writeSocket(socket, bytes);
          }
          await writeSocket(socket, Buffer.alloc(4));
        });
        if (response !== "stream: OK" && !/^stream: .+ FOUND$/.test(response))
          throw new Error("FILE_SCANNER_SCAN_FAILED");
        return {
          scannerName: "ClamAV",
          scannerVersion: version,
          scannerResult: response === "stream: OK" ? ("clean" as const) : ("quarantined" as const),
        };
      },
    );
    if (result === null) throw new Error("FILE_SCANNER_OBJECT_MISSING");
    return result;
  };
  return { inspectUploadedObject, scanUploadedObject };
};
