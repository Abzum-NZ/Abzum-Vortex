import {
  PLATFORM_SERVICE_OPERATIONS,
  platformOperationKey,
} from "../catalogue/platform-service-operation-catalogue";
import type { FlowTask } from "./flow-contracts";

/** The one catalogue lookup used by the server interpreter and compiled browser stubs. */
export const flowOperationOutputMembers = (task: FlowTask): Readonly<Record<string, string>> => {
  if (task.type !== "operation.call" || !("properties" in task)) return {};
  const operation = task.properties.operation;
  const key = operation?.kind === "literal" ? operation.literal.value : undefined;
  const entry = Object.values(PLATFORM_SERVICE_OPERATIONS).find(
    (candidate) => platformOperationKey(candidate.key) === key,
  );
  if (
    entry === undefined ||
    (entry.descriptor.effect !== "read" && entry.descriptor.effect !== "change")
  )
    return {};
  return Object.fromEntries(
    Object.entries(entry.descriptor.outputs).map(([member, declaration]) => [
      member,
      declaration.type,
    ]),
  );
};
