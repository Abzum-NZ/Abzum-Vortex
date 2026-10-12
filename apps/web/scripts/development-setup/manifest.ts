import {
  actorIdSchema,
  administrationDuplicateKeySchema,
  clusterIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
} from "@vortex/contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The configured development setup manifest. It is the only place the setup names what it
 * provisions: the disposable organisation, the applications it installs and the fixed development
 * identities that make an exact re-run replay instead of repeating.
 *
 * Nothing here is authority. The nominated account arrives from the command line (never from a
 * browser), every write goes through the protected entry points, and the database decides each
 * one. The identifiers are development-only constants for a disposable local database; they are
 * not credentials.
 */

/**
 * The shipped applications of `@vortex/modules` the setup can install, by definition key. Anything
 * else is refused before any write.
 */
const shippedApplicationKeys = [
  "vortex.app.iam",
  "vortex.app.organisation_administration",
  "vortex.app.tenant_administration",
  "vortex.app.operations",
  "vortex.app.crm",
  "vortex.app.hr",
  "vortex.app.tasks",
  "vortex.app.service_desk",
  "vortex.app.landing_zone",
] as const;

export const developmentSetupManifestSchema = z
  .object({
    manifestVersion: z.literal("1.0.0"),
    /** The trusted configured operator that provisions the tenant (the #605 receipt actor). */
    operator: z.object({ clusterId: clusterIdSchema, systemActorId: actorIdSchema }).strict(),
    /** The system actor that authors and publishes the shipped definitions. */
    definitionActorId: actorIdSchema,
    provisioning: z
      .object({
        duplicateKey: administrationDuplicateKeySchema,
        tenant: z.object({ shortName: z.string(), displayName: z.string() }).strict(),
        rootOrganization: z.object({ shortName: z.string(), displayName: z.string() }).strict(),
        accountDisplayName: z.string(),
        language: z.string(),
        timeZone: z.string(),
        currency: z.string(),
      })
      .strict(),
    applicationKeys: z.array(z.enum(shippedApplicationKeys)).min(1),
    /**
     * The custom role the steward creates and assigns to themselves so they can install
     * applications (a provisioned steward holds no application-installation permission).
     */
    installerRole: z
      .object({
        roleKey: z.string(),
        roleId: roleIdSchema,
        roleAssignmentId: roleAssignmentIdSchema,
      })
      .strict(),
    definitionRole: z
      .object({
        roleKey: z.string(),
        roleId: roleIdSchema,
        roleAssignmentId: roleAssignmentIdSchema,
      })
      .strict(),
  })
  .strict();

export type DevelopmentSetupManifest = z.infer<typeof developmentSetupManifestSchema>;

const setupUuidNamespace = Buffer.from("6d1f0c523b7a4c4e8a510e1a7b0c9d00", "hex");

const setupUuid = (name: string): string => {
  const digest = createHash("sha1").update(setupUuidNamespace).update(name).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const developmentSetupManifestFor = (
  tenantShortName = "abzum",
  organizationShortName = tenantShortName,
): DevelopmentSetupManifest => {
  const targetKey = `${tenantShortName}/${organizationShortName}`;
  const defaultOrganization = tenantShortName === "abzum" && organizationShortName === "abzum";
  return developmentSetupManifestSchema.parse({
    manifestVersion: "1.0.0",
    operator: {
      clusterId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d01",
      systemActorId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d02",
    },
    definitionActorId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d03",
    provisioning: {
      duplicateKey: defaultOrganization
        ? "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d04"
        : setupUuid(`${targetKey}/provision`),
      tenant: {
        shortName: tenantShortName,
        displayName: tenantShortName === "abzum" ? "Abzum Development" : `${tenantShortName} Demo`,
      },
      rootOrganization: {
        shortName: organizationShortName,
        displayName:
          organizationShortName === "abzum" ? "Abzum Development" : `${organizationShortName} Demo`,
      },
      accountDisplayName: "First owner",
      language: "en-NZ",
      timeZone: "Pacific/Auckland",
      currency: "NZD",
    },
    // Install every shipped application. Local setup accepts and assigns its registered roles to
    // the nominated first owner through protected Access administration operations.
    applicationKeys: [
      "vortex.app.iam",
      "vortex.app.organisation_administration",
      "vortex.app.tenant_administration",
      "vortex.app.crm",
      "vortex.app.service_desk",
      "vortex.app.operations",
      "vortex.app.landing_zone",
    ],
    installerRole: {
      roleKey: "application_installer",
      roleId: defaultOrganization
        ? "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d08"
        : setupUuid(`${targetKey}/installer-role`),
      roleAssignmentId: defaultOrganization
        ? "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d09"
        : setupUuid(`${targetKey}/installer-assignment`),
    },
    definitionRole: {
      roleKey: "definition_author_publisher",
      roleId: defaultOrganization
        ? "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d0a"
        : setupUuid(`${targetKey}/definition-role`),
      roleAssignmentId: defaultOrganization
        ? "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d0b"
        : setupUuid(`${targetKey}/definition-assignment`),
    },
  });
};
