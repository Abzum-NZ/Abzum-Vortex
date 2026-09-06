import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  blockSettingValueSchema,
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
  it("does not interpret literal JSON, including nested arrays and wrapper-shaped objects", () => {
    const schema = z
      .object({
        settings: z.record(z.string(), blockSettingValueSchema),
        defaults: jsonValueSchema.optional(),
      })
      .strict();
    const input = {
      settings: { payload: { kind: "literal", value: literal } },
      defaults: [literal],
    };
    const parsed = schema.parse(input);
    expect(unresolvedRecordTypeReferencePaths(schema, parsed)).toEqual([]);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
  });

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

  it("continues to reject malformed references and unknown discriminators", () => {
    for (const value of [
      { state: "other", qualifiedKey: "sample:item" },
      { state: "unresolved", qualifiedKey: "not qualified" },
      { state: "resolved", moduleRootId: "not an id", recordTypeId: "not an id" },
    ])
      expect(recordTypeReferenceSchema.safeParse(value).success).toBe(false);
    expect(blockSettingValueSchema.safeParse({ kind: "unknown", value: literal }).success).toBe(
      false,
    );
  });
});
