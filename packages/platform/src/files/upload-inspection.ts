import "server-only";

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileTypeFromStream } from "file-type";
import { trustedFileInspectionSchema } from "./file-contracts";
import type { StorageCredentialBridge } from "./storage-credentials";
import { resolveFileStorageDestination, type FileStorageDestination } from "./storage-destination";
import type { UploadedObjectInspector, UploadedObjectLocation } from "./upload";

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

export const createStoredUploadInspection = (
  configuration: Readonly<{
    bridge: StorageCredentialBridge;
    destination: FileStorageDestination;
    maximumBytes: number;
    fetchImplementation?: typeof fetch;
  }>,
): Readonly<{
  inspectUploadedObject: UploadedObjectInspector;
}> => {
  const { origin: storageOrigin } = resolveFileStorageDestination(configuration.destination);
  if (
    !Number.isSafeInteger(configuration.maximumBytes) ||
    configuration.maximumBytes < 1 ||
    configuration.maximumBytes > 5000 * 1024 * 1024
  )
    throw new Error("FILE_INSPECTION_LIMIT_INVALID");
  const fetchImplementation = configuration.fetchImplementation ?? fetch;
  const inspectUploadedObject: UploadedObjectInspector = (location) =>
    withStoredObject(
      configuration.bridge,
      storageOrigin,
      location,
      configuration.maximumBytes,
      fetchImplementation,
      async (filename, size, checksum) => {
        const content = createReadStream(filename);
        let detected: { ext: string; mime: string } | undefined;
        try {
          // Web-stream detection keeps file-type's Node-only dynamic imports out of bundled routes.
          detected = await fileTypeFromStream(
            Readable.toWeb(content) as ReadableStream<Uint8Array>,
          );
        } finally {
          content.destroy();
        }
        if (detected === undefined) {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let text = true;
          try {
            for await (const chunk of createReadStream(filename)) {
              const decoded = decoder.decode(chunk, { stream: true });
              // eslint-disable-next-line no-control-regex -- Binary control bytes cannot be admitted as plain text.
              const hasControlBytes = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
              if (hasControlBytes) {
                text = false;
                break;
              }
            }
            decoder.decode();
          } catch (cause) {
            if (!(cause instanceof TypeError)) throw cause;
            text = false;
          }
          if (text) detected = { ext: "txt", mime: "text/plain" };
        }
        // Unknown bytes remain unknown; neither a filename nor a browser Content-Type promotes them.
        return trustedFileInspectionSchema.parse({
          actualSizeBytes: size,
          checksum,
          detectedMediaType: detected?.mime ?? "application/octet-stream",
          detectedExtension: detected === undefined ? ".bin" : `.${detected.ext}`,
        });
      },
    );
  return { inspectUploadedObject };
};
