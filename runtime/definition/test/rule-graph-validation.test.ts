import fs from "node:fs";
import path from "node:path";
import {
  ruleGraphSchema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
  type RuleGraph,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { ruleGraphValidationCodes, validateRuleGraph } from "../src/rule-graph-validation";

const readFixture = (): RuleGraph =>
  ruleGraphSchema.parse(
    JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../../testing/fixtures/rule-graphs/before-save-complete.canonical.json",
        ),
        "utf8",
      ),
    ),
  );

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const field = (
  fieldId: string,
  key: string,
  type: ModuleFieldV2["type"],
  settings: unknown,
): ModuleFieldV2 =>
  ({
    fieldId,
    key,
    label: key,
    required: false,
    unique: false,
    filterable: true,
    sortable: true,
    personalData: "none",
    publicDisplay: "refused",
    type,
    settings,
  }) as ModuleFieldV2;

const fields: ModuleFieldV2[] = [
  field(id(41), "amount", "decimal_number", {
    digitsBeforeDecimal: 30,
    decimalPlaces: 12,
  }),
  field(id(42), "status", "text", { maxLength: 120 }),
  field(id(43), "budget", "money", { currencyMode: "fixed", currency: "NZD" }),
  field(id(44), "related", "link", {
    target: { state: "resolved", moduleRootId: id(101), recordTypeId: id(3) },
    reverseKey: "candidates",
    onParentDelete: "refuse",
  }),
  field(id(45), "obsolete_note", "text", { maxLength: 120 }),
  field(id(46), "sequence", "reference_number", { digits: 8 }),
  field(id(47), "charges", "table", {
    minimumRows: 0,
    maximumRows: 1_000,
    columns: [
      {
        key: "amount",
        type: "money",
        required: true,
        settings: { currencyMode: "fixed", currency: "NZD" },
      },
      {
        key: "tax",
        type: "decimal_number",
        required: false,
        settings: { digitsBeforeDecimal: 30, decimalPlaces: 12 },
      },
    ],
  }),
];

const subjectRecordType = {
  recordTypeId: id(2),
  fields,
} as RecordTypeDefinitionV2;
const availableRecordTypeIds = new Set([id(2), id(3), id(4)]);

const validate = (graph: RuleGraph, available: ReadonlySet<string> = availableRecordTypeIds) =>
  validateRuleGraph({
    graph: ruleGraphSchema.parse(graph),
    subjectRecordType,
    availableRecordTypeIds: available,
  });

const copy = (): RuleGraph => structuredClone(readFixture());
const codes = (graph: RuleGraph, available?: ReadonlySet<string>) =>
  validate(graph, available).map((entry) => entry.ruleCode);

