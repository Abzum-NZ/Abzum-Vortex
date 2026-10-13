/**
 * Every refused operation logs one line with a stable code naming the operation and the refusal
 * (for example TENANT_ADMIN_PROVISION_TENANT_INVALID_COMMAND, the prefix being the caller's area), so a refusal that reaches the
 * operator is never silent. The database cause, where there is one, is logged where it is mapped.
 */
export const logRefusedOperations = <Operations extends Record<string, (...args: never[]) => Promise<unknown>>>(
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
        const detail = result as { operation?: unknown; code?: unknown };
        console.error(
          `[identity] refused ${prefix}_${String(detail.operation ?? name).toUpperCase()}_${String(detail.code ?? "unspecified").toUpperCase()}`,
        );
      }
      return result;
    };
  return wrapped as Operations;
};

