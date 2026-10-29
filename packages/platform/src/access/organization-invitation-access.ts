import { z } from "zod";
import { revisionSchema, roleIdSchema } from "../catalogue/identifiers";

/** The exact role revision the inviter intended to grant. */
export const organizationInvitationRoleIntentSchema = z
  .object({ roleId: roleIdSchema, roleRevision: revisionSchema })
  .strict();

export const organizationInvitationRoleIntentsSchema = z
  .array(organizationInvitationRoleIntentSchema)
  .superRefine((roles, context) => {
    const ids = roles.map((role) => role.roleId.toLowerCase());
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
      context.addIssue({ code: "custom", message: "Invitation roles must be unique and ordered" });
  });

export type OrganizationInvitationRoleIntent = z.infer<
  typeof organizationInvitationRoleIntentSchema
>;
