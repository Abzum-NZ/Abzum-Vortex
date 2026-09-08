import fs from "node:fs";
import path from "node:path";
import {
  moduleSourceDocumentV1Schema,
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
  type ModuleSourceDocumentV1,
  type ModuleSourceDocumentV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import {
  convertModuleSourceV1ToV3,
  convertModuleSourceV2ToV3,
  type ModuleV3DraftConversionResolution,
  type ModuleV3RuleMessageResolution,
} from "../src/module-v3-draft-conversion";
import { compileDefinitionSet, validateDefinitionSet } from "../src/validation";
import { graphModuleRequests } from "./module-v3-fixtures";

const fixtureNames = [
  "crm.activities.json",
  "crm.opportunities.json",
  "crm.organisations.json",
  "crm.people.json",
  "crm.tags.json",
  "service-desk.cases.json",
  "service-desk.knowledge.json",
  "service-desk.sla.json",
] as const;

const fixture = (name: (typeof fixtureNames)[number]): ModuleSourceDocumentV2 =>
  moduleSourceDocumentV2Schema.parse(
    JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, `../../../testing/fixtures/modules/${name}`),
        "utf8",
      ),
    ),
  );

const v1Fixture = (name: (typeof fixtureNames)[number]): ModuleSourceDocumentV1 =>
  moduleSourceDocumentV1Schema.parse(
    JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          `../../../testing/fixtures/historical/module-v1/modules/${name}`,
        ),
        "utf8",
      ),
    ),
  );

const messageResolutions = (
  source: ModuleSourceDocumentV1 | ModuleSourceDocumentV2,
): ModuleV3RuleMessageResolution[] =>
  source.body.rules.flatMap((rule, index) =>
    rule.effect.kind === "set_value"
      ? []
      : [
          {
            kind: "rule_message" as const,
            path: ["body", "rules", index, "effect"],
            message: `Converted safe message for ${rule.id}.`,
          },
        ],
  );

const convertedV2 = (
  source: ModuleSourceDocumentV2,
  resolutions: readonly ModuleV3RuleMessageResolution[] = messageResolutions(source),
) => {
  const result = convertModuleSourceV2ToV3(source, resolutions);
  if (!result.success)
    throw new Error(
      result.diagnostics.map((item) => `${item.code}:${item.path.join(".")}`).join("\n"),
    );
  return result.source;
};

