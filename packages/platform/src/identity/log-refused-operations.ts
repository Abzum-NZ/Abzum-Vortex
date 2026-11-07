import "server-only";

import { classifyRequestFailure } from "../access/request-failure";
import { describeFailure } from "../catalogue/runtime-primitives";

const causes = new WeakMap<object, unknown>();
const loggedElsewhere = new WeakSet<object>();

/**
 * A refusal an operation answered because a database call failed: the wrapper below logs it once
 * with that cause, at the level the cause's class decides. Returns the same result.
 */
export const refusedBy = <const Result extends object>(result: Result, cause: unknown): Result => {
  causes.set(result, cause);
  return result;
};

/**
 * A refusal whose failure the request boundary that aborts on it logs itself: the wrapper below
 * adds no line. Returns the same result.
 */
export const refusedLoggedElsewhere = <const Result extends object>(result: Result): Result => {
  loggedElsewhere.add(result);
  return result;
};

/**
 * Every refused operation logs one line with a stable code naming the operation and the refusal
 * (for example TENANT_ADMIN_PROVISION_TENANT_INVALID_COMMAND, the prefix being the caller's area),
 * so a refusal that reaches the operator is never silent. An answer the caller's own input or
 * configuration gives is information; one that a failed database call gave carries that call's
 * cause and is information for a refusal or a race and an error for a platform fault.
 */
export const logRefusedOperations = <
  Operations extends Record<string, (...args: never[]) => Promise<unknown>>,
>(
  prefix: string,
  operations: Operations,
): Operations => {
  const wrapped: Record<string, unknown> = {};
  for (const [name, operation] of Object.entries(operations))
    wrapped[name] = async (...args: never[]) => {
      const result = await operation(...args);
      if (
        typeof result === "object" &&
        result !== null &&
        "outcome" in result &&
        result.outcome === "refused"
      ) {
        if (loggedElsewhere.has(result)) return result;
        const cause = causes.get(result);
        const detail = result as { operation?: unknown; code?: unknown };
        const line = `[identity] refused ${prefix}_${String(detail.operation ?? name).toUpperCase()}_${String(detail.code ?? "unspecified").toUpperCase()}`;
        if (cause === undefined) console.info(line);
        else if (classifyRequestFailure(cause, { addressed: false }).level === "info")
          console.info(`${line} cause=${describeFailure(cause)}`);
        else console.error(`${line} cause=${describeFailure(cause)}`);
      }
      return result;
    };
  return wrapped as Operations;
};
