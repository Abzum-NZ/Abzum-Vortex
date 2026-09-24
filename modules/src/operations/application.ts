import {
  applicationSourceDocumentV2Schema,
  CHOICE_INPUT_BLOCK_RELEASE,
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  FORM_CONTAINER_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";

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

const slot = (alias: string, value: unknown) => ({
  placements: { [alias]: value },
  order: { desktop: [alias] },
});

const singleBlockComposition = (
  alias: string,
  release: PlatformBlockReleaseV2,
  settings: Record<string, SourceBlockPropertyValueV2Contract> = {},
  extra: Record<string, unknown> = {},
) => ({
  shell_kind: "default" as const,
  main: slot(alias, { ...placement(release, settings), ...extra }),
});

const textBlock = (title: string, text: string) =>
  placement(TEXT_BLOCK_RELEASE, {
    title: { kind: "text", value: title },
    text: { kind: "text", value: text },
  });

/** A form text input whose name matches the committed field or action input key. */
const textInput = (name: string, label: string, multiline: boolean) =>
  placement(TEXT_INPUT_BLOCK_RELEASE, {
    name: { kind: "text", value: name },
    label: { kind: "text", value: label },
    required: { kind: "boolean", value: true },
    multiline: { kind: "boolean", value: multiline },
  });

/** A form choice input whose name matches the committed field key. */
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

const formComposition = (
  formAlias: string,
  title: string,
  inputs: Record<string, unknown>,
  order: readonly string[],
) =>
  ({
    shell_kind: "default" as const,
    main: slot(
      formAlias,
      placement(
        FORM_CONTAINER_BLOCK_RELEASE,
        { title: { kind: "text", value: title } },
        { content: { placements: inputs, order: { desktop: [...order] } } },
      ),
    ),
  }) as const;

const usedBlockReleases = [
  CHOICE_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
];

const platformBlockDependencies = usedBlockReleases
  .map((release) => ({
    kind: "platform_block" as const,
    block_id: String(release.blockId),
    release_version: release.releaseVersion,
    content_fingerprint: release.contentFingerprint,
    catalogue_fingerprint: release.catalogueFingerprint,
  }))
  .sort((left, right) =>
    left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1 : 0,
  );

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

const dashboardStates = ["normal", "loading", "empty", "refused", "failure", "recovery"];
const listStates = ["normal", "loading", "empty", "refused", "access_ended", "failure", "recovery"];
const formStates = ["normal", "loading", "validation", "refused", "conflict", "failure", "recovery"];
const detailStates = ["normal", "loading", "not_found", "refused", "failure", "recovery"];

const incidentContentInputs = {
  incident_code_input: textInput("code", "Code", false),
  incident_severity_input: choiceInput("severity", "Severity", [
    ["warning", "Warning"],
    ["error", "Error"],
    ["critical", "Critical"],
  ]),
  incident_service_input: textInput("affected_service", "Affected service", false),
  incident_deduplication_input: textInput("deduplication_key", "Deduplication key", false),
  incident_owning_role_input: textInput("owning_role", "Owning role", false),
  incident_runbook_input: textInput("runbook_reference", "Runbook reference", false),
};
const incidentContentOrder = [
  "incident_code_input",
  "incident_severity_input",
  "incident_service_input",
  "incident_deduplication_input",
  "incident_owning_role_input",
  "incident_runbook_input",
];

/**
 * The Operations application. Incidents are ordinary application-contained records created or
 * changed only by an operator action; there is no automatic or system-triggered incident creation.
 * Open alert signals are persisted and deduplicated by the alert sink, but no protected read model
 * exposes them yet, so the open-signals page stays honest text rather than an unbound table. No page
 * or action grants customer-content access.
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
        "Operational incidents with timelines, scope, containment, recovery, evidence, communication, cause and follow-up. Operators see open alert signals, open incidents and attach signals by hand.",
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
            "vortex.operations.incidents.incident.create",
            "vortex.operations.incidents.incident.read",
            "vortex.operations.incidents.incident.update",
            "vortex.operations.incidents.incident.soft_delete",
            "vortex.operations.incidents.incident.restore",
            "vortex.operations.incidents.incident.export",
            "vortex.operations.incidents.incident.attach",
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
              permission: "vortex.operations.incidents.incident.create",
            },
            {
              id: "nav_operations_attach_incident",
              type: "page",
              label: "Attach to incident",
              page: "operations_attach_incident",
              permission: "vortex.operations.incidents.incident.attach",
            },
          ],
        },
      ],
      queries: [
        {
          id: "qry_operations_open_incidents",
          key: "operations_open_incidents",
          record_type: "vortex.operations.incidents:incident",
          select: [
            "incident_number",
            "code",
            "severity",
            "affected_service",
            "deduplication_key",
            "owning_role",
            "runbook_reference",
            "state",
            "opened_at",
          ],
          filter: {
            field: "state",
            operator: "not_in",
            value: ["resolved", "closed"],
          },
          group_by: [],
          aggregates: [],
          sort: [{ field: "opened_at", direction: "descending" }],
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
      events: [],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [],
      pages: [
        {
          id: "page_operations_signals",
          key: "operations_signals",
          name: "Open signals",
          type: "dashboard",
          permission: "application.operations.open",
          states: dashboardStates,
          composition: {
            shell_kind: "default",
            main: slot(
              "operations_signals_text",
              textBlock(
                "Open alert signals",
                "Open alert signals are persisted, deduplicated by deduplication key and contain no customer content. They are not yet available from a protected read model, so this page shows no signal rows yet; operators create or attach incidents from the incident pages below. Alert signals will be shown here once they become a system record type.",
              ),
            ),
          },
        },
        {
          id: "page_operations_incidents",
          key: "operations_incidents",
          name: "Incidents",
          type: "list",
          record_type: "vortex.operations.incidents:incident",
          permission: "vortex.operations.incidents.incident.read",
          query: "operations_open_incidents",
          arrangements: ["table", "summary"],
          states: listStates,
          composition: singleBlockComposition(
            "operations_incidents_table",
            TABLE_BLOCK_RELEASE,
            { title: { kind: "text", value: "Open incidents" } },
            { query: "operations_open_incidents" },
          ),
        },
        {
          id: "page_operations_incident_detail",
          key: "operations_incident_detail",
          name: "Incident",
          type: "detail",
          record_type: "vortex.operations.incidents:incident",
          permission: "vortex.operations.incidents.incident.read",
          states: detailStates,
          composition: singleBlockComposition(
            "operations_incident_detail_body",
            RECORD_DETAIL_BLOCK_RELEASE,
            { title: { kind: "text", value: "Incident" } },
          ),
        },
        {
          id: "page_operations_new_incident",
          key: "operations_new_incident",
          name: "Create incident",
          type: "form",
          record_type: "vortex.operations.incidents:incident",
          permission: "vortex.operations.incidents.incident.create",
          commit_action: "vortex.operations.incidents.incident.create",
          states: formStates,
          composition: formComposition(
            "operations_new_incident_form",
            "Create incident",
            incidentContentInputs,
            incidentContentOrder,
          ),
          standard_page_replacement: {
            standard_page: "create_form",
            record_type: "vortex.operations.incidents:incident",
          },
        },
        {
          id: "page_operations_attach_incident",
          key: "operations_attach_incident",
          name: "Attach to incident",
          type: "form",
          record_type: "vortex.operations.incidents:incident",
          permission: "vortex.operations.incidents.incident.attach",
          commit_action: "vortex.operations.incidents.incident.attach",
          states: formStates,
          composition: formComposition(
            "operations_attach_incident_form",
            "Attach a signal to an incident",
            {
              incident_attach_deduplication_input: textInput(
                "deduplication_key",
                "Deduplication key",
                false,
              ),
              incident_attach_evidence_input: textInput("evidence", "Evidence", true),
            },
            ["incident_attach_deduplication_input", "incident_attach_evidence_input"],
          ),
        },
      ],
      theme,
      flows: [],
      flow_bindings: [],
    },
  });