describe("Module source V2 to V3 rule-graph conversion", () => {
  it.each(fixtureNames)(
    "converts supported current fixture rules in %s without mutation",
    (name) => {
      const source = fixture(name);
      const before = structuredClone(source);
      const converted = convertedV2(source);

      expect(source).toEqual(before);
      expect(moduleSourceDocumentV3Schema.safeParse(converted).success).toBe(true);
      expect(converted.source_contract_version).toBe("3.0.0");
      expect(converted.body.rules).toHaveLength(source.body.rules.length);
      converted.body.rules.forEach((graph, index) => {
        const legacy = source.body.rules[index]!;
        expect(graph).toMatchObject({
          id: legacy.id,
          key: legacy.key,
          record_type: legacy.record_type,
          priority: legacy.priority,
          inputs: [],
          variables: [],
        });
      });
    },
  );

  it("converts exact decimal, money, dependency link and explicit clear effects", () => {
    const source = fixture("crm.opportunities.json");
    source.body.rules = [
      {
        id: "set_decimal",
        key: "set_decimal",
        record_type: "opportunity",
        trigger: "change",
        priority: 10,
        condition: { field: "discount_percent", operator: "greater_than", value: "1.2500" },
        effect: { kind: "set_value", field: "discount_percent", value: "12.3400" },
      },
      {
        id: "set_money",
        key: "set_money",
        record_type: "opportunity",
        trigger: "change",
        priority: 20,
        condition: { field: "stage", operator: "is_not_empty" },
        effect: {
          kind: "set_value",
          field: "value",
          value: { amount: "9007199254740993.25", currency: "NZD" },
        },
      },
      {
        id: "set_link",
        key: "set_link",
        record_type: "opportunity",
        trigger: "change",
        priority: 30,
        condition: {
          field: "company",
          operator: "equals",
          value: {
            record_type: "vortex.crm.organisations:company",
            record_id: "30000000-0000-4000-8000-000000000001",
          },
        },
        effect: {
          kind: "set_value",
          field: "company",
          value: {
            record_type: "vortex.crm.organisations:company",
            record_id: "30000000-0000-4000-8000-000000000002",
          },
        },
      },
      {
        id: "clear_link",
        key: "clear_link",
        record_type: "opportunity",
        trigger: "change",
        priority: 40,
        condition: { field: "primary_contact", operator: "is_not_empty" },
        effect: { kind: "set_value", field: "primary_contact", value: null },
      },
      {
        id: "set_choice",
        key: "set_choice",
        record_type: "opportunity",
        trigger: "change",
        priority: 50,
        condition: { field: "stage", operator: "in", value: ["discovery", "qualified"] },
        effect: { kind: "set_value", field: "stage", value: "qualified" },
      },
    ];

    const graphs = convertedV2(source).body.rules;
    const decimalCondition = graphs[0]!.nodes.find((node) => node.type === "condition");
    const decimalEffect = graphs[0]!.nodes.find((node) => node.type === "set_field");
    const moneyEffect = graphs[1]!.nodes.find((node) => node.type === "set_field");
    const linkCondition = graphs[2]!.nodes.find((node) => node.type === "condition");
    const linkEffect = graphs[2]!.nodes.find((node) => node.type === "set_field");
    const clearEffect = graphs[3]!.nodes.find((node) => node.type === "set_field");
    const choiceCondition = graphs[4]!.nodes.find((node) => node.type === "condition");

    expect(decimalCondition).toMatchObject({
      condition: {
        right: { source: "literal", value: { type: "decimal_number", value: "1.2500" } },
      },
    });
    expect(decimalEffect).toMatchObject({
      assignment: {
        kind: "set",
        value: { source: "literal", value: { type: "decimal_number", value: "12.3400" } },
      },
    });
    expect(moneyEffect).toMatchObject({
      assignment: {
        value: {
          value: {
            type: "money",
            value: { amount: "9007199254740993.25", currency: "NZD" },
          },
        },
      },
    });
    expect(linkCondition).toMatchObject({
      condition: {
        right: {
          value: {
            type: "link",
            value: { record_type: "vortex.crm.organisations:company" },
          },
        },
      },
    });
    expect(linkEffect).toMatchObject({
      assignment: { value: { value: { type: "link" } } },
    });
    expect(clearEffect).toMatchObject({ assignment: { kind: "clear" } });
    expect(choiceCondition).toMatchObject({
      condition: {
        right: {
          value: {
            type: "several_choices",
            value: ["discovery", "qualified"],
          },
        },
      },
    });
  });

  it.each([
    ["crm.organisations.json", "company", "name", "company_number", "C-42"],
    ["crm.people.json", "contact", "first_name", "full_name", "Ada Lovelace"],
    ["crm.tags.json", "tag", "name", "assignment_count", 4],
    ["crm.tags.json", "tag", "name", "assignment_count", null],
  ] as const)(
    "reports a set-value write to generator-owned field %s/%s/%s",
    (name, recordType, conditionField, targetField, value) => {
      const source = fixture(name);
      source.body.rules = [
        {
          id: "write_generated_field",
          key: "write_generated_field",
          record_type: recordType,
          trigger: "change",
          priority: 10,
          condition: { field: conditionField, operator: "is_not_empty" },
          effect: { kind: "set_value", field: targetField, value },
        },
      ];

      expect(convertModuleSourceV2ToV3(source, [])).toMatchObject({
        success: false,
        diagnostics: [
          expect.objectContaining({
            code: "unsupported_rule_effect",
            path: ["body", "rules", 0, "effect", "field"],
          }),
        ],
      });
    },
  );

  it("requires exact safe message resolutions and rejects duplicate or unused paths", () => {
    const source = fixture("crm.organisations.json");
    expect(convertModuleSourceV2ToV3(source, [])).toMatchObject({
      success: false,
      diagnostics: [
        {
          code: "missing_rule_message",
          path: ["body", "rules", 0, "effect"],
        },
      ],
    });

    const resolution = messageResolutions(source)[0]!;
    const preserved = convertedV2(source, [resolution]).body.rules[0]!.nodes.find(
      (node) => node.type === "refuse",
    );
    expect(preserved).toMatchObject({ code: "company_name_required" });
    expect(
      convertModuleSourceV2ToV3(source, [{ ...resolution, code: "replacement_code" }]),
    ).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: "invalid_rule_message" })],
    });
    expect(convertModuleSourceV2ToV3(source, [resolution, resolution])).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: "duplicate_resolution" })],
    });
    expect(
      convertModuleSourceV2ToV3(fixture("crm.tags.json"), [
        { ...resolution, path: ["body", "rules", 0, "effect"] },
      ]),
    ).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: "unrecognized_resolution" })],
    });
    expect(convertModuleSourceV2ToV3(source, [{ ...resolution, message: "   " }])).toMatchObject({
      success: false,
      diagnostics: [expect.objectContaining({ code: "invalid_rule_message" })],
    });
  });

  it("maps a create-time require to an exact branch graph with supplied safe text", () => {
    const source = fixture("crm.organisations.json");
    source.body.rules = [
      {
        id: "require_name",
        key: "require_name",
        record_type: "company",
        trigger: "create",
        priority: 5,
        condition: { field: "name", operator: "is_empty" },
        effect: { kind: "require", field: "name" },
      },
    ];
    const graph = convertedV2(source, [
      {
        kind: "rule_message",
        path: ["body", "rules", 0, "effect"],
        code: "company_name_required",
        message: "Enter a company name.",
      },
    ]).body.rules[0]!;

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "start", operations: ["create"] }),
        expect.objectContaining({
          type: "require_field",
          field: "name",
          code: "company_name_required",
          message: "Enter a company name.",
        }),
        expect.objectContaining({ id: "finish_effect", type: "finish" }),
        expect.objectContaining({ id: "finish_false", type: "finish" }),
      ]),
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "condition", port: "true", to: "effect" },
        { from: "condition", port: "false", to: "finish_false" },
        { from: "effect", port: "next", to: "finish_effect" },
      ]),
    );
  });

  it.each(["delete", "form_change", "action"] as const)(
    "reports unsupported %s triggers without dropping the rule",
    (trigger) => {
      const source = fixture("crm.organisations.json");
      source.body.rules[0]!.trigger = trigger;
      expect(convertModuleSourceV2ToV3(source, [])).toMatchObject({
        success: false,
        diagnostics: [
          expect.objectContaining({
            code: "unsupported_rule_trigger",
            path: ["body", "rules", 0, "trigger"],
          }),
        ],
      });
    },
  );

  it.each(["show_or_hide", "start_background_work"] as const)(
    "reports unsupported %s effects before generic schema failure",
    (kind) => {
      const source = fixture("crm.organisations.json") as unknown as Record<string, unknown>;
      const body = source.body as { rules: Array<{ effect: unknown }> };
      body.rules[0]!.effect = { kind };
      expect(
        convertModuleSourceV2ToV3(source as unknown as ModuleSourceDocumentV2, []),
      ).toMatchObject({
        success: false,
        diagnostics: [
          expect.objectContaining({
            code: "unsupported_rule_effect",
            path: ["body", "rules", 0, "effect", "kind"],
          }),
        ],
      });
    },
  );

  it.each(fixtureNames)(
    "composes V1 field/value conversion for %s and keeps the source immutable",
    (name) => {
      const source = v1Fixture(name);
      const before = structuredClone(source);
      const resolutions: ModuleV3DraftConversionResolution[] = messageResolutions(source);
      const converted = convertModuleSourceV1ToV3(source, resolutions);

      expect(source).toEqual(before);
      expect(converted).toMatchObject({
        success: true,
        source: { source_contract_version: "3.0.0" },
      });
      if (!converted.success) throw new Error("Expected V1-to-V3 conversion");
      expect(converted.source.body.record_types.map((record) => record.key)).toEqual(
        source.body.record_types.map((record) => record.key),
      );
    },
  );

  it("feeds a converted graph through the real Module V3 compile and validation entry", () => {
    const source = convertedV2(fixture("crm.organisations.json"));
    const requests = graphModuleRequests([source]);
    const outputs = compileDefinitionSet(requests, {
      publishedHistories: [{ kind: "module", definitionKey: source.key, history: [] }],
    });
    const validation = validateDefinitionSet({
      requests,
      outputs,
      publishedHistories: [{ kind: "module", definitionKey: source.key, history: [] }],
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.canonical.content.rules).toHaveLength(1);
    expect(validation.failures).toEqual([]);
  });
});
