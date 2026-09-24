import {
  applicationSourceDocumentV2Schema,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  FORM_CONTAINER_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  PLATFORM_SERVICE_OPERATIONS,
  TABLE_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  platformServiceOperationBindingSource,
  platformServiceOperationFlowSource,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type PlatformServiceOperationCatalogueEntry,
  type ProtectedReadModelKey,
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

const emptySlot = () => ({ placements: {} as Record<string, unknown>, order: { desktop: [] as string[] } });

const slot = (alias: string, value: unknown) => ({
  placements: { [alias]: value },
  order: { desktop: [alias] },
});

/** A required form text input whose name matches the committed action's input key. */
const textInput = (name: string, label: string, multiline: boolean) =>
  placement(TEXT_INPUT_BLOCK_RELEASE, {
    name: { kind: "text", value: name },
    label: { kind: "text", value: label },
    required: { kind: "boolean", value: true },
    multiline: { kind: "boolean", value: multiline },
  });

/**
 * The protected organisation settings operations this application offers: each is one registered
 * platform-service operation of an existing Access settings method. The owning service derives the
 * organisation and authority from the request context, so no form can name another organisation.
 */
const settingsOperations: readonly PlatformServiceOperationCatalogueEntry[] = [
  PLATFORM_SERVICE_OPERATIONS.update_runtime_settings,
  PLATFORM_SERVICE_OPERATIONS.set_default_application,
];
const settingsEventId = "event_organisation_settings_action";

/** Closed choices, matching the settings contract's own closed vocabularies exactly. */
const choiceOptions: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  date_format: [
    ["short", "Short"],
    ["medium", "Medium"],
    ["long", "Long"],
    ["full", "Full"],
  ],
  number_format: [
    ["auto", "Automatic grouping"],
    ["always", "Always group"],
    ["min2", "Group from two digits"],
    ["never", "Never group"],
  ],
};

const humanise = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const controlAlias = (operation: PlatformServiceOperationCatalogueEntry) =>
  `button_${operation.key}`;
const formAlias = (operation: PlatformServiceOperationCatalogueEntry) => `form_${operation.key}`;

/**
 * One form for one operation: an input for each typed flow input, named by the input's key, and the
 * button whose `action` event starts the bound flow.
 */
const settingsForm = (operation: PlatformServiceOperationCatalogueEntry) => {
  const children: Record<string, unknown> = {};
  const order: string[] = [];
  for (const [key, declaration] of Object.entries(operation.descriptor.inputs)) {
    const alias = `input_${operation.key}_${key}`;
    const name = { kind: "text" as const, value: key };
    const label = { kind: "text" as const, value: humanise(key) };
    const required = { kind: "boolean" as const, value: declaration.required };
    const choices = choiceOptions[key];
    children[alias] =
      declaration.type === "whole_number"
        ? placement(NUMBER_INPUT_BLOCK_RELEASE, {
            name,
            label,
            required,
            integer: { kind: "boolean", value: true },
            min_value: { kind: "number", value: 1 },
          })
        : declaration.type === "choice" && choices !== undefined
          ? placement(CHOICE_INPUT_BLOCK_RELEASE, {
              name,
              label,
              required,
              options: {
                kind: "list",
                items: choices.map(([value, optionLabel]) => ({
                  kind: "group" as const,
                  properties: {
                    key: { kind: "text" as const, value },
                    label: { kind: "text" as const, value: optionLabel },
                  },
                })),
              },
            })
          : placement(TEXT_INPUT_BLOCK_RELEASE, { name, label, required });
    order.push(alias);
  }
  children[controlAlias(operation)] = placement(BUTTON_BLOCK_RELEASE, {
    label: { kind: "text", value: operation.name },
    action_kind: { kind: "choice", value: "action" },
    variant: { kind: "choice", value: "primary" },
  });
  order.push(controlAlias(operation));
  return placement(
    FORM_CONTAINER_BLOCK_RELEASE,
    { title: { kind: "text", value: operation.name } },
    { content: { placements: children, order: { desktop: order } } },
  );
};

const usedBlockReleases = [
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
];

const platformBlockDependencies = usedBlockReleases
  .map((release) => ({
    kind: "platform_block" as const,
    block_id: String(release.blockId),
    release_version: release.releaseVersion,
    content_fingerprint: release.contentFingerprint,
    catalogue_fingerprint: release.catalogueFingerprint,
  }))
  .sort((left, right) => (left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1 : 0));

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

