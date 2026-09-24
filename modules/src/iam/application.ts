import {
  applicationSourceDocumentV2Schema,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  DEFAULT_PLATFORM_THEME_RELEASE_V2,
  FORM_CONTAINER_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  PLATFORM_SERVICE_OPERATIONS,
  RECORD_DETAIL_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  platformServiceOperationBindingSource,
  platformServiceOperationFlowSource,
  type ApplicationSourceDocumentV2,
  type PlatformBlockReleaseV2,
  type PlatformServiceOperationCatalogueEntry,
  type ProtectedReadModelKey,
} from "@vortex/contracts";
import { requestTypeOptions } from "./module";

const textValue = (value: string) => ({ kind: "text" as const, value });
const choiceValue = (value: string) => ({ kind: "choice" as const, value });
const booleanValue = (value: boolean) => ({ kind: "boolean" as const, value });

const blockRef = (release: PlatformBlockReleaseV2) => ({
  block_id: release.blockId,
  release_version: release.releaseVersion,
});

const dependency = (release: PlatformBlockReleaseV2) => ({
  kind: "platform_block" as const,
  block_id: release.blockId,
  release_version: release.releaseVersion,
  content_fingerprint: release.contentFingerprint,
  catalogue_fingerprint: release.catalogueFingerprint,
});

const fill = { kind: "fill" as const };
const content = { kind: "content" as const };
const layout = { visible: true, width: fill, height: content };

const placement = (
  release: PlatformBlockReleaseV2,
  settings: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  block: blockRef(release),
  settings,
  theme_overrides: {},
  responsive: { desktop: layout },
  slots: {},
  ...extra,
});

const slot = (placements: Record<string, unknown>, order: string[]) => ({
  placements,
  order: { desktop: order },
});

const singleBlockComposition = (
  alias: string,
  release: PlatformBlockReleaseV2,
  settings: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  shell_kind: "default" as const,
  main: slot({ [alias]: placement(release, settings, extra) }, [alias]),
});

/**
 * A region that reads one or more declared protected read models. Each region placement binds one
 * closed read-model key and carries no query, so live protected data is never copied into records.
 */
const readModelComposition = (
  aliasPrefix: string,
  heading: string,
  regions: ReadonlyArray<{ alias: string; key: ProtectedReadModelKey; title: string }>,
) => {
  const placements: Record<string, unknown> = {
    [`${aliasPrefix}_heading`]: placement(TEXT_BLOCK_RELEASE, {
      title: textValue(heading),
      text: textValue(
        "Read live from protected Identity and Access data under your current authority; nothing is copied into application records.",
      ),
    }),
  };
  const order = [`${aliasPrefix}_heading`];
  for (const region of regions) {
    placements[region.alias] = {
      ...placement(TABLE_BLOCK_RELEASE, { title: textValue(region.title) }),
      read_model: region.key,
    };
    order.push(region.alias);
  }
  return { shell_kind: "default" as const, main: slot(placements, order) };
};

const textInput = (alias: string, name: string, label: string, multiline = false) => ({
  alias,
  release: TEXT_INPUT_BLOCK_RELEASE,
  settings: {
    name: textValue(name),
    label: textValue(label),
    ...(multiline ? { multiline: booleanValue(true) } : {}),
  },
});

const choiceInput = (
  alias: string,
  name: string,
  label: string,
  options: ReadonlyArray<{ value: string; label: string }>,
) => ({
  alias,
  release: CHOICE_INPUT_BLOCK_RELEASE,
  settings: {
    name: textValue(name),
    label: textValue(label),
    options: {
      kind: "list" as const,
      items: options.map((option) => ({
        kind: "group" as const,
        properties: { key: textValue(option.value), label: textValue(option.label) },
      })),
    },
  },
});

const dateInput = (alias: string, name: string, label: string) => ({
  alias,
  release: DATE_INPUT_BLOCK_RELEASE,
  settings: { name: textValue(name), label: textValue(label) },
});

const submitButton = (alias: string, label: string) => ({
  alias,
  release: BUTTON_BLOCK_RELEASE,
  settings: {
    label: textValue(label),
    action_kind: choiceValue("submit"),
    variant: choiceValue("primary"),
  },
});

