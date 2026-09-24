import "server-only";

import { z } from "zod";
import type { QueryCacheDecision } from "./cache-policy";

/**
 * The shared cache boundary for Query results. The store is injected (the
 * deployment's shared runtime cache); this adapter adds expiry, the current
 * permission recheck on every hit, and the fallback rule: a bypass, a miss, an
 * expired or mismatched entry, an unreadable entry, a failed recheck or any
 * store failure runs the ordinary authorised query. Cache trouble never refuses
 * a request and never serves unverifiable content.
 */
export interface SharedCacheStore {
  get(key: string): Promise<string | undefined | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export type QueryCacheState = "hit" | "miss" | "bypass";

export type QueryCacheReadResult<Value> = Readonly<{ value: Value; cacheState: QueryCacheState }>;

const maxEntryCharacters = 4_000_000;

const envelopeSchema = z
  .object({ key: z.string().min(1).max(128), expiresAt: z.iso.datetime({ offset: true }), value: z.unknown() })
  .strict();

export type QueryCacheAdapterOptions<Value> = Readonly<{
  store: SharedCacheStore;
  decision: QueryCacheDecision;
  /** Current time, supplied by the caller. */
  now: () => Date;
  /** Runs the ordinary authorised query. */
  load: () => Promise<Value>;
  /** Accepts a stored value only if it still has the exact result shape. */
  parse: (stored: unknown) => Value | undefined;
  /**
   * Rechecks, at the current authority, that this actor may still run the Query
   * and read every field in the stored value. It runs before every hit is
   * returned; anything but `true` discards the hit and runs the ordinary load.
   */
  recheck: (value: Value) => Promise<boolean>;
  /** True only for a completed result that may be stored; refusals are never stored. */
  shouldStore: (value: Value) => boolean;
}>;

const readEntry = async <Value>(
  options: QueryCacheAdapterOptions<Value>,
  decision: Extract<QueryCacheDecision, { outcome: "cache" }>,
): Promise<Value | undefined> => {
  try {
    const raw = await options.store.get(decision.key);
    if (typeof raw !== "string" || raw.length > maxEntryCharacters) return undefined;
    const envelope = envelopeSchema.safeParse(JSON.parse(raw));
    if (!envelope.success) return undefined;
    const currentMs = options.now().getTime();
    if (
      envelope.data.key !== decision.key ||
      Date.parse(envelope.data.expiresAt) <= currentMs ||
      Date.parse(envelope.data.expiresAt) > Date.parse(decision.expiresAt)
    )
      return undefined;
    const value = options.parse(envelope.data.value);
    if (value === undefined || (await options.recheck(value)) !== true) return undefined;
    return value;
  } catch {
    return undefined;
  }
};

const writeEntry = async <Value>(
  options: QueryCacheAdapterOptions<Value>,
  decision: Extract<QueryCacheDecision, { outcome: "cache" }>,
  value: Value,
): Promise<void> => {
  try {
    if (!options.shouldStore(value)) return;
    const remainingSeconds = Math.floor((Date.parse(decision.expiresAt) - options.now().getTime()) / 1_000);
    if (remainingSeconds < 1) return;
    const serialized = JSON.stringify({ key: decision.key, expiresAt: decision.expiresAt, value });
    if (serialized.length > maxEntryCharacters) return;
    await options.store.set(decision.key, serialized, Math.min(remainingSeconds, decision.ttlSeconds));
  } catch {
    // A failed write only forgoes a later hit.
  }
};

export const readThroughQueryCache = async <Value>(
  options: QueryCacheAdapterOptions<Value>,
): Promise<QueryCacheReadResult<Value>> => {
  const { decision } = options;
  if (decision.outcome === "bypass") return { value: await options.load(), cacheState: "bypass" };

  const cached = await readEntry(options, decision);
  if (cached !== undefined) return { value: cached, cacheState: "hit" };

  const value = await options.load();
  await writeEntry(options, decision, value);
  return { value, cacheState: "miss" };
};
