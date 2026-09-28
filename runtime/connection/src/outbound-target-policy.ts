import "server-only";

import { isIP } from "node:net";

/** Redirects are counted after the initial request and checked again at every hop. */
export const maximumOutboundRedirects = 5;

/** Inputs are bounded before parsing or copying so callers cannot pass unbounded targets. */
export const outboundTargetPolicyLimits = Object.freeze({
  allowedHosts: 256,
  resolvedAddresses: 64,
  urlLength: 8_192,
});

export const outboundTargetPolicyRefusalCodes = [
  "invalid_policy",
  "redirect_not_allowed",
  "redirect_limit_exceeded",
  "invalid_url",
  "host_not_allowed",
  "port_not_allowed",
  "invalid_dns_answers",
  "non_public_address",
] as const;

export type OutboundTargetPolicyRefusalCode =
  (typeof outboundTargetPolicyRefusalCodes)[number];

export interface OutboundTargetPolicyInput {
  /** Exact lower-case hosts from the immutable platform connection catalogue. */
  readonly allowedHosts: readonly string[];
  /** The initial operation URL or the Location resolved against the previous hop. */
  readonly candidateUrl: string;
  /** The catalogue operation's redirect setting. */
  readonly allowRedirects: boolean;
  /** Zero for the initial target; increment once for each redirect followed. */
  readonly redirectsFollowed: number;
  /** The complete A and AAAA answers resolved for this hop. */
  readonly resolvedAddresses: readonly string[];
}

export interface AllowedOutboundTarget {
  /** Canonical absolute HTTPS URL, with a default port and normalized host spelling. */
  readonly url: string;
  readonly hostname: string;
  /** All checked answers; the caller must pin transport to this set for this hop. */
  readonly addresses: readonly string[];
  readonly port: 443;
  readonly redirectsFollowed: number;
}

export type OutboundTargetPolicyResult =
  | Readonly<{ outcome: "allowed"; target: AllowedOutboundTarget }>
  | Readonly<{ outcome: "refused"; reasonCode: OutboundTargetPolicyRefusalCode }>;

const refuse = (reasonCode: OutboundTargetPolicyRefusalCode): OutboundTargetPolicyResult =>
  Object.freeze({ outcome: "refused", reasonCode });

const isCanonicalCatalogueHostname = (hostname: string): boolean => {
  if (hostname.length < 3 || hostname.length > 253 || hostname !== hostname.toLowerCase()) {
    return false;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return false;
  }

  try {
    const parsed = new URL(`https://${hostname}/`);
    return parsed.hostname === hostname && isIP(parsed.hostname) === 0;
  } catch {
    return false;
  }
};

const ipv4ToNumber = (address: string): number | undefined => {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return undefined;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
};

const ipv4Range = (first: string, last: string): readonly [number, number] => {
  const firstNumber = ipv4ToNumber(first);
  const lastNumber = ipv4ToNumber(last);
  if (firstNumber === undefined || lastNumber === undefined) {
    throw new Error("Outbound IPv4 policy range is invalid");
  }
  return Object.freeze([firstNumber, lastNumber]);
};

// IANA IPv4 special-purpose ranges that are not globally reachable, plus all multicast.
const nonPublicIpv4Ranges: readonly (readonly [number, number])[] = Object.freeze([
  ipv4Range("0.0.0.0", "0.255.255.255"),
  ipv4Range("10.0.0.0", "10.255.255.255"),
  ipv4Range("100.64.0.0", "100.127.255.255"),
  ipv4Range("127.0.0.0", "127.255.255.255"),
  ipv4Range("169.254.0.0", "169.254.255.255"),
  ipv4Range("172.16.0.0", "172.31.255.255"),
  ipv4Range("192.0.0.0", "192.0.0.8"),
  ipv4Range("192.0.0.11", "192.0.0.255"),
  ipv4Range("192.0.2.0", "192.0.2.255"),
  ipv4Range("192.88.99.0", "192.88.99.255"),
  ipv4Range("192.168.0.0", "192.168.255.255"),
  ipv4Range("198.18.0.0", "198.19.255.255"),
  ipv4Range("198.51.100.0", "198.51.100.255"),
  ipv4Range("203.0.113.0", "203.0.113.255"),
  ipv4Range("224.0.0.0", "255.255.255.255"),
]);

