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
] as const;
export const protectedReadModelKeySchema = z.enum(protectedReadModelKeys);
