import "server-only";

import { AsyncResource } from "node:async_hooks";
import { ADDRCONFIG, ALL, V4MAPPED, lookup as nativeLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import {
  cleanNetworkLookupRegistryKey,
  readCleanNetworkLookupCapability,
  type CleanNetworkLookupCapability,
  type LookupDeliveryOutcome,
  type NativeLookupState,
  type OwnedNetworkLookup,
} from "./owned-network-lookup";

const nativeLookupLimit = 32;
const supportedHints = ADDRCONFIG | ALL | V4MAPPED;

type LookupCallback = Parameters<LookupFunction>[2];
interface NativeCounter {
  occupied: number;
}

/**
 * The native callback's complete reachable application state. It never points to
 * its owner, dispatch closure, signal, socket, promise, or originating request.
 * delivery is its only live request-associated reference and is taken before call.
 */
interface NeutralLookupCell {
  hostname: string | undefined;
  options: Readonly<LookupOptions> | undefined;
  all: boolean;
  delivery: LookupCallback | undefined;
  counter: NativeCounter | undefined;
  nativeState: NativeLookupState;
  started: boolean;
  stopped: boolean;
  terminal: boolean;
  invocationCount: number;
  outcome: LookupDeliveryOutcome;
}

function deliverySettled(cell: NeutralLookupCell): boolean {
  return cell.terminal && cell.invocationCount === 0 && cell.delivery === undefined;
}

function lookupError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("Owned network lookup is unavailable.");
  error.code = code;
  return error;
}

/** Scalars only; no reference to the caller's options object or its prototype. */
function copyLookupOptions(
  options: LookupOptions,
  cell: NeutralLookupCell,
): Readonly<LookupOptions> | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const all = options.all;
  cell.all = all === true;
  if (cell.stopped) return undefined;
  const family = options.family;
  if (cell.stopped) return undefined;
  const hints = options.hints;
  if (cell.stopped) return undefined;
  const order = options.order;
  if (cell.stopped) return undefined;
  const verbatim = options.verbatim;
  if (cell.stopped) return undefined;
  if (
    (family !== undefined &&
      family !== 0 &&
      family !== 4 &&
      family !== 6 &&
      family !== "IPv4" &&
      family !== "IPv6") ||
    (hints !== undefined &&
      (!Number.isInteger(hints) ||
        hints < 0 ||
        hints > 0xffffffff ||
        (hints & ~supportedHints) !== 0)) ||
    (all !== undefined && typeof all !== "boolean") ||
    (order !== undefined &&
      order !== "verbatim" &&
      order !== "ipv4first" &&
      order !== "ipv6first") ||
    (verbatim !== undefined && typeof verbatim !== "boolean")
  )
    return undefined;
  const copied: LookupOptions = {};
  if (family !== undefined) copied.family = family;
  if (hints !== undefined) copied.hints = hints;
  if (all !== undefined) copied.all = all;
  if (order !== undefined) copied.order = order;
  if (verbatim !== undefined) copied.verbatim = verbatim;
  return Object.freeze(copied);
}

/** A refused extra invocation must not replace the original live delivery slot. */
function refuseAdditionalLookup(
  cell: NeutralLookupCell,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  // Own the pending refusal before a selector getter can reenter stop.
  cell.invocationCount += 1;
  let all = false;
  try {
    all = options?.all === true;
  } catch {
    // The fixed refusal owns neither this selector exception nor its options.
  }
  let callbackFailed = false;
  try {
    callback(
      lookupError(cell.stopped ? "ERR_VORTEX_LOOKUP_STOPPED" : "ERR_VORTEX_LOOKUP_ALREADY_USED"),
      all ? [] : "",
    );
  } catch {
    callbackFailed = true;
    cell.outcome = "callback_failed";
  } finally {
    cell.invocationCount -= 1;
  }
  if (callbackFailed) stopLookup(cell);
}

/** Taking the sole slot first makes reentrant stop observe no pending delivery. */
function deliverLookup(
  cell: NeutralLookupCell,
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[] | undefined,
  family?: number,
): void {
  let callback = cell.delivery;
  cell.delivery = undefined;
  cell.hostname = undefined;
  cell.options = undefined;
  if (callback === undefined) return;
  cell.terminal = true;
  cell.invocationCount += 1;
  try {
    callback(error, address ?? (cell.all ? [] : ""), family);
  } catch {
    // The internal Node callback is synchronous. Its throw is a safe terminal
    // failure, never a retained exception or an unowned queued error turn.
    cell.stopped = true;
    cell.outcome = "callback_failed";
  } finally {
    callback = undefined;
    cell.invocationCount -= 1;
  }
}

function stopLookup(cell: NeutralLookupCell): boolean {
  cell.stopped = true;
  cell.terminal = true;
  if (cell.outcome === "open") cell.outcome = "stopped";
  cell.hostname = undefined;
  cell.options = undefined;
  deliverLookup(cell, lookupError("ERR_VORTEX_LOOKUP_STOPPED"), undefined);
  // A callback already on the stack, including this stop's own callback, must
  // actually return before delivery can be certified. No native slot is freed.
  return deliverySettled(cell);
}

function completeNativeLookup(cell: NeutralLookupCell): boolean {
  if (cell.nativeState !== "pending" && cell.nativeState !== "dispatch_unconfirmed")
    return false;
  cell.nativeState = "completed";
  const counter = cell.counter;
  cell.counter = undefined;
  if (counter !== undefined) counter.occupied -= 1;
  return true;
}

