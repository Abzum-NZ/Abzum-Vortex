import {
  PLATFORM_SERVICE_OPERATIONS,
  type PlatformServiceOperationKey,
} from "../../catalogue/platform-service-operation-catalogue";
import { fail, type JsonObject } from "./shared";

/**
 * Resolves a source action's registered protected-operation key to the exact operation reference
 * the canonical action carries. Registration is the platform-service catalogue; an action never
 * names an operation identity itself.
 */
export function platformServiceProtectedOperationReference(key: unknown): JsonObject {
  const operation = PLATFORM_SERVICE_OPERATIONS[String(key) as PlatformServiceOperationKey];
  if (operation === undefined)
    fail("vortex.definition.workflow_node_references", "broken_reference");
  return {
    owner: { kind: "platform_service", serviceId: operation.release.serviceId },
    operationId: operation.release.operationId,
  };
}
