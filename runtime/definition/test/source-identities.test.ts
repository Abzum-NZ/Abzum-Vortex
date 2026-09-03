import type { DefinitionSourceDocument } from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { extractSourceIdentityRequirements } from "../src/source-identities";

const asSource = (value: unknown): DefinitionSourceDocument => value as DefinitionSourceDocument;

describe("source identity requirements", () => {
  it("extracts every Module identity owner with record-scoped contents", () => {
    const source = asSource({
      source_contract_version: "1.0.0",
      root_alias: "module_root",
      key: "example.module",
      kind: "module",
      body: {
        record_types: [
          {
            id: "record_owner",
            key: "entry",
            storage_contract_id: "storage_owner",
            fields: [{ id: "field_owner", key: "title" }],
            relationships: [{ id: "relationship_owner", key: "parent" }],
          },
        ],
        permissions: [{ id: "permission_owner", key: "example.permission.read" }],
        actions: [{ id: "action_owner", key: "example.action.update" }],
        rules: [{ id: "rule_owner", key: "required_title" }],
        events: [{ id: "event_owner", key: "example.event.changed" }],
        extension_points: [{ id: "extension_owner", key: "extra_fields" }],
        sharing_conditions: [{ id: "condition_owner", key: "approved_records" }],
      },
    });

    expect(
      extractSourceIdentityRequirements(source).map(
        ({ definitionKey, scope, kind, componentOwner, aliases }) => ({
          definitionKey,
          scope,
          kind,
          componentOwner,
          aliases,
        }),
      ),
    ).toEqual([
      {
        definitionKey: "example.module",
        scope: "document",
        kind: "root",
        componentOwner: "root",
        aliases: ["example.module", "module_root"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "permission",
        componentOwner: "permission_owner",
        aliases: ["permission_owner", "example.permission.read"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "action",
        componentOwner: "action_owner",
        aliases: ["action_owner", "example.action.update"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "rule",
        componentOwner: "rule_owner",
        aliases: ["rule_owner", "required_title"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "event",
        componentOwner: "event_owner",
        aliases: ["event_owner", "example.event.changed"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "record_type",
        componentOwner: "record_owner",
        aliases: ["record_owner", "entry"],
      },
      {
        definitionKey: "example.module",
        scope: "record:entry",
        kind: "storage_contract",
        componentOwner: "storage_owner",
        aliases: ["storage_owner", "entry"],
      },
      {
        definitionKey: "example.module",
        scope: "record:entry",
        kind: "field",
        componentOwner: "field_owner",
        aliases: ["field_owner", "title"],
      },
      {
        definitionKey: "example.module",
        scope: "record:entry",
        kind: "relationship",
        componentOwner: "relationship_owner",
        aliases: ["relationship_owner", "parent"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "extension_point",
        componentOwner: "extension_owner",
        aliases: ["extension_owner", "extra_fields"],
      },
      {
        definitionKey: "example.module",
        scope: "content",
        kind: "sharing_condition",
        componentOwner: "condition_owner",
        aliases: ["condition_owner", "approved_records"],
      },
    ]);
  });

  it("walks all Application identities, nested navigation, guided steps, placements and operations", () => {
    const source = asSource({
      source_contract_version: "1.0.0",
      root_alias: "application_root",
      key: "example.application",
      kind: "application",
      body: {
        permissions: [{ id: "permission_owner", key: "example.permission.open" }],
        actions: [{ id: "action_owner", key: "example.action.submit" }],
        rules: [{ id: "rule_owner", key: "show_notice" }],
        events: [{ id: "event_owner", key: "example.event.submitted" }],
        roles: [{ id: "role_owner", key: "member" }],
        navigation: [
          {
            id: "navigation_parent",
            type: "heading",
            children: [{ id: "navigation_child", type: "page" }],
          },
        ],
        queries: [{ id: "query_owner", key: "recent_entries" }],
        block_registrations: [{ id: "block_owner" }],
        pages: [
          {
            id: "page_owner",
            key: "entry_form",
            steps: [
              {
                id: "step_owner",
                blocks: [{ id: "nested_placement_owner" }],
              },
            ],
          },
          { id: "page_owner_two", key: "entry_detail", blocks: [{ id: "placement_owner" }] },
        ],
        workflows: [{ id: "workflow_owner", key: "process_entry", nodes: [{ id: "node_owner" }] }],
        pipelines: [{ id: "pipeline_owner", key: "entry_state" }],
        connection_bindings: [{ id: "connection_owner", key: "delivery" }],
        interfaces: [
          {
            id: "interface_owner",
            key: "example.interface.entries",
            operations: [{ id: "operation_owner", key: "list_entries", path: "/entries" }],
          },
        ],
        public_addresses: [{ id: "address_owner", path: "/public/entries" }],
      },
    });

    const requirements = extractSourceIdentityRequirements(source);
    expect(
      requirements.map(({ kind, scope, componentOwner }) => [kind, scope, componentOwner]),
    ).toEqual([
      ["root", "document", "root"],
      ["permission", "content", "permission_owner"],
      ["action", "content", "action_owner"],
      ["rule", "content", "rule_owner"],
      ["event", "content", "event_owner"],
      ["role", "content", "role_owner"],
      ["query", "content", "query_owner"],
      ["block", "content", "block_owner"],
      ["pipeline", "content", "pipeline_owner"],
      ["connection_binding", "content", "connection_owner"],
      ["public_address", "content", "address_owner"],
      ["navigation_item", "content", "navigation_parent"],
      ["navigation_item", "content", "navigation_child"],
      ["page", "content", "page_owner"],
      ["guided_step", "page:entry_form", "step_owner"],
      ["block_placement", "content", "nested_placement_owner"],
      ["page", "content", "page_owner_two"],
      ["block_placement", "content", "placement_owner"],
      ["workflow", "content", "workflow_owner"],
      ["workflow_node", "workflow:process_entry", "node_owner"],
      ["interface", "content", "interface_owner"],
      ["interface_operation", "interface:example.interface.entries", "operation_owner"],
    ]);
    expect(
      requirements.find((requirement) => requirement.kind === "public_address")?.aliases,
    ).toEqual(["address_owner", "/public/entries"]);
    expect(
      requirements.find((requirement) => requirement.kind === "interface_operation")?.aliases,
    ).toEqual(["operation_owner", "list_entries"]);
    expect(requirements.find((requirement) => requirement.kind === "guided_step")?.ownerScope).toBe(
      "page_owner:page_owner",
    );
    expect(
      requirements.find((requirement) => requirement.kind === "workflow_node")?.ownerScope,
    ).toBe("workflow_owner:workflow_owner");
    expect(
      requirements.find((requirement) => requirement.kind === "interface_operation")?.ownerScope,
    ).toBe("interface_owner:interface_owner");
  });

  it("does not invent aliases or owners outside parsed source", () => {
    const source = asSource({
      source_contract_version: "1.0.0",
      root_alias: "module_root",
      key: "example.module",
      kind: "module",
      body: {
        record_types: [],
        permissions: [],
        actions: [],
        rules: [],
        events: [],
        extension_points: [],
        sharing_conditions: [],
      },
    });
    const requirements = extractSourceIdentityRequirements(source);
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      kind: "root",
      componentOwner: "root",
      aliases: ["example.module", "module_root"],
    });
    expect(requirements[0]?.aliases).not.toContain("invented");
  });
});
