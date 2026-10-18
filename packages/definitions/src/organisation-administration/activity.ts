const fields = [
  { key: "organization_id", label: "Organisation", type: "text", settings: { max_length: 36 } },
  { key: "revision", label: "Revision", type: "whole_number", settings: {} },
  {
    key: "occurred_at",
    label: "Occurred",
    type: "date_time",
    settings: { display_time_zone: "organization" },
  },
  { key: "actor_kind", label: "Actor kind", type: "text", settings: { max_length: 40 } },
  {
    key: "actor",
    label: "Actor",
    type: "link",
    settings: {
      target: "vortex.system_directory:person",
      reverse_key: "activity_entries",
      on_parent_delete: "empty_optional",
      application_root_required: false,
    },
  },
  { key: "action", label: "Action", type: "text", settings: { max_length: 40 } },
  { key: "subject_count", label: "Subjects", type: "whole_number", settings: {} },
  { key: "changed_field_count", label: "Changed fields", type: "whole_number", settings: {} },
] as const;

export const activityRecordType = {
  id: "rt_activity_entry",
  key: "activity_entry",
  name: "Activity entry",
  plural_name: "Activity",
  title_field: "action",
  storage_contract_id: "srt_org_admin_activity_entry",
  storage_scope: "organization_shared",
  ownership_mode: "none",
  standard_actions: ["read"],
  custom_actions: [],
  system_projection: {
    protected_view: "activity_entry",
    organization_field: "organization_id",
    revision_field: "revision",
    filterable_fields: [],
    sortable_fields: ["occurred_at"],
  },
  fields: fields.map((field) => ({
    id: `fld_activity_${field.key}`,
    key: field.key,
    label: field.label,
    required: !["changed_field_count", "actor"].includes(field.key),
    unique: false,
    filterable: false,
    sortable: field.key === "occurred_at",
    personal_data: field.key === "actor" ? "personal" : "none",
    public_display: "refused",
    type: field.type,
    settings: field.settings,
  })),
  pipelines: [],
  relationships: [
    {
      id: "rel_activity_actor",
      key: "actor",
      from_field: "actor",
      to_record_type: "vortex.system_directory:person",
      cardinality: "many_to_one",
      on_parent_delete: "empty_optional",
    },
  ],
};

export const activityReadPermission = {
  id: "perm_activity_entry_read",
  key: "vortex.organisation_administration.activity_entry.read",
  label: "Read activity",
  description:
    "Read the current person's recent Activity, or the organisation audit view when independently authorised.",
  record_type: "activity_entry",
  action_kind: "read",
  administrative: false,
  record_scope: { routes: [{ kind: "all_records" }] },
  field_policy: {
    readable_fields: fields.map((field) => field.key),
    changeable_fields: [],
  },
};

export const activityQuery = {
  id: "qry_activity_entries",
  key: "activity_entries",
  record_type: "activity_entry",
  inputs: [],
  select: ["occurred_at", "actor_kind", "actor", "action", "subject_count", "changed_field_count"],
  filter: null,
  group_by: [],
  aggregates: [],
  sort: [{ field: "occurred_at", direction: "descending" }],
  page_size: 50,
  relationship_hops: 0,
};