const shell = {
  id: "shell_organisation_administration",
  key: "organisation_administration_shell",
  name: "Organisation administration shell",
  layout: {
    placements: {
      shell_root: placement(
        TABS_BLOCK_RELEASE,
        { title: { kind: "text", value: "Organisation administration" } },
        { tab_one: emptySlot() },
      ),
    },
    order: { desktop: ["shell_root"] },
  },
  content_slots: [
    {
      id: "slot_primary",
      key: "primary",
      label: "Primary",
      required: true,
      allowed_child_categories: ["content", "data", "figures", "record", "actions", "input", "layout"],
      parent_placement: "shell_root",
      parent_slot: "tab_one",
    },
  ],
};

const dashboardStates = ["normal", "loading", "empty", "refused", "failure", "recovery"];
const listStates = ["normal", "loading", "empty", "refused", "access_ended", "failure", "recovery"];
const formStates = ["normal", "loading", "validation", "refused", "conflict", "failure", "recovery"];

const textBlock = (title: string, text: string) =>
  placement(TEXT_BLOCK_RELEASE, {
    title: { kind: "text", value: title },
    text: { kind: "text", value: text },
  });

/**
 * A protected read-model placement. The closed placement binding names one declared platform read
 * model and reads it live under the viewer's current authority. It never carries a query, so live
 * protected data is never copied into an application record.
 */
const readModelBlock = (key: ProtectedReadModelKey, title: string) => ({
  ...placement(TABLE_BLOCK_RELEASE, { title: { kind: "text", value: title } }),
  read_model: key,
});

/**
 * The Organisation Administration application definition. Every visible region is
 * definition-led. Ordinary notices and privacy request cases come from the bound
 * module; the organisation-account, invitation and runtime-settings regions read live
 * protected read models. No region offers a
 * parallel access-grant control: role grants run in the IAM application.
 */
