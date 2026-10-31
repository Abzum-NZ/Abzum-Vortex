import "server-only";

import { after } from "next/server";
import {
  createBackgroundFlowExecutor,
  createSimulatedBackendAdapter,
  type BackendAdapter,
} from "@vortex/platform/server";
import { requestDependencies } from "./application-page/installed-context";
import { applicationStoreService } from "./application-store-service";
import { getQueryContinuationKey } from "./query-continuation-key";

let adapter: BackendAdapter | undefined;

/** The one in-process back-end adapter: Run on back end children and after-save subscribers. */
export const backendAdapter = (): BackendAdapter => {
  adapter ??= createSimulatedBackendAdapter({
    execute: createBackgroundFlowExecutor({
      requests: requestDependencies(),
      applicationStore: applicationStoreService(),
      continuationKey: getQueryContinuationKey(),
      backend: backendAdapter,
    }),
    schedule: (work) => after(work),
  });
  return adapter;
};