/** Module-scope construction: this closure captures only its explicit cell. */
function nativeCallbackFor(cell: NeutralLookupCell) {
  return (
    error: NodeJS.ErrnoException | null,
    address?: string | LookupAddress[],
    family?: number,
  ): void => {
    if (!completeNativeLookup(cell)) return;
    if (cell.delivery === undefined) {
      cell.hostname = undefined;
      cell.options = undefined;
      return;
    }
    cell.outcome = error === null ? "completed" : "lookup_failed";
    deliverLookup(cell, error, address, family);
  };
}

/** Called only inside the startup root; no request-scope callback factory. */
function dispatchNativeLookup(cell: NeutralLookupCell, counter: NativeCounter): void {
  if (cell.stopped || cell.delivery === undefined) return;
  if (counter.occupied >= nativeLookupLimit) {
    cell.nativeState = "not_dispatched";
    cell.outcome = "refused";
    deliverLookup(cell, lookupError("ERR_VORTEX_LOOKUP_CAPACITY"), undefined);
    return;
  }
  const hostname = cell.hostname;
  const options = cell.options;
  if (hostname === undefined || options === undefined) {
    cell.nativeState = "not_dispatched";
    cell.outcome = "refused";
    deliverLookup(cell, lookupError("ERR_VORTEX_LOOKUP_INVALID_OPTIONS"), undefined);
    return;
  }
  counter.occupied += 1;
  cell.counter = counter;
  cell.nativeState = "pending";
  // IP literals and immediate getaddrinfo errors also use Node's asynchronous
  // callback. Conservatively retain their slot until that real callback arrives.
  nativeLookup(hostname, options, nativeCallbackFor(cell));
}

function createLookupOwner(dispatch: (cell: NeutralLookupCell) => void): OwnedNetworkLookup {
  const cell: NeutralLookupCell = {
    hostname: undefined,
    options: undefined,
    all: false,
    delivery: undefined,
    counter: undefined,
    nativeState: "not_started",
    started: false,
    stopped: false,
    terminal: false,
    invocationCount: 0,
    outcome: "open",
  };
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (cell.started || cell.stopped) {
      refuseAdditionalLookup(cell, options, callback);
      return;
    }
    cell.started = true;
    cell.delivery = callback;
    let copied: Readonly<LookupOptions> | undefined;
    try {
      copied = copyLookupOptions(options, cell);
    } catch {
      // Getter failures are known to precede native dispatch and retain no job.
    }
    if (cell.stopped || cell.delivery === undefined) return;
    if (
      copied === undefined ||
      typeof hostname !== "string" ||
      hostname.length === 0 ||
      hostname.includes("\0")
    ) {
      cell.nativeState = "not_dispatched";
      cell.outcome = "refused";
      deliverLookup(cell, lookupError("ERR_VORTEX_LOOKUP_INVALID_OPTIONS"), undefined);
      return;
    }
    cell.hostname = hostname;
    cell.options = copied;
    try {
      dispatch(cell);
    } catch {
      // An exception before reservation proves no dispatch. Once native lookup
      // was entered, its public void API cannot prove that no job was created.
      // Keep that bounded neutral slot until an actual callback, possibly forever.
      if (cell.nativeState !== "completed") {
        cell.nativeState = cell.counter === undefined ? "not_dispatched" : "dispatch_unconfirmed";
        if (cell.delivery !== undefined) {
          cell.outcome = "refused";
          deliverLookup(cell, lookupError("ERR_VORTEX_LOOKUP_DISPATCH_FAILED"), undefined);
        }
      }
    }
  };
  return Object.freeze({
    lookup,
    stop(): boolean {
      return stopLookup(cell);
    },
    get lookupDeliverySettled(): boolean {
      return deliverySettled(cell);
    },
    get nativeLookupState(): NativeLookupState {
      return cell.nativeState;
    },
    get deliveryOutcome(): LookupDeliveryOutcome {
      return cell.outcome;
    },
  });
}

/**
 * Sole caller: application-root instrumentation.register on the qualified standard
 * Next Node startup path. Startup ordering, not a trigger ID or ALS manipulation,
 * establishes that the captured context predates Web request dispatch.
 */
export function registerCleanNetworkStartup(): void {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    throw new Error("Clean network startup is unavailable.");
  const existing = Object.getOwnPropertyDescriptor(globalThis, cleanNetworkLookupRegistryKey);
  if (existing !== undefined) {
    if (readCleanNetworkLookupCapability() !== undefined) return;
    throw new Error("Clean network startup is incompatible.");
  }

  const root = new AsyncResource("VortexCleanNetworkStartup", { requireManualDestroy: true });
  const counter: NativeCounter = { occupied: 0 };
  const capability = Object.freeze<CleanNetworkLookupCapability>({
    version: "vortex.owned-network-lookup.v1",
    createOwnedLookup(): OwnedNetworkLookup {
      return createLookupOwner((cell) => {
        root.runInAsyncScope(dispatchNativeLookup, undefined, cell, counter);
      });
    },
    get activeNativeLookupCount(): number {
      return counter.occupied;
    },
  });
  // Keep the root private and process-resident. The immutable realm capability
  // exposes no root, bind, snapshot, run function, native cell, or request state.
  Object.defineProperty(globalThis, cleanNetworkLookupRegistryKey, {
    value: capability,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
