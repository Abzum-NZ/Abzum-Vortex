import { z } from "zod";

/**
 * The internal destinations an application surface may offer from a definition. A target names
 * only where a link leads; the server decides, per person and per application, whether the link is
 * offered at all, and every destination re-checks its own access when it opens.
 *
 * - `open_application`: the application's own home page, for a person who may open it.
 * - `studio_editor`: the Studio editor for that application, for a person who may change its drafts.
 * - `studio_new_application`: Studio's new-application flow, for a person who may change drafts.
 * - `app_store_upgrade`: the App Store's page for that application, which offers its Install or
 *   upgrade dialog, for a person who may install and whose organisation runs an older version.
 */
export const applicationLinkTargets = [
  "open_application",
  "studio_editor",
  "studio_new_application",
  "app_store_upgrade",
] as const;
export const applicationLinkTargetSchema = z.enum(applicationLinkTargets);
export type ApplicationLinkTarget = z.infer<typeof applicationLinkTargetSchema>;

/** What a row action needs of the application its row is about, beyond the link it declares. */
export const applicationActionCapabilities = ["install_application", "remove_application"] as const;
export const applicationActionCapabilitySchema = z.enum(applicationActionCapabilities);
export type ApplicationActionCapability = z.infer<typeof applicationActionCapabilitySchema>;

/**
 * Who a placement is offered to. The page read drops a placement declared for builders or
 * installers unless the one application-surface decision allows that audience, so a definition
 * names its audience and no component decides who sees what.
 */
export const applicationAudienceValues = ["builders", "installers"] as const;
export const applicationAudienceSchema = z.enum(applicationAudienceValues);
export type ApplicationAudience = z.infer<typeof applicationAudienceSchema>;

/**
 * The application facts a link is resolved for: its stable root identity, its key as the address
 * names it, the status the shared read reports, and whether the platform supplies it.
 */
export const applicationLinkRowSchema = z
  .object({
    applicationRootId: z.string().min(1),
    key: z.string().min(1),
    status: z.string().nullable(),
    isSystemApplication: z.boolean(),
  })
  .strict()
  .readonly();
export type ApplicationLinkRow = z.infer<typeof applicationLinkRowSchema>;
