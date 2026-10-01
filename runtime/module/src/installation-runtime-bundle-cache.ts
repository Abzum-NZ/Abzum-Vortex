import "server-only";

import { createHash } from "node:crypto";
import {
  installationRuntimeBundlePartMetadataSchema,
  installationRuntimeBundlePartSchema,
  type InstallationRuntimeBundleIndex,
  type InstallationRuntimeBundlePart,
  type InstallationRuntimeBundlePartMetadata,
} from "@vortex/contracts";

const initialMaximumBytes = 16_777_216;
const sharedStateSymbol = Symbol.for("@vortex/module/installation-runtime-bundle-cache/v1");

interface CacheEntry {
  readonly serializedValue: string;
  readonly charge: number;
}

interface CacheState {
  maximumBytes: number;
  chargedBytes: number;
  readonly entries: Map<string, CacheEntry>;
}

export interface InstallationRuntimeBundleCacheStatus {
  readonly maximumBytes: number;
  readonly chargedBytes: number;
  readonly entryCount: number;
  readonly sharedTierDisabled: true;
}

const isCacheState = (value: unknown): value is CacheState => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CacheState>;
  return (
    typeof candidate.maximumBytes === "number" &&
    Number.isSafeInteger(candidate.maximumBytes) &&
    candidate.maximumBytes >= 0 &&
    typeof candidate.chargedBytes === "number" &&
    Number.isSafeInteger(candidate.chargedBytes) &&
    candidate.chargedBytes >= 0 &&
    candidate.entries instanceof Map
  );
};

const cacheState = (): CacheState => {
  const globalState = globalThis as unknown as Record<symbol, unknown>;
  const existing = globalState[sharedStateSymbol];
  if (isCacheState(existing)) return existing;

  const created: CacheState = {
    maximumBytes: initialMaximumBytes,
    chargedBytes: 0,
    entries: new Map(),
  };
  Object.defineProperty(globalState, sharedStateSymbol, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  });
  return created;
};

const removeEntry = (state: CacheState, key: string): void => {
  const entry = state.entries.get(key);
  if (entry === undefined) return;
  state.entries.delete(key);
  state.chargedBytes -= entry.charge;
};

const removeLeastRecentlyUsed = (state: CacheState): boolean => {
  const oldestKey = state.entries.keys().next().value;
  if (oldestKey === undefined) return false;
  removeEntry(state, oldestKey);
  return true;
};

const clearEntries = (state: CacheState): void => {
  while (removeLeastRecentlyUsed(state)) {}
};

const cacheKey = (
  index: InstallationRuntimeBundleIndex,
  metadata: InstallationRuntimeBundlePartMetadata,
): string | undefined => {
  if (
    !Number.isSafeInteger(index.applicationReleaseRevision) ||
    index.applicationReleaseRevision < 1 ||
    !Number.isSafeInteger(index.bundleFormatVersion) ||
    index.bundleFormatVersion < 1 ||
    !Number.isSafeInteger(metadata.ordinal) ||
    metadata.ordinal < 0
  )
    return undefined;

  return JSON.stringify([
    index.organizationId.toLowerCase(),
    index.applicationRootId.toLowerCase(),
    index.applicationReleaseRevision,
    index.bundleFormatVersion,
    metadata.section,
    metadata.ordinal,
  ]);
};

const sha256 = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

const partFromEntry = (
  entry: CacheEntry,
  index: InstallationRuntimeBundleIndex,
  expected: InstallationRuntimeBundlePartMetadata,
): InstallationRuntimeBundlePart | undefined => {
  try {
    const value: unknown = JSON.parse(entry.serializedValue);
    if (!Array.isArray(value) || value.length !== 6) return undefined;
    const [pinFingerprint, section, ordinal, byteSize, digest, content] = value as unknown[];
    if (
      pinFingerprint !== index.pinFingerprint ||
      section !== expected.section ||
      ordinal !== expected.ordinal ||
      byteSize !== expected.byteSize ||
      digest !== expected.sha256 ||
      typeof content !== "string"
    )
      return undefined;

    const parsed = installationRuntimeBundlePartSchema.safeParse({
      section,
      ordinal,
      byteSize,
      sha256: digest,
      content,
    });
    if (
      !parsed.success ||
      Buffer.byteLength(parsed.data.content, "utf8") !== parsed.data.byteSize ||
      sha256(parsed.data.content) !== parsed.data.sha256
    )
      return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
};

/** Returns a fresh part only when its serialized cache entry matches the live index. */
export const readInstallationRuntimeBundleCachePart = (
  index: InstallationRuntimeBundleIndex,
  expectedCandidate: InstallationRuntimeBundlePartMetadata,
): InstallationRuntimeBundlePart | undefined => {
  try {
    const expected = installationRuntimeBundlePartMetadataSchema.safeParse(expectedCandidate);
    if (!expected.success) return undefined;
    const key = cacheKey(index, expected.data);
    if (key === undefined) return undefined;

    const state = cacheState();
    const entry = state.entries.get(key);
    if (entry === undefined) return undefined;

    const part = partFromEntry(entry, index, expected.data);
    if (part === undefined) {
      removeEntry(state, key);
      return undefined;
    }

    state.entries.delete(key);
    state.entries.set(key, entry);
    return part;
  } catch {
    return undefined;
  }
};

/** Retains a validated part as one charged key/value pair in the process-wide LRU. */
export const retainInstallationRuntimeBundleCachePart = (
  index: InstallationRuntimeBundleIndex,
  partCandidate: InstallationRuntimeBundlePart,
): void => {
  try {
    const part = installationRuntimeBundlePartSchema.safeParse(partCandidate);
    if (!part.success) return;
    const key = cacheKey(index, part.data);
    if (key === undefined) return;

    const state = cacheState();
    removeEntry(state, key);
    if (state.maximumBytes === 0) return;

    const serializedValue = JSON.stringify([
      index.pinFingerprint,
      part.data.section,
      part.data.ordinal,
      part.data.byteSize,
      part.data.sha256,
      part.data.content,
    ]);
    if (typeof serializedValue !== "string") return;
    const charge = Buffer.byteLength(key, "utf8") + Buffer.byteLength(serializedValue, "utf8");
    if (!Number.isSafeInteger(charge) || charge < 0 || charge > state.maximumBytes) return;

    while (state.chargedBytes > state.maximumBytes - charge) {
      if (!removeLeastRecentlyUsed(state)) return;
    }
    if (state.chargedBytes > state.maximumBytes - charge) return;

    state.entries.set(key, { serializedValue, charge });
    state.chargedBytes += charge;
  } catch {
    return;
  }
};

/** Sets the process-wide retained-data limit; invalid values disable and clear the cache. */
export const configureInstallationRuntimeBundleCache = (maximumBytes: unknown): void => {
  const state = cacheState();
  state.maximumBytes =
    typeof maximumBytes === "number" && Number.isSafeInteger(maximumBytes) && maximumBytes >= 0
      ? maximumBytes
      : 0;

  if (state.maximumBytes === 0) {
    clearEntries(state);
    return;
  }

  while (state.chargedBytes > state.maximumBytes) {
    if (!removeLeastRecentlyUsed(state)) break;
  }
};

/** Reports content-free accounting for the single process-wide cache. */
export const readInstallationRuntimeBundleCacheStatus =
  (): InstallationRuntimeBundleCacheStatus => {
    const state = cacheState();
    return Object.freeze({
      maximumBytes: state.maximumBytes,
      chargedBytes: state.chargedBytes,
      entryCount: state.entries.size,
      sharedTierDisabled: true,
    });
  };