const parseIpv6 = (address: string): bigint | undefined => {
  if (isIP(address) !== 6 || address.includes(".")) return undefined;

  const normalized = address.toLowerCase();
  const separator = normalized.indexOf("::");
  if (separator !== -1 && normalized.indexOf("::", separator + 2) !== -1) {
    return undefined;
  }

  const leftText = separator === -1 ? normalized : normalized.slice(0, separator);
  const rightText = separator === -1 ? "" : normalized.slice(separator + 2);
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  if (left.concat(right).some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return undefined;
  }

  const omittedCount = 8 - left.length - right.length;
  if ((separator === -1 && omittedCount !== 0) || (separator !== -1 && omittedCount < 1)) {
    return undefined;
  }

  const groups = left.concat(Array.from({ length: omittedCount }, () => "0"), right);
  if (groups.length !== 8) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
};

interface Ipv6Prefix {
  readonly network: bigint;
  readonly mask: bigint;
}

const ipv6Prefix = (network: string, length: number): Ipv6Prefix => {
  const value = parseIpv6(network);
  if (value === undefined || !Number.isInteger(length) || length < 0 || length > 128) {
    throw new Error("Outbound IPv6 policy prefix is invalid");
  }
  const mask = length === 0 ? 0n : ((1n << BigInt(length)) - 1n) << BigInt(128 - length);
  return Object.freeze({ network: value & mask, mask });
};

const isWithinIpv6Prefix = (address: bigint, prefix: Ipv6Prefix): boolean =>
  (address & prefix.mask) === prefix.network;

// IANA IPv6 global-unicast allocations reviewed 2025-10-10. Unallocated GUA space fails closed.
const publicIpv6Prefixes: readonly Ipv6Prefix[] = Object.freeze(
  [
    ["2001:200::", 23],
    ["2001:400::", 23],
    ["2001:600::", 23],
    ["2001:800::", 22],
    ["2001:c00::", 23],
    ["2001:e00::", 23],
    ["2001:1200::", 23],
    ["2001:1400::", 22],
    ["2001:1800::", 23],
    ["2001:1a00::", 23],
    ["2001:1c00::", 22],
    ["2001:2000::", 19],
    ["2001:4000::", 23],
    ["2001:4200::", 23],
    ["2001:4400::", 23],
    ["2001:4600::", 23],
    ["2001:4800::", 23],
    ["2001:4a00::", 23],
    ["2001:4c00::", 23],
    ["2001:5000::", 20],
    ["2001:8000::", 19],
    ["2001:a000::", 20],
    ["2001:b000::", 20],
    ["2003::", 18],
    ["2400::", 12],
    ["2410::", 12],
    ["2600::", 12],
    ["2610::", 23],
    ["2620::", 23],
    ["2630::", 12],
    ["2800::", 12],
    ["2a00::", 12],
    ["2a10::", 12],
    ["2c00::", 12],
  ].map(([network, length]) => ipv6Prefix(network as string, length as number)),
);

// The documentation block is carved out of the broader 2001:c00::/23 allocation.
const nonPublicIpv6Prefixes: readonly Ipv6Prefix[] = Object.freeze([
  ipv6Prefix("2001:db8::", 32),
]);

const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToNumber(address);
    return (
      value !== undefined &&
      !nonPublicIpv4Ranges.some(([first, last]) => value >= first && value <= last)
    );
  }
  if (family !== 6) return false;

  const value = parseIpv6(address);
  return (
    value !== undefined &&
    !nonPublicIpv6Prefixes.some((prefix) => isWithinIpv6Prefix(value, prefix)) &&
    publicIpv6Prefixes.some((prefix) => isWithinIpv6Prefix(value, prefix))
  );
};

