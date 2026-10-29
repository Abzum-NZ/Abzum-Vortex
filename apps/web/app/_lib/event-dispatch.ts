import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  createEventDispatcherWakeup,
  createDerivedFieldBackfillConsumer,
  createSearchEventConsumer,
  createSearchIndexDependencies,
} from "@vortex/platform/server";

/**
 * Runs the bounded dispatcher with a process-local credential and the dispatcher system grant.
 */
type InProcessEventDispatcher = Readonly<{
  /** One bounded dispatch; throws with the refusal reason or the failed delivery counts. */
  dispatchOnce: () => Promise<number>;
  /** Dispatches until the outbox has nothing left to claim. */
  drain: () => Promise<number>;
}>;

const maximumDrainDispatches = 500;

export const createInProcessEventDispatcher = (): InProcessEventDispatcher => {
  const credential = randomBytes(32).toString("hex");
  const wakeup = createEventDispatcherWakeup({
    consumers: [
      createDerivedFieldBackfillConsumer(),
      createSearchEventConsumer(createSearchIndexDependencies()),
    ],
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
    throw new Error(
      `Event delivery was still claiming after ${maximumDrainDispatches} dispatches.`,
    );
  };

  return Object.freeze({ dispatchOnce, drain });
};
