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

const recordPermission = (
  recordKey: string,
  action: (typeof standardActions)[number],
  readableFields: string[],
  changeableFields: string[],
) => ({
  id: `perm_${recordKey}_${action}`,
  key: `vortex.iam.core.${recordKey}.${action}`,
  label: `${recordKey.replace(/_/g, " ")} ${action.replace(/_/g, " ")}`,
  description: `Allows the standard ${action} operation for ${recordKey.replace(/_/g, " ")} records.`,
  record_type: recordKey,
  action_kind: actionKinds[action],
  administrative: false,
  record_scope: { routes: [{ kind: "all_records" }] },
  field_policy: {
    readable_fields: readableFields,
    changeable_fields: changeableFields,
  },
});

const scopedRecordPermission = (
  recordKey: string,
  action: (typeof standardActions)[number],
  suffix: string,
  scope: {
    routes: readonly Record<string, string>[];
    saved_condition?: {
      condition: string;
      parameter_bindings: readonly {
        key: string;
        source: "current_organization_account_id";
      }[];
    };
  },
  readableFields: string[],
  changeableFields: string[],
) => ({
  ...recordPermission(recordKey, action, readableFields, changeableFields),
  id: `perm_${recordKey}_${action}_${suffix}`,
  key: `vortex.iam.core.${recordKey}.${action}_${suffix}`,
  label: `${recordKey.replace(/_/g, " ")} ${action.replace(/_/g, " ")} ${suffix.replace(/_/g, " ")}`,
  description: `Allows ${action} on ${suffix.replace(/_/g, " ")} ${recordKey.replace(/_/g, " ")} records only.`,
  record_scope: scope,
});

const ownRecords = { routes: [{ kind: "ownership" }] } as const;
const assignedReviews = {
  routes: [{ kind: "all_records" }],
  saved_condition: {
    condition: "assigned_reviewer",
    parameter_bindings: [{ key: "current_account", source: "current_organization_account_id" }],
  },
} as const;
const reviewedRequests = {
  routes: [
    {
      kind: "relationship",
      relationship: "vortex.iam.core:access_review.request",
      source_permission: "vortex.iam.core.access_review.read_assigned",
    },
  ],
} as const;

const requestChangeable = [
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
  "proposal_revision",
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
  "proposal_revision",
  "submitted_at",
  "decided_at",
];

const requestItemChangeable = ["request", "item_type", "target_key", "change", "application_key"];
const requestItemReadable = [
  "request",
  "item_type",
  "target_key",
  "change",
  "application_key",
];

const reviewChangeable = [
  "request",
  "proposal_revision",
  "decision",
  "reviewer",
  "decided_at",
  "comments",
];
const reviewReadable = [
  "review_number",
  "request",
  "proposal_revision",
  "decision",
  "reviewer",
  "decided_at",
  "comments",
];

const reviewResponseChangeable = ["review", "responder", "outcome", "comment", "responded_at"];
const reviewResponseReadable = ["review", "responder", "outcome", "comment", "responded_at"];

const ownRequestChangeable = [
  "title",
  "request_type",
  "target_role_key",
  "target_group_key",
  "application_context",
  "reason",
  "starts_on",
  "expires_on",
];

