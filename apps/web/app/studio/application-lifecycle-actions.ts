"use server";

import {
  applicationRootIdSchema,
  flowRefusalFeedbackSentences,
  logRefusal,
  organizationIdSchema,
} from "@vortex/platform/schema";
import { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { applicationStoreService } from "../_lib/application-store-service";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";
import { mapWebError } from "../_lib/web-error-mapper";
import {
  applicationLifecycleTools,
  type ApplicationLifecycleToolName,
} from "./_lib/application-lifecycle-tools";
import { unavailableMessage } from "./_components/studio-refusal-messages";

const requestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    tool: z.enum(
      Object.keys(applicationLifecycleTools) as [
        ApplicationLifecycleToolName,
        ...ApplicationLifecycleToolName[],
      ],
    ),
    input: z.unknown(),
  })
  .strict();

const journeys = {
  review_application_installation: "review",
  install_application: "install",
  upgrade_application: "upgrade",
  review_application_removal: "reviewRemoval",
  uninstall_application: "remove",
} as const;

const changeRefused =
  "The application change was refused. Its state may have moved on since the review, or your access does not allow it: call the matching review again and pass its expected unchanged; if it is still refused, ask an administrator for permission to manage applications and any roles you accept.";

/**
 * A refusal the catalogue does not name: a state that no longer allows the journey and missing
 * authority look the same here, so each message names both and the next step; the log keeps the cause.
 */
const uncodedRefusals: Readonly<Record<ApplicationLifecycleToolName, string>> = {
  review_application_installation:
    "You cannot review this application with your current access. Ask an administrator for permission to manage applications.",
  review_application_removal:
    "Nothing can be reviewed for removal: the application may not be installed here, or your access does not allow managing applications. Call review_application_installation to see its current state.",
  install_application: changeRefused,
  upgrade_application: changeRefused,
  uninstall_application: changeRefused,
};

/** What a completed journey tells the agent, including which tool confirms a review. */
const completedMessage = (tool: ApplicationLifecycleToolName, change: unknown): string => {
  switch (tool) {
    case "review_application_installation":
      return change === "install"
        ? "This would be a first install. Confirm with install_application, passing expected unchanged and choosing whether to take the member role."
        : change === "upgrade" || change === "roles"
          ? "Confirm with upgrade_application, passing expected unchanged and the role_template_ids to accept."
          : "The latest published release is installed and has no role changes waiting. Nothing to confirm.";
    case "review_application_removal":
      return "Confirm with uninstall_application, passing expected unchanged. Records and storage will remain in place.";
    case "install_application":
      return "The application was installed. Read the report for its release and member role.";
    case "upgrade_application":
      return "The application was upgraded. Read the report for its release and the role changes accepted or still waiting.";
    case "uninstall_application":
      return "The application was uninstalled and its access withdrawn. Records and storage remain in place.";
  }
};

/**
 * Studio's agent uses the catalogue's one protected lifecycle, under the signed-in person's
 * authority and on the web channel like Studio's other agent tools.
 */
export async function runStudioApplicationLifecycle(organizationId: string, candidate: unknown) {
  try {
    const organization = organizationIdSchema.safeParse(organizationId);
    const request = requestSchema.safeParse(candidate);
    if (!organization.success || !request.success)
      return {
        outcome: "invalid_input",
        message: "Choose a valid application and lifecycle request.",
      };
    const { rootId, tool } = request.data;
    const input = applicationLifecycleTools[tool].input.safeParse(request.data.input);
    if (!input.success)
      return {
        outcome: "invalid_input",
        message:
          "Give the inputs this tool declares, including the complete reviewed state for a change.",
      };
    // Studio authority is checked afresh as well as the installation authority the journey checks.
    const draft = await loadStudioApplicationDraft(organization.data, rootId);
    if (draft.kind !== "available")
      return {
        outcome: draft.kind,
        message: unavailableMessage(draft.kind, draft.reason),
      };
    const identity = await resolveIdentitySession();
    if (identity.kind !== "active")
      return { outcome: "refused", message: "Sign in again before managing this application." };
    const result = await applicationStoreService()[journeys[tool]](
      identity.session,
      { organizationId: organization.data },
      { ...input.data, application_root_id: rootId },
    );
    if (result === "conflict")
      return {
        outcome: "conflict",
        message:
          "The application or its roles changed since the review. Review it again before confirming.",
      };
    if (result.kind === "available" && result.value.change === "unavailable")
      return {
        outcome: "unavailable",
        report: result.value,
        message:
          result.value.reason === "not_published"
            ? "Publish a release before installing this application."
            : result.value.reason === "module_set_changed"
              ? "This release changes the application's modules, so it cannot upgrade the current installation."
              : result.value.reason === "installation_incomplete"
                ? "The current installation is incomplete. Ask an administrator to finish it before continuing."
                : result.value.reason === "registration_misaligned"
                  ? "The application's registered access does not match this release. Ask an administrator to review it."
                  : "This application's release cannot be installed or upgraded here. Review its dependencies and installation before continuing.",
      };
    if (result.kind === "available")
      return {
        outcome:
          tool === "install_application"
            ? "installed"
            : tool === "upgrade_application"
              ? "upgraded"
              : tool === "uninstall_application"
                ? "uninstalled"
                : "reviewed",
        report: result.value,
        message: completedMessage(tool, result.value.change),
      };
    const code =
      result.kind === "confirmed_failure"
        ? result.diagnostic.code
        : result.kind === "unavailable"
          ? result.code
          : undefined;
    logRefusal(
      "studio/application-lifecycle-actions",
      tool,
      code ?? result.kind,
      result.kind === "confirmed_failure" ? result.diagnostic : result.cause,
    );
    return {
      outcome: result.kind === "temporarily_unavailable" ? "unavailable" : "refused",
      ...(code === undefined ? {} : { refusalCode: code }),
      message:
        code !== undefined
          ? flowRefusalFeedbackSentences[code]
          : result.kind === "temporarily_unavailable"
            ? "The request did not complete. Review the application's current state before retrying."
            : uncodedRefusals[tool],
    };
  } catch (error) {
    return mapWebError(error, {
      route: "studio/application-lifecycle-actions",
      operation: "application-lifecycle",
      code: "STUDIO_APPLICATION_LIFECYCLE_FAILED",
      fallback: {
        outcome: "unavailable",
        message: "The outcome is unknown. Review the application's current state before retrying.",
      },
    });
  }
}
