import { readMotionSeconds } from "./motion-tokens";

/**
 * Hold then swap. When the next page of an application arrives with its primary placement's data
 * still streaming, the page waits (suspends inside the navigation's transition, so React keeps the
 * current page on screen) until that data has arrived or the page hold token has passed, whichever
 * comes first. A page that is still waiting after the hold swaps in with its loading skeleton.
 *
 * Only a page that mounts in the browser after the document has hydrated is held: the server render
 * and hydration never wait, so the first load streams exactly as before.
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
  const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // A projected slot holds `placements` by identity and their `order` per breakpoint; each
  // placement holds its own `slots`. The first breakpoint's order is the document order.
  const visit = (value: unknown): string | undefined => {
    if (!isObject(value)) return undefined;
    const placements = value.placements;
    if (isObject(placements)) {
      const order = isObject(value.order)
        ? Object.values(value.order).find((ids): ids is readonly string[] => Array.isArray(ids))
        : undefined;
      const ids = [
        ...(order ?? []),
        ...Object.keys(placements).filter((id) => !(order ?? []).includes(id)),
      ];
      for (const id of ids) {
        const own = streamedIds.get(id.toLowerCase());
        if (own !== undefined) return own;
        const placement = placements[id];
        if (!isObject(placement) || !isObject(placement.slots)) continue;
        for (const slot of Object.values(placement.slots)) {
          const found = visit(slot);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    }
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(isObject(content) && isObject(content.composition) ? content.composition : content);
};
