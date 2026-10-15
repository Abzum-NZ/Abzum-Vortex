import { z } from "zod";

/**
 * Closed, platform-declared protected read models that a module's protected view may name.
 */
export const protectedReadModelKeys = [
  "people",
  "organization_accounts",
  "roles",
  "permissions",
  "groups",
  "effective_assignments",
  "role_activations",
  "delegations",
  "tenant_structure",
  "organization_invitations",
  "organization_runtime_settings",
  "tenants",
  "tenant_administrators",
  "installed_applications",
  "application_role_templates",
  "activity_entry",
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
  role_activations: [
    "record_id",
    "activated_at",
    "expires_at",
    "state",
    "account_display_name",
    "role_key",
    "role_label",
  ],
  delegations: ["record_id", "scope_kind", "starts_at", "expires_at", "state"],
  organization_invitations: ["record_id", "invited_email", "expires_at", "state"],
  organization_runtime_settings: ["record_id", "language"],
  activity_entry: ["occurred_at"],
};
