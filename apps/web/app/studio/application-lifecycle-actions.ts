"use server";

import { applicationRootIdSchema, logRefusal, organizationIdSchema } from "@vortex/platform/schema";
import { z } from "zod";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { applicationStoreService } from "../_lib/application-store-service";
import { loadStudioApplicationDraft } from "../_lib/studio-application-draft";
import { mapWebError } from "../_lib/web-error-mapper";
import { applicationLifecycleTools } from "./_lib/application-lifecycle-tools";
import { unavailableMessage } from "./_components/studio-refusal-messages";

const requestSchema = z
  .object({
    rootId: applicationRootIdSchema,
    tool: z.enum(
      Object.keys(applicationLifecycleTools) as [
        keyof typeof applicationLifecycleTools,
        ...Array<keyof typeof applicationLifecycleTools>,
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

/** Studio's agent uses the catalogue's one protected lifecycle, under the signed-in person's authority. */
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
    const result = await applicationStoreService("mcp")[journeys[tool]](
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
        message:
          tool === "uninstall_application"
            ? "The application was uninstalled and its access withdrawn. Records and storage remain in place."
            : tool === "review_application_removal"
              ? "Review the installed version before confirming uninstall. Records and storage will remain in place."
              : "The application request completed. Read the report for its release and role changes.",
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
      message:
        code === "recent_authentication_required"
          ? "Sign in again before managing this application."
          : code === "installation_delegation_required"
            ? "You need authority to assign the application's member role. Decline that role or ask an administrator for delegation."
            : code === "application_storage_incompatible"
              ? "This release cannot use the organisation's current record storage. Choose a compatible release."
              : result.kind === "temporarily_unavailable"
                ? "The request did not complete. Review the application's current state before retrying."
                : "You cannot perform this application change with your current access. Ask an administrator for permission to manage applications and any roles you accept.",
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
