import {
  moduleSourceDocumentSchema,
  type ModuleSourceDocument,
} from "@vortex/contracts";

const fieldBase = {
  required: false,
  unique: false,
  filterable: false,
  sortable: false,
  personal_data: "none" as const,
  public_display: "refused" as const,
};

const standardActions = ["create", "read", "update", "soft_delete", "restore", "export"] as const;

const actionKinds = {
  create: "create",
  read: "read",
  update: "update",
  soft_delete: "delete",
  restore: "restore",
  export: "export",
} as const;

type RecordScope = {
  routes: readonly Record<string, string>[];
  saved_condition?: {
    condition: string;
    parameter_bindings: readonly {
      key: string;
      source: "current_organization_account_id";
    }[];
  };
};

const allRecords: RecordScope = { routes: [{ kind: "all_records" }] };

const recordPermission = (
  recordKey: string,
  action: (typeof standardActions)[number],
  readableFields: string[],
  changeableFields: string[],
  scope: RecordScope = allRecords,
) => ({
  id: `perm_${recordKey}_${action}`,
  key: `vortex.iam.core.${recordKey}.${action}`,
  label: `${recordKey.replace(/_/g, " ")} ${action.replace(/_/g, " ")}`,
  description: `Allows the standard ${action} operation for ${recordKey.replace(/_/g, " ")} records.`,
  record_type: recordKey,
  action_kind: actionKinds[action],
  administrative: false,
  record_scope: scope,
  field_policy: {
    readable_fields: readableFields,
    changeable_fields: changeableFields,
  },
});

const scopedRecordPermission = (
  recordKey: string,
  action: (typeof standardActions)[number],
  suffix: string,
  scope: RecordScope,
  readableFields: string[],
  changeableFields: string[],
) => ({
  ...recordPermission(recordKey, action, readableFields, changeableFields, scope),
  id: `perm_${recordKey}_${action}_${suffix}`,
  key: `vortex.iam.core.${recordKey}.${action}_${suffix}`,
  label: `${recordKey.replace(/_/g, " ")} ${action.replace(/_/g, " ")} ${suffix.replace(/_/g, " ")}`,
  description: `Allows ${action} on ${suffix.replace(/_/g, " ")} ${recordKey.replace(/_/g, " ")} records only.`,
});

// Ordinary request edits apply only while the request is a draft; protected journeys move it onwards.
const draftRequestCondition = { condition: "draft_request", parameter_bindings: [] };
const draftRequests: RecordScope = { ...allRecords, saved_condition: draftRequestCondition };
const ownRecords: RecordScope = { routes: [{ kind: "ownership" }] };
const ownDraftRequests: RecordScope = { ...ownRecords, saved_condition: draftRequestCondition };

/** Access request kinds; the IAM request forms offer the same choices. */
export const requestTypeOptions = [
  { value: "grant_role", label: "Grant role" },
  { value: "remove_role", label: "Remove role" },
  { value: "group_membership", label: "Group membership" },
  { value: "role_activation", label: "Activate privileged role" },
  { value: "role_deactivation", label: "Deactivate privileged role" },
  { value: "delegation", label: "Delegated management" },
  { value: "group_change", label: "Change a group" },
  { value: "other", label: "Other" },
] as const;

// Ordinary record actions can edit draft content; protected journeys own identity and state.
const requestChangeable = [
  "title",
  "request_type",
  "target_role_key",
  "target_group_key",
  "application_context",
  "reason",
  "starts_on",
  "expires_on",
];
const requestReadable = [
  "request_number",
  "title",
  "request_type",
  "state",
  "beneficiary",
  "target_role_key",
  "target_group_key",
  "application_context",
  "reason",
  "starts_on",
  "expires_on",
  "submitted_at",
  "decided_at",
];

const requestItemCreateChangeable = [
  "request",
  "item_type",
  "target_key",
  "change",
  "application_key",
];
const requestItemUpdateChangeable = ["item_type", "target_key", "change", "application_key"];
const requestItemReadable = [
  "request",
  "item_type",
  "target_key",
  "change",
  "application_key",
];

