import tenantAdministration from "./modules/tenant_administration.json";

/**
 * The Modules the Tenant Administration Application owns, authored inside its Application source.
 * The Module keeps its own local tenant projection; the shared organisation and tenant-administrator
 * projections live in System Directory.
 */
export const tenantAdministrationModules: readonly unknown[] = [tenantAdministration];
