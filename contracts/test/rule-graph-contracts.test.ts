import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  moduleCanonicalDocumentV2Schema,
  moduleContractVersionPairV2Schema,
  moduleDraftV2Schema,
} from "../src/module-contracts-v2";
import {
  moduleCanonicalDocumentV3Schema,
  moduleContractVersionPairV3Schema,
  moduleDraftV3Schema,
} from "../src/module-contracts-v3";
import { moduleSourceDocumentV2Schema } from "../src/module-source-contracts-v2";
import { moduleSourceDocumentV3Schema } from "../src/module-source-contracts-v3";
import {
  ruleGraphConditionSchema,
  ruleGraphInputDeclarationSchema,
  ruleGraphSchema,
  ruleGraphTypedValueSchema,
  ruleGraphValueTypeKeys,
  ruleGraphVariableDeclarationSchema,
} from "../src/rule-graph-contracts";
import {
  sourceRuleGraphConditionSchema,
  sourceRuleGraphInputDeclarationSchema,
  sourceRuleGraphSchema,
  sourceRuleGraphTypedValueSchema,
  sourceRuleGraphVariableDeclarationSchema,
} from "../src/rule-graph-source-contracts";

const fixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, `../../testing/fixtures/rule-graphs/${name}`),
      "utf8",
    ),
  );

const sourceGraph = fixture("before-save-complete.source.json");
const canonicalGraph = fixture("before-save-complete.canonical.json");
const currentModuleV2 = fixture("../modules/service-desk.sla.json");

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const nodeTypes = [
  "start",
  "condition",
  "set_variable",
  "set_field",
  "require_field",
  "warn",
  "refuse",
  "finish",
] as const;

const expectedValueTypes = [
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "email_address",
  "phone_number",
  "web_address",
  "table",
  "link",
  "link_to_one_of_several",
  "link_to_person",
  "attachment",
] as const;

const canonicalModuleV2 = {
  envelope: {
    kind: "module",
    rootId: id(901),
    key: "example.rule_graph",
    organizationId: id(902),
    draftRevision: 1,
    createdAt: "2026-09-09T00:00:00Z",
    createdBy: id(903),
    updatedAt: "2026-09-09T00:00:00Z",
    updatedBy: id(903),
  },
  content: {
    name: "Rule graph fixture",
    description: "A structural Module contract fixture.",
    dependencies: [],
    recordTypes: [
      {
        recordTypeId: id(2),
        key: "candidate",
        singularLabel: "Candidate",
        pluralLabel: "Candidates",
        titleFieldId: id(41),
        storageContractId: id(904),
        storageScope: "organization_shared",
        ownershipMode: "none",
        fields: [
          {
            fieldId: id(41),
            key: "amount",
            label: "Amount",
            required: true,
            unique: false,
            filterable: true,
            sortable: true,
            personalData: "none",
            publicDisplay: "refused",
            type: "decimal_number",
            settings: { digitsBeforeDecimal: 30, decimalPlaces: 12 },
          },
        ],
        relationships: [],
        standardActions: ["create", "read"],
        customActionIds: [],
      },
    ],
    permissions: [],
    actions: [],
    events: [],
    rules: [],
    sharingConditions: [],
    extensionPoints: [],
  },
} as const;

