import { jsonValueSchema, roleIdSchema } from "@vortex/platform/schema";
import { z } from "zod";

const expected = z
  .record(z.string(), jsonValueSchema)
  .describe("The complete expected object returned by the latest review, unchanged.");

/** The same input contract is advertised to the agent and checked by the server action. */
export const applicationLifecycleTools = {
  review_application_installation: {
    description:
      "Review installing or upgrading this application's latest published release in the current organisation. Returns the release, role changes and expected state to confirm. Changes nothing.",
    input: z.object({}).strict(),
    readOnly: true,
  },
  install_application: {
    description:
      "Install this application's reviewed published release in the current organisation. Pass expected from review_application_installation unchanged and explicitly choose whether to take the member role. Current permissions and reviewed state are checked again.",
    input: z.object({ expected, accept_member_role: z.boolean() }).strict(),
    readOnly: false,
  },
  upgrade_application: {
    description:
      "Upgrade this application to the reviewed release, or accept its pending role changes. Pass expected from review_application_installation unchanged and the role_template_ids to accept from that review; an empty list leaves role changes waiting. Current permissions and reviewed state are checked again.",
    input: z.object({ expected, role_template_ids: z.array(roleIdSchema) }).strict(),
    readOnly: false,
  },
  review_application_removal: {
    description:
      "Review uninstalling this application from the current organisation. Returns its installed version and expected state to confirm. Uninstalling withdraws access and leaves records and storage in place. Changes nothing.",
    input: z.object({}).strict(),
    readOnly: true,
  },
  uninstall_application: {
    description:
      "Uninstall this application from the current organisation, withdrawing its access while retaining records and storage. Pass expected from review_application_removal unchanged. Returns the uninstall report. Current permissions and reviewed state are checked again.",
    input: z.object({ expected }).strict(),
    readOnly: false,
  },
} as const;

export type ApplicationLifecycleToolName = keyof typeof applicationLifecycleTools;