const formComposition = (
  formAlias: string,
  title: string,
  inputs: ReadonlyArray<{
    alias: string;
    release: PlatformBlockReleaseV2;
    settings: Record<string, unknown>;
  }>,
) => {
  const childPlacements: Record<string, unknown> = {};
  const order: string[] = [];
  for (const input of inputs) {
    childPlacements[input.alias] = placement(input.release, input.settings);
    order.push(input.alias);
  }
  return {
    shell_kind: "default" as const,
    main: slot(
      {
        [formAlias]: {
          block: blockRef(FORM_CONTAINER_BLOCK_RELEASE),
          settings: { title: textValue(title) },
          theme_overrides: {},
          responsive: { desktop: layout },
          slots: { content: slot(childPlacements, order) },
        },
      },
      [formAlias],
    ),
  };
};

/**
 * The protected administration operations this application offers. Each is one registered
 * platform-service operation of an existing Access administration method that ends, revises the
 * metadata of, or creates an empty, Group or Role. Granting, assigning and activating access are
 * absent from this definition, not disabled, so no control can expand anyone's authority.
 */
const rolesAndGroupsOperations: readonly PlatformServiceOperationCatalogueEntry[] = [
  PLATFORM_SERVICE_OPERATIONS.revise_role_metadata,
  PLATFORM_SERVICE_OPERATIONS.retire_role,
  PLATFORM_SERVICE_OPERATIONS.create_group,
  PLATFORM_SERVICE_OPERATIONS.rename_group,
  PLATFORM_SERVICE_OPERATIONS.retire_group,
  PLATFORM_SERVICE_OPERATIONS.remove_group_membership,
];
const assignmentOperations: readonly PlatformServiceOperationCatalogueEntry[] = [
  PLATFORM_SERVICE_OPERATIONS.revoke_role_assignment,
  PLATFORM_SERVICE_OPERATIONS.deactivate_role_activation,
  PLATFORM_SERVICE_OPERATIONS.revoke_delegation_authority,
];
const administrationOperations = [...rolesAndGroupsOperations, ...assignmentOperations];
const administrationEventId = "event_iam_administration_action";
const endingOperations: ReadonlySet<string> = new Set([
  "retire_role",
  "retire_group",
  "remove_group_membership",
  "revoke_role_assignment",
  "deactivate_role_activation",
  "revoke_delegation_authority",
]);

