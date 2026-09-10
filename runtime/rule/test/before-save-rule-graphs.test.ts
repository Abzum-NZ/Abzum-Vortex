import fs from "node:fs";
import path from "node:path";
import {
  moduleDefinitionConsumerReadResultV3Schema,
  moduleFieldV2Schema,
  ruleGraphSchema,
  type JsonValue,
  type ModuleDefinitionConsumerReadResultV3,
  type ModuleFieldV2,
  type RuleGraph,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { BeforeSaveRuleGraphEvaluationError, evaluateBeforeSaveRuleGraphs } from "../src";

const id = (value: number) => `10000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;

const recordTypeId = id(2);
const relatedRecordTypeId = id(3);
const amountFieldId = id(41);
const statusFieldId = id(42);
const budgetFieldId = id(43);
const relatedFieldId = id(44);
const obsoleteFieldId = id(45);
const generatedFieldId = id(46);

const field = (fieldId: string, key: string, type: string, settings: unknown): ModuleFieldV2 =>
  moduleFieldV2Schema.parse({
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
  });

const fields = [
  field(amountFieldId, "amount", "decimal_number", {
    digitsBeforeDecimal: 30,
    decimalPlaces: 4,
  }),
  field(statusFieldId, "status", "text", { maxLength: 120 }),
  field(budgetFieldId, "budget", "money", { currencyMode: "fixed", currency: "NZD" }),
  field(relatedFieldId, "related", "link", {
    target: { state: "resolved", moduleRootId: id(80), recordTypeId: relatedRecordTypeId },
    reverseKey: "candidates",
    onParentDelete: "refuse",
  }),
  field(obsoleteFieldId, "obsolete_note", "text", { maxLength: 200 }),
  field(generatedFieldId, "reference", "reference_number", { digits: 8 }),
];

const completeGraph = ruleGraphSchema.parse(
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

const releaseWith = (rules: readonly RuleGraph[]): ModuleDefinitionConsumerReadResultV3 =>
  moduleDefinitionConsumerReadResultV3Schema.parse({
    kind: "module",
    rootId: id(90),
    organizationId: id(91),
    definitionKey: "example.candidate",
    releaseRevision: 1,
    releaseVersion: "1.0.0",
    validationContractVersion: "3.0.0",
    contentFingerprint: fingerprint,
    resolutionFingerprint: fingerprint,
    dependencyManifest: [],
    correlationId: id(92),
    content: {
      name: "Candidate",
      description: "Rule evaluator fixture",
      dependencies: [],
      recordTypes: [
        {
          recordTypeId,
          key: "candidate",
          singularLabel: "Candidate",
          pluralLabel: "Candidates",
          titleFieldId: statusFieldId,
          storageContractId: id(93),
          storageScope: "organization_shared",
          ownershipMode: "none",
          fields,
          relationships: [],
          standardActions: ["create", "read", "update"],
          customActionIds: [],
        },
      ],
      permissions: [],
      actions: [],
      events: [],
      rules,
      sharingConditions: [],
      extensionPoints: [],
    },
  });

const literal = (type: string, value: JsonValue) => ({ source: "literal", value: { type, value } });

const linearGraph = ({
  ruleId,
  priority,
  setValue,
  warning,
}: {
  ruleId: string;
  priority: number;
  setValue: string;
  warning: string;
}): RuleGraph =>
  ruleGraphSchema.parse({
    ruleId,
    key: warning,
    subjectRecordTypeId: recordTypeId,
    profile: "before_save",
    graphVersion: "1.0.0",
    priority,
    inputs: [],
    variables: [],
    nodes: [
      { nodeId: id(61), nodeVersion: "1.0.0", type: "start", operations: ["update"] },
      {
        nodeId: id(62),
        nodeVersion: "1.0.0",
        type: "condition",
        condition: {
          kind: "comparison",
          operator: "equals",
          left: { source: "current_field", fieldId: statusFieldId },
          right: literal("text", setValue === "first" ? "initial" : "first"),
        },
      },
      {
        nodeId: id(63),
        nodeVersion: "1.0.0",
        type: "set_field",
        fieldId: statusFieldId,
        assignment: { kind: "set", value: literal("text", setValue) },
      },
      {
        nodeId: id(64),
        nodeVersion: "1.0.0",
        type: "require_field",
        fieldId: generatedFieldId,
        code: "reference_required",
        message: "A reference must be generated.",
      },
      {
        nodeId: id(65),
        nodeVersion: "1.0.0",
        type: "warn",
        code: warning,
        message: warning,
      },
      { nodeId: id(66), nodeVersion: "1.0.0", type: "finish" },
    ],
    edges: [
      { fromNodeId: id(61), port: "next", toNodeId: id(62) },
      { fromNodeId: id(62), port: "false", toNodeId: id(66) },
      { fromNodeId: id(62), port: "true", toNodeId: id(63) },
      { fromNodeId: id(63), port: "next", toNodeId: id(64) },
      { fromNodeId: id(64), port: "next", toNodeId: id(65) },
      { fromNodeId: id(65), port: "next", toNodeId: id(66) },
    ],
  });

describe("before-save Rule graphs", () => {
  it("executes all eight node types over exact decimal, money, reference, and previous values", () => {
    const requestedBudget = {
      amount: "90071992547409931234567890.1234",
      currency: "NZD",
    };
    const related = {
      recordTypeId: relatedRecordTypeId,
      recordId: "80000000-0000-4000-8000-000000000001",
    };
    const initialCandidateValues = {
      [amountFieldId]: "9007199254740994",
      [statusFieldId]: "new",
      [budgetFieldId]: { amount: "1", currency: "NZD" },
      [obsoleteFieldId]: "remove me",
    } as const;
    const previousValues = {
      [amountFieldId]: "9007199254740994",
      [statusFieldId]: "old",
      [budgetFieldId]: { amount: "1", currency: "NZD" },
      [obsoleteFieldId]: "remove me",
    } as const;
    const inputValuesByRuleId = {
      [completeGraph.ruleId]: {
        [completeGraph.inputs[1]!.inputId]: requestedBudget,
        [completeGraph.inputs[2]!.inputId]: related,
      },
    };
    const untouched = structuredClone({
      initialCandidateValues,
      previousValues,
      inputValuesByRuleId,
    });

    const result = evaluateBeforeSaveRuleGraphs({
      release: releaseWith([completeGraph]),
      subjectRecordTypeId: recordTypeId,
      operation: "update",
      initialCandidateValues,
      previousValues,
      inputValuesByRuleId,
    });

    expect(result).toEqual({
      success: true,
      setValues: { [budgetFieldId]: requestedBudget },
      clearFieldIds: [obsoleteFieldId],
      requirements: [
        {
          fieldId: relatedFieldId,
          code: "related_required",
          message: "Choose a related record.",
        },
      ],
      warnings: [
        {
          code: "budget_adjusted",
          message: "The proposed budget was applied.",
        },
      ],
    });
    expect({ initialCandidateValues, previousValues, inputValuesByRuleId }).toEqual(untouched);
    if (result.success)
      (result.setValues[budgetFieldId] as { amount: string }).amount = "changed outside";
    expect(requestedBudget.amount).toBe("90071992547409931234567890.1234");
  });

  it("returns an explicit refusal without exposing an applicable patch", () => {
    const result = evaluateBeforeSaveRuleGraphs({
      release: releaseWith([completeGraph]),
      subjectRecordTypeId: recordTypeId,
      operation: "update",
      initialCandidateValues: {
        [amountFieldId]: "1",
        [statusFieldId]: "same",
        [obsoleteFieldId]: "unchanged",
      },
      previousValues: { [amountFieldId]: "1", [statusFieldId]: "same" },
      inputValuesByRuleId: {
        [completeGraph.ruleId]: {
          [completeGraph.inputs[1]!.inputId]: { amount: "12.34", currency: "NZD" },
          [completeGraph.inputs[2]!.inputId]: {
            recordTypeId: relatedRecordTypeId,
            recordId: id(200),
          },
        },
      },
    });

    expect(result).toEqual({
      success: false,
      refusal: {
        code: "amount_too_low",
        message: "The amount is below the allowed threshold.",
        fieldId: amountFieldId,
      },
      warnings: [],
    });
    expect("setValues" in result).toBe(false);
    expect("requirements" in result).toBe(false);
  });

  it("carries later writes across deterministic graph order and retains requirement duplicates", () => {
    const first = linearGraph({
      ruleId: id(501),
      priority: 10,
      setValue: "first",
      warning: "first",
    });
    const second = linearGraph({
      ruleId: id(502),
      priority: 10,
      setValue: "second",
      warning: "second",
    });

    const result = evaluateBeforeSaveRuleGraphs({
      release: releaseWith([second, first]),
      subjectRecordTypeId: recordTypeId,
      operation: "update",
      initialCandidateValues: { [statusFieldId]: "initial" },
      previousValues: { [statusFieldId]: "older" },
    });

    expect(result).toEqual({
      success: true,
      setValues: { [statusFieldId]: "second" },
      clearFieldIds: [],
      requirements: [
        {
          fieldId: generatedFieldId,
          code: "reference_required",
          message: "A reference must be generated.",
        },
        {
          fieldId: generatedFieldId,
          code: "reference_required",
          message: "A reference must be generated.",
        },
      ],
      warnings: [
        { code: "first", message: "first" },
        { code: "second", message: "second" },
      ],
    });
  });

  it("distinguishes an absent optional input from a value and refuses unsafe missing comparisons", () => {
    const optionalInputId = id(71);
    const graph = ruleGraphSchema.parse({
      ruleId: id(70),
      key: "optional_input",
      subjectRecordTypeId: recordTypeId,
      profile: "before_save",
      graphVersion: "1.0.0",
      priority: 0,
      inputs: [{ inputId: optionalInputId, key: "optional_input", type: "text", required: false }],
      variables: [],
      nodes: [
        { nodeId: id(72), nodeVersion: "1.0.0", type: "start", operations: ["create"] },
        {
          nodeId: id(73),
          nodeVersion: "1.0.0",
          type: "condition",
          condition: {
            kind: "comparison",
            operator: "is_empty",
            left: { source: "input", inputId: optionalInputId },
          },
        },
        {
          nodeId: id(74),
          nodeVersion: "1.0.0",
          type: "set_field",
          fieldId: statusFieldId,
          assignment: { kind: "clear" },
        },
        { nodeId: id(75), nodeVersion: "1.0.0", type: "finish" },
      ],
      edges: [
        { fromNodeId: id(72), port: "next", toNodeId: id(73) },
        { fromNodeId: id(73), port: "false", toNodeId: id(75) },
        { fromNodeId: id(73), port: "true", toNodeId: id(74) },
        { fromNodeId: id(74), port: "next", toNodeId: id(75) },
      ],
    });
    const release = releaseWith([graph]);

    expect(
      evaluateBeforeSaveRuleGraphs({
        release,
        subjectRecordTypeId: recordTypeId,
        operation: "create",
        initialCandidateValues: { [statusFieldId]: "draft" },
      }),
    ).toMatchObject({ success: true, clearFieldIds: [statusFieldId] });

    const unsafeGraph = ruleGraphSchema.parse({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.type === "condition"
          ? {
              ...node,
              condition: {
                kind: "not",
                condition: {
                  kind: "comparison",
                  operator: "equals",
                  left: { source: "input", inputId: optionalInputId },
                  right: literal("text", "expected"),
                },
              },
            }
          : node,
      ),
    });
    expect(() =>
      evaluateBeforeSaveRuleGraphs({
        release: releaseWith([unsafeGraph]),
        subjectRecordTypeId: recordTypeId,
        operation: "create",
        initialCandidateValues: { [statusFieldId]: "draft" },
      }),
    ).toThrowError("vortex.rule.typed_condition_input_refused");
  });

  it("refuses malformed candidate values and undeclared or wrong-target inputs", () => {
    expect(() =>
      evaluateBeforeSaveRuleGraphs({
        release: releaseWith([completeGraph]),
        subjectRecordTypeId: recordTypeId,
        operation: "update",
        initialCandidateValues: { [amountFieldId]: "1.00" as JsonValue },
        previousValues: {},
        inputValuesByRuleId: {
          [completeGraph.ruleId]: {
            [completeGraph.inputs[1]!.inputId]: { amount: "1", currency: "NZD" },
            [completeGraph.inputs[2]!.inputId]: {
              recordTypeId: id(999),
              recordId: id(200),
            },
          },
        },
      }),
    ).toThrowError(BeforeSaveRuleGraphEvaluationError);

    expect(() =>
      evaluateBeforeSaveRuleGraphs({
        release: releaseWith([completeGraph]),
        subjectRecordTypeId: recordTypeId,
        operation: "update",
        initialCandidateValues: { [amountFieldId]: "2", [statusFieldId]: "new" },
        previousValues: { [amountFieldId]: "2", [statusFieldId]: "old" },
        inputValuesByRuleId: { [id(999)]: {} },
      }),
    ).toThrowError("vortex.rule.before_save_graph_input_refused");
  });
});
