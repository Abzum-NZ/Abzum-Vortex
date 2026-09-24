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
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";

type JsonObject = Record<string, unknown>;

const incidentRecordType = "vortex.operations.incidents:incident";
const createAction = "vortex.operations.incidents.incident.create";
const attachAction = "vortex.operations.incidents.incident.attach";

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

/** A form container holding its inputs followed by its one submit button. */
const form = (title: string, inputs: Record<string, unknown>) =>
  placement(FORM_CONTAINER_BLOCK_RELEASE, { title: { kind: "text", value: title } }, {
    content: slot(inputs),
  });

/** The outcomes every committing flow node settles into; each returns to the submitting form. */
const flowOutcomes = ["committed", "validation", "refused", "conflict", "uncertain"] as const;

/**
 * One current-user flow that commits a single action node and returns its settled outcome, the same
 * shape Service Desk uses to continue a form submission. The flow runs as the signed-in operator,
 * so the action's own permission, field policy and precondition decide the result.
 */
const committingFlow = (
  id: string,
  name: string,
  description: string,
  target: JsonObject,
  inputs: Record<string, { type: string; required: boolean }>,
) => ({
  id,
  key: id,
  name,
  description,
  run_as: "current_user",
  inputs,
  outputs: {},
  variables: {},
  nodes: [
    { id: `start_${id}`, key: "start", kind: "start", outputs: inputs },
    {
      id: `run_${id}`,
      key: "run_action",
      kind: "action",
      target,
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([key, input]) => [
          key,
          { type: input.type, value: { source: "flow_input", input: key } },
        ]),
      ),
      outputs: {},
      results: {},
    },
    ...flowOutcomes.map((outcome) => ({
      id: `return_${id}_${outcome}`,
      key: `return_${outcome}`,
      kind: "return",
      results: {},
      outcome,
    })),
  ],
  edges: [
    { id: `begin_${id}`, from_node: `start_${id}`, to_node: `run_${id}` },
    ...flowOutcomes.map((outcome) => ({
      id: `run_${id}_${outcome}`,
      from_node: `run_${id}`,
      to_node: `return_${id}_${outcome}`,
      outcome,
    })),
  ],
});

const dashboardStates = ["normal", "loading", "empty", "refused", "failure", "recovery"];
const listStates = ["normal", "loading", "empty", "refused", "access_ended", "failure", "recovery"];
const formStates = ["normal", "loading", "validation", "refused", "conflict", "failure", "recovery"];
const detailStates = [
  "normal",
  "loading",
  "not_found",
  "validation",
  "refused",
  "conflict",
  "failure",
  "recovery",
];

const createForm = "form_operations_new_incident";
const attachForm = "form_operations_incident_attach";

const pages = [
  {
    id: "page_operations_signals",
    key: "operations_signals",
    name: "Open signals",
    type: "dashboard",
    permission: "application.operations.open",
    states: dashboardStates,
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
    arrangements: ["table"],
    states: listStates,
    composition: {
      shell_kind: "default",
      main: slot({
        operations_incidents_table: {
          ...placement(TABLE_BLOCK_RELEASE, { title: { kind: "text", value: "Open incidents" } }),
          query: "operations_open_incidents",
        },
      }),
    },
    standard_page_replacement: { standard_page: "list", record_type: incidentRecordType },
  },
  {
    id: "page_operations_incident_detail",
    key: "operations_incident_detail",
    name: "Incident",
    type: "detail",
    record_type: incidentRecordType,
    permission: "vortex.operations.incidents.incident.read",
    states: detailStates,
    composition: {
      shell_kind: "default",
      main: slot({
        operations_incident_detail_body: placement(RECORD_DETAIL_BLOCK_RELEASE, {
          title: { kind: "text", value: "Incident" },
        }),
        // Attach runs on the open incident as its subject; operators without the attach
        // permission never see the form, and the action refuses a resolved or closed incident.
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
      }),
    },
    standard_page_replacement: { standard_page: "detail", record_type: incidentRecordType },
  },
  {
    id: "page_operations_new_incident",
    key: "operations_new_incident",
    name: "Create incident",
    type: "form",
    record_type: incidentRecordType,
    permission: createAction,
    commit_action: createAction,
    states: formStates,
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
    standard_page_replacement: { standard_page: "create_form", record_type: incidentRecordType },
  },
];

const collectBlockIds = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) collectBlockIds(item, result);
  } else if (value !== null && typeof value === "object") {
    const item = value as JsonObject;
    const block = item.block as JsonObject | undefined;
    if (block && typeof block.block_id === "string") result.add(block.block_id);
    for (const child of Object.values(item)) collectBlockIds(child, result);
  }
  return result;
};

const releasesById = new Map<string, PlatformBlockReleaseV2>(
  PLATFORM_BLOCK_RELEASES.map((release) => [String(release.blockId), release]),
);
/** Exactly the registered block releases the pages place, in permanent-identity order. */
const platformBlockDependencies = [...collectBlockIds(pages)].sort().map((blockId) => {
  const release = releasesById.get(blockId);
  if (!release) throw new TypeError(`Unregistered platform block release: ${blockId}`);
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
 * when a signed-in operator submits a form: Create incident commits the standard create action, and
 * Attach commits the incident's named attach action from its detail page. No workflow, schedule or
 * system path creates or changes an incident. Open alert signals are recorded by the alert sink, but
 * no record type or protected read model exposes them yet, so the open-signals page is honest text
 * rather than an unbound table. No page or action grants customer-content access.
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
        "Operational incidents with timelines, scope, containment, recovery, evidence, communication, cause, follow-up and verification. Operators create incidents and attach alert signals to open incidents by hand.",
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
      rules: [],
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
      ],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [],
      pages,
      theme,
      flows: [
        committingFlow(
          "operations_create_incident",
          "Create incident",
          "Creates the incident from the submitted Create incident form through the standard create action.",
          { kind: "record_save", record_type: incidentRecordType, mode: "create" },
          {},
        ),
        committingFlow(
          "operations_attach_signal",
          "Attach signal",
          "Attaches the submitted alert signal to the current open incident through the bound incident.attach named action.",
          { kind: "named_action", action: attachAction },
          {
            deduplication_key: { type: "text", required: true },
            evidence: { type: "formatted_text", required: true },
          },
        ),
      ],
      flow_bindings: [
        {
          id: "form_binding_operations_new_incident",
          control: createForm,
          event_id: "form_submit_operations_new_incident",
          event: "form_submit",
          flow: { kind: "application_owned", flow: "operations_create_incident" },
          inputs: {},
          results: {},
          declared_effects: ["form_interaction", "change"],
        },
        {
          id: "form_binding_operations_incident_attach",
          control: attachForm,
          event_id: "form_submit_operations_incident_attach",
          event: "form_submit",
          flow: { kind: "application_owned", flow: "operations_attach_signal" },
          inputs: {
            deduplication_key: {
              type: "text",
              value: { source: "form_input", form: attachForm, input: "deduplication_key" },
            },
            evidence: {
              type: "formatted_text",
              value: { source: "form_input", form: attachForm, input: "evidence" },
            },
          },
          results: {},
          declared_effects: ["form_interaction", "change"],
        },
      ],
    },
  });
