import {
  applicationSourceDocumentV2Schema,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  FORM_CONTAINER_BLOCK_RELEASE,
  PLATFORM_BLOCK_RELEASES,
  RECORD_DETAIL_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  defaultOperationFlowSource,
  defaultSaveFlowSource,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";
import {
  operationsRunbooks,
  runbookPageKey,
  runbookPageText,
} from "./runbooks";

type JsonObject = Record<string, unknown>;

const incidentRecordType = "vortex.operations.incidents:incident";
const createAction = "vortex.operations.incidents.incident.create";
const attachAction = "vortex.operations.incidents.incident.attach";
const incidentActionEventId = "event_operations_incident_action";

/**
 * The bounded operator actions on an open incident. Each is one detail-page button, shown only to
 * the holder of its own named-action permission, whose action event starts one flow of one Call
 * protected operation task on that named action.
 */
const incidentOperations = [
  {
    action: "vortex.operations.incidents.incident.acknowledge",
    button: "button_operations_incident_acknowledge",
    flow: "operations_acknowledge_incident",
    name: "Acknowledge incident",
    label: "Acknowledge",
    variant: "primary",
    description:
      "Acknowledges the current open incident through the bound incident.acknowledge named action.",
  },
  {
    action: "vortex.operations.incidents.incident.escalate",
    button: "button_operations_incident_escalate",
    flow: "operations_escalate_incident",
    name: "Escalate incident",
    label: "Escalate",
    variant: "danger",
    description:
      "Escalates the current open incident to its owning role through the bound incident.escalate named action.",
  },
  {
    action: "vortex.operations.incidents.incident.resolve",
    button: "button_operations_incident_resolve",
    flow: "operations_resolve_incident",
    name: "Resolve incident",
    label: "Resolve",
    variant: "secondary",
    description:
      "Resolves the current open incident through the bound incident.resolve named action.",
  },
] as const;

const placementLayout = {
  visible: true,
  width: { kind: "fill" as const },
  height: { kind: "content" as const },
};

/** Authored V2 block placement: exact block release, typed settings and named child slots. */
const placement = (
  release: PlatformBlockReleaseV2,
  settings: Record<string, SourceBlockPropertyValueV2Contract> = {},
  slots: Record<string, unknown> = {},
) => ({
  block: { block_id: release.blockId, release_version: release.releaseVersion },
  settings,
  theme_overrides: {},
  responsive: { desktop: placementLayout },
  slots,
});

const slot = (entries: Record<string, unknown>) => ({
  placements: entries,
  order: { desktop: Object.keys(entries) },
});

const textBlock = (title: string, text: string) =>
  placement(TEXT_BLOCK_RELEASE, {
    title: { kind: "text", value: title },
    text: { kind: "text", value: text },
  });

/** A required single-line form input whose name matches the committed field or action input key. */
const textInput = (name: string, label: string) =>
  placement(TEXT_INPUT_BLOCK_RELEASE, {
    name: { kind: "text", value: name },
    label: { kind: "text", value: label },
    required: { kind: "boolean", value: true },
  });

/** A required formatted-text form input whose name matches the committed action input key. */
const richTextInput = (name: string, label: string, helpText: string) =>
  placement(RICH_TEXT_INPUT_BLOCK_RELEASE, {
    name: { kind: "text", value: name },
    label: { kind: "text", value: label },
    help_text: { kind: "text", value: helpText },
    required: { kind: "boolean", value: true },
  });

/** A required form choice input whose name matches the committed field key. */
const choiceInput = (
  name: string,
  label: string,
  options: ReadonlyArray<readonly [string, string]>,
) =>
  placement(CHOICE_INPUT_BLOCK_RELEASE, {
    name: { kind: "text", value: name },
    label: { kind: "text", value: label },
    required: { kind: "boolean", value: true },
    options: {
      kind: "list",
      items: options.map(([value, optionLabel]) => ({
        kind: "group" as const,
        properties: {
          key: { kind: "text" as const, value },
          label: { kind: "text" as const, value: optionLabel },
        },
      })),
    },
  });

const submitButton = (label: string) =>
  placement(BUTTON_BLOCK_RELEASE, {
    label: { kind: "text", value: label },
    action_kind: { kind: "choice", value: "submit" },
    variant: { kind: "choice", value: "primary" },
  });

/** A button whose action event starts one bound named-action flow; shown only to its permission. */
const actionButton = (
  label: string,
  variant: "primary" | "secondary" | "danger",
  permission: string,
) => ({
  ...placement(BUTTON_BLOCK_RELEASE, {
    label: { kind: "text", value: label },
    action_kind: { kind: "choice", value: "action" },
    variant: { kind: "choice", value: variant },
  }),
  view_permission: permission,
});

/** A form container holding its inputs followed by its one submit button. */
const form = (title: string, inputs: Record<string, unknown>) =>
  placement(FORM_CONTAINER_BLOCK_RELEASE, { title: { kind: "text", value: title } }, {
    content: slot(inputs),
  });

const createForm = "form_operations_new_incident";
const attachForm = "form_operations_incident_attach";

/**
 * One reachable dashboard page per spec 19 runbook, keyed by its exact `runbookReference` tail. The
 * page text carries the reference, its owning role, concrete operator steps and the bounded action
 * set, so an operator reading an incident's `runbook_reference` can follow it without opening
 * customer content.
 */
const runbookPages = operationsRunbooks.map((runbook) => {
  const pageKey = runbookPageKey(runbook);
  return {
    id: `page_operations_${pageKey}`,
    key: pageKey,
    name: runbook.title,
    type: "dashboard",
    permission: "application.operations.open",
    composition: {
      shell_kind: "default",
      main: slot({
        [`${pageKey}_text`]: textBlock(runbook.title, runbookPageText(runbook)),
      }),
    },
  };
});

const pages = [
  ...runbookPages,
  {
    id: "page_operations_signals",
    key: "operations_signals",
    name: "Open signals",
    type: "dashboard",
    permission: "application.operations.open",
    composition: {
      shell_kind: "default",
      main: slot({
        operations_signals_text: textBlock(
          "Open alert signals",
          "Open alert signals are recorded and deduplicated by the platform alert sink and hold no customer content. They cannot be listed here yet: signals will appear on this page once they become a system record type. Until then, create an incident from the Create incident page, or open an incident from the Incidents page and attach a signal to it by its deduplication key.",
        ),
      }),
    },
  },
  {
    id: "page_operations_incidents",
    key: "operations_incidents",
    name: "Incidents",
    type: "list",
    record_type: incidentRecordType,
    permission: "vortex.operations.incidents.incident.read",
    query: "operations_open_incidents",
    composition: {
      shell_kind: "default",
      main: slot({
        operations_incidents_table: {
          ...placement(TABLE_BLOCK_RELEASE, { title: { kind: "text", value: "Open incidents" } }),
          query: "operations_open_incidents",
        },
      }),
    },
  },
  {
    id: "page_operations_incident_detail",
    key: "operations_incident_detail",
    name: "Incident",
    type: "detail",
    record_type: incidentRecordType,
    permission: "vortex.operations.incidents.incident.read",
    composition: {
      shell_kind: "default",
      main: slot({
        operations_incident_detail_body: placement(RECORD_DETAIL_BLOCK_RELEASE, {
          title: { kind: "text", value: "Incident" },
        }),
        // Attach runs on the open incident as its subject; operators without the attach
        // permission never see the form, and the action refuses a resolved or closed incident and
        // a signal whose deduplication key does not match the incident's own.
        [attachForm]: {
          ...form("Attach a signal to this incident", {
            input_operations_attach_deduplication_key: textInput(
              "deduplication_key",
              "Signal deduplication key",
            ),
            input_operations_attach_evidence: richTextInput(
              "evidence",
              "Signal evidence",
              "Operational evidence only. Do not paste customer content or personal data.",
            ),
            submit_operations_incident_attach: submitButton("Attach signal"),
          }),
          view_permission: attachAction,
        },
        // The bounded operator actions run on the open incident as their subject. Each button is
        // shown only to its own permission holder, and every action refuses a resolved or closed
        // incident in the module.
        ...Object.fromEntries(
          incidentOperations.map((operation) => [
            operation.button,
            actionButton(operation.label, operation.variant, operation.action),
          ]),
        ),
      }),
    },
  },
  {
    id: "page_operations_new_incident",
    key: "operations_new_incident",
    name: "Create incident",
    type: "form",
    record_type: incidentRecordType,
    permission: createAction,
    composition: {
      shell_kind: "default",
      main: slot({
        [createForm]: form("Create incident", {
          input_operations_incident_code: textInput("code", "Code"),
          input_operations_incident_severity: choiceInput("severity", "Severity", [
            ["warning", "Warning"],
            ["error", "Error"],
            ["critical", "Critical"],
          ]),
          input_operations_incident_service: textInput("affected_service", "Affected service"),
          input_operations_incident_deduplication_key: textInput(
            "deduplication_key",
            "Deduplication key",
          ),
          input_operations_incident_owning_role: textInput("owning_role", "Owning role"),
          input_operations_incident_runbook: textInput("runbook_reference", "Runbook reference"),
          submit_operations_new_incident: submitButton("Create incident"),
        }),
      }),
    },
  },
];

/** Every placed block release as `block_id@release_version`: one block can have several releases. */
const collectBlockReleases = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectBlockReleases(item, result);
  } else if (value !== null && typeof value === "object") {
    const item = value as JsonObject;
    const block = item.block as JsonObject | undefined;
    if (block && typeof block.block_id === "string" && typeof block.release_version === "string")
      result.add(`${block.block_id}@${block.release_version}`);
    for (const child of Object.values(item)) collectBlockReleases(child, result);
  }
  return result;
};