const humanise = (key: string): string => {
  const words = key.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const controlAlias = (operation: PlatformServiceOperationCatalogueEntry) =>
  `button_${operation.key}`;
const formAlias = (operation: PlatformServiceOperationCatalogueEntry) => `form_${operation.key}`;

/**
 * One form for one operation: an input for each typed flow input, named by the input's key, and the
 * button whose `action` event starts the bound flow. Identities and expected revisions are typed
 * in because protected read models do not yet carry a selectable row context.
 */
const administrationForm = (operation: PlatformServiceOperationCatalogueEntry) => {
  const children: Record<string, unknown> = {};
  const order: string[] = [];
  for (const [key, declaration] of Object.entries(operation.descriptor.inputs)) {
    const alias = `input_${operation.key}_${key}`;
    children[alias] =
      declaration.type === "whole_number"
        ? placement(NUMBER_INPUT_BLOCK_RELEASE, {
            name: textValue(key),
            label: textValue(humanise(key)),
            required: booleanValue(declaration.required),
            integer: booleanValue(true),
            min_value: { kind: "number", value: 1 },
          })
        : placement(TEXT_INPUT_BLOCK_RELEASE, {
            name: textValue(key),
            label: textValue(humanise(key)),
            required: booleanValue(declaration.required),
            ...(key === "description" ? { multiline: booleanValue(true) } : {}),
          });
    order.push(alias);
  }
  children[controlAlias(operation)] = placement(BUTTON_BLOCK_RELEASE, {
    label: textValue(operation.name),
    action_kind: choiceValue("action"),
    variant: choiceValue(endingOperations.has(operation.key) ? "danger" : "primary"),
  });
  order.push(controlAlias(operation));
  return {
    block: blockRef(FORM_CONTAINER_BLOCK_RELEASE),
    settings: { title: textValue(operation.name) },
    theme_overrides: {},
    responsive: { desktop: layout },
    slots: { content: slot(children, order) },
  };
};

/** A manage-only page of operation forms under one explanatory heading. */
const administrationComposition = (
  aliasPrefix: string,
  heading: string,
  description: string,
  operations: readonly PlatformServiceOperationCatalogueEntry[],
) => {
  const placements: Record<string, unknown> = {
    [`${aliasPrefix}_heading`]: placement(TEXT_BLOCK_RELEASE, {
      title: textValue(heading),
      text: textValue(description),
    }),
  };
  const order = [`${aliasPrefix}_heading`];
  for (const operation of operations) {
    placements[formAlias(operation)] = administrationForm(operation);
    order.push(formAlias(operation));
  }
  return { shell_kind: "default" as const, main: slot(placements, order) };
};

const usedReleases: readonly PlatformBlockReleaseV2[] = [
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
];

const platformBlockDependencies = [...usedReleases]
  .sort((left, right) =>
    left.blockId < right.blockId ? -1 : left.blockId > right.blockId ? 1 : 0,
  )
  .map(dependency);

const recordKeys = [
  "access_request",
  "access_request_item",
  "access_review",
  "access_review_response",
] as const;
const actions = ["create", "read", "update", "soft_delete", "restore", "export"] as const;
const allRecordPermissionKeys = recordKeys.flatMap((recordKey) =>
  actions.map((action) => `vortex.iam.core.${recordKey}.${action}`),
);

const applicationPermissions = [
  {
    id: "perm_app_iam_open",
    key: "application.iam.open",
    label: "Open IAM",
    description: "Allows opening the IAM application.",
    action_kind: "named",
    named_action: "open",
    administrative: false,
  },
  {
    id: "perm_app_iam_request",
    key: "application.iam.request",
    label: "Request access",
    description: "Allows creating and submitting access requests.",
    action_kind: "named",
    named_action: "request",
    administrative: false,
  },
  {
    id: "perm_app_iam_review",
    key: "application.iam.review",
    label: "Review access",
    description: "Allows recording access review decisions.",
    action_kind: "named",
    named_action: "review",
    administrative: false,
  },
  {
    id: "perm_app_iam_manage",
    key: "application.iam.manage",
    label: "Manage IAM",
    description: "Administrative management of the IAM application.",
    action_kind: "named",
    named_action: "manage",
    administrative: true,
  },
];

const roles = [
  {
    id: "role_iam_requester",
    key: "iam_requester",
    name: "IAM requester",
    home_page: "iam_access_requests",
    permissions: [
      "application.iam.open",
      "application.iam.request",
      "vortex.iam.core.access_request.create_own",
      "vortex.iam.core.access_request.read_own",
      "vortex.iam.core.access_request.update_own",
      "vortex.iam.core.access_request.soft_delete_own",
      "vortex.iam.core.access_request_item.create_own",
      "vortex.iam.core.access_request_item.read_own",
    ],
  },
  {
    id: "role_iam_reviewer",
    key: "iam_reviewer",
    name: "IAM reviewer",
    home_page: "iam_reviews",
    permissions: [
      "application.iam.open",
      "application.iam.review",
      "vortex.iam.core.access_request.read_reviewed",
      "vortex.iam.core.access_review.read_assigned",
      "vortex.iam.core.access_review.update_assigned",
    ],
  },
  {
    id: "role_iam_administrator",
    key: "iam_administrator",
    name: "IAM administrator",
    home_page: "iam_overview",
    permissions: [
      "application.iam.open",
      "application.iam.request",
      "application.iam.review",
      "application.iam.manage",
      ...allRecordPermissionKeys,
    ],
  },
];

export const iamApplication: ApplicationSourceDocumentV2 = applicationSourceDocumentV2Schema.parse(
  {
    source_contract_version: "2.0.0",
    root_alias: "app_iam",
    key: "vortex.app.iam",
    kind: "application",
    body: {
      name: "IAM",
      description:
        "Roles and Groups. People request, review, grant and remove access, and manage eligible and active privileged roles. Effective assignments always come from the protected Access source.",
      icon: "users",
      home_page: "iam_overview",
      module_bindings: [
        {
          module: "vortex.iam.core",
          version: { selection: "exact", version: "1.0.0" },
          purpose: "primary",
        },
      ],
      theme: {
        base: {
          kind: "platform_theme",
          catalogue_theme_id: DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueThemeId,
          release_version: DEFAULT_PLATFORM_THEME_RELEASE_V2.releaseVersion,
          content_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.contentFingerprint,
          catalogue_fingerprint: DEFAULT_PLATFORM_THEME_RELEASE_V2.catalogueFingerprint,
        },
        token_overrides: {},
      },
      permissions: applicationPermissions,
      roles,
      navigation: [
        {
          id: "nav_iam_overview",
          type: "page",
          label: "Overview",
          page: "iam_overview",
          permission: "application.iam.open",
        },
        {
          id: "nav_iam_people_heading",
          type: "heading",
          label: "People",
          children: [
            {
              id: "nav_iam_people",
              type: "page",
              label: "People",
              page: "iam_people",
              permission: "application.iam.open",
            },
          ],
        },
        {
          id: "nav_iam_roles_heading",
          type: "heading",
          label: "Roles and Groups",
          children: [
            {
              id: "nav_iam_roles",
              type: "page",
              label: "Roles and Groups",
              page: "iam_roles_groups",
              permission: "application.iam.open",
            },
            {
              id: "nav_iam_manage_roles_groups",
              type: "page",
              label: "Manage roles and Groups",
              page: "iam_manage_roles_groups",
              permission: "application.iam.manage",
            },
            {
              id: "nav_iam_assignments",
              type: "page",
              label: "Assignments",
              page: "iam_assignments",
              permission: "application.iam.open",
            },
            {
              id: "nav_iam_manage_assignments",
              type: "page",
              label: "Manage assignments",
              page: "iam_manage_assignments",
              permission: "application.iam.manage",
            },
          ],
        },
        {
          id: "nav_iam_access_heading",
          type: "heading",
          label: "Access",
          children: [
            {
              id: "nav_iam_requests",
              type: "page",
              label: "Access Requests",
              page: "iam_access_requests",
              permission: "application.iam.open",
            },
            {
              id: "nav_iam_reviews",
              type: "page",
              label: "Reviews",
              page: "iam_reviews",
              permission: "application.iam.review",
            },
          ],
        },
        {
          id: "nav_iam_privileged_heading",
          type: "heading",
          label: "Privileged access",
          children: [
            {
              id: "nav_iam_eligible",
              type: "page",
              label: "Eligible roles",
              page: "iam_privileged_eligible",
              permission: "application.iam.open",
            },
            {
              id: "nav_iam_active",
              type: "page",
              label: "Active roles",
              page: "iam_privileged_active",
              permission: "application.iam.open",
            },
          ],
        },
      ],
      queries: [
        {
          id: "qry_iam_access_requests",
          key: "iam_access_requests",
          record_type: "vortex.iam.core:access_request",
          select: [
            "request_number",
            "title",
            "request_type",
            "state",
            "beneficiary",
            "submitted_at",
          ],
          filter: null,
          group_by: [],
          aggregates: [],
          sort: [{ field: "request_number", direction: "descending" }],
          page_size: 50,
          relationship_hops: 0,
        },
        {
          id: "qry_iam_reviews",
          key: "iam_reviews",
          record_type: "vortex.iam.core:access_review",
          select: [
            "review_number",
            "request",
            "decision",
            "reviewer",
            "decided_at",
          ],
          filter: null,
          group_by: [],
          aggregates: [],
          sort: [{ field: "review_number", direction: "descending" }],
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
          id: administrationEventId,
          key: "vortex.app.iam.administration_action",
          record_type: "vortex.iam.core:access_request",
          carries: [],
          personal_or_sensitive_values_allowed: false,
        },
      ],
      public_addresses: [],
      platform_block_dependencies: platformBlockDependencies,
      shells: [],
      pages: [
        {
          id: "page_iam_overview",
          key: "iam_overview",
          name: "IAM overview",
          type: "dashboard",
          permission: "application.iam.open",
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: {
            shell_kind: "default",
            main: slot(
              {
                iam_overview_heading: placement(TEXT_BLOCK_RELEASE, {
                  title: textValue("IAM overview"),
                  text: textValue(
                    "Access requests and reviews describe intent and decisions. Only protected Access determines current people, roles, groups and assignments; those views read live protected Access data and are never copied into records.",
                  ),
                }),
              },
              ["iam_overview_heading"],
            ),
          },
        },
        {
          id: "page_iam_people",
          key: "iam_people",
          name: "People",
          type: "dashboard",
          permission: "application.iam.open",
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: readModelComposition("iam_people", "People", [
            { alias: "iam_people_region", key: "people", title: "People (Group membership)" },
          ]),
        },
        {
          id: "page_iam_roles_groups",
          key: "iam_roles_groups",
          name: "Roles and Groups",
          type: "dashboard",
          permission: "application.iam.open",
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: readModelComposition("iam_roles_groups", "Roles and Groups", [
            { alias: "iam_roles_region", key: "roles", title: "Roles" },
            { alias: "iam_groups_region", key: "groups", title: "Groups" },
          ]),
        },
        {
          id: "page_iam_assignments",
          key: "iam_assignments",
          name: "Assignments",
          type: "dashboard",
          permission: "application.iam.open",
          states: ["normal", "loading", "empty", "refused", "access_ended", "failure", "recovery"],
          composition: readModelComposition("iam_assignments", "Assignments", [
            {
              alias: "iam_assignments_region",
              key: "effective_assignments",
              title: "Current effective assignments",
            },
          ]),
        },
        {
          id: "page_iam_manage_roles_groups",
          key: "iam_manage_roles_groups",
          name: "Manage roles and Groups",
          type: "dashboard",
          permission: "application.iam.manage",
          states: ["normal", "loading", "validation", "refused", "conflict", "failure", "recovery"],
          composition: administrationComposition(
            "iam_manage_roles_groups",
            "Manage roles and Groups",
            "Revise a role's label and description, create an empty Group, rename a Group, or end a role, Group or Group membership. Each change runs under your own authority in protected Access, is checked against the revision you read, and is refused if you lack the authority. Granting access is never done from here.",
            rolesAndGroupsOperations,
          ),
        },
        {
          id: "page_iam_manage_assignments",
          key: "iam_manage_assignments",
          name: "Manage assignments",
          type: "dashboard",
          permission: "application.iam.manage",
          states: ["normal", "loading", "validation", "refused", "conflict", "failure", "recovery"],
          composition: administrationComposition(
            "iam_manage_assignments",
            "Manage assignments",
            "End a role assignment, a role activation or a delegation authority. Each change runs under your own authority in protected Access, is checked against the revision you read, and is refused if you lack the authority. Granting, assigning and activating access are never done from here.",
            assignmentOperations,
          ),
        },
        {
          id: "page_iam_privileged_eligible",
          key: "iam_privileged_eligible",
          name: "Eligible roles",
          type: "dashboard",
          permission: "application.iam.open",
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: readModelComposition("iam_privileged_eligible", "Eligible roles", [
            {
              alias: "iam_privileged_eligible_region",
              key: "privileged_eligible",
              title: "Privileged roles you may activate",
            },
          ]),
        },
        {
          id: "page_iam_privileged_active",
          key: "iam_privileged_active",
          name: "Active roles",
          type: "dashboard",
          permission: "application.iam.open",
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: readModelComposition("iam_privileged_active", "Active roles", [
            {
              alias: "iam_privileged_active_region",
              key: "privileged_active",
              title: "Privileged roles currently active for you",
            },
          ]),
        },
        {
          id: "page_iam_access_requests",
          key: "iam_access_requests",
          name: "Access Requests",
          type: "list",
          record_type: "vortex.iam.core:access_request",
          permission: "application.iam.open",
          query: "iam_access_requests",
          arrangements: ["table"],
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: singleBlockComposition(
            "iam_access_requests_list",
            TABLE_BLOCK_RELEASE,
            { title: textValue("Access Requests") },
            { query: "iam_access_requests" },
          ),
        },
        {
          id: "page_iam_access_request_detail",
          key: "iam_access_request_detail",
          name: "Access request",
          type: "detail",
          record_type: "vortex.iam.core:access_request",
          permission: "application.iam.open",
          states: ["normal", "loading", "not_found", "refused", "failure", "recovery"],
          composition: singleBlockComposition(
            "iam_access_request_detail_body",
            RECORD_DETAIL_BLOCK_RELEASE,
            { title: textValue("Access request") },
          ),
        },
        {
          id: "page_iam_access_request_new",
          key: "iam_access_request_new",
          name: "New access request",
          type: "form",
          record_type: "vortex.iam.core:access_request",
          permission: "application.iam.request",
          commit_action: "vortex.iam.core.access_request.create",
          states: [
            "normal",
            "loading",
            "validation",
            "refused",
            "conflict",
            "failure",
            "recovery",
          ],
          composition: formComposition("iam_access_request_new_form", "New access request", [
            textInput("iam_request_new_title", "title", "Title"),
            choiceInput("iam_request_new_type", "request_type", "Request type", requestTypeOptions),
            textInput("iam_request_new_role", "target_role_key", "Target role"),
            textInput("iam_request_new_group", "target_group_key", "Target group"),
            textInput("iam_request_new_application", "application_context", "Application"),
            textInput("iam_request_new_reason", "reason", "Reason", true),
            dateInput("iam_request_new_starts", "starts_on", "Starts on"),
            dateInput("iam_request_new_expires", "expires_on", "Expires on"),
            submitButton("iam_request_new_submit", "Submit request"),
          ]),
        },
        {
          id: "page_iam_access_request_edit",
          key: "iam_access_request_edit",
          name: "Edit access request",
          type: "form",
          record_type: "vortex.iam.core:access_request",
          permission: "application.iam.request",
          commit_action: "vortex.iam.core.access_request.update",
          states: [
            "normal",
            "loading",
            "validation",
            "refused",
            "conflict",
            "failure",
            "recovery",
          ],
          composition: formComposition("iam_access_request_edit_form", "Edit access request", [
            textInput("iam_request_edit_title", "title", "Title"),
            choiceInput("iam_request_edit_type", "request_type", "Request type", requestTypeOptions),
            textInput("iam_request_edit_role", "target_role_key", "Target role"),
            textInput("iam_request_edit_group", "target_group_key", "Target group"),
            textInput("iam_request_edit_application", "application_context", "Application"),
            textInput("iam_request_edit_reason", "reason", "Reason", true),
            dateInput("iam_request_edit_starts", "starts_on", "Starts on"),
            dateInput("iam_request_edit_expires", "expires_on", "Expires on"),
            submitButton("iam_request_edit_submit", "Save request"),
          ]),
        },
        {
          id: "page_iam_reviews",
          key: "iam_reviews",
          name: "Reviews",
          type: "list",
          record_type: "vortex.iam.core:access_review",
          permission: "application.iam.review",
          query: "iam_reviews",
          arrangements: ["table"],
          states: ["normal", "loading", "empty", "refused", "failure", "recovery"],
          composition: singleBlockComposition(
            "iam_reviews_list",
            TABLE_BLOCK_RELEASE,
            { title: textValue("Reviews") },
            { query: "iam_reviews" },
          ),
        },
        {
          id: "page_iam_review_detail",
          key: "iam_review_detail",
          name: "Review",
          type: "detail",
          record_type: "vortex.iam.core:access_review",
          permission: "application.iam.review",
          states: ["normal", "loading", "not_found", "refused", "failure", "recovery"],
          composition: singleBlockComposition(
            "iam_review_detail_body",
            RECORD_DETAIL_BLOCK_RELEASE,
            { title: textValue("Review") },
          ),
        },
        {
          id: "page_iam_review_comments",
          key: "iam_review_comments",
          name: "Review comments",
          type: "form",
          record_type: "vortex.iam.core:access_review",
          permission: "application.iam.review",
          commit_action: "vortex.iam.core.access_review.update",
          states: [
            "normal",
            "loading",
            "validation",
            "refused",
            "conflict",
            "failure",
            "recovery",
          ],
          composition: formComposition("iam_review_comments_form", "Review comments", [
            textInput("iam_review_comments_text", "comments", "Comments", true),
            submitButton("iam_review_comments_submit", "Save comments"),
          ]),
        },
      ],
      flows: administrationOperations.map(platformServiceOperationFlowSource),
      flow_bindings: administrationOperations.map((operation) =>
        platformServiceOperationBindingSource(operation, {
          control: controlAlias(operation),
          form: formAlias(operation),
          eventId: administrationEventId,
        }),
      ),
    },
  },
);
