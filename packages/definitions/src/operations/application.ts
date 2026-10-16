import {
  applicationSourceDocumentSchema,
  DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  defaultOperationFlowSource,
  defaultSaveFlowSource,
  type ApplicationSourceDocument,
  type PlatformBlockReleaseIdentity,
  type SourceItemVortex,
} from "@vortex/platform/schema";
import { operationsModules } from "./module";
import { operationsRunbooks, runbookPageKey, runbookPageText } from "./runbooks";

type JsonObject = Record<string, unknown>;

const {
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE_1_2_0,
  CONTAINER_BLOCK_RELEASE_1_3_0,
  FORM_CONTAINER_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE_1_3_0,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
} = PLATFORM_BLOCK_RELEASE_IDENTITIES;

const incidentRecordType = "vortex.operations.incidents:incident";
/** The open-incidents query the Incidents module exposes, by module key and query key. */
const openIncidentsQuery = "vortex.operations.incidents:operations_open_incidents";
const createAction = "vortex.operations.incidents.incident.create";
/**
 * Page and placement access permissions. The page access decision matches only application
 * permissions, so a page, navigation item or placement view gate names one; the record permissions
 * behind it (incident.read, incident.create and each named action) still decide what its data,
 * forms and actions allow. A role holds each gate exactly when it holds the matching record
 * permission.
 */
const readIncidentsPage = "application.operations.incident.read";
const createIncidentPage = "application.operations.incident.create";
const attachAction = "vortex.operations.incidents.incident.attach";
const attachIncidentView = "application.operations.incident.attach";
const incidentActionEventId = "event_operations_incident_action";
const incidentRowClickEventId = "event_operations_open_incident";

/**
 * The identities of the Incidents row click: the event the table's row_click setting names, the
 * browser-only flow it runs, and that flow's own label and description.
 */
const openIncidentRowClick = {
  eventId: incidentRowClickEventId,
  flow: "operations_open_incident",
  label: "Open incident",
  description:
    "Opens the clicked incident's own detail page with the record identity the clicked row carries.",
};

/**
 * The bounded operator actions on an open incident. Each is one detail-page button, shown only to
 * the holder of its own view permission (held exactly by holders of the named-action permission),
 * whose action event starts one flow of one Call protected operation task on that named action.
 */
