import { z } from "zod";
import {
  applicationRootIdSchema,
  builderKeySchema,
  namespacedKeySchema,
  organizationIdSchema,
} from "../catalogue/identifiers";

/*
 * The applications a person may open at an organisation address, as the address resolution
 * reads them, and the launcher's view of that read. The server builds them with these schemas and
 * the launcher parses its read with the same ones.
 */

export const permittedApplicationSchema = z
  .object({
    applicationRootId: applicationRootIdSchema,
    key: namespacedKeySchema,
    name: z.string().trim().min(1).max(120),
    icon: z.string().trim().min(1).max(120),
    homePageKey: builderKeySchema,
    pageKeys: z.array(builderKeySchema).min(1).max(10_000),
    /** The preview of this Application's draft that this address runs, if it is a preview. */
    previewInstallationId: z.uuid().optional(),
  })
  .strict();

/** Launcher links carry no page authority and cannot be used as an addressed projection. */
export const applicationLauncherEntrySchema = permittedApplicationSchema.omit({
  pageKeys: true,
  previewInstallationId: true,
});

export const permittedApplicationsReadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      organizationId: organizationIdSchema,
      tenantShortName: builderKeySchema,
      organizationShortName: builderKeySchema,
      defaultApplicationRootId: applicationRootIdSchema.nullable(),
      /** The viewer's own display name in this organisation; absent when the account has none. */
      accountDisplayName: z.string().trim().min(1).max(120).optional(),
      applications: z.array(permittedApplicationSchema).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("suspended_super_administrator_account") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
  z.object({ kind: z.literal("temporarily_unavailable"), cause: z.string().optional() }).strict(),
]);

export type PermittedApplication = z.infer<typeof permittedApplicationSchema>;
export type PermittedApplicationsRead = z.infer<typeof permittedApplicationsReadSchema>;
export const applicationLauncherReadSchema = z.discriminatedUnion("kind", [
  permittedApplicationsReadSchema.options[0].extend({
    applications: z.array(applicationLauncherEntrySchema).max(10_000),
  }),
  permittedApplicationsReadSchema.options[1],
  permittedApplicationsReadSchema.options[2],
  permittedApplicationsReadSchema.options[3],
]);
export type ApplicationLauncherEntry = z.infer<typeof applicationLauncherEntrySchema>;
export type ApplicationLauncherRead = z.infer<typeof applicationLauncherReadSchema>;
