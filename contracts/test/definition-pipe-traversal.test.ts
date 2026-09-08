import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  walkDefinitionContract,
  unresolvedRecordTypeReferencePaths,
  recordTypeReferenceSchema,
} from "../src/definitions";
import { jsonValueSchema } from "../src/common";

describe("parsed definition pipeline traversal", () => {
  it("visits declared output references without executing preprocessing again", () => {
    let preprocessingCalls = 0;
    const schema = z.preprocess(
      (value) => {
        preprocessingCalls += 1;
        return value;
      },
      z.object({ target: recordTypeReferenceSchema, payload: jsonValueSchema }),
    );
    const value = schema.parse({
      target: { state: "unresolved", qualifiedKey: "shared:related" },
      payload: { state: "unresolved", qualifiedKey: "not_a:reference" },
    });
    expect(unresolvedRecordTypeReferencePaths(schema, value)).toEqual([["target"]]);
    const paths: PropertyKey[][] = [];
    walkDefinitionContract(schema, value, (position, _entry, path) => {
      if (position === recordTypeReferenceSchema) paths.push(path);
    });
    expect(paths).toEqual([["target"]]);
    expect(preprocessingCalls).toBe(1);
  });

  it("selects a nested union branch from parsed output without rerunning its preprocessor", () => {
    let preprocessingCalls = 0;
    const schema = z.union([
      z.object({ kind: z.literal("plain"), value: z.string() }).strict(),
      z.union([
        z.object({ kind: z.literal("other"), value: z.number() }).strict(),
        z
          .object({
            kind: z.literal("reference"),
            target: z.preprocess((value) => {
              preprocessingCalls += 1;
              return value;
            }, recordTypeReferenceSchema),
          })
          .strict(),
      ]),
    ]);
    const value = schema.parse({
      kind: "reference",
      target: { state: "unresolved", qualifiedKey: "shared:related" },
    });

    expect(unresolvedRecordTypeReferencePaths(schema, value)).toEqual([["target"]]);
    expect(preprocessingCalls).toBe(1);
  });

  it("distinguishes same-tag object branches by their complete parsed structure", () => {
    const schema = z.union([
      z
        .object({
          kind: z.literal("reference"),
          source: z.literal("direct"),
          ignored: jsonValueSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("reference"),
          source: z.literal("resolved"),
          target: recordTypeReferenceSchema,
        })
        .strict(),
    ]);
    const value = schema.parse({
      kind: "reference",
      source: "resolved",
      target: { state: "unresolved", qualifiedKey: "shared:related" },
    });

    expect(unresolvedRecordTypeReferencePaths(schema, value)).toEqual([["target"]]);
  });

  it("matches untagged object and array output without rerunning nested preprocessors", () => {
    let preprocessingCalls = 0;
    const processedReference = z.preprocess((value) => {
      preprocessingCalls += 1;
      return value;
    }, recordTypeReferenceSchema);
    const schema = z.union([
      z.object({ values: z.array(z.number()) }).strict(),
      z.object({ values: z.array(processedReference) }).strict(),
    ]);
    const value = schema.parse({
      values: [{ state: "unresolved", qualifiedKey: "shared:related" }],
    });

    expect(unresolvedRecordTypeReferencePaths(schema, value)).toEqual([["values", 0]]);
    expect(preprocessingCalls).toBe(1);
  });
});