/**
 * Validates one outbound URL hop without resolving names or performing network I/O.
 * The caller must use the returned address set for the request and call this policy
 * again with fresh complete DNS answers for every redirect destination. A successful
 * result validates only the network target; it does not authorize an operation or instance.
 */
export function validateOutboundTarget(
  input: OutboundTargetPolicyInput,
): OutboundTargetPolicyResult {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.allowedHosts) ||
    input.allowedHosts.length < 1 ||
    input.allowedHosts.length > outboundTargetPolicyLimits.allowedHosts ||
    typeof input.allowRedirects !== "boolean" ||
    !Number.isSafeInteger(input.redirectsFollowed) ||
    input.redirectsFollowed < 0 ||
    !Array.isArray(input.resolvedAddresses)
  ) {
    return refuse("invalid_policy");
  }

  if (input.redirectsFollowed > 0 && !input.allowRedirects) {
    return refuse("redirect_not_allowed");
  }
  if (input.redirectsFollowed > maximumOutboundRedirects) {
    return refuse("redirect_limit_exceeded");
  }

  const allowedHosts = new Set<string>();
  for (const host of input.allowedHosts) {
    if (typeof host !== "string" || !isCanonicalCatalogueHostname(host)) {
      return refuse("invalid_policy");
    }
    allowedHosts.add(host);
  }

  if (
    typeof input.candidateUrl !== "string" ||
    input.candidateUrl.length < 1 ||
    input.candidateUrl.length > outboundTargetPolicyLimits.urlLength ||
    /[\u0000-\u0020\u007f\\]/.test(input.candidateUrl) ||
    input.candidateUrl.includes("#")
  ) {
    return refuse("invalid_url");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.candidateUrl);
  } catch {
    return refuse("invalid_url");
  }
  if (parsedUrl.protocol !== "https:") return refuse("invalid_url");
  if (parsedUrl.href.length > outboundTargetPolicyLimits.urlLength) {
    return refuse("invalid_url");
  }

  const authorityMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(input.candidateUrl);
  const authority = authorityMatch?.[1];
  const hostMatch =
    authority === undefined ? undefined : /^([a-z0-9.-]+)(?::([0-9]+))?$/i.exec(authority);
  if (hostMatch === undefined || hostMatch === null) return refuse("invalid_url");

  const rawHostname = hostMatch[1];
  const rawPort = hostMatch[2];
  const hostname = parsedUrl.hostname;
  if (
    rawHostname === undefined ||
    !isCanonicalCatalogueHostname(rawHostname.toLowerCase()) ||
    rawHostname.toLowerCase() !== hostname
  ) {
    return refuse("invalid_url");
  }
  if ((rawPort !== undefined && rawPort !== "443") || parsedUrl.port !== "") {
    return refuse("port_not_allowed");
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "" || parsedUrl.hash !== "") {
    return refuse("invalid_url");
  }
  if (!allowedHosts.has(hostname)) return refuse("host_not_allowed");
  if (
    input.resolvedAddresses.length < 1 ||
    input.resolvedAddresses.length > outboundTargetPolicyLimits.resolvedAddresses ||
    input.resolvedAddresses.some((address) => typeof address !== "string" || isIP(address) === 0)
  ) {
    return refuse("invalid_dns_answers");
  }
  if (input.resolvedAddresses.some((address) => !isPublicAddress(address))) {
    return refuse("non_public_address");
  }

  const addresses = Object.freeze([...input.resolvedAddresses]);
  const target = Object.freeze({
    url: parsedUrl.href,
    hostname,
    addresses,
    port: 443 as const,
    redirectsFollowed: input.redirectsFollowed,
  });
  return Object.freeze({ outcome: "allowed", target });
}