const incidentOperations = [
  {
    action: "vortex.operations.incidents.incident.acknowledge",
    viewPermission: "application.operations.incident.acknowledge",
    viewPermissionAlias: "app_permission_operations_incident_acknowledge",
    viewNamedAction: "incident_acknowledge",
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
    viewPermission: "application.operations.incident.escalate",
    viewPermissionAlias: "app_permission_operations_incident_escalate",
    viewNamedAction: "incident_escalate",
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
    viewPermission: "application.operations.incident.resolve",
    viewPermissionAlias: "app_permission_operations_incident_resolve",
    viewNamedAction: "incident_resolve",
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

/**
 * One authored item before it is named: the block release's renderer, plain settings, child slots
 * and its Vortex metadata (exact block release, optional bindings, layout).
 */
const placement = (
  release: PlatformBlockReleaseIdentity,
  settings: Record<string, unknown> = {},
  slots: Record<string, readonly unknown[]> = {},
  bindings: Partial<Pick<SourceItemVortex, "view_permission" | "query">> = {},
) => ({
  type: release.rendererKey,
  props: {
    ...settings,
    ...slots,
    vortex: {
      block: { block_id: release.blockId, release_version: release.releaseVersion },
      ...bindings,
      theme_overrides: {},
      responsive: { desktop: placementLayout },
    },
  },
});
type Placement = ReturnType<typeof placement>;

/** A slot's items in desktop order, each named by its alias. */
const slot = (entries: Record<string, Placement>) =>
  Object.entries(entries).map(([id, item]) => ({ type: item.type, props: { id, ...item.props } }));

const textBlock = (title: string, text: string) =>
  placement(TEXT_BLOCK_RELEASE, {
    title,
    text,
  });

/** A required single-line form input whose name matches the committed field or action input key. */
const textInput = (name: string, label: string) =>
  placement(TEXT_INPUT_BLOCK_RELEASE, {
    name,
    label,
    required: true,
  });

/** A required formatted-text form input whose name matches the committed action input key. */
const richTextInput = (name: string, label: string, helpText: string) =>
  placement(RICH_TEXT_INPUT_BLOCK_RELEASE, {
    name,
    label,
    help_text: helpText,
    required: true,
  });

/** A required form choice input whose name matches the committed field key. */
const choiceInput = (
  name: string,
  label: string,
  options: ReadonlyArray<readonly [string, string]>,
) =>
  placement(CHOICE_INPUT_BLOCK_RELEASE, {
    name,
    label,
    required: true,
    options: options.map(([value, optionLabel]) => ({ key: value, label: optionLabel })),
  });

const submitButton = (label: string) =>
  placement(BUTTON_BLOCK_RELEASE, {
    label,
    action_kind: "submit",
    variant: "primary",
  });

/** A button whose action event starts one bound named-action flow; shown only to its permission. */
const actionButton = (
  label: string,
  variant: "primary" | "secondary" | "danger",
  permission: string,
) =>
  placement(
    BUTTON_BLOCK_RELEASE,
    { label, action_kind: "action", variant },
    {},
    { view_permission: permission },
  );

/** A form container holding its inputs followed by its one submit button. */
const form = (
  title: string,
  inputs: Record<string, Placement>,
  bindings: Parameters<typeof placement>[3] = {},
) => placement(FORM_CONTAINER_BLOCK_RELEASE, { title }, { content: slot(inputs) }, bindings);

const createForm = "form_operations_new_incident";
const attachForm = "form_operations_incident_attach";

/**
 * The columns the Incidents table shows: exactly the fields its own open-incidents query selects,
 * each labelled for a reader and formatted from the field's own declared type.
 */
const incidentColumns: ReadonlyArray<readonly [string, string]> = [
  ["incident_number", "Incident number"],
  ["code", "Code"],
  ["severity", "Severity"],
  ["affected_service", "Affected service"],
  ["owning_role", "Owning role"],
  ["runbook_reference", "Runbook"],
  ["state", "State"],
  ["attached_at", "Attached"],
];

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
    blocks: slot({
      [`${pageKey}_text`]: textBlock(runbook.title, runbookPageText(runbook)),
    }),
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
    blocks: slot({
      operations_signals_text: textBlock(
        "Open alert signals",
        "Open alert signals are recorded and deduplicated by the platform alert sink and hold no customer content. They cannot be listed here yet: signals will appear on this page once they become a system record type. Until then, create an incident from the Create incident page, or open an incident from the Incidents page and attach a signal to it by its deduplication key.",
      ),
    }),
  },
  {
    id: "page_operations_incidents",
    key: "operations_incidents",
    name: "Incidents",
    type: "list",
    record_type: incidentRecordType,
    permission: readIncidentsPage,
    query: openIncidentsQuery,
    blocks: slot({
      operations_incidents_table: placement(
        TABLE_BLOCK_RELEASE_1_3_0,
        {
          title: "Open incidents",
          columns: incidentColumns.map(([field, label]) => ({
            field: `${incidentRecordType}.${field}`,
            label,
          })),
          row_click: { event_id: incidentRowClickEventId },
        },
        {},
        { query: openIncidentsQuery },
      ),
    }),
  },
  {
    id: "page_operations_incident_detail",
    key: "operations_incident_detail",
    name: "Incident",
    type: "detail",
    record_type: incidentRecordType,
    permission: readIncidentsPage,
    blocks: slot({
      operations_incident_detail_body: placement(RECORD_DETAIL_BLOCK_RELEASE, {
        title: "Incident",
      }),
      // Attach runs on the open incident as its subject; operators without the attach
      // permission never see the form, and the action refuses a resolved or closed incident and
      // a signal whose deduplication key does not match the incident's own.
      [attachForm]: form(
        "Attach a signal to this incident",
        {
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
        },
        { view_permission: attachIncidentView },
      ),
      // The bounded operator actions run on the open incident as their subject. Each button is
      // shown only to its own permission holder, and every action refuses a resolved or closed
      // incident in the module.
      ...Object.fromEntries(
        incidentOperations.map((operation) => [
          operation.button,
          actionButton(operation.label, operation.variant, operation.viewPermission),
        ]),
      ),
    }),
  },
  {
    id: "page_operations_new_incident",
    key: "operations_new_incident",
    name: "Create incident",
    type: "form",
    record_type: incidentRecordType,
    permission: createIncidentPage,
    blocks: slot({
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
];

const applicationShell = {
  id: "shell_operations",
  key: "operations_shell",
  name: "Operations shell",
  presentation: {
    sidebar: { collapsible: "icon", default_collapsed: false },
    top_bar: {
      breadcrumbs: true,
      organization_switcher: true,
      application_switcher: true,
      account_menu: true,
      appearance_toggle: true,
    },
  },
  layout: {
    root: { props: { vortex: { slot_orders: {} } } },
    content: slot({
      shell_root: placement(
        CONTAINER_BLOCK_RELEASE_1_3_0,
        {
          direction: "column",
          gap: "medium",
          padding: "medium",
          content_width: "fill",
        },
        {
          header: slot({}),
          content: slot({
            shell_body: placement(
              CONTAINER_BLOCK_RELEASE_1_2_0,
              {
                direction: "row",
                gap: "medium",
                menu_width: 16,
                menu_placement: "sticky",
                content_landmark: true,
                tablet_menu_width: 14,
                phone_direction: "column",
                phone_menu_placement: "flow",
              },
              {
                menu: slot({
                  shell_navigation: placement(APPLICATION_NAVIGATION_BLOCK_RELEASE, {
                    title: "Operations",
                  }),
                }),
                content: slot({}),
              },
            ),
          }),
        },
      ),
    }),
  },
  content_slots: [
    {
      id: "slot_primary",
      key: "primary",
      label: "Primary",
      required: true,
      allowed_child_categories: [
        "content",
        "data",
        "figures",
        "record",
        "actions",
        "input",
        "layout",
      ],
      parent_placement: "shell_body",
      parent_slot: "content",
    },
  ],
};

/** Every page fills the shell's one primary content slot with its blocks. */
const applicationPages = pages.map(({ blocks, ...page }) => ({
  ...page,
  composition: {
    root: {
      props: { slot_primary: blocks, vortex: { shell: "shell_operations", slot_orders: {} } },
    },
    content: [],
  },
}));

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

/** Exactly the registered block releases the shell and pages place, in permanent-identity order. */
const platformBlockDependencies = [
  ...collectBlockReleases({ shell: applicationShell, pages: applicationPages }),
]
  .sort()
  .map((releaseKey) => {
    const separator = releaseKey.lastIndexOf("@");
    if (separator < 1 || separator === releaseKey.length - 1)
      throw new TypeError(`Invalid platform block release identity: ${releaseKey}`);
    return {
      kind: "platform_block" as const,
      block_id: releaseKey.slice(0, separator),
      release_version: releaseKey.slice(separator + 1),
    };
  });

const theme = {
  base: {
    kind: "platform_theme" as const,
    catalogue_theme_id: String(DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY.catalogueThemeId),
    release_version: DEFAULT_PLATFORM_THEME_RELEASE_IDENTITY.releaseVersion,
  },
  selection: DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
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
export const operationsApplication: ApplicationSourceDocument =
  applicationSourceDocumentSchema.parse({
    source_contract_version: "3.0.0",
    root_alias: "app_operations",
    key: "vortex.app.operations",
    kind: "application",
    body: {
      name: "Operations",
      description:
        "Operational incidents with timelines, scope, containment, recovery, evidence, communication, cause, follow-up and verification, plus one reachable runbook for each critical alert code. Operators create incidents, attach alert signals to open incidents, and acknowledge, escalate or resolve them under their own permission.",
      icon: "activity",
      home_page: "operations_signals",
      modules: operationsModules,
      uses: [],
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
        {
          id: "app_permission_operations_incident_read",
          key: readIncidentsPage,
          label: "Open incident pages",
          description: "Allows opening the incident list and incident pages.",
          action_kind: "named",
          named_action: "incident_read",
          administrative: false,
        },
        {
          id: "app_permission_operations_incident_create",
          key: createIncidentPage,
          label: "Open incident creation",
          description: "Allows opening the create incident page.",
          action_kind: "named",
          named_action: "incident_create",
          administrative: false,
        },
        {
          id: "app_permission_operations_incident_attach",
          key: attachIncidentView,
          label: "See signal attachment",
          description: "Allows seeing the attach signal form on an incident page.",
          action_kind: "named",
          named_action: "incident_attach",
          administrative: false,
        },
        ...incidentOperations.map((operation) => ({
          id: operation.viewPermissionAlias,
          key: operation.viewPermission,
          label: `See the ${operation.label} action`,
          description: `Allows seeing the ${operation.label} button on an incident page.`,
          action_kind: "named" as const,
          named_action: operation.viewNamedAction,
          administrative: false,
        })),
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
            createIncidentPage,
            "vortex.operations.incidents.incident.read",
            readIncidentsPage,
            "vortex.operations.incidents.incident.update",
            "vortex.operations.incidents.incident.soft_delete",
            "vortex.operations.incidents.incident.restore",
            "vortex.operations.incidents.incident.export",
            attachAction,
            attachIncidentView,
            ...incidentOperations.flatMap((operation) => [
              operation.action,
              operation.viewPermission,
            ]),
          ],
        },
      ],
      navigation: [
        {
          id: "nav_operations",
          type: "heading",
          label: "Operations",
          icon: "grid",
          children: [
            {
              id: "nav_operations_signals",
              type: "page",
              label: "Open signals",
              icon: "life-buoy",
              page: "operations_signals",
              permission: "application.operations.open",
            },
            {
              id: "nav_operations_incidents",
              type: "page",
              label: "Incidents",
              icon: "life-buoy",
              page: "operations_incidents",
              permission: readIncidentsPage,
            },
            {
              id: "nav_operations_new_incident",
              type: "page",
              label: "Create incident",
              icon: "plus",
              page: "operations_new_incident",
              permission: createIncidentPage,
            },
          ],
        },
        {
          id: "nav_operations_runbooks",
          type: "heading",
          label: "Runbooks",
          icon: "sliders-horizontal",
          children: operationsRunbooks.map((runbook) => ({
            id: `nav_operations_${runbookPageKey(runbook)}`,
            type: "page",
            label: runbook.title,
            icon: "life-buoy",
            page: runbookPageKey(runbook),
            permission: "application.operations.open",
          })),
        },
      ],
      pipelines: [],
      connection_bindings: [],
      interfaces: [],
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
        {
          id: incidentRowClickEventId,
          key: "vortex.app.events.vortex_app_operations_open_incident",
          record_type: incidentRecordType,
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
      ],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [applicationShell],
      pages: applicationPages,
      theme,
      // Each form or operator button commits through one flow with one task: the default Save of
      // the incident form, or a call of the incident's attach, acknowledge, escalate or resolve
      // named action. The flows run as the signed-in operator, so the action's own permission,
      // field policy and precondition decide the result.
      flows: [
        {
          // Clicking an incident row opens its own detail page with the record identity the row
          // carries, so the page subject is read through the normal record read path.
          contractVersion: "1.0.0",
          id: openIncidentRowClick.flow,
          key: openIncidentRowClick.flow,
          description: openIncidentRowClick.description,
          labels: { name: openIncidentRowClick.label },
          execution: "interactive",
          runAs: { kind: "initiator" },
          inputs: {
            record_id: {
              type: "record_reference",
              required: true,
              recordTypeIds: [incidentRecordType],
            },
          },
          tasks: [
            {
              id: "open_detail",
              type: "interface.navigate",
              version: "1.0.0",
              properties: {
                page: {
                  kind: "literal",
                  literal: { type: "text", value: "operations_incident_detail" },
                },
                parameters: {
                  kind: "map",
                  entries: { record_id: "{{ inputs.record_id }}" },
                },
              },
            },
          ],
          outputs: {},
        },
        {
          ...defaultSaveFlowSource({
            id: "operations_create_incident",
            key: "operations_create_incident",
            description:
              "Creates the incident from the submitted Create incident form through the one Save record task.",
            recordType: incidentRecordType,
            mode: "create",
            ownershipMode: "none",
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
        // Clicking an incident row starts the one flow that opens that incident's detail page,
        // with the record identity the row carries as its only input.
        {
          id: "row_binding_operations_open_incident",
          control: "operations_incidents_table",
          event_id: openIncidentRowClick.eventId,
          event: "row_clicked" as const,
          flow: openIncidentRowClick.flow,
          inputs: { record_id: { kind: "caller" as const, name: "record_id" } },
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
