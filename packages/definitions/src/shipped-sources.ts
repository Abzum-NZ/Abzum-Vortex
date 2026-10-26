import type { StoredDefinitionSource } from "@vortex/platform/schema";
import { appStoreApplication } from "./app-store";
import { iamApplication } from "./iam";
import { landingZoneApplication } from "./landing-zone";
import { operationsApplication } from "./operations";
import { organisationAdministrationApplication } from "./organisation-administration";
import { tenantAdministrationApplication } from "./tenant-administration";

/**
 * Every Application source shipped with the platform and the origin its root is created with. Each
 * Application carries the Modules it owns: Organisation Administration owns System Directory, and
 * each platform system Application owns its own system Module. The App Store is a platform system
 * Application: it installs and upgrades the organisation's other Applications.
 */
export const shippedApplications: readonly Readonly<{
  source: Extract<StoredDefinitionSource, { kind: "application" }>;
  applicationOriginKind: "platform_system_application" | "ordinary";
}>[] = [
  { source: iamApplication, applicationOriginKind: "platform_system_application" },
  { source: tenantAdministrationApplication, applicationOriginKind: "platform_system_application" },
  {
    source: organisationAdministrationApplication,
    applicationOriginKind: "platform_system_application",
  },
  { source: operationsApplication, applicationOriginKind: "ordinary" },
  { source: landingZoneApplication, applicationOriginKind: "platform_system_application" },
  { source: appStoreApplication, applicationOriginKind: "platform_system_application" },
];