const releasesByKey = new Map<string, PlatformBlockReleaseV2>(
  PLATFORM_BLOCK_RELEASES.map((release) => [
    `${String(release.blockId)}@${release.releaseVersion}`,
    release,
  ]),
);
/** Exactly the registered block releases the pages place, in permanent-identity order. */
const platformBlockDependencies = [...collectBlockReleases(pages)].sort().map((releaseKey) => {
  const release = releasesByKey.get(releaseKey);
  if (!release) throw new TypeError(`Unregistered platform block release: ${releaseKey}`);
  return {
    kind: "platform_block" as const,
    block_id: String(release.blockId),
    release_version: release.releaseVersion,
    content_fingerprint: release.contentFingerprint,
    catalogue_fingerprint: release.catalogueFingerprint,
  };
});

const theme = {
  base: {
    kind: "platform_theme" as const,
    catalogue_theme_id: String(DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueThemeId),
    release_version: DEFAULT_PLATFORM_THEME_RELEASE_V2.releaseVersion,
    content_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.contentFingerprint,
    catalogue_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueFingerprint,
  },
  token_overrides: {},
};

/**
 * The Operations application. Incidents are ordinary application-contained records that change only
 * when a signed-in operator acts: Create incident commits the standard create action; Attach, and
 * the bounded Acknowledge, Escalate and Resolve actions, commit the incident's named actions from
 * its detail page. Each action runs as the operator, is gated by its own module permission and field
 * policy, and refuses a resolved or closed incident; Attach also refuses a signal whose
 * deduplication key does not match the incident's, so a repeated signal updates the one incident it
 * belongs to. One Runbooks page per spec 19 critical code carries concrete operator steps keyed by
 * the incident's `runbook_reference`. No workflow, schedule or system path creates or changes an
 * incident. Open alert signals are recorded by the alert sink, but no record type or protected read
 * model exposes them yet, so the open-signals page is honest text rather than an unbound table. No
 * page or action grants customer-content access, and no action approves itself.
 */
