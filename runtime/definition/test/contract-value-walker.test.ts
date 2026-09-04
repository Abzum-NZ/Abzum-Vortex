import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  actionDefinitionSchema,
  conditionNodeSchema,
  workflowValueSchema,
} from "@vortex/contracts";
import { createContractValueWalker } from "../src/contract-value-walker";

const fieldId = "00000000-0000-4000-8000-000000000001";
const payload = {
  source: "field",
  fieldId: "literal data",
  nested: [{ source: "node_output", nodeId: "literal data", outputKey: "literal data" }],
};

describe("semantic contract traversal", () => {
  it("does not interpret user-defined input-map keys as platform reference properties", () => {
    const schema = z.object({ inputs: z.record(z.string(), workflowValueSchema) }).strict();
    const value = schema.parse({
      inputs: { fieldId: { source: "literal", value: "ordinary input" } },
    });
    const references: unknown[] = [];
    createContractValueWalker([{ schema, value }])(value, (entry) => {
      if ("fieldId" in entry) references.push(entry.fieldId);
    });
    expect(references).toEqual([]);
  });
  it("inspects the real condition operand but not reference-shaped comparison data", () => {
    const condition = conditionNodeSchema.parse({
      kind: "comparison",
      operator: "equals",
      left: { source: "field", fieldId },
      right: { source: "value", value: payload },
    });
    const references: unknown[] = [];
    createContractValueWalker([{ schema: conditionNodeSchema, value: condition }])(
      condition,
      (entry) => {
        if (entry.source === "field") references.push(entry.fieldId);
      },
    );
    expect(references).toEqual([fieldId]);
  });

  it("keeps action literal inputs opaque while retaining the action target field", () => {
    const schema = actionDefinitionSchema.shape.effects.element;
    const effect = schema.parse({
      kind: "set_field",
      fieldId,
      value: { source: "literal", value: payload },
    });
    const references: unknown[] = [];
    createContractValueWalker([{ schema, value: effect }])(effect, (entry) => {
      if ("fieldId" in entry) references.push(entry.fieldId);
    });
    expect(references).toEqual([fieldId]);
    expect(effect).toMatchObject({ value: { value: payload } });
  });

  it("does not treat workflow literal data as a producer and retains real producer references", () => {
    const literal = workflowValueSchema.parse({ source: "literal", value: payload });
    const producer = workflowValueSchema.parse({
      source: "node_output",
      nodeId: fieldId,
      outputKey: "result",
    });
    const walk = createContractValueWalker([
      { schema: workflowValueSchema, value: literal },
      { schema: workflowValueSchema, value: producer },
    ]);
    const references: unknown[] = [];
    const inspect = (entry: Record<string, unknown>) => {
      if (entry.source === "node_output") references.push(entry.nodeId);
    };
    walk(literal, inspect);
    walk(producer, inspect);
    expect(references).toEqual([fieldId]);
    expect(() => walk(structuredClone(producer), inspect)).toThrow("declared contract position");
  });
});
