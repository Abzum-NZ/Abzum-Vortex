import { walkPageComposition } from "@vortex/platform/schema";
import { readMotionSeconds } from "./motion-tokens";

/**
 * Hold then swap. When the next page of an application arrives with its primary placement's data
 * still streaming, the page waits (suspends inside the navigation's transition, so React keeps the
 * current page on screen) until that data has arrived or the page hold token has passed, whichever
 * comes first. A page that is still waiting after the hold swaps in with its loading skeleton.
 *
 * Only a page that mounts in the browser after the document has hydrated is held. The first document
 * never holds: it streams its frame first and its primary placement's rows after it, in the same
 * response.
 */

/** How a held page was released: its primary data arrived, or the hold ran out first. */
export type PageHoldOutcome = "ready" | "held";

/** A promise that also reports its result synchronously once settled, as React's `use` reads it. */
type TrackedPromise<T> = Promise<T> & { status?: "pending" | "fulfilled"; value?: T };

let documentHydrated = false;

/** Marks the document as hydrated; called once by the application frame's first effect. */
export const markDocumentHydrated = (): void => {
  documentHydrated = true;
};

/** Whether a page rendering now is a client-side page change rather than the first document. */
export const isClientPageChange = (): boolean => typeof window !== "undefined" && documentHydrated;

const settledValues = new WeakMap<Promise<unknown>, { value: unknown }>();

/** Records a streamed value once it settles, so a later render can read it without waiting. */
export const observeSettled = <T>(promise: Promise<T>): void => {
  if (settledValues.has(promise)) return;
  void promise.then(
    (value) => settledValues.set(promise, { value }),
    () => undefined,
  );
};

/** The value a streamed promise settled with, when it has already settled. */
export const settledValue = <T>(promise: Promise<T>): T | undefined =>
  settledValues.get(promise)?.value as T | undefined;

/** The page hold in milliseconds, from the platform token on the application's page outlet. */
const pageHoldMs = (): number => {
  const outlet = document.querySelector("[data-vortex-shell-outlet]");
  const value = outlet === null ? undefined : readMotionSeconds(outlet, "page-hold");
  return value === undefined ? 0 : Math.max(0, value * 1000);
};

const holds = new WeakMap<Promise<unknown>, TrackedPromise<PageHoldOutcome>>();

/**
 * The hold for one page's primary data, created once per streamed promise so every render attempt
 * of the waiting page reads the same hold. It settles "ready" when the data arrives and "held" when
 * the page hold token passes first, and it reports its outcome synchronously once settled.
 */
export const pageHoldFor = (primary: Promise<unknown>): Promise<PageHoldOutcome> => {
  const existing = holds.get(primary);
  if (existing !== undefined) return existing;
  observeSettled(primary);
  const holdMs = pageHoldMs();
  const hold: TrackedPromise<PageHoldOutcome> = new Promise<PageHoldOutcome>((resolve) => {
    const timer = holdMs > 0 ? window.setTimeout(() => resolve("held"), holdMs) : undefined;
    if (timer === undefined) resolve("held");
    void primary.then(
      () => {
        window.clearTimeout(timer);
        resolve("ready");
      },
      () => {
        window.clearTimeout(timer);
        resolve("ready");
      },
    );
  });
  hold.status = "pending";
  void hold.then((outcome) => {
    hold.status = "fulfilled";
    hold.value = outcome;
  });
  holds.set(primary, hold);
  return hold;
};

/**
 * The first placement identity, in document order, of a page's own content that the server is
 * streaming: the page's primary data (the first table, list, board or other streamed read in the
 * content region). The rule reads only the projected composition's placement identities and order,
 * never a block kind or a definition name.
 */
export const primaryStreamedPlacement = (
  content: unknown,
  streamed: Readonly<Record<string, unknown>>,
): string | undefined => {
  const streamedIds = new Map(Object.keys(streamed).map((id) => [id.toLowerCase(), id]));
  if (streamedIds.size === 0) return undefined;
  // A projected composition is Puck data: each item list is in document (desktop) order and each
  // item holds its child slots, so a depth-first walk meets placements in document order.
  let found: string | undefined;
  const composition =
    typeof content === "object" && content !== null && "composition" in content
      ? (content as Readonly<Record<string, unknown>>).composition
      : content;
  walkPageComposition(composition, ({ placementId }) => {
    if (found !== undefined) return false;
    found = streamedIds.get(placementId.toLowerCase());
    return found === undefined ? undefined : false;
  });
  return found;
};