export const operationsApplication: ApplicationSourceDocumentV2 =
  applicationSourceDocumentV2Schema.parse({
    source_contract_version: "2.0.0",
    root_alias: "app_operations",
    key: "vortex.app.operations",
    kind: "application",
    body: {
      name: "Operations",
      description:
        "Operational incidents with timelines, scope, containment, recovery, evidence, communication, cause, follow-up and verification, plus one reachable runbook for each critical alert code. Operators create incidents, attach alert signals to open incidents, and acknowledge, escalate or resolve them under their own permission.",
      icon: "activity",
      home_page: "operations_signals",
      module_bindings: [
        {
          module: "vortex.operations.incidents",
          version: { selection: "exact", version: "1.0.0" },
          purpose: "primary",
        },
      ],
      permissions: [
        {
          id: "app_permission_operations_open",
          key: "application.operations.open",
          label: "Open Operations",
          description: "Allows opening the Operations application.",
          action_kind: "named",
          named_action: "open",
          administrative: false,
        },
      ],
      roles: [
        {
          id: "role_operations_operator",
          key: "operations_operator",
          name: "Operations operator",
          home_page: "operations_signals",
          permissions: [
            "application.operations.open",
            createAction,
            "vortex.operations.incidents.incident.read",
            "vortex.operations.incidents.incident.update",
            "vortex.operations.incidents.incident.soft_delete",
            "vortex.operations.incidents.incident.restore",
            "vortex.operations.incidents.incident.export",
            attachAction,
            ...incidentOperations.map((operation) => operation.action),
          ],
        },
      ],
      navigation: [
        {
          id: "nav_operations",
          type: "heading",
          label: "Operations",
          children: [
            {
              id: "nav_operations_signals",
              type: "page",
              label: "Open signals",
              page: "operations_signals",
              permission: "application.operations.open",
            },
            {
              id: "nav_operations_incidents",
              type: "page",
              label: "Incidents",
              page: "operations_incidents",
              permission: "vortex.operations.incidents.incident.read",
            },
            {
              id: "nav_operations_new_incident",
              type: "page",
              label: "Create incident",
              page: "operations_new_incident",
              permission: createAction,
            },
          ],
        },
        {
          id: "nav_operations_runbooks",
          type: "heading",
          label: "Runbooks",
          children: operationsRunbooks.map((runbook) => ({
            id: `nav_operations_${runbookPageKey(runbook)}`,
            type: "page",
            label: runbook.title,
            page: runbookPageKey(runbook),
            permission: "application.operations.open",
          })),
        },
      ],
      queries: [
        {
          id: "qry_operations_open_incidents",
          key: "operations_open_incidents",
          record_type: incidentRecordType,
          select: [
            "incident_number",
            "code",
            "severity",
            "affected_service",
            "owning_role",
            "runbook_reference",
            "state",
            "attached_at",
          ],
          filter: { field: "state", operator: "not_in", value: ["resolved", "closed"] },
          group_by: [],
          aggregates: [],
          sort: [{ field: "incident_number", direction: "descending" }],
          page_size: 50,
          relationship_hops: 0,
        },
      ],
      workflows: [],
      pipelines: [],
      connection_bindings: [],
      interfaces: [],
      actions: [],
      events: [
        {
          id: "form_submit_operations_new_incident",
          key: "vortex.app.events.vortex_app_operations_create_incident",
          record_type: incidentRecordType,
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
        {
          id: "form_submit_operations_incident_attach",
          key: "vortex.app.events.vortex_app_operations_attach_signal",
          record_type: incidentRecordType,
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
        {
          id: incidentActionEventId,
          key: "vortex.app.events.vortex_app_operations_incident_action",
          record_type: incidentRecordType,
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
      ],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [],
      pages,
      theme,
      // Each form or operator button commits through one flow with one task: the default Save of
      // the incident form, or a call of the incident's attach, acknowledge, escalate or resolve
      // named action. The flows run as the signed-in operator, so the action's own permission,
      // field policy and precondition decide the result.
      flows: [
        {
          ...defaultSaveFlowSource({
            id: "operations_create_incident",
            key: "operations_create_incident",
            description:
              "Creates the incident from the submitted Create incident form through the one Save record task.",
            recordType: incidentRecordType,
            mode: "create",
          }),
          labels: { name: "Create incident" },
        },
        {
          ...defaultOperationFlowSource({
            id: "operations_attach_signal",
            key: "operations_attach_signal",
            description:
              "Attaches the submitted alert signal to the current open incident through the bound incident.attach named action.",
            operation: attachAction,
            inputs: {
              deduplication_key: { type: "text", required: true },
              evidence: { type: "formatted_text", required: true },
            },
          }),
          labels: { name: "Attach signal" },
        },
        ...incidentOperations.map((operation) => ({
          ...defaultOperationFlowSource({
            id: operation.flow,
            key: operation.flow,
            description: operation.description,
            operation: operation.action,
            inputs: {},
          }),
          labels: { name: operation.name },
        })),
      ],
      flow_bindings: [
        {
          id: "form_binding_operations_new_incident",
          control: createForm,
          event_id: "form_submit_operations_new_incident",
          event: "form_submit",
          flow: "operations_create_incident",
          inputs: { values: { kind: "caller", name: "values" } },
        },
        {
          id: "form_binding_operations_incident_attach",
          control: attachForm,
          event_id: "form_submit_operations_incident_attach",
          event: "form_submit",
          flow: "operations_attach_signal",
          inputs: {
            deduplication_key: { kind: "caller", name: "deduplication_key" },
            evidence: { kind: "caller", name: "evidence" },
          },
        },
        // Each operator button starts its own one-task flow with no inputs: the incident is the
        // detail page's subject, and the named action's own permission, field policy and
        // precondition decide the result.
        ...incidentOperations.map((operation) => ({
          id: `button_binding_${operation.flow}`,
          control: operation.button,
          event_id: incidentActionEventId,
          event: "action" as const,
          flow: operation.flow,
          inputs: {},
        })),
      ],
    },
  });
