import { jsonValueSchema, walkDefinitionContract } from "@vortex/contracts";
import type { z } from "zod";

type JsonObject = Record<string, unknown>;

/** Bind semantic walks to the schemas of this validation call, never shared state. */
export const createContractValueWalker = (
  roots: readonly { schema: z.core.$ZodType; value: unknown }[],
) => {
  const positions = new WeakMap<object, { schema: z.core.$ZodType; location: string } | null>();
  for (const [rootIndex, root] of roots.entries())
    walkDefinitionContract(root.schema, root.value, (schema, value, path) => {
      if (value === null || typeof value !== "object") return;
      const location = JSON.stringify([rootIndex, path]);
      const existing = positions.get(value);
      if (existing && existing.location !== location) positions.set(value, null);
      else if (existing !== null) positions.set(value, { schema, location });
    });

  return (value: unknown, visit: (value: JsonObject) => void): void => {
    if (value === null || typeof value !== "object") return;
    const position = positions.get(value);
    if (position === undefined)
      throw new Error("Semantic traversal requires a declared contract position");
    if (position === null)
      throw new Error("Semantic traversal refuses an ambiguous shared contract value");
    const visited = new WeakSet<object>();
    walkDefinitionContract(position.schema, value, (schema, entry) => {
      if (
        schema === jsonValueSchema ||
        schema._zod.def.type !== "object" ||
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
