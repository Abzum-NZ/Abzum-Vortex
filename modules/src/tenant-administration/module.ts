import {
  moduleSourceDocumentSchema,
  tenantStructuralCapabilityKeys,
  type ModuleSourceDocument,
} from "@vortex/contracts";

// Tenant Administration keeps its local tenant projection; the shared
// organisation and tenant-administrator projections live in System Directory.
// Every projection is read-only and exposes only safe, projected fields. The
// registered readers apply current tenant and viewer authority; tenant lists
// include only active tenants the caller's effective structural administrator
// assignment can already read. Changes remain protected operations and never
// use ordinary record writes.
const tenantAllFields = [
  "organization_id",
  "revision",
  "short_name",
  "display_name",
  "state",
  "state_changed_at",
  "created_at",
];
const tenantStateOptions = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "archived", label: "Archived" },
  { value: "removal_pending", label: "Removal pending" },
] as const;

/**
 * Tenant Administration keeps a local tenant projection; organisation and tenant
 * administrator projections are read from System Directory. Structure changes
 * use protected tenant governance operations, never ordinary record writes.
 */
export const tenantAdministrationModule: ModuleSourceDocument = moduleSourceDocumentSchema.parse({
  source_contract_version: "3.0.0",
  root_alias: "mod_tenant_administration",
  key: "vortex.tenant_administration",
  kind: "module",
  body: {
    name: "Tenant Administration",
    description:
      "Tenant structure and direct protected actions for a tenant administrator.",
    dependencies: [
      {
        dependency_key: "system_directory",
        module: "vortex.system_directory",
        version: { selection: "exact", version: "1.0.0" },
      },
    ],
    record_types: [
      {
        id: "rt_tenant",
        key: "tenant",
        name: "Tenant",
        plural_name: "Tenants",
        title_field: "display_name",
        storage_contract_id: "srt_tenant_admin_tenant",
        storage_scope: "organisation_shared",
        ownership_mode: "none",
        standard_actions: ["read"],
        custom_actions: [],
        system_projection: {
          protected_view: "tenants",
          organization_field: "organization_id",
          revision_field: "revision",
          filterable_fields: ["state"],
          sortable_fields: [
            "short_name",
            "display_name",
            "state",
            "state_changed_at",
            "created_at",
          ],
        },
        fields: [
          {
            id: "fld_tenant_organization_id",
            key: "organization_id",
            label: "Organisation",
            required: true,
            unique: false,
            filterable: false,
            sortable: false,
            personal_data: "none",
            public_display: "refused",
            type: "text",
            settings: { max_length: 36 },
          },
          {
            id: "fld_tenant_revision",
            key: "revision",
            label: "Revision",
            required: true,
            unique: false,
            filterable: false,
            sortable: false,
            personal_data: "none",
            public_display: "refused",
            type: "whole_number",
            settings: {},
          },
          {
            id: "fld_tenant_short_name",
            key: "short_name",
            label: "Short name",
            required: false,
            unique: false,
            filterable: false,
            sortable: true,
            search_priority: "first",
            personal_data: "none",
            public_display: "refused",
            type: "text",
            settings: { max_length: 40 },
          },
          {
            id: "fld_tenant_display_name",
            key: "display_name",
            label: "Display name",
            required: false,
            unique: false,
            filterable: false,
            sortable: true,
            search_priority: "normal",
            personal_data: "none",
            public_display: "refused",
            type: "text",
            settings: { max_length: 120 },
          },
          {
            id: "fld_tenant_state",
            key: "state",
            label: "State",
            required: false,
            unique: false,
            filterable: true,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            type: "choice",
            settings: { options: [...tenantStateOptions] },
          },
          {
            id: "fld_tenant_state_changed_at",
            key: "state_changed_at",
            label: "State changed at",
            required: false,
            unique: false,
            filterable: false,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            type: "date_time",
            settings: { display_time_zone: "organisation" },
          },
          {
            id: "fld_tenant_created_at",
            key: "created_at",
            label: "Created at",
            required: false,
            unique: false,
            filterable: false,
            sortable: true,
            personal_data: "none",
            public_display: "refused",
            type: "date_time",
            settings: { display_time_zone: "organisation" },
          },
        ],
        relationships: [],
      },
    ],
    permissions: [
      {
        id: "perm_tenant_read",
        key: "vortex.tenant_administration.tenant.read",
        label: "Read tenants",
        description: "Allows reading the protected tenant projection as a system record.",
        record_type: "tenant",
        action_kind: "read",
        administrative: false,
        record_scope: { routes: [{ kind: "all_records" }] },
        field_policy: { readable_fields: tenantAllFields, changeable_fields: [] },
      },
    ],
    actions: [],
    events: [],
    flows: [],
    extension_points: [],
    sharing_conditions: [],
    queries: [],
  },
});
