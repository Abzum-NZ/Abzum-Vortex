import type { StoredDefinitionSource } from "@vortex/platform/schema";
import { crmApplication, crmModuleSources } from "./crm";
import { hrApplication, hrModuleSources } from "./hr";
import { iamApplication, iamModule } from "./iam";
import { landingZoneApplication, landingZoneModuleSources } from "./landing-zone";
import { messagesPreferenceModule } from "./messages-preferences";
import { operationsApplication, operationsModuleSources } from "./operations";
import {
  organisationAdministrationApplication,
  organisationAdministrationModule,
} from "./organisation-administration";
import { serviceDeskApplication, serviceDeskModuleSources } from "./service-desk";
import { systemDirectoryModule } from "./system-directory";
import { tasksApplication, tasksModule } from "./tasks";
import { tenantAdministrationApplication, tenantAdministrationModule } from "./tenant-administration";

/** Every Module source shipped with the platform, including Modules no Application binds. */
export const shippedModuleSources = [
  iamModule,
  tenantAdministrationModule,
  organisationAdministrationModule,
  systemDirectoryModule,
  ...landingZoneModuleSources,
  messagesPreferenceModule,
  ...crmModuleSources,
  ...serviceDeskModuleSources,
  ...operationsModuleSources,
  ...hrModuleSources,
  tasksModule,
] as readonly StoredDefinitionSource[];

/** Every Application source shipped with the platform and the origin its root is created with. */
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
  { source: crmApplication, applicationOriginKind: "ordinary" },
  { source: hrApplication, applicationOriginKind: "ordinary" },
  { source: tasksApplication, applicationOriginKind: "ordinary" },
  { source: serviceDeskApplication, applicationOriginKind: "ordinary" },
  { source: landingZoneApplication, applicationOriginKind: "platform_system_application" },
];