const permissions = [
  ...standardActions.flatMap((action) => {
    const readable =
      action === "soft_delete" || action === "restore" ? [] : requestReadable;
    const changeable =
      action === "create" || action === "update" ? requestChangeable : [];
    const scope = action === "update" ? draftRequests : allRecords;
    return [recordPermission("access_request", action, readable, changeable, scope)];
  }),
  ...standardActions.flatMap((action) => {
    const readable =
      action === "soft_delete" || action === "restore" ? [] : requestItemReadable;
    const changeable =
      action === "create"
        ? requestItemCreateChangeable
        : action === "update"
          ? requestItemUpdateChangeable
          : [];
    return [recordPermission("access_request_item", action, readable, changeable)];
  }),
  scopedRecordPermission(
    "access_request", "create", "own", ownRecords, requestReadable, requestChangeable,
  ),
  scopedRecordPermission("access_request", "read", "own", ownRecords, requestReadable, []),
  scopedRecordPermission(
    "access_request", "update", "own", ownDraftRequests, requestReadable, requestChangeable,
  ),
  scopedRecordPermission("access_request", "soft_delete", "own", ownRecords, [], []),
  scopedRecordPermission(
    "access_request_item",
    "create",
    "own",
    ownRecords,
    requestItemReadable,
    requestItemCreateChangeable,
  ),
  scopedRecordPermission("access_request_item", "read", "own", ownRecords, requestItemReadable, []),
];

