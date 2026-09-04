import { jsonValueSchema, walkDefinitionContract } from "@vortex/contracts";
import type { z } from "zod";

type JsonObject = Record<string, unknown>;

/** Bind semantic walks to the schemas of this validation call, never shared state. */
export const createContractValueWalker = (
  roots: readonly { schema: z.core.$ZodType; value: unknown }[],
) => {
  const positions = new WeakMap<object, z.core.$ZodType>();
  for (const root of roots)
    walkDefinitionContract(root.schema, root.value, (schema, value) => {
      if (value !== null && typeof value === "object") positions.set(value, schema);
    });

  return (value: unknown, visit: (value: JsonObject) => void): void => {
    if (value === null || typeof value !== "object") return;
    const schema = positions.get(value);
    if (!schema) throw new Error("Semantic traversal requires a declared contract position");
    const visited = new WeakSet<object>();
    walkDefinitionContract(schema, value, (position, entry) => {
      if (
        position === jsonValueSchema ||
        position._zod.def.type !== "object" ||
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        visited.has(entry)
      )
        return;
      visited.add(entry);
      visit(entry as JsonObject);
    });
  };
};
