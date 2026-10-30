import "server-only";

import {
  createDerivedFieldBackfillConsumer,
  createFlowSubscriberConsumer,
  createSearchEventConsumer,
  createSearchIndexDependencies,
} from "@vortex/platform/server";
import { backendAdapter } from "./backend-adapter";
import { requestDependencies } from "./application-page/installed-context";

/** The consumers every event dispatcher delivers to: the in-process dispatch and the recovery tick. */
export const eventConsumers = () => [
  createDerivedFieldBackfillConsumer(),
  createSearchEventConsumer(createSearchIndexDependencies()),
  createFlowSubscriberConsumer({ requests: requestDependencies, adapter: backendAdapter }),
];
