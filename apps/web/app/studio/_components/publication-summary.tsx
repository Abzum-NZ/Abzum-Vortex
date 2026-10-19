"use client";

import type { DefinitionPublicationConfirmation } from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { StudioInspectorGroup } from "@vortex/ui/studio";

const impactLabels = {
  patch: "Small change",
  minor: "New capability",
  major: "Breaking change",
} as const;

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
  module: "Module",
  application: "Application",
  dependency: "Dependency",
  record_type: "Record type",
  field: "Field",
  relationship: "Relationship",
  action: "Action",
  action_input: "Action input",
  event: "Event",
  rule: "Rule",
  rule_input: "Rule input",
  rule_variable: "Rule variable",
  rule_node: "Rule step",
  sharing_condition: "Sharing condition",
  extension_point: "Extension point",
  module_binding: "Module link",
  navigation_item: "Navigation item",
  page: "Page",
  page_block: "Page block",
  role: "Role",
  permission: "Permission",
  query: "Saved view",
  block_registration: "Block registration",
  pipeline: "Pipeline",
  pipeline_stage: "Pipeline stage",
  connection_binding: "Connection",
  interface: "Interface",
  public_address: "Public address",
  theme: "Theme",
  platform_block_dependency: "Platform block",
  shell: "Application frame",
  shell_content_slot: "Frame slot",
  block_placement: "Block placement",
  flow: "Flow",
  flow_node: "Flow step",
  flow_edge: "Flow connection",
  flow_binding: "Flow link",
};

const propertyLabels: Record<string, string> = {
  definition: "definition",
  identity: "identity",
  key: "key",
  name: "name",
  description: "description",
  order: "order",
  configuration: "settings",
  constraint: "rules",
  required: "required setting",
  storage: "storage",
  ownership: "owner",
  permission: "permissions",
  visibility: "visibility",
  behavior: "behaviour",
  version_requirement: "required version",
  address: "address",
  theme: "theme",
  icon: "icon",
  presentation: "presentation",
};

export function PublicationSummary({
  confirmation,
  componentLabels,
}: {
  confirmation: DefinitionPublicationConfirmation;
  componentLabels: readonly Readonly<{ componentId: string; label: string }>[];
}) {
  const names = new Map(
    componentLabels.map((entry) => [entry.componentId.toLowerCase(), entry.label]),
  );
  const intro =
    confirmation.outcome === "initial_release"
      ? `This is the first release. It will be published as version ${confirmation.assignedVersion}.`
      : `${impactLabels[confirmation.impact]}: this will be published as version ${confirmation.assignedVersion}.`;
  const groups = new Map<string, DefinitionPublicationConfirmation["reasons"]>();
  for (const reason of confirmation.reasons) {
    const key = reason.location.componentId ?? reason.location.componentKind;
    groups.set(key, [...(groups.get(key) ?? []), reason]);
  }
  return (
    <div className="min-w-0 space-y-4 text-sm wrap-anywhere">
      <p>{intro}</p>
      {confirmation.reasons.length > 0 && (
        <ul aria-label="Publication changes" className="m-0 min-w-0 list-none space-y-2 p-0">
          {Array.from(groups).map(([key, reasons]) => (
            <li key={key} className="min-w-0 space-y-2 rounded-md py-3 hover:bg-muted/40">
              <p className="m-0 font-medium">
                {names.get(key.toLowerCase()) ??
                  kindLabels[reasons[0]!.location.componentKind] ??
                  reasons[0]!.location.componentKind}
              </p>
              <ul className="m-0 list-none space-y-2 p-0">
                {reasons.map((reason, index) => {
                  const added =
                    reason.code === "component_added" || reason.code === "required_component_added";
                  const removed = reason.code === "component_removed";
                  return (
                    <li key={`${reason.code}:${index}`} className="flex min-w-0 items-start gap-2">
                      {added || removed ? (
                        <Icon
                          name={added ? "plus" : "minus"}
                          className={`mt-1 size-4 shrink-0 ${added ? "text-success" : "text-destructive"}`}
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="w-4 shrink-0 text-center font-medium text-info"
                        >
                          ~
                        </span>
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <p>
                          {reasonLabels[reason.code]}{" "}
                          <span className="text-muted-foreground">
                            · {propertyLabels[reason.location.property] ?? reason.location.property}
                          </span>
                        </p>
                        <Badge variant="outline" className="max-w-full whitespace-normal">
                          {impactLabels[reason.impact]}
                        </Badge>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <StudioInspectorGroup title="Details" defaultOpen={false}>
        <dl className="space-y-2 font-mono text-xs">
          {confirmation.reasons.some((reason) => reason.location.componentId !== undefined) && (
            <div>
              <dt className="font-semibold">Changed item identities</dt>
              <dd className="break-all">
                {confirmation.reasons
                  .flatMap((reason) =>
                    reason.location.componentId === undefined ? [] : [reason.location.componentId],
                  )
                  .join(", ")}
              </dd>
            </div>
          )}
          <div>
            <dt className="font-semibold">Draft revision</dt>
            <dd>{confirmation.expectedDraftRevision}</dd>
          </div>
          <div>
            <dt className="font-semibold">Source fingerprint</dt>
            <dd className="break-all">
              <code>{confirmation.sourceFingerprint}</code>
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Content fingerprint</dt>
            <dd className="break-all">
              <code>{confirmation.contentFingerprint}</code>
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Resolution fingerprint</dt>
            <dd className="break-all">
              <code>{confirmation.resolutionFingerprint}</code>
            </dd>
          </div>
        </dl>
      </StudioInspectorGroup>
    </div>
  );
}
