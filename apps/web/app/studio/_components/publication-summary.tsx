"use client";

import type { DefinitionPublicationConfirmation } from "@vortex/platform/schema";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@vortex/ui/components/table";
import { TechnicalDetails, ViewSource } from "@vortex/ui/components/technical-details";

const impactLabels = { patch: "Small change", minor: "New capability", major: "Breaking change" } as const;

const reasonLabels: Record<DefinitionPublicationConfirmation["reasons"][number]["code"], string> = {
  definition_text_changed: "Wording changed",
  presentation_changed: "Look and layout changed",
  component_added: "Added",
  required_component_added: "Required item added",
  component_removed: "Removed",
  component_identity_changed: "Replaced by a different item",
  component_key_changed: "Key changed",
  meaningful_order_changed: "Order changed",
  constraint_widened: "Rules relaxed",
  constraint_narrowed: "Rules tightened",
  storage_contract_changed: "Stored data shape changed",
  ownership_changed: "Ownership changed",
  permission_changed: "Permissions changed",
  public_contract_changed: "Public contract changed",
  dependency_requirement_changed: "Required version of another item changed",
  existing_behavior_changed: "Existing behaviour changed",
};

const kindLabels: Record<string, string> = {
  module: "Module", application: "Application", dependency: "Dependency", record_type: "Record type", field: "Field",
  relationship: "Relationship", action: "Action", action_input: "Action input", event: "Event", rule: "Rule",
  rule_input: "Rule input", rule_variable: "Rule variable", rule_node: "Rule step", sharing_condition: "Sharing condition",
  extension_point: "Extension point", module_binding: "Module link", navigation_item: "Navigation item", page: "Page",
  page_block: "Page block", role: "Role", permission: "Permission", query: "Saved view", block_registration: "Block registration",
  pipeline: "Pipeline", pipeline_stage: "Pipeline stage", connection_binding: "Connection", interface: "Interface",
  public_address: "Public address", theme: "Theme", platform_block_dependency: "Platform block", shell: "Application frame",
  shell_content_slot: "Frame slot", block_placement: "Block placement", flow: "Flow", flow_node: "Flow step",
  flow_edge: "Flow connection", flow_binding: "Flow link",
};

const propertyLabels: Record<string, string> = {
  definition: "definition", identity: "identity", key: "key", name: "name", description: "description", order: "order",
  configuration: "settings", constraint: "rules", required: "required setting", storage: "storage", ownership: "owner",
  permission: "permissions", visibility: "visibility", behavior: "behaviour", version_requirement: "required version",
  address: "address", theme: "theme", icon: "icon", presentation: "presentation",
};

export function PublicationSummary({ confirmation }: { confirmation: DefinitionPublicationConfirmation }) {
  const intro = confirmation.outcome === "initial_release"
    ? `This is the first release. It will be published as version ${confirmation.assignedVersion}.`
    : `${impactLabels[confirmation.impact]}: this will be published as version ${confirmation.assignedVersion}.`;
  return (
    <div className="space-y-2">
      <p>{intro}</p>
      {confirmation.reasons.length > 0 && <Table>
        <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>What changed</TableHead><TableHead>Effect</TableHead></TableRow></TableHeader>
        <TableBody>
          {confirmation.reasons.map((reason, index) => <TableRow key={`${reason.code}:${reason.location.componentId ?? ""}:${index}`}>
            <TableCell>{kindLabels[reason.location.componentKind] ?? reason.location.componentKind} ({propertyLabels[reason.location.property] ?? reason.location.property})
              {reason.location.componentId === undefined ? null : <code className="block break-all text-xs text-muted-foreground">{reason.location.componentId}</code>}
            </TableCell>
            <TableCell>{reasonLabels[reason.code]}</TableCell>
            <TableCell>{impactLabels[reason.impact]}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>}
      <TechnicalDetails>
        <dl className="space-y-1">
          <div><dt className="font-semibold">Draft revision</dt><dd>{confirmation.expectedDraftRevision}</dd></div>
          <div><dt className="font-semibold">Source fingerprint</dt><dd className="break-all"><code>{confirmation.sourceFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Content fingerprint</dt><dd className="break-all"><code>{confirmation.contentFingerprint}</code></dd></div>
          <div><dt className="font-semibold">Resolution fingerprint</dt><dd className="break-all"><code>{confirmation.resolutionFingerprint}</code></dd></div>
        </dl>
        <ViewSource value={confirmation} title="View complete confirmation" />
        <ViewSource value={confirmation.dependencyManifest} title="View exact dependencies" />
      </TechnicalDetails>
    </div>
  );
}
