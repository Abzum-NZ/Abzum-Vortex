import { describe, expect, it } from "vitest";
import { compileDefinition, compileDefinitionWithContext } from "../src/compiler";
import { compileDefinitionSet, validateDefinitionSet } from "../src/validation";
import { graphModuleRequests } from "./module-v3-fixtures";

describe("packaged Module V3 graph compilation", () => {
  it("compiles complete graph dependencies and retains every source/canonical leaf", () => {
    const requests = graphModuleRequests();
    const shared = compileDefinition(requests[0]!);
    const candidate = compileDefinitionWithContext(requests[1]!, { dependencyOutputs: [shared] });
    expect(candidate.validationContractVersion).toBe("3.0.0");
    expect(candidate.canonical.content.rules[0]!.nodes).toHaveLength(9);
    const validation = validateDefinitionSet({
      requests,
      outputs: [shared, candidate],
      publishedHistories: requests.map((request) => ({
        kind: "module" as const,
        definitionKey: request.source.key,
        history: [],
      })),
    });
    expect(validation.failures).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(
      compileDefinitionSet(requests, {
        publishedHistories: requests.map((request) => ({
          kind: "module" as const,
          definitionKey: request.source.key,
          history: [],
        })),
      }),
    ).toHaveLength(2);
  });

  it("preserves graph meaning across source node and edge reordering", () => {
    const requests = graphModuleRequests();
    const shared = compileDefinition(requests[0]!);
    const original = compileDefinitionWithContext(requests[1]!, { dependencyOutputs: [shared] });
    const reordered = structuredClone(requests[1]!);
    const graph = reordered.source.body.rules[0]!;
    graph.nodes.reverse();
    graph.edges.reverse();
    graph.variables.reverse();
    graph.inputs.reverse();
    const second = compileDefinitionWithContext(reordered, { dependencyOutputs: [shared] });
    expect(second.canonical).toEqual(original.canonical);
    expect(second.artifact).toEqual(original.artifact);
    expect(second.provenance).not.toEqual(original.provenance);
  });

  it("refuses a cyclic packaged graph through the actual publication entry point", () => {
    const requests = graphModuleRequests();
    const graph = requests[1]!.source.body.rules[0]!;
    graph.edges.find((edge) => edge.from === "start")!.to = "start";
    expect(() =>
      compileDefinitionSet(requests, {
        publishedHistories: requests.map((request) => ({
          kind: "module" as const,
          definitionKey: request.source.key,
          history: [],
        })),
      }),
    ).toThrow("vortex.definition.rule_graph_topology");
  });

  it("resolves local record and field source identities as well as their keys", () => {
    const requests = graphModuleRequests();
    const shared = compileDefinition(requests[0]!);
    const original = compileDefinitionWithContext(requests[1]!, { dependencyOutputs: [shared] });
    const request = structuredClone(requests[1]!);
    const graph = request.source.body.rules[0]!;
    graph.record_type = request.source.body.record_types[0]!.id;
    const node = graph.nodes.find((node) => node.type === "set_field" && node.field === "budget");
    if (!node || node.type !== "set_field") throw new Error("Expected set-field fixture node");
    node.field = request.source.body.record_types[0]!.fields.find(
      (field) => field.key === "budget",
    )!.id;
    expect(
      compileDefinitionWithContext(request, { dependencyOutputs: [shared] }).canonical,
    ).toEqual(original.canonical);
    expect(validateDefinitionSet({ requests: [request], outputs: [] }, "edit_save").valid).toBe(
      true,
    );
  });

  it("refuses a mismatched pair without interpreting it as legacy rules", () => {
    const request = graphModuleRequests()[1]!;
    expect(() =>
      compileDefinition({ ...request, validationContractVersion: "2.0.0" } as never),
    ).toThrow("vortex.definition.invalid_compilation_request");
  });

  it("allows repeated data columns named id and key in a flow table", () => {
    const requests = graphModuleRequests();
    const request = requests[1]!;
    const graph = request.source.body.rules[0]!;
    const variable = graph.variables[0]!;
    variable.type = "table";
    delete variable.record_types;
    variable.columns = [
      { key: "id", type: "text", required: true },
      { key: "key", type: "text", required: true },
    ];
    variable.default_value = {
      type: "table",
      columns: variable.columns,
      value: [
        { id: "same", key: "same" },
        { id: "same", key: "same" },
      ],
    };
    // Only the edit/save declaration check is exercised here; the full graph
    // deliberately retains its existing money-typed use, rejected at publication.
    const validation = validateDefinitionSet({ requests, outputs: [] }, "edit_save");
    expect(validation.failures).toEqual([]);
  });
});
