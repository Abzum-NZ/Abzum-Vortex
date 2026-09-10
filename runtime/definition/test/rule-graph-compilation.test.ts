import fs from "node:fs";
import path from "node:path";
import {
  containedComponentIdSchema,
  fieldIdSchema,
  recordTypeIdSchema,
  ruleIdSchema,
  sourceRuleGraphSchema,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { compileRuleGraph, type RuleGraphCompilationResolver } from "../src/rule-graph-compilation";

const readFixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, `../../../testing/fixtures/rule-graphs/${name}`),
      "utf8",
    ),
  );

const sourceFixture = readFixture("before-save-complete.source.json");
const canonicalFixture = readFixture("before-save-complete.canonical.json");
const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const nodeIds = new Map([
  ["start", id(31)],
  ["eligible", id(32)],
  ["remember_budget", id(33)],
  ["apply_budget", id(34)],
  ["require_relation", id(35)],
  ["warn_adjustment", id(36)],
  ["refuse_amount", id(37)],
  ["finish", id(38)],
  ["clear_obsolete_note", id(39)],
]);
const inputIds = new Map([
  ["minimum_amount", id(11)],
  ["requested_budget", id(12)],
  ["related_record", id(13)],
]);
const variableIds = new Map([
  ["effective_budget", id(21)],
  ["remembered_record", id(22)],
  ["table_values", id(23)],
]);
const fieldIds = new Map([
  ["amount", id(41)],
  ["status", id(42)],
  ["budget", id(43)],
  ["related", id(44)],
  ["obsolete_note", id(45)],
]);
const recordTypeIds = new Map([
  ["example.shared:related", id(3)],
  ["example.shared:alternative", id(4)],
]);

const required = <T>(
  map: ReadonlyMap<string, string>,
  key: string,
  parse: (value: string) => T,
) => {
  const value = map.get(key);
  if (!value) throw new Error(`Missing test resolution for ${key}`);
  return parse(value);
};

const resolver: RuleGraphCompilationResolver = {
  ruleId: () => ruleIdSchema.parse(id(1)),
  nodeId: (_rule, alias) => required(nodeIds, alias, containedComponentIdSchema.parse),
  inputId: (_rule, alias) => required(inputIds, alias, containedComponentIdSchema.parse),
  variableId: (_rule, alias) => required(variableIds, alias, containedComponentIdSchema.parse),
  localRecordTypeId: () => recordTypeIdSchema.parse(id(2)),
  localFieldId: (_record, alias) => required(fieldIds, alias, fieldIdSchema.parse),
  qualifiedRecordTypeId: (reference) =>
    required(recordTypeIds, reference, recordTypeIdSchema.parse),
};

const leafPaths = (
  value: unknown,
  base: Array<string | number> = [],
): Array<Array<string | number>> => {
  if (value === null || typeof value !== "object") return [base];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => leafPaths(entry, [...base, index]));
  return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...base, key]));
};

describe("Rule graph compilation helper", () => {
  it("lowers the complete authored graph to the deterministic canonical fixture", () => {
    const source = sourceRuleGraphSchema.parse(sourceFixture);
    const compiled = compileRuleGraph(source, resolver);

    expect(compiled.graph).toEqual(canonicalFixture);
    const canonicalPaths = compiled.provenance.map((entry) => JSON.stringify(entry.canonicalPath));
    expect(new Set(canonicalPaths).size).toBe(canonicalPaths.length);
    expect(new Set(canonicalPaths)).toEqual(
      new Set(leafPaths(compiled.graph).map((path) => JSON.stringify(path))),
    );
  });

  it("records exact normalization, reference resolution and source-to-sorted positions", () => {
    const compiled = compileRuleGraph(sourceRuleGraphSchema.parse(sourceFixture), resolver);

    expect(compiled.provenance).toContainEqual({
      canonicalPath: ["nodes", 1, "condition", "conditions", 0, "right", "value", "value"],
      origin: "source",
      sourcePath: ["nodes", 1, "condition", "conditions", 0, "right", "value", "value"],
      ruleCode: "vortex.definition.semantic_transform",
    });
    expect(compiled.provenance).toContainEqual({
      canonicalPath: ["variables", 1, "recordTypeIds", 0],
      origin: "resolved",
      sourcePath: ["variables", 1, "record_types", 0],
      ruleCode: "vortex.definition.immutable_resolution",
    });
    expect(compiled.provenance).toContainEqual({
      canonicalPath: ["edges", 1, "port"],
      origin: "source",
      sourcePath: ["edges", 2, "port"],
    });
  });

  it("normalizes table cells from their explicit columns without changing row order", () => {
    const source = sourceRuleGraphSchema.parse({
      ...(sourceFixture as object),
      variables: [
        ...(sourceFixture as { variables: unknown[] }).variables,
        {
          id: "table_values",
          key: "table_values",
          type: "table",
          columns: [
            { key: "tax", type: "decimal_number", required: true },
            { key: "amount", type: "money", required: true },
          ],
          default_value: {
            type: "table",
            columns: [
              { key: "tax", type: "decimal_number", required: true },
              { key: "amount", type: "money", required: true },
            ],
            value: [
              { tax: "1.2000", amount: { amount: "12.3400", currency: "NZD" } },
              { tax: "2.500", amount: { amount: "9.000", currency: "NZD" } },
            ],
          },
        },
      ],
    });

    const compiled = compileRuleGraph(source, resolver);
    const table = compiled.graph.variables.find((variable) => variable.key === "table_values");
    expect(table?.columns?.map((column) => column.key)).toEqual(["amount", "tax"]);
    expect(table?.defaultValue).toEqual({
      type: "table",
      columns: [
        { key: "amount", type: "money", required: true },
        { key: "tax", type: "decimal_number", required: true },
      ],
      value: [
        { tax: "1.2", amount: { amount: "12.34", currency: "NZD" } },
        { tax: "2.5", amount: { amount: "9", currency: "NZD" } },
      ],
    });
  });
});