describe("shared Rule graph contracts", () => {
  it("accepts the complete authored and canonical before-save fixture shapes", () => {
    const source = sourceRuleGraphSchema.parse(sourceGraph);
    const canonical = ruleGraphSchema.parse(canonicalGraph);

    expect(new Set(source.nodes.map((node) => node.type))).toEqual(new Set(nodeTypes));
    expect(new Set(canonical.nodes.map((node) => node.type))).toEqual(new Set(nodeTypes));
    expect(
      source.edges.filter((edge) => edge.from === "eligible").map((edge) => edge.port),
    ).toEqual(["true", "false"]);
    expect(
      canonical.edges
        .filter((edge) => edge.fromNodeId === "10000000-0000-4000-8000-000000000032")
        .map((edge) => edge.port),
    ).toEqual(["false", "true"]);
    expect(ruleGraphValueTypeKeys).toEqual(expectedValueTypes);

    expect(
      sourceRuleGraphSchema.safeParse({
        ...source,
        nodes: source.nodes.map((node) =>
          node.type === "start" ? { ...node, operations: ["create"] } : node,
        ),
      }).success,
    ).toBe(true);
  });

  it("keeps authored exact values and references distinct from canonical values", () => {
    expect(
      sourceRuleGraphTypedValueSchema.safeParse({
        type: "decimal_number",
        value: "9007199254740993.00",
      }).success,
    ).toBe(true);
    expect(
      ruleGraphTypedValueSchema.safeParse({
        type: "decimal_number",
        value: "9007199254740993.00",
      }).success,
    ).toBe(false);
    expect(
      ruleGraphTypedValueSchema.safeParse({
        type: "decimal_number",
        value: "9007199254740993",
      }).success,
    ).toBe(true);

    const sourceLink = {
      type: "link",
      value: {
        record_type: "example.shared:related",
        record_id: "80000000-0000-4000-8000-000000000001",
      },
    };
    const canonicalLink = {
      type: "link",
      value: {
        recordTypeId: "10000000-0000-4000-8000-000000000003",
        recordId: "80000000-0000-4000-8000-000000000001",
      },
    };
    expect(sourceRuleGraphTypedValueSchema.safeParse(sourceLink).success).toBe(true);
    expect(ruleGraphTypedValueSchema.safeParse(sourceLink).success).toBe(false);
    expect(ruleGraphTypedValueSchema.safeParse(canonicalLink).success).toBe(true);
    expect(sourceRuleGraphTypedValueSchema.safeParse(canonicalLink).success).toBe(false);
  });

  it("requires allowed record types only for record-reference declarations", () => {
    expect(
      sourceRuleGraphInputDeclarationSchema.safeParse({
        id: "related",
        key: "related",
        type: "link",
        required: false,
      }).success,
    ).toBe(false);
    expect(
      sourceRuleGraphInputDeclarationSchema.safeParse({
        id: "amount",
        key: "amount",
        type: "decimal_number",
        required: true,
        record_types: ["example.shared:related"],
      }).success,
    ).toBe(false);
    expect(
      ruleGraphInputDeclarationSchema.safeParse({
        inputId: "10000000-0000-4000-8000-000000000013",
        key: "related",
        type: "link_to_one_of_several",
        required: false,
        recordTypeIds: ["10000000-0000-4000-8000-000000000003"],
      }).success,
    ).toBe(true);

    const sourceVariable = {
      id: "selected_record",
      key: "selected_record",
      type: "link_to_one_of_several",
      record_types: ["example.shared:alternative", "example.shared:related"],
    } as const;
    expect(sourceRuleGraphVariableDeclarationSchema.safeParse(sourceVariable).success).toBe(true);
    expect(
      sourceRuleGraphVariableDeclarationSchema.safeParse({
        ...sourceVariable,
        record_types: ["example.shared:related", "example.shared:related"],
      }).success,
    ).toBe(false);

    const canonicalVariable = {
      variableId: id(22),
      key: "selected_record",
      type: "link_to_one_of_several",
      recordTypeIds: [id(3), id(4)],
    } as const;
    expect(ruleGraphVariableDeclarationSchema.safeParse(canonicalVariable).success).toBe(true);
    expect(
      ruleGraphVariableDeclarationSchema.safeParse({
        ...canonicalVariable,
        recordTypeIds: [id(4), id(3)],
      }).success,
    ).toBe(false);
    expect(
      ruleGraphVariableDeclarationSchema.safeParse({
        ...canonicalVariable,
        recordTypeIds: [id(3), id(3)],
      }).success,
    ).toBe(false);
  });

  it("refuses unsupported versions, node shapes and duplicate local identities", () => {
    const source = sourceRuleGraphSchema.parse(sourceGraph);
    const canonical = ruleGraphSchema.parse(canonicalGraph);

    expect(sourceRuleGraphSchema.safeParse({ ...source, graph_version: "2.0.0" }).success).toBe(
      false,
    );
    expect(ruleGraphSchema.safeParse({ ...canonical, profile: "interactive" }).success).toBe(false);
    expect(
      sourceRuleGraphSchema.safeParse({
        ...source,
        nodes: source.nodes.map((node, index) =>
          index === 0 ? { ...node, node_version: "2.0.0" } : node,
        ),
      }).success,
    ).toBe(false);
    expect(
      sourceRuleGraphSchema.safeParse({
        ...source,
        nodes: source.nodes.map((node, index) =>
          index === 0 ? { ...node, operations: ["create", "create"] } : node,
        ),
      }).success,
    ).toBe(false);
    expect(
      ruleGraphSchema.safeParse({
        ...canonical,
        inputs: [...canonical.inputs, canonical.inputs[0]],
      }).success,
    ).toBe(false);
    expect(
      sourceRuleGraphSchema.safeParse({
        ...source,
        nodes: [...source.nodes, source.nodes[0]],
      }).success,
    ).toBe(false);
    expect(
      sourceRuleGraphSchema.safeParse({
        ...source,
        edges: [{ from: "start", port: "otherwise", to: "finish" }],
      }).success,
    ).toBe(false);
    expect(
      sourceRuleGraphSchema.safeParse({
        ...source,
        edges: [...source.edges, { from: "start", port: "next", to: "finish" }],
      }).success,
    ).toBe(false);
  });

  it("leaves graph topology and definite-assignment decisions to Definition validation", () => {
    const source = sourceRuleGraphSchema.parse(sourceGraph);
    const structurallyValidButCyclic = {
      ...source,
      edges: [...source.edges, { from: "finish", port: "next", to: "start" }],
    };
    const structurallyValidButDangling = {
      ...source,
      edges: source.edges.map((edge) =>
        edge.from === "warn_adjustment" ? { ...edge, to: "missing_node" } : edge,
      ),
    };

    expect(sourceRuleGraphSchema.safeParse(structurallyValidButCyclic).success).toBe(true);
    expect(sourceRuleGraphSchema.safeParse(structurallyValidButDangling).success).toBe(true);
  });

  it("bounds graph collections and refuses over-deep conditions without throwing", () => {
    const canonical = ruleGraphSchema.parse(canonicalGraph);
    const inputs = Array.from({ length: 101 }, (_, index) => ({
      inputId: id(1_000 + index),
      key: `input_${index}`,
      type: "text" as const,
      required: false,
    }));
    const variables = Array.from({ length: 101 }, (_, index) => ({
      variableId: id(2_000 + index),
      key: `variable_${index}`,
      type: "text" as const,
    }));
    const nodes = Array.from({ length: 101 }, (_, index) => ({
      nodeId: id(3_000 + index),
      nodeVersion: "1.0.0" as const,
      type: "finish" as const,
    }));
    const edges = Array.from({ length: 201 }, (_, index) => ({
      fromNodeId: id(4_000 + index),
      port: "next" as const,
      toNodeId: id(5_000 + index),
    }));

    expect(ruleGraphSchema.safeParse({ ...canonical, inputs }).success).toBe(false);
    expect(ruleGraphSchema.safeParse({ ...canonical, variables }).success).toBe(false);
    expect(ruleGraphSchema.safeParse({ ...canonical, nodes }).success).toBe(false);
    expect(ruleGraphSchema.safeParse({ ...canonical, edges }).success).toBe(false);

    let sourceCondition: unknown = {
      kind: "comparison",
      operator: "is_empty",
      left: { source: "input", input: "related_record" },
    };
    let canonicalCondition: unknown = {
      kind: "comparison",
      operator: "is_empty",
      left: { source: "input", inputId: id(13) },
    };
    for (let depth = 0; depth < 10_000; depth += 1) {
      sourceCondition = { kind: "not", condition: sourceCondition };
      canonicalCondition = { kind: "not", condition: canonicalCondition };
    }

    expect(() => sourceRuleGraphConditionSchema.safeParse(sourceCondition)).not.toThrow();
    expect(sourceRuleGraphConditionSchema.safeParse(sourceCondition).success).toBe(false);
    expect(() => ruleGraphConditionSchema.safeParse(canonicalCondition)).not.toThrow();
    expect(ruleGraphConditionSchema.safeParse(canonicalCondition).success).toBe(false);
  });

  it("embeds graphs only in the explicit Module 3 source shape", () => {
    const moduleV2 = moduleSourceDocumentV2Schema.parse(currentModuleV2);
    const moduleV3 = {
      ...moduleV2,
      source_contract_version: "3.0.0",
      body: { ...moduleV2.body, rules: [sourceGraph] },
    };

    expect(moduleSourceDocumentV3Schema.safeParse(moduleV3).success).toBe(true);
    expect(moduleSourceDocumentV2Schema.safeParse(moduleV3).success).toBe(false);
    expect(moduleSourceDocumentV2Schema.safeParse(moduleV2).success).toBe(true);
    expect(moduleSourceDocumentV3Schema.safeParse(moduleV2).success).toBe(false);
  });

  it("embeds canonical graphs only in the explicit Module 3 pair", () => {
    const moduleV2 = moduleDraftV2Schema.parse(canonicalModuleV2);
    const moduleV3 = { ...moduleV2, content: { ...moduleV2.content, rules: [canonicalGraph] } };

    expect(moduleDraftV3Schema.safeParse(moduleV3).success).toBe(true);
    expect(moduleDraftV2Schema.safeParse(moduleV3).success).toBe(false);
    expect(
      moduleCanonicalDocumentV3Schema.safeParse({
        validationContractVersion: "3.0.0",
        canonical: moduleV3,
      }).success,
    ).toBe(true);
    expect(
      moduleCanonicalDocumentV2Schema.safeParse({
        validationContractVersion: "2.0.0",
        canonical: moduleV3,
      }).success,
    ).toBe(false);
    expect(
      moduleCanonicalDocumentV3Schema.safeParse({
        validationContractVersion: "2.0.0",
        canonical: moduleV2,
      }).success,
    ).toBe(false);

    expect(
      moduleContractVersionPairV3Schema.safeParse({
        sourceContractVersion: "3.0.0",
        validationContractVersion: "3.0.0",
      }).success,
    ).toBe(true);
    expect(
      moduleContractVersionPairV3Schema.safeParse({
        sourceContractVersion: "3.0.0",
        validationContractVersion: "2.0.0",
      }).success,
    ).toBe(false);
    expect(
      moduleContractVersionPairV2Schema.safeParse({
        sourceContractVersion: "2.0.0",
        validationContractVersion: "3.0.0",
      }).success,
    ).toBe(false);
  });
});