export const iamModule: ModuleSourceDocument = moduleSourceDocumentSchema.parse({
  source_contract_version: "3.0.0",
  root_alias: "mod_iam_core",
  key: "vortex.iam.core",
  kind: "module",
  body: {
    name: "IAM",
    description:
      "Ordinary access request and request item records for the IAM application. These records describe intent only; they confer no access.",
    dependencies: [],
    record_types: [
      {
        id: "rt_iam_access_request",
        key: "access_request",
        name: "Access request",
        plural_name: "Access requests",
        title_field: "title",
        storage_contract_id: "srt_iam_access_request",
        storage_scope: "application_contained",
        ownership_mode: "organisation_account",
        standard_actions: [...standardActions],
        custom_actions: [],
        fields: [
          {
            ...fieldBase,
            id: "fld_iam_request_number",
            key: "request_number",
            label: "Request number",
            required: true,
            unique: true,
            filterable: true,
            sortable: true,
            search_priority: "first",
            type: "reference_number",
            settings: { prefix: "IAM-", digits: 6 },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_title",
            key: "title",
            label: "Title",
            required: true,
            filterable: true,
            sortable: true,
            search_priority: "first",
            type: "text",
            settings: { max_length: 120 },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_type",
            key: "request_type",
            label: "Request type",
            required: true,
            filterable: true,
            sortable: true,
            type: "choice",
            settings: { options: [...requestTypeOptions] },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_state",
            key: "state",
            label: "State",
            required: true,
            filterable: true,
            sortable: true,
            type: "choice",
            settings: {
              options: [
                { value: "draft", label: "Draft" },
                { value: "submitted", label: "Submitted" },
                { value: "in_review", label: "In review" },
                { value: "approved", label: "Approved" },
                { value: "refused", label: "Refused" },
                { value: "cancelled", label: "Cancelled" },
                { value: "expired", label: "Expired" },
              ],
            },
            default: "draft",
          },
          {
            ...fieldBase,
            id: "fld_iam_request_beneficiary",
            key: "beneficiary",
            label: "Beneficiary",
            filterable: true,
            personal_data: "personal",
            type: "link_to_person",
            settings: {
              audience: "organisation_accounts",
              application_root_required: false,
              on_person_deactivation: "retain_reference",
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_role",
            key: "target_role_key",
            label: "Target role",
            filterable: true,
            type: "text",
            settings: { max_length: 120 },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_group",
            key: "target_group_key",
            label: "Target group",
            filterable: true,
            type: "text",
            settings: { max_length: 120 },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_application",
            key: "application_context",
            label: "Application context",
            filterable: true,
            type: "text",
            settings: { max_length: 120 },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_reason",
            key: "reason",
            label: "Reason",
            personal_data: "personal",
            type: "long_text",
            settings: { max_length: 2000 },
          },
          {
            ...fieldBase,
            id: "fld_iam_request_starts",
            key: "starts_on",
            label: "Starts on",
            filterable: true,
            sortable: true,
            type: "date",
            settings: {},
          },
          {
            ...fieldBase,
            id: "fld_iam_request_expires",
            key: "expires_on",
            label: "Expires on",
            filterable: true,
            sortable: true,
            type: "date",
            settings: {},
          },
          {
            ...fieldBase,
            id: "fld_iam_request_submitted",
            key: "submitted_at",
            label: "Submitted at",
            filterable: true,
            sortable: true,
            type: "date_time",
            settings: {},
          },
          {
            ...fieldBase,
            id: "fld_iam_request_decided",
            key: "decided_at",
            label: "Decided at",
            filterable: true,
            sortable: true,
            type: "date_time",
            settings: {},
          },
        ],
        relationships: [],
      },
      {
        id: "rt_iam_access_request_item",
        key: "access_request_item",
        name: "Access request item",
        plural_name: "Access request items",
        title_field: "target_key",
        storage_contract_id: "srt_iam_access_request_item",
        storage_scope: "application_contained",
        ownership_mode: "inherited",
        ownership_relationship: "request",
        standard_actions: [...standardActions],
        custom_actions: [],
        fields: [
          {
            ...fieldBase,
            id: "fld_iam_item_request",
            key: "request",
            label: "Request",
            required: true,
            filterable: true,
            type: "link",
            settings: {
              target: "vortex.iam.core:access_request",
              reverse_key: "items",
              on_parent_delete: "soft_delete_dependent",
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_item_type",
            key: "item_type",
            label: "Item type",
            required: true,
            filterable: true,
            type: "choice",
            settings: {
              options: [
                { value: "role", label: "Role" },
                { value: "permission", label: "Permission" },
                { value: "group", label: "Group" },
                { value: "delegation", label: "Delegation" },
              ],
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_item_target",
            key: "target_key",
            label: "Target",
            required: true,
            filterable: true,
            search_priority: "normal",
            type: "text",
            settings: { max_length: 120 },
          },
          {
            ...fieldBase,
            id: "fld_iam_item_change",
            key: "change",
            label: "Change",
            required: true,
            filterable: true,
            type: "choice",
            settings: {
              options: [
                { value: "add", label: "Add" },
                { value: "remove", label: "Remove" },
              ],
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_item_application",
            key: "application_key",
            label: "Application",
            filterable: true,
            type: "text",
            settings: { max_length: 120 },
          },
        ],
        relationships: [
          {
            id: "rel_iam_item_request",
            key: "request",
            from_field: "request",
            to_record_type: "vortex.iam.core:access_request",
            cardinality: "many_to_one",
            on_parent_delete: "soft_delete_dependent",
          },
        ],
      },
    ],
    permissions,
    actions: [],
    events: [],
    flows: [],
    extension_points: [],
    sharing_conditions: [
      {
        id: "condition_iam_draft_request",
        source_record_type: "access_request",
        key: "draft_request",
        parameters: [],
        condition: { field: "state", operator: "equals", value: "draft" },
        declared_fields: ["state"],
        publication_tests: [
          {
            name: "Draft request may be edited",
            parameters: {},
            field_values: { state: "draft" },
            expected: true,
          },
          {
            name: "Submitted request cannot be edited",
            parameters: {},
            field_values: { state: "submitted" },
            expected: false,
          },
        ],
      },
    ],
  },
});
