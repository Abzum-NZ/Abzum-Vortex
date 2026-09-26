import {
  actorIdSchema,
  administrationDuplicateKeySchema,
  clusterIdSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  correlationIdSchema,
} from "@vortex/contracts";
import { z } from "zod";

/**
 * The configured development setup manifest. It is the only place the setup names what it
 * provisions: the disposable organisation, the applications it installs, the one operating role
 * the nominated first owner receives and the fixed development identities that make an exact
 * re-run replay instead of repeating.
 *
 * Nothing here is authority. The nominated account arrives from the command line (never from a
 * browser), every write goes through the protected entry points, and the database decides each
 * one. The identifiers are development-only constants for a disposable local database; they are
 * not credentials.
 */

/**
 * The applications the setup installs, in installation order, by their definition key. Each must
 * be a shipped application of `@vortex/modules`; anything else is refused before any write.
 */
const installedApplicationKeys = [
  "vortex.app.iam",
  "vortex.app.organisation_administration",
  "vortex.app.tenant_administration",
  "vortex.app.crm",
  "vortex.app.service_desk",
] as const;

export const developmentSetupManifestSchema = z
  .object({
    manifestVersion: z.literal("1.0.0"),
    /** The trusted configured operator that provisions the tenant (the #605 receipt actor). */
    operator: z
      .object({ clusterId: clusterIdSchema, systemActorId: actorIdSchema })
      .strict(),
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
    applicationKeys: z.array(z.enum(installedApplicationKeys)).min(1),
    /**
     * The one application whose operating role the first owner receives through the Access-owned
     * initial operating-role grant, and that role's key. Later access expansion is not this
     * command: the owner grants further roles through the IAM application.
     */
    operatingRole: z
      .object({
        applicationKey: z.enum(installedApplicationKeys),
        roleKey: z.string(),
        /** The identity of the new organisation role and of its one standing assignment. */
        roleId: roleIdSchema,
        roleAssignmentId: roleAssignmentIdSchema,
      })
      .strict(),
    /** The correlation the grant records; reused so an exact retry replays the original result. */
    setupCorrelationId: correlationIdSchema,
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
    applicationKeys: [...installedApplicationKeys],
    operatingRole: {
      applicationKey: "vortex.app.iam",
      roleKey: "iam_administrator",
      roleId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d05",
      roleAssignmentId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d06",
    },
    setupCorrelationId: "6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d07",
  });
