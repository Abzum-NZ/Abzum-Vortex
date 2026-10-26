import "server-only";

import type { HumanOrganizationRequestDependencies } from "../access/human-organization-request";
import type { QueryContinuationKey } from "./continuation-token";

export type ProtectedQueryServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** Server-held AES-256-GCM key that makes continuation tokens opaque and bound. */
    continuationKey: QueryContinuationKey;
  }>;
