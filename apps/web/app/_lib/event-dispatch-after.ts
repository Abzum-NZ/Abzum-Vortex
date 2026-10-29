import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { createInProcessEventDispatcher } from "./event-dispatch";

const dispatcherContext = new AsyncLocalStorage<boolean>();
const dispatcher = createInProcessEventDispatcher();
let running: Promise<void> | undefined;
let queued = false;

const dispatch = (): Promise<void> => {
  if (running !== undefined) {
    queued = true;
    return running;
  }
  running = dispatcherContext.run(true, async () => {
    try {
      do {
        queued = false;
        try {
          await dispatcher.dispatchOnce();
        } catch (error) {
          console.error("[events] committed transaction dispatch failed", error);
        }
      } while (queued);
    } finally {
      running = undefined;
    }
  });
  return running;
};

/** Schedule only after commit, and never recursively schedule the dispatcher's own transactions. */
export const scheduleCommittedEventDispatch = (): void => {
  if (dispatcherContext.getStore()) return;
  after(dispatch);
};
