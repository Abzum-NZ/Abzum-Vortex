"use client";

import type {
  DefinitionPublicationConfirmation,
  PrepareDefinitionPublicationResult,
} from "@vortex/platform/schema";
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
  sharing_condition: "Sharing condition",
  extension_point: "Extension point",
  module_binding: "Module link",
  navigation_item: "Navigation item",
  page: "Page",
  page_block: "Page block",
  role: "Role",
  permission: "Access",
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
  block_placement: "Block",
  flow: "Workflow",
  flow_node: "Workflow step",
  flow_edge: "Workflow connection",
  flow_binding: "Interaction",
};

export type PublicationComponentLabel = Readonly<
  Omit<PrepareDefinitionPublicationResult["componentLabels"][number], "componentId"> & {
    componentId: string;
  }
>;

type Reason = DefinitionPublicationConfirmation["reasons"][number];
const list = (values: readonly string[]): string =>
  values.length < 2 ? (values[0] ?? "") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
const actions = (values: readonly string[]): string =>
  list(values.map((value) => value.charAt(0).toLowerCase() + value.slice(1)));

const sentence = (reason: Reason, component: PublicationComponentLabel): string => {
  const { componentKind: kind, property } = reason.location;
  const name = component.label;
  if (kind === "role" && property === "permission") {
    const changes = [];
    if (component.addedAccess?.length)
      changes.push(`${name} can now ${actions(component.addedAccess)}`);
    if (component.removedAccess?.length)
      changes.push(`${name} can no longer ${actions(component.removedAccess)}`);
    if (changes.length > 0) return changes.join("; ");
    return reason.code === "component_added"
      ? `Access added for ${name}`
      : `Access changed for ${name}`;
  }
  if (reason.code === "component_added") {
    if (kind === "block_placement" && property === "behavior")
      return component.addedCapabilities?.length
        ? `New capability: ${list(component.addedCapabilities)} on ${name}`
        : `New capability: ${name}`;
    return `New ${(kindLabels[kind] ?? "item").toLowerCase()}: ${name}`;
  }
  if (reason.code === "component_removed") return `${kindLabels[kind] ?? "Item"} removed: ${name}`;
  if (reason.code === "presentation_changed" && component.wordingChanged)
    return `Wording changed: ${name}`;
  return `${reasonLabels[reason.code]}: ${name}`;
};

export function PublicationSummary({
  confirmation,
  componentLabels,
}: {
  confirmation: DefinitionPublicationConfirmation;
  componentLabels: readonly PublicationComponentLabel[];
}) {
  const names = new Map(componentLabels.map((entry) => [entry.componentId.toLowerCase(), entry]));
  const intro =
    confirmation.outcome === "initial_release"
      ? `This is the first release. It will be published as version ${confirmation.assignedVersion}.`
      : `${impactLabels[confirmation.impact]}: this will be published as version ${confirmation.assignedVersion}.`;
  const groups = new Map<string, DefinitionPublicationConfirmation["reasons"]>();
  const addedPages = new Set(
    confirmation.reasons
      .filter(
        (reason) => reason.location.componentKind === "page" && reason.code === "component_added",
      )
      .map((reason) => reason.location.componentId?.toLowerCase()),
  );
  for (const reason of confirmation.reasons) {
    const id = reason.location.componentId?.toLowerCase();
    const pageId = id === undefined ? undefined : names.get(id)?.pageId;
    // A new page and its new menu link are one destination, identified by the actual page id.
    const key =
      reason.location.componentKind === "navigation_item" &&
      reason.code === "component_added" &&
      pageId !== undefined &&
      addedPages.has(pageId)
        ? `page:${pageId}`
        : `${reason.location.componentKind}:${id ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), reason]);
  }
  return (
    <div className="min-w-0 space-y-4 text-sm wrap-anywhere">
      <p>{intro}</p>
      {confirmation.reasons.length > 0 && (
        <ul aria-label="Publication changes" className="m-0 min-w-0 list-none space-y-2 p-0">
          {Array.from(groups).map(([key, reasons]) => {
            const primary =
              reasons.find((reason) => reason.location.componentKind === "page") ?? reasons[0]!;
            const component = names.get(primary.location.componentId?.toLowerCase() ?? "") ?? {
              componentId: "",
              label: kindLabels[primary.location.componentKind] ?? "Item",
            };
            const sentences = [
              ...new Set(
                reasons
                  .filter(
                    (reason) =>
                      !(
                        primary.location.componentKind === "page" &&
                        reason.location.componentKind === "navigation_item" &&
                        primary.code === "component_added" &&
                        reason.code === "component_added"
                      ),
                  )
                  .map((reason) => sentence(reason, component)),
              ),
            ];
            const added = reasons.every(
              (reason) =>
                reason.code === "component_added" || reason.code === "required_component_added",
            );
            const removed = reasons.some((reason) => reason.code === "component_removed");
            const impact = reasons.some((reason) => reason.impact === "major")
              ? "major"
              : reasons.some((reason) => reason.impact === "minor")
                ? "minor"
                : "patch";
            return (
              <li
                key={key}
                className="flex min-w-0 items-start gap-2 rounded-md py-3 hover:bg-muted/40"
              >
                {added || removed ? (
                  <Icon
                    name={removed ? "minus" : "plus"}
                    className={`mt-1 size-4 shrink-0 ${removed ? "text-destructive" : "text-success"}`}
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
                  {sentences.map((value) => (
                    <p key={value}>{value}</p>
                  ))}
                  <Badge variant="outline" className="max-w-full whitespace-normal">
                    {impactLabels[impact]}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <StudioInspectorGroup title="Details" defaultOpen={false}>
        <dl className="space-y-2 font-mono text-xs">
          {confirmation.reasons.some((reason) => reason.location.componentId !== undefined) && (
            <div>
              <dt className="font-semibold">Changed item identities</dt>
              <dd className="break-all">
                {[
                  ...new Set(
                    confirmation.reasons.flatMap((reason) =>
                      reason.location.componentId === undefined
                        ? []
                        : [reason.location.componentId],
                    ),
                  ),
                ].join(", ")}
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
