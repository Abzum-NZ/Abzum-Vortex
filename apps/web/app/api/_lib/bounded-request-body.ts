import "server-only";

import { logRefusal } from "@vortex/platform/schema";

type BoundedRequestText =
  | Readonly<{ kind: "read"; text: string }>
  | Readonly<{ kind: "too_large" }>
  | Readonly<{ kind: "unreadable" }>;

/**
 * Reads a request body as text without ever holding more than `maximumBytes` of it. A declared
 * `content-length` over the limit is refused before reading, and the stream itself is counted
 * while it is read, so a chunked or understated body is cancelled as soon as it passes the limit
 * instead of being buffered in full.
 */
export const readBoundedRequestBytes = async (
  request: Request,
  maximumBytes: number,
): Promise<
  Readonly<{ kind: "read"; bytes: Uint8Array }> | Readonly<{ kind: "too_large" | "unreadable" }>
> => {
  if (Number(request.headers.get("content-length") ?? 0) > maximumBytes)
    return { kind: "too_large" };
  if (request.body === null) return { kind: "read", bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    logRefusal("request-body", "bounded read", "body_unreadable", error);
    return { kind: "unreadable" };
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "read", bytes: body };
};

export const readBoundedRequestText = async (
  request: Request,
  maximumBytes: number,
): Promise<BoundedRequestText> => {
  const result = await readBoundedRequestBytes(request, maximumBytes);
  return result.kind === "read"
    ? { kind: "read", text: new TextDecoder().decode(result.bytes) }
    : result;
};