const permissions = [
  ...standardActions.flatMap((action) => {
    const readable =
      action === "soft_delete" || action === "restore" ? [] : requestReadable;
    const changeable =
      action === "create" || action === "update" ? requestChangeable : [];
    return [recordPermission("access_request", action, readable, changeable)];
  }),
  ...standardActions.flatMap((action) => {
    const readable =
      action === "soft_delete" || action === "restore" ? [] : requestItemReadable;
    const changeable =
      action === "create" || action === "update" ? requestItemChangeable : [];
    return [recordPermission("access_request_item", action, readable, changeable)];
  }),
  ...standardActions.flatMap((action) => {
    const readable = action === "soft_delete" || action === "restore" ? [] : reviewReadable;
    const changeable =
      action === "create" || action === "update" ? reviewChangeable : [];
    return [recordPermission("access_review", action, readable, changeable)];
  }),
  ...standardActions.flatMap((action) => {
    const readable =
      action === "soft_delete" || action === "restore" ? [] : reviewResponseReadable;
    const changeable =
      action === "create" || action === "update" ? reviewResponseChangeable : [];
    return [recordPermission("access_review_response", action, readable, changeable)];
  }),
  scopedRecordPermission(
    "access_request", "create", "own", ownRecords, requestReadable, ownRequestChangeable,
  ),
  scopedRecordPermission("access_request", "read", "own", ownRecords, requestReadable, []),
  scopedRecordPermission(
    "access_request", "update", "own", ownRecords, requestReadable, ownRequestChangeable,
  ),
  scopedRecordPermission("access_request", "soft_delete", "own", ownRecords, [], []),
  scopedRecordPermission(
    "access_request_item", "create", "own", ownRecords, requestItemReadable, requestItemChangeable,
  ),
  scopedRecordPermission("access_request_item", "read", "own", ownRecords, requestItemReadable, []),
  scopedRecordPermission(
    "access_review", "read", "assigned", assignedReviews, reviewReadable, [],
  ),
  scopedRecordPermission(
    "access_request", "read", "reviewed", reviewedRequests, requestReadable, [],
  ),
];

