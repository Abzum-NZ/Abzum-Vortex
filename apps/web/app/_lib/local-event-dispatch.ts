import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  createEventDispatcherWakeup,
  createSearchEventConsumer,
  createSearchIndexDependencies,
} from "@vortex/platform/server";

/**
 * Local development has no database webhook (it needs a public HTTPS endpoint) and no Kestra
 * recovery tick, so the committed Event outbox would never be delivered. This runs the same bounded
 * dispatcher in process with a credential generated for this process alone; hosted deployments keep
 * the protected `/api/events/dispatch` route as their only trigger.
 */
export type LocalEventDispatcher = Readonly<{
  /** One bounded dispatch; throws with the refusal reason or the failed delivery counts. */
  dispatchOnce: () => Promise<number>;
  /** Dispatches until the outbox has nothing left to claim. */
  drain: () => Promise<number>;
}>;

const maximumDrainDispatches = 500;

export const createLocalEventDispatcher = (): LocalEventDispatcher => {
  const credential = randomBytes(32).toString("hex");
  const wakeup = createEventDispatcherWakeup({
    consumers: [createSearchEventConsumer(createSearchIndexDependencies())],
    environment: {
      VORTEX_EVENT_DISPATCHER_CREDENTIAL_SHA256: createHash("sha256")
        .update(credential, "utf8")
        .digest("hex"),
    },
  });

  const dispatchOnce = async (): Promise<number> => {
    const response = await wakeup.handle({
      authorization: `Bearer ${credential}`,
      body: { source: "scheduled_recovery" },
    });
    if (response.outcome === "refused")
      throw new Error(`The event dispatcher was refused: ${response.reason}.`);
    if (response.outcome === "invalid_request")
      throw new Error(`The event dispatch request was invalid: ${response.code}.`);
    const { result } = response;
    if (result.status === "interrupted" || result.status === "partial_failure")
      throw new Error(`Event delivery did not complete: ${JSON.stringify(result)}.`);
    return result.claimedCount;
  };

  const drain = async (): Promise<number> => {
    let delivered = 0;
    for (let dispatches = 0; dispatches < maximumDrainDispatches; dispatches += 1) {
      const claimed = await dispatchOnce();
      if (claimed === 0) return delivered;
      delivered += claimed;
    }
    throw new Error(`Event delivery was still claiming after ${maximumDrainDispatches} dispatches.`);
  };

  return Object.freeze({ dispatchOnce, drain });
};

const localDispatchIntervalMs = 2_000;

/** Delivers committed occurrences every few seconds in `next dev`; a failure is logged with its cause. */
export const startLocalEventDispatch = (): void => {
  const dispatcher = createLocalEventDispatcher();
  let running = false;
  let lastFailure: string | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatcher
      .dispatchOnce()
      .then(() => {
        lastFailure = undefined;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastFailure) console.error("[local event dispatch]", error);
        lastFailure = message;
      })
      .finally(() => {
        running = false;
      });
  }, localDispatchIntervalMs);
  timer.unref();
};