export const organisationAdministrationApplication: ApplicationSourceDocumentV2 =
  applicationSourceDocumentV2Schema.parse({
    source_contract_version: "2.0.0",
    root_alias: "app_organisation_administration",
    key: "vortex.app.organisation_administration",
    kind: "application",
    body: {
      name: "Organisation Administration",
      description:
        "Organisation accounts, invitations, runtime settings, notices and privacy request cases for an organisation administrator, entirely definition-led.",
      icon: "sliders-horizontal",
      home_page: "organisation_overview",
      module_bindings: [
        {
          module: "vortex.organisation_administration",
          version: { selection: "exact", version: "1.0.0" },
          purpose: "primary",
        },
      ],
      permissions: [
        {
          id: "app_permission_open",
          key: "application.organisation_administration.open",
          label: "Open Organisation Administration",
          description: "Allows opening the Organisation Administration application.",
          action_kind: "named",
          named_action: "open",
          administrative: false,
        },
        {
          id: "app_permission_manage",
          key: "application.organisation_administration.manage",
          label: "Manage Organisation Administration",
          description:
            "Allows managing Organisation Administration definition-level administration.",
          action_kind: "manage",
          administrative: true,
        },
      ],
      roles: [
        {
          id: "role_organisation_administrator",
          key: "organisation_administrator",
          name: "Organisation administrator",
          home_page: "organisation_overview",
          permissions: [
            "application.organisation_administration.open",
            "vortex.organisation_administration.organisation_notice.create",
            "vortex.organisation_administration.organisation_notice.read",
            "vortex.organisation_administration.organisation_notice.update",
            "vortex.organisation_administration.organisation_notice.soft_delete",
            "vortex.organisation_administration.organisation_notice.restore",
            "vortex.organisation_administration.organisation_notice.export",
            "vortex.organisation_administration.organisation_notice.record_notice",
            "vortex.organisation_administration.organisation_notice.withdraw",
            "vortex.organisation_administration.privacy_request_case.create",
            "vortex.organisation_administration.privacy_request_case.read",
            "vortex.organisation_administration.privacy_request_case.update",
            "vortex.organisation_administration.privacy_request_case.soft_delete",
            "vortex.organisation_administration.privacy_request_case.restore",
            "vortex.organisation_administration.privacy_request_case.export",
            "vortex.organisation_administration.privacy_request_case.record_privacy_request",
            "vortex.organisation_administration.privacy_request_case.complete",
            "vortex.organisation_administration.privacy_request_case.refuse",
          ],
        },
      ],
      navigation: [
        {
          id: "nav_organisation",
          type: "heading",
          label: "Organisation",
          children: [
            {
              id: "nav_overview",
              type: "page",
              label: "Overview",
              page: "organisation_overview",
              permission: "application.organisation_administration.open",
            },
            {
              id: "nav_accounts",
              type: "page",
              label: "Organisation accounts",
              page: "organisation_accounts",
              permission: "application.organisation_administration.open",
            },
            {
              id: "nav_invitations",
              type: "page",
              label: "Invitations",
              page: "organisation_invitations",
              permission: "application.organisation_administration.open",
            },
            {
              id: "nav_runtime_settings",
              type: "page",
              label: "Runtime settings",
              page: "organisation_runtime_settings",
              permission: "application.organisation_administration.open",
            },
          ],
        },
        {
          id: "nav_content",
          type: "heading",
          label: "Organisation content",
          children: [
            {
              id: "nav_notices",
              type: "page",
              label: "Notices",
              page: "organisation_notices",
              permission: "vortex.organisation_administration.organisation_notice.read",
            },
            {
              id: "nav_record_notice",
              type: "page",
              label: "Record notice",
              page: "record_organisation_notice",
              permission: "vortex.organisation_administration.organisation_notice.record_notice",
            },
            {
              id: "nav_privacy_cases",
              type: "page",
              label: "Privacy request cases",
              page: "privacy_request_cases",
              permission: "vortex.organisation_administration.privacy_request_case.read",
            },
            {
              id: "nav_record_privacy_request",
              type: "page",
              label: "Record privacy request",
              page: "record_privacy_request_case",
              permission:
                "vortex.organisation_administration.privacy_request_case.record_privacy_request",
            },
          ],
        },
        {
          id: "nav_access",
          type: "heading",
          label: "Access",
          children: [
            {
              id: "nav_roles_and_groups",
              type: "page",
              label: "Roles and groups",
              page: "roles_and_groups",
              permission: "application.organisation_administration.open",
            },
          ],
        },
      ],
      queries: [
        {
          id: "qry_organisation_notices",
          key: "organisation_notices",
          record_type: "vortex.organisation_administration:organisation_notice",
          select: ["title", "body", "state", "published_at"],
          filter: null,
          group_by: [],
          aggregates: [],
          sort: [{ field: "title", direction: "ascending" }],
          page_size: 50,
          relationship_hops: 0,
        },
        {
          id: "qry_privacy_request_cases",
          key: "privacy_request_cases",
          record_type: "vortex.organisation_administration:privacy_request_case",
          select: ["subject", "request_kind", "state", "received_at", "closed_at"],
          filter: null,
          group_by: [],
          aggregates: [],
          sort: [{ field: "received_at", direction: "descending" }],
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
          id: settingsEventId,
          key: "vortex.app.organisation_administration.settings_action",
          record_type: "vortex.organisation_administration:organisation_notice",
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
      ],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [shell],
      pages: [
        {
          id: "page_organisation_overview",
          key: "organisation_overview",
          name: "Organisation overview",
          type: "dashboard",
          permission: "application.organisation_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: slot(
                "overview_text",
                textBlock(
                  "Organisation overview",
                  "Review organisation accounts, invitations, runtime settings, notices and privacy request cases. Account, invitation and runtime-settings displays are read live from protected Identity and Access read models.",
                ),
              ),
            },
          },
        },
        {
          id: "page_organisation_accounts",
          key: "organisation_accounts",
          name: "Organisation accounts",
          type: "dashboard",
          permission: "application.organisation_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: {
                placements: {
                  accounts_text: textBlock(
                    "Organisation accounts",
                    "Organisation accounts are read live from protected Identity and Access data; no account directory is copied into this application. Role grants run in the IAM application, never here.",
                  ),
                  accounts_region: readModelBlock("organization_accounts", "Organisation accounts"),
                },
                order: { desktop: ["accounts_text", "accounts_region"] },
              },
            },
          },
        },
        {
          id: "page_organisation_invitations",
          key: "organisation_invitations",
          name: "Invitations",
          type: "dashboard",
          permission: "application.organisation_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: {
                placements: {
                  invitations_text: textBlock(
                    "Invitations",
                    "Pending and past invitations are read live from protected Identity and Access data. Invitations carrying intended role assignments follow the governed IAM journey; this application offers no grant control.",
                  ),
                  invitations_region: readModelBlock("organization_invitations", "Invitations"),
                },
                order: { desktop: ["invitations_text", "invitations_region"] },
              },
            },
          },
        },
        {
          id: "page_organisation_runtime_settings",
          key: "organisation_runtime_settings",
          name: "Runtime settings",
          type: "dashboard",
          permission: "application.organisation_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: {
                placements: {
                  settings_text: textBlock(
                    "Runtime settings",
                    "The organisation's current runtime localisation settings are read live from protected Access data below. Change them or the organisation default application with the forms below: each runs under your own authority in protected Access, is checked against the settings revision you supply, and is refused if you lack the authority. These settings are never copied into ordinary records.",
                  ),
                  settings_region: readModelBlock(
                    "organization_runtime_settings",
                    "Current runtime settings",
                  ),
                  ...Object.fromEntries(
                    settingsOperations.map((operation) => [
                      formAlias(operation),
                      settingsForm(operation),
                    ]),
                  ),
                },
                order: {
                  desktop: [
                    "settings_text",
                    "settings_region",
                    ...settingsOperations.map((operation) => formAlias(operation)),
                  ],
                },
              },
            },
          },
        },
        {
          id: "page_roles_and_groups",
          key: "roles_and_groups",
          name: "Roles and groups",
          type: "dashboard",
          permission: "application.organisation_administration.open",
          states: dashboardStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: {
                placements: {
                  roles_text: textBlock(
                    "Roles and groups",
                    "Roles and groups are read live from protected Access. Role grants, group membership and assignments are managed in the IAM application; this application offers no parallel grant control.",
                  ),
                  roles_region: readModelBlock("roles", "Roles"),
                  groups_region: readModelBlock("groups", "Groups"),
                },
                order: { desktop: ["roles_text", "roles_region", "groups_region"] },
              },
            },
          },
        },
        {
          id: "page_organisation_notices",
          key: "organisation_notices",
          name: "Organisation notices",
          type: "list",
          record_type: "vortex.organisation_administration:organisation_notice",
          permission: "vortex.organisation_administration.organisation_notice.read",
          query: "organisation_notices",
          arrangements: ["table", "summary"],
          states: listStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: slot(
                "notices_table",
                {
                  ...placement(TABLE_BLOCK_RELEASE, {
                    title: { kind: "text", value: "Organisation notices" },
                  }),
                  query: "organisation_notices",
                },
              ),
            },
          },
        },
        {
          id: "page_record_notice",
          key: "record_organisation_notice",
          name: "Record organisation notice",
          type: "form",
          record_type: "vortex.organisation_administration:organisation_notice",
          permission: "vortex.organisation_administration.organisation_notice.record_notice",
          commit_action: "vortex.organisation_administration.organisation_notice.record_notice",
          states: formStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: slot(
                "notice_form",
                placement(
                  FORM_CONTAINER_BLOCK_RELEASE,
                  { title: { kind: "text", value: "Record organisation notice" } },
                  {
                    content: {
                      placements: {
                        notice_title_input: textInput("title", "Title", false),
                        notice_body_input: textInput("body", "Notice text", true),
                      },
                      order: { desktop: ["notice_title_input", "notice_body_input"] },
                    },
                  },
                ),
              ),
            },
          },
        },
        {
          id: "page_privacy_request_cases",
          key: "privacy_request_cases",
          name: "Privacy request cases",
          type: "list",
          record_type: "vortex.organisation_administration:privacy_request_case",
          permission: "vortex.organisation_administration.privacy_request_case.read",
          query: "privacy_request_cases",
          arrangements: ["table", "summary"],
          states: listStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: slot(
                "privacy_cases_table",
                {
                  ...placement(TABLE_BLOCK_RELEASE, {
                    title: { kind: "text", value: "Privacy request cases" },
                  }),
                  query: "privacy_request_cases",
                },
              ),
            },
          },
        },
        {
          id: "page_record_privacy_request",
          key: "record_privacy_request_case",
          name: "Record privacy request case",
          type: "form",
          record_type: "vortex.organisation_administration:privacy_request_case",
          permission:
            "vortex.organisation_administration.privacy_request_case.record_privacy_request",
          commit_action:
            "vortex.organisation_administration.privacy_request_case.record_privacy_request",
          states: formStates,
          composition: {
            shell_kind: "application",
            shell: "shell_organisation_administration",
            content: {
              slot_primary: slot(
                "privacy_form",
                placement(
                  FORM_CONTAINER_BLOCK_RELEASE,
                  { title: { kind: "text", value: "Record privacy request case" } },
                  {
                    content: {
                      placements: {
                        privacy_subject_input: textInput("subject", "Subject", false),
                        privacy_details_input: textInput("details", "Request details", true),
                      },
                      order: { desktop: ["privacy_subject_input", "privacy_details_input"] },
                    },
                  },
                ),
              ),
            },
          },
        },
      ],
      theme,
      flows: settingsOperations.map(platformServiceOperationFlowSource),
      flow_bindings: settingsOperations.map((operation) =>
        platformServiceOperationBindingSource(operation, {
          control: controlAlias(operation),
          form: formAlias(operation),
          eventId: settingsEventId,
        }),
      ),
    },
  });