describe("Rule graph semantic validation helper", () => {
  it("accepts the complete update-only graph", () => {
    expect(validate(readFixture())).toEqual([]);
  });

  it.each([
    ["missing condition branch", (graph: RuleGraph) => graph.edges.splice(1, 1)],
    [
      "dangling endpoint",
      (graph: RuleGraph) => {
        graph.edges[7] = { ...graph.edges[7]!, toNodeId: id(99) };
      },
    ],
    [
      "cycle",
      (graph: RuleGraph) => {
        graph.edges[6] = { ...graph.edges[6]!, toNodeId: id(32) };
      },
    ],
  ])("refuses %s as graph topology", (_label, mutate) => {
    const graph = copy();
    mutate(graph);
    expect(codes(graph)).toContain(ruleGraphValidationCodes.topology);
  });

  it("refuses previous-field reads for a create entry path", () => {
    const graph = copy();
    const start = graph.nodes[0];
    if (!start || start.type !== "start") throw new Error("Expected fixture start node");
    start.operations = ["create", "update"];

    expect(codes(graph)).toContain(ruleGraphValidationCodes.references);
  });

  it("refuses non-local and generated write targets", () => {
    const missing = copy();
    const missingSet = missing.nodes[3];
    if (!missingSet || missingSet.type !== "set_field")
      throw new Error("Expected fixture set-field node");
    missingSet.fieldId = id(99);
    expect(codes(missing)).toContain(ruleGraphValidationCodes.references);

    const generated = copy();
    const generatedSet = generated.nodes[3];
    if (!generatedSet || generatedSet.type !== "set_field")
      throw new Error("Expected fixture set-field node");
    generatedSet.fieldId = id(46);
    expect(codes(generated)).toContain(ruleGraphValidationCodes.references);
  });

  it("checks assignment types and declared record targets", () => {
    const wrongType = copy();
    const set = wrongType.nodes[3];
    if (!set || set.type !== "set_field") throw new Error("Expected fixture set-field node");
    set.assignment = {
      kind: "set",
      value: { source: "input", inputId: id(13) },
    };
    expect(codes(wrongType)).toContain(ruleGraphValidationCodes.valueTypes);

    const wrongTarget = copy();
    const condition = wrongTarget.nodes[1];
    if (!condition || condition.type !== "condition" || condition.condition.kind !== "all")
      throw new Error("Expected fixture condition node");
    condition.condition.conditions[2] = {
      kind: "comparison",
      operator: "equals",
      left: { source: "input", inputId: id(13) },
      right: {
        source: "literal",
        value: {
          type: "link",
          value: { recordTypeId: id(4), recordId: id(201) },
        },
      },
    };
    expect(codes(wrongTarget)).toContain(ruleGraphValidationCodes.valueTypes);
  });

  it("requires every declared and literal record target to be in the exact Module catalogue", () => {
    const graph = copy();
    const onlySubject = new Set([id(2)]);
    const issues = validate(graph, onlySubject);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: ruleGraphValidationCodes.references,
          path: ["inputs", 2, "recordTypeIds", 0],
        }),
        expect.objectContaining({
          ruleCode: ruleGraphValidationCodes.references,
          path: ["variables", 1, "defaultValue", "value", "recordTypeId"],
        }),
        expect.objectContaining({
          ruleCode: ruleGraphValidationCodes.references,
          path: [
            "nodes",
            1,
            "condition",
            "conditions",
            2,
            "right",
            "value",
            "value",
            "recordTypeId",
          ],
        }),
      ]),
    );
  });

  it("checks a reference default against its variable targets, not only the catalogue", () => {
    const graph = copy();
    graph.variables[1]!.recordTypeIds = [id(4)];
    expect(validate(graph)).toContainEqual({
      ruleCode: ruleGraphValidationCodes.valueTypes,
      family: "invalid_value",
      path: ["variables", 1, "defaultValue"],
    });
  });

  it("does not treat table cell contents as previous-field operands", () => {
    const graph = copy();
    graph.nodes[0] = { ...graph.nodes[0]!, type: "start", operations: ["create"] };
    graph.nodes[1] = {
      nodeId: id(32),
      nodeVersion: "1.0.0",
      type: "condition",
      condition: {
        kind: "comparison",
        operator: "is_not_empty",
        left: {
          source: "literal",
          value: {
            type: "table",
            columns: [{ key: "source", type: "text", required: true }],
            value: [{ source: "previous_field" }],
          },
        },
      },
    };
    expect(validate(graph)).toEqual([]);
  });

  it("leaves final field policy to the owning save, allowing intermediate typed writes", () => {
    const graph = copy();
    const set = graph.nodes[3];
    if (!set || set.type !== "set_field") throw new Error("Expected fixture set-field node");
    set.assignment = {
      kind: "set",
      value: {
        source: "literal",
        value: { type: "money", value: { amount: "1", currency: "USD" } },
      },
    };
    // The field requires NZD. Publication checks this is money; Record must
    // reject a final USD candidate unless a later configured node corrects it.
    expect(validate(graph)).toEqual([]);
  });

  it("distinguishes optional absence probes from reads that require a present value", () => {
    const probe = copy();
    const condition = probe.nodes[1];
    if (!condition || condition.type !== "condition")
      throw new Error("Expected fixture condition node");
    condition.condition = {
      kind: "comparison",
      operator: "is_empty",
      left: { source: "input", inputId: id(11) },
    };
    expect(codes(probe)).not.toContain(ruleGraphValidationCodes.variableAvailability);

    const read = copy();
    const readCondition = read.nodes[1];
    if (
      !readCondition ||
      readCondition.type !== "condition" ||
      readCondition.condition.kind !== "all"
    )
      throw new Error("Expected fixture condition node");
    readCondition.condition.conditions[0] = {
      kind: "comparison",
      operator: "greater_than",
      left: { source: "input", inputId: id(11) },
      right: {
        source: "literal",
        value: { type: "decimal_number", value: "1" },
      },
    };
    expect(codes(read)).toContain(ruleGraphValidationCodes.variableAvailability);
  });

  it("requires a variable to be available on every incoming branch", () => {
    const graph = copy();
    const variable = graph.variables[0];
    delete variable.defaultValue;
    graph.edges[1] = { ...graph.edges[1]!, toNodeId: id(34) };
    graph.nodes.splice(6, 1);
    graph.edges.splice(6, 1);

    expect(codes(graph)).toContain(ruleGraphValidationCodes.variableAvailability);
  });

  it("compares table declarations without treating Record field settings as graph metadata", () => {
    const graph = copy();
    graph.inputs.push({
      inputId: id(14),
      key: "charges",
      type: "table",
      required: true,
      columns: [
        { key: "amount", type: "money", required: true },
        { key: "tax", type: "decimal_number", required: false },
      ],
    });
    const set = graph.nodes[3];
    if (!set || set.type !== "set_field") throw new Error("Expected fixture set-field node");
    set.fieldId = id(47);
    set.assignment = { kind: "set", value: { source: "input", inputId: id(14) } };
    expect(validate(graph)).toEqual([]);

    graph.inputs[3]!.columns[0] = {
      key: "amount",
      type: "decimal_number",
      required: true,
    };
    expect(codes(graph)).toContain(ruleGraphValidationCodes.valueTypes);
  });
});