export const iamModule: ModuleSourceDocument = moduleSourceDocumentSchema.parse({
  source_contract_version: "3.0.0",
  root_alias: "mod_iam_core",
  key: "vortex.iam.core",
  kind: "module",
  body: {
    name: "IAM",
    description:
      "Ordinary access request, request item, review and review response records for the IAM application. These records describe intent and decisions only; they confer no access.",
    dependencies: [],
    record_types: [
      {
        id: "rt_iam_access_request",
        key: "access_request",
        name: "Access request",
        plural_name: "Access requests",
        title_field: "title",
        storage_contract_id: "srt_iam_access_request",
        storage_scope: "organisation_shared",
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
            settings: {
              options: [
                { value: "grant_role", label: "Grant role" },
                { value: "remove_role", label: "Remove role" },
                { value: "group_membership", label: "Group membership" },
                { value: "role_activation", label: "Activate privileged role" },
                { value: "role_deactivation", label: "Deactivate privileged role" },
                { value: "delegation", label: "Delegated management" },
                { value: "group_change", label: "Change a group" },
                { value: "other", label: "Other" },
              ],
            },
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
            id: "fld_iam_request_proposal_revision",
            key: "proposal_revision",
            label: "Proposal revision",
            required: true,
            filterable: true,
            sortable: true,
            type: "whole_number",
            settings: { minimum: 1 },
            default: 1,
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
        storage_scope: "organisation_shared",
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
      {
        id: "rt_iam_access_review",
        key: "access_review",
        name: "Access review",
        plural_name: "Access reviews",
        title_field: "review_number",
        storage_contract_id: "srt_iam_access_review",
        storage_scope: "organisation_shared",
        ownership_mode: "none",
        standard_actions: [...standardActions],
        custom_actions: [],
        fields: [
          {
            ...fieldBase,
            id: "fld_iam_review_number",
            key: "review_number",
            label: "Review number",
            required: true,
            unique: true,
            filterable: true,
            sortable: true,
            search_priority: "first",
            type: "reference_number",
            settings: { prefix: "REV-", digits: 6 },
          },
          {
            ...fieldBase,
            id: "fld_iam_review_request",
            key: "request",
            label: "Request",
            required: true,
            filterable: true,
            type: "link",
            settings: {
              target: "vortex.iam.core:access_request",
              reverse_key: "reviews",
              on_parent_delete: "refuse",
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_review_proposal_revision",
            key: "proposal_revision",
            label: "Proposal revision",
            required: true,
            filterable: true,
            sortable: true,
            type: "whole_number",
            settings: { minimum: 1 },
          },
          {
            ...fieldBase,
            id: "fld_iam_review_decision",
            key: "decision",
            label: "Decision",
            required: true,
            filterable: true,
            sortable: true,
            type: "choice",
            settings: {
              options: [
                { value: "pending", label: "Pending" },
                { value: "approved", label: "Approved" },
                { value: "refused", label: "Refused" },
                { value: "expired", label: "Expired" },
              ],
            },
            default: "pending",
          },
          {
            ...fieldBase,
            id: "fld_iam_review_reviewer",
            key: "reviewer",
            label: "Reviewer",
            required: true,
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
            id: "fld_iam_review_decided",
            key: "decided_at",
            label: "Decided at",
            filterable: true,
            sortable: true,
            type: "date_time",
            settings: {},
          },
          {
            ...fieldBase,
            id: "fld_iam_review_evidence",
            key: "workflow_evidence",
            label: "Protected human-input evidence",
            filterable: true,
            type: "text",
            settings: { max_length: 200 },
          },
          {
            ...fieldBase,
            id: "fld_iam_review_comments",
            key: "comments",
            label: "Comments",
            personal_data: "personal",
            type: "long_text",
            settings: { max_length: 2000 },
          },
        ],
        relationships: [
          {
            id: "rel_iam_review_request",
            key: "request",
            from_field: "request",
            to_record_type: "vortex.iam.core:access_request",
            cardinality: "many_to_one",
            on_parent_delete: "refuse",
          },
        ],
      },
      {
        id: "rt_iam_access_review_response",
        key: "access_review_response",
        name: "Access review response",
        plural_name: "Access review responses",
        title_field: "outcome",
        storage_contract_id: "srt_iam_access_review_response",
        storage_scope: "organisation_shared",
        ownership_mode: "none",
        standard_actions: [...standardActions],
        custom_actions: [],
        fields: [
          {
            ...fieldBase,
            id: "fld_iam_response_review",
            key: "review",
            label: "Review",
            required: true,
            filterable: true,
            type: "link",
            settings: {
              target: "vortex.iam.core:access_review",
              reverse_key: "responses",
              on_parent_delete: "soft_delete_dependent",
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_response_responder",
            key: "responder",
            label: "Responder",
            required: true,
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
            id: "fld_iam_response_outcome",
            key: "outcome",
            label: "Outcome",
            required: true,
            filterable: true,
            type: "choice",
            settings: {
              options: [
                { value: "approved", label: "Approved" },
                { value: "refused", label: "Refused" },
                { value: "commented", label: "Commented" },
              ],
            },
          },
          {
            ...fieldBase,
            id: "fld_iam_response_comment",
            key: "comment",
            label: "Comment",
            personal_data: "personal",
            type: "long_text",
            settings: { max_length: 2000 },
          },
          {
            ...fieldBase,
            id: "fld_iam_response_responded",
            key: "responded_at",
            label: "Responded at",
            required: true,
            filterable: true,
            sortable: true,
            type: "date_time",
            settings: {},
          },
        ],
        relationships: [
          {
            id: "rel_iam_response_review",
            key: "review",
            from_field: "review",
            to_record_type: "vortex.iam.core:access_review",
            cardinality: "many_to_one",
            on_parent_delete: "soft_delete_dependent",
          },
        ],
      },
    ],
    permissions,
    actions: [],
    events: [],
    rules: [],
    extension_points: [],
    sharing_conditions: [
      {
        id: "condition_iam_assigned_review",
        source_record_type: "access_review",
        key: "assigned_reviewer",
        parameters: [{ key: "current_account", type: "organization_account_reference" }],
        condition: { field: "reviewer", operator: "equals", parameter: "current_account" },
        declared_fields: ["reviewer"],
        publication_tests: [
          {
            name: "Assigned reviewer may see review",
            parameters: { current_account: "11111111-1111-4111-8111-111111111111" },
            field_values: {
              reviewer: { organization_account_id: "11111111-1111-4111-8111-111111111111" },
            },
            expected: true,
          },
          {
            name: "Other reviewer cannot see review",
            parameters: { current_account: "22222222-2222-4222-8222-222222222222" },
            field_values: {
              reviewer: { organization_account_id: "11111111-1111-4111-8111-111111111111" },
            },
            expected: false,
          },
        ],
      },
    ],
  },
});
