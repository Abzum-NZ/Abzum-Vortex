import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import type { ConnectionTypeSourceDocument } from "../definition/definition-source";
import { logRefusal } from "../catalogue/runtime-primitives";

type ConnectionType = ConnectionTypeSourceDocument["body"];
type ConnectionOperation = ConnectionType["operations"][number];

/** Provider code supplies a request and interprets a response; only this executor sends it. */
export interface ConnectionProviderAdapter {
  prepareRequest(
    operation: ConnectionOperation,
    secret: string,
    input: unknown,
  ): Readonly<{
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: Uint8Array;
  }>;
  interpretResponse(operation: ConnectionOperation, status: number, body: Uint8Array): boolean;
}

/** Releases without a registered provider have no executable adapter. */
export const connectionProviderAdapters: ReadonlyMap<string, ConnectionProviderAdapter> = new Map();

export type OutboundOutcome = Readonly<{
  outcome: "success" | "retryable" | "terminal" | "unknown";
  code: string;
}>;

const deniedAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  deniedAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2002::", 16],
] as const)
  deniedAddresses.addSubnet(address, prefix, "ipv6");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

const publicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !deniedAddresses.check(address, "ipv4");
  if (family === 6)
    return globalIpv6.check(address, "ipv6") && !deniedAddresses.check(address, "ipv6");
  return false;
};

const safeUrl = (candidate: string, allowedHosts: readonly string[]): URL | undefined => {
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !allowedHosts.includes(url.hostname) ||
      isIP(url.hostname) !== 0
    )
      return undefined;
    return url;
  } catch (error) {
    logRefusal(
      "connection",
      "outbound URL",
      error instanceof TypeError ? "invalid_url" : "url_error",
    );
    return undefined;
  }
};

type Response = Readonly<{ status: number; body: Uint8Array; location?: string }>;

const send = async (
  url: URL,
  method: ConnectionOperation["method"],
  headers: Readonly<Record<string, string>>,
  body: Uint8Array | undefined,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Response> => {
  // Resolve before opening a socket, reject the entire answer if any address is unsafe, then pin
  // the chosen address to the TLS request so a second DNS answer cannot change its destination.
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("deadline"));
      else signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
    }),
  ]);
  if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address)))
    throw new Error("address_refused");
  const selected = addresses[0]!;
  const pinned = ((_hostname, _options, callback) => {
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
  return new Promise<Response>((resolve, reject) => {
    const call = httpsRequest(url, { method, headers, lookup: pinned, signal }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximumBytes) response.destroy(new Error("response_too_large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks),
          ...(response.headers.location === undefined
            ? {}
            : { location: response.headers.location }),
        }),
      );
    });
    call.on("error", reject);
    call.end(body);
  });
};

/** Run a release operation with bounded attempts, response size and elapsed time. */
export async function executeConnectionOperation(
  type: ConnectionType,
  operation: ConnectionOperation,
  adapter: ConnectionProviderAdapter,
  resolveSecret: () => Promise<string>,
  input: unknown,
): Promise<OutboundOutcome> {
  if (!type.operations.some((candidate) => candidate === operation))
    return { outcome: "terminal", code: "operation_refused" };
  const deadline = AbortSignal.timeout(operation.timeout_seconds * 1000);
  let request: ReturnType<ConnectionProviderAdapter["prepareRequest"]>;
  try {
    request = adapter.prepareRequest(operation, await resolveSecret(), input);
  } catch (error) {
    logRefusal(
      "connection",
      "outbound credentials",
      error instanceof TypeError ? "invalid_adapter" : "credential_unavailable",
    );
    return { outcome: "terminal", code: "credential_unavailable" };
  }
  if (
    (request.body?.byteLength ?? 0) > 1_000_000 ||
    Object.keys(request.headers).some((header) =>
      ["host", "connection", "content-length", "transfer-encoding"].includes(header.toLowerCase()),
    )
  )
    return { outcome: "terminal", code: "request_refused" };
  const first = safeUrl(request.url, type.allowed_hosts);
  if (first === undefined) return { outcome: "terminal", code: "host_refused" };
  const attempts = operation.method === "GET" ? operation.max_attempts : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let url = first;
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await send(
          url,
          operation.method,
          request.headers,
          request.body,
          operation.maximum_response_bytes,
          deadline,
        );
        if (response.status >= 300 && response.status < 400) {
          if (
            operation.method !== "GET" ||
            !type.allow_redirects ||
            response.location === undefined ||
            redirects === 5
          )
            return { outcome: "terminal", code: "redirect_refused" };
          const redirected = safeUrl(new URL(response.location, url).href, type.allowed_hosts);
          // Never forward credential-bearing headers across origins.
          if (redirected === undefined || redirected.origin !== first.origin)
            return { outcome: "terminal", code: "redirect_refused" };
          url = redirected;
          continue;
        }
        if (response.status >= 500 || response.status === 429) {
          if (operation.method !== "GET")
            return { outcome: "unknown", code: "provider_unavailable" };
          break;
        }
        if (response.status < 200 || response.status >= 300)
          return { outcome: "terminal", code: "provider_refused" };
        return adapter.interpretResponse(operation, response.status, response.body)
          ? { outcome: "success", code: "completed" }
          : { outcome: "terminal", code: "provider_result_refused" };
      }
    } catch (error) {
      if (error instanceof Error && error.message === "address_refused")
        return { outcome: "terminal", code: "address_refused" };
      if (error instanceof Error && error.message === "response_too_large")
        return { outcome: "terminal", code: "response_too_large" };
      if (deadline.aborted) return { outcome: "unknown", code: "deadline_exceeded" };
      if (operation.method !== "GET") return { outcome: "unknown", code: "delivery_unknown" };
    }
  }
  return { outcome: "retryable", code: "provider_unavailable" };
}
