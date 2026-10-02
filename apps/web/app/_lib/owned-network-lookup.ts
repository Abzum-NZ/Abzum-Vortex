import "server-only";

import type { LookupFunction } from "node:net";

export type NativeLookupState =
  | "not_started"
  | "not_dispatched"
  | "pending"
  | "dispatch_unconfirmed"
  | "completed";

export type LookupDeliveryOutcome =
  | "open"
  | "completed"
  | "lookup_failed"
  | "stopped"
  | "refused"
  | "callback_failed";

/**
 * One trusted socket construction owns one lookup. Stop joins synchronous delivery,
 * not native DNS or physical socket disposal. Reentrant stop returns false until
 * the callback on the stack returns; the consumer must not certify disposal then.
 */
export interface OwnedNetworkLookup {
  readonly lookup: LookupFunction;
  /** True only after every synchronous delivery invocation has returned. */
  stop(): boolean;
  readonly lookupDeliverySettled: boolean;
  /** completed means an actual Node callback; stop never produces that state. */
  readonly nativeLookupState: NativeLookupState;
  readonly deliveryOutcome: LookupDeliveryOutcome;
}

/** Shared by separate Next bundles in the same Node realm, never by module identity. */
export const cleanNetworkLookupRegistryKey = Symbol.for("vortex.web.clean-network-lookup");

export interface CleanNetworkLookupCapability {
  readonly version: "vortex.owned-network-lookup.v1";
  createOwnedLookup(): OwnedNetworkLookup;
  /** Conservatively occupied slots, including an unconfirmed dispatch failure. */
  readonly activeNativeLookupCount: number;
}

function isLookupCapability(value: unknown): value is CleanNetworkLookupCapability {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.isFrozen(value)
  )
    return false;
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== 3 ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !names.includes("version") ||
    !names.includes("createOwnedLookup") ||
    !names.includes("activeNativeLookupCount")
  )
    return false;
  const version = Object.getOwnPropertyDescriptor(value, "version");
  const create = Object.getOwnPropertyDescriptor(value, "createOwnedLookup");
  const count = Object.getOwnPropertyDescriptor(value, "activeNativeLookupCount");
  return (
    version?.value === "vortex.owned-network-lookup.v1" &&
    typeof create?.value === "function" &&
    count !== undefined &&
    typeof count.get === "function" &&
    count.set === undefined
  );
}

/** No getter, registration fallback, root, or arbitrary executor is invoked here. */
export function readCleanNetworkLookupCapability(): CleanNetworkLookupCapability | undefined {
  try {
    const slot = Object.getOwnPropertyDescriptor(globalThis, cleanNetworkLookupRegistryKey);
    if (
      slot === undefined ||
      slot.configurable !== false ||
      slot.enumerable !== false ||
      slot.writable !== false
    )
      return undefined;
    const value: unknown = slot.value;
    return isLookupCapability(value) ? value : undefined;
  } catch {
    // A malformed existing slot is unavailable, never a replacement-root path.
    return undefined;
  }
}

/** A missing/Edge startup owns no native work and retains no callback. */
function createUnavailableLookup(): OwnedNetworkLookup {
  let stopped = false;
  let started = false;
  let invocationCount = 0;
  let outcome: LookupDeliveryOutcome = "open";
  const settled = (): boolean => (stopped || started) && invocationCount === 0;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    // Own the pending refusal before a selector getter can reenter stop.
    invocationCount += 1;
    let all = false;
    try {
      all = options?.all === true;
    } catch {
      // Refusal does not execute a selector getter again or retain its exception.
    }
    const code = stopped
      ? "ERR_VORTEX_LOOKUP_STOPPED"
      : started
        ? "ERR_VORTEX_LOOKUP_ALREADY_USED"
        : "ERR_VORTEX_LOOKUP_STARTUP_UNAVAILABLE";
    started = true;
    if (outcome !== "callback_failed") outcome = stopped ? "stopped" : "refused";
    const error: NodeJS.ErrnoException = new Error("Owned network lookup is unavailable.");
    error.code = code;
    try {
      callback(error, all ? [] : "");
    } catch {
      stopped = true;
      outcome = "callback_failed";
    } finally {
      invocationCount -= 1;
    }
  };
  return Object.freeze({
    lookup,
    stop(): boolean {
      stopped = true;
      if (outcome === "open") outcome = "stopped";
      return settled();
    },
    get lookupDeliverySettled(): boolean {
      return settled();
    },
    get nativeLookupState(): NativeLookupState {
      return "not_dispatched";
    },
    get deliveryOutcome(): LookupDeliveryOutcome {
      return outcome;
    },
  });
}

/**
 * The hostname belongs to the later socket owner's validated configured endpoint.
 * This bridge selects no endpoint or authority and changes no DNS or TLS policy.
 * Missing startup refuses; calling this function can never create a clean root.
 */
export function createOwnedNetworkLookup(): OwnedNetworkLookup {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    return createUnavailableLookup();
  return readCleanNetworkLookupCapability()?.createOwnedLookup() ?? createUnavailableLookup();
}
