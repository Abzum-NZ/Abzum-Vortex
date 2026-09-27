import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  jsonValueSchema,
  recordTypeReferenceSchema,
  requireResolvedRecordTypeReferences,
  unresolvedRecordTypeReferencePaths,
} from "../src";

const literal = {
  state: "unresolved",
  qualifiedKey: "sample:item",
  nested: [{ source: "node_output", fieldId: "ordinary data", value: null }],
};

describe("declared reference positions", () => {
  it("reports a genuine unresolved reference at its exact path alongside literal data", () => {
    const schema = z
      .object({
        refs: z.array(recordTypeReferenceSchema.nullable()),
        data: jsonValueSchema,
      })
      .strict();
    const value = schema.parse({
      refs: [null, { state: "unresolved", qualifiedKey: "sample:item" }],
      data: literal,
    });
    expect(unresolvedRecordTypeReferencePaths(schema, value, ["content"])).toEqual([
      ["content", "refs", 1],
    ]);
    const published = schema
      .superRefine((entry, context) => requireResolvedRecordTypeReferences(schema, entry, context))
      .safeParse(value);
    expect(published.success).toBe(false);
    if (!published.success) expect(published.error.issues[0]?.path).toEqual(["refs", 1]);
  });
});
