import {
  actorIdSchema,
  administrationDuplicateKeySchema,
  clusterIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
} from "@vortex/contracts";
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
  })
  .strict();

export type DevelopmentSetupManifest = z.infer<typeof developmentSetupManifestSchema>;

export const developmentSetupManifest: DevelopmentSetupManifest =
  developmentSetupManifestSchema.parse({
    manifestVersion: "1.0.0",
    operator: {
      clusterId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d01",
      systemActorId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d02",
    },
    definitionActorId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d03",
    provisioning: {
      duplicateKey: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d04",
      tenant: { shortName: "abzum", displayName: "Abzum Development" },
      rootOrganization: { shortName: "abzum", displayName: "Abzum Development" },
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
      roleId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d08",
      roleAssignmentId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d09",
    },
  });
