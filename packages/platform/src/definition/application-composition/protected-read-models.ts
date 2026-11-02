import { z } from "zod";

/**
 * Closed, platform-declared protected read models that a module's protected view may name.
 */
const protectedReadModelKeys = [
  "people",
  "organization_accounts",
  "roles",
  "permissions",
  "groups",
  "effective_assignments",
  "delegations",
  "tenant_structure",
  "organization_invitations",
  "organization_runtime_settings",
  "tenants",
  "tenant_administrators",
  "application_role_templates",
  "activity_entry",
  "application_store_entries",
  "connection_instances",
] as const;
export const protectedReadModelKeySchema = z.enum(protectedReadModelKeys);

/** Sort keys accepted by each registered bounded projection reader. */
export const boundedProtectedReadModelSortKeys: Partial<
  Record<(typeof protectedReadModelKeys)[number], readonly string[]>
> = {
  organization_accounts: ["record_id", "display_name", "state"],
  roles: ["record_id", "key", "label", "lifecycle"],
  permissions: ["record_id", "key", "label", "administrative"],
  groups: ["record_id", "key", "label", "state"],
  people: ["record_id", "starts_at", "expires_at", "state", "account_display_name"],
  effective_assignments: [
    "record_id",
    "starts_at",
    "expires_at",
    "state",
    "role_key",
    "role_label",
  ],
  delegations: ["record_id", "scope_kind", "starts_at", "expires_at", "state"],
  organization_invitations: ["record_id", "invited_email", "expires_at", "state"],
  organization_runtime_settings: ["record_id", "language"],
  application_role_templates: ["record_id", "source_role_id", "key", "label"],
  activity_entry: ["occurred_at"],
  application_store_entries: [
    "record_id",
    "key",
    "name",
    "release_revision",
    "status",
    "listing_order",
  ],
  connection_instances: ["record_id", "destination_key", "state"],
};
