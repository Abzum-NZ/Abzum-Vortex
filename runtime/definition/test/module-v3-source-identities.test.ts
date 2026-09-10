import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  moduleSourceDocumentV2Schema,
  moduleSourceDocumentV3Schema,
  sourceRuleGraphSchema,
} from "@vortex/contracts";
import {
  extractModuleSourceIdentityRequirementsV3,
  extractStoredSourceIdentityRequirements,
} from "../src/source-identities";

const fixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, `../../../testing/fixtures/${name}`), "utf8"),
  );

const moduleSourceV2 = moduleSourceDocumentV2Schema.parse(fixture("modules/crm.tags.json"));
const sourceGraph = sourceRuleGraphSchema.parse(
  fixture("rule-graphs/before-save-complete.source.json"),
);

const sourceV3 = (rules: readonly unknown[]) =>
  moduleSourceDocumentV3Schema.parse({
    ...moduleSourceV2,
    source_contract_version: "3.0.0",
    body: { ...moduleSourceV2.body, rules },
  });

describe("Module V3 source identities", () => {
  it("allocates graph inputs, variables and nodes under their permanent Rule owner", () => {
    const requirements = extractModuleSourceIdentityRequirementsV3(sourceV3([sourceGraph]));
    const graphRequirements = requirements.filter((entry) => entry.kind.startsWith("rule_"));

    expect(requirements.some((entry) => entry.kind === "rule")).toBe(true);
    expect(graphRequirements.filter((entry) => entry.kind === "rule_input")).toHaveLength(3);
    expect(graphRequirements.filter((entry) => entry.kind === "rule_variable")).toHaveLength(2);
    expect(graphRequirements.filter((entry) => entry.kind === "rule_node")).toHaveLength(9);
    expect(
      graphRequirements.every(
        (entry) =>
          entry.ownerScope === "rule_owner:prepare_candidate" &&
          entry.scope === "rule:prepare_candidate",
      ),
    ).toBe(true);
    expect(
      graphRequirements.find(
        (entry) => entry.kind === "rule_input" && entry.componentOwner === "requested_budget",
      )?.aliases,
    ).toEqual(["requested_budget"]);
  });

  it("keeps the owner scope stable when a Rule key changes", () => {
    const renamed = { ...sourceGraph, key: "renamed_candidate_rule" };
    const originalNode = extractModuleSourceIdentityRequirementsV3(sourceV3([sourceGraph])).find(
      (entry) => entry.kind === "rule_node" && entry.componentOwner === "start",
    );
    const renamedNode = extractModuleSourceIdentityRequirementsV3(sourceV3([renamed])).find(
      (entry) => entry.kind === "rule_node" && entry.componentOwner === "start",
    );

    expect(originalNode?.ownerScope).toBe("rule_owner:prepare_candidate");
    expect(renamedNode?.ownerScope).toBe(originalNode?.ownerScope);
    expect(originalNode?.scope).toBe("rule:prepare_candidate");
    expect(renamedNode?.scope).toBe("rule:renamed_candidate_rule");
  });

  it("allows the same local node alias under distinct permanent Rule owners", () => {
    const secondGraph = {
      ...sourceGraph,
      id: "prepare_candidate_alternative",
      key: "prepare_candidate_alternative",
    };
    const starts = extractModuleSourceIdentityRequirementsV3(
      sourceV3([sourceGraph, secondGraph]),
    ).filter((entry) => entry.kind === "rule_node" && entry.componentOwner === "start");

    expect(starts).toHaveLength(2);
    expect(starts.map((entry) => entry.ownerScope).sort()).toEqual([
      "rule_owner:prepare_candidate",
      "rule_owner:prepare_candidate_alternative",
    ]);
  });

  it("selects V3 extraction only for exact stored V3 source metadata", () => {
    const v3Requirements = extractStoredSourceIdentityRequirements(sourceV3([sourceGraph]));
    const v2Requirements = extractStoredSourceIdentityRequirements(
      moduleSourceDocumentV2Schema.parse(moduleSourceV2),
    );

    expect(v3Requirements.some((entry) => entry.kind === "rule_node")).toBe(true);
    expect(v2Requirements.some((entry) => entry.kind === "rule_node")).toBe(false);
  });
});
