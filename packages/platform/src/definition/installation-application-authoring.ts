import "server-only";

import { z } from "zod";
import {
  createHumanApplicationDraftWriter,
  type HumanApplicationDraftWriteResult,
} from "../access/definition-draft-write";
import {
  createHumanDefinitionPublisher,
  type HumanDefinitionPublicationPreparationResult,
  type HumanDefinitionPublicationResult,
} from "../access/definition-publication";
import type { HumanOrganizationRequestResult } from "../access/human-organization-request";
import type { createHumanOrganizationRequestService } from "../access/human-organization-request";
import type { IdentitySession, OrganizationSelectionCandidate } from "../access/identity-access";
import type { PlatformPermissionSource } from "../access/platform-permissions";
import type { JsonValue } from "../catalogue/common";
import { applicationRootIdSchema, organizationIdSchema } from "../catalogue/identifiers";
import { describeFailure } from "../catalogue/runtime-primitives";
import type { FlowRefusalFeedback } from "../workflows/flow-refusal-feedback";
import { minimumApplicationSource } from "./application-authoring/new-application-source";
import { readApplicationDefinitionDraft } from "./definition-draft-read";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "./publication/read";

type Outputs = Readonly<Record<string, JsonValue>>;

/** What a journey answers the protected operation executor with. */
export type ApplicationAuthoringResult =
  | HumanOrganizationRequestResult<Outputs>
  | "conflict"
  | Readonly<{
      kind: "confirmed_failure";
      outcome: "refused" | "conflict";
      diagnostic: FlowRefusalFeedback;
    }>;

export type ApplicationAuthoringEnvironment = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
  permissions: PlatformPermissionSource;
}>;

const refuse = (code: FlowRefusalFeedback["code"]): ApplicationAuthoringResult => ({
  kind: "confirmed_failure",
  outcome: "refused",
  diagnostic: { code },
});

const organizationOf = (selection: OrganizationSelectionCandidate) =>
  organizationIdSchema.parse(selection.organizationId);

const createInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1000),
    key: z.string().trim().max(100).optional(),
  })
  .strict();

/** The draft writer's refusal as the sentence the person is shown; the cause was logged there. */
const draftFailure = (result: HumanApplicationDraftWriteResult): ApplicationAuthoringResult => {
  if (result.kind === "conflict")
    return result.reason === "key_exists" || result.reason === "alias_conflict"
      ? refuse("application_key_in_use")
      : "conflict";
  if (result.kind === "refused")
    return result.reason === "permission_missing"
      ? refuse("definition_drafts_manage_required")
      : refuse("application_input_invalid");
  return { kind: "temporarily_unavailable" };
};

/** The sentence for a publication that cannot go ahead; the cause is already in the server log. */
const problemOf = (
  failure: Exclude<HumanDefinitionPublicationPreparationResult, { kind: "available" }>,
): { status: "no_change" | "blocked"; problem: string } => {
  if (failure.kind === "no_change")
    return {
      status: "no_change",
      problem: "Nothing has changed since the last version, so there is nothing to publish.",
    };
  if (failure.reason === "release_permission_missing")
    return {
      status: "blocked",
      problem: "You need permission to publish versions of applications.",
    };
  if (failure.reason === "recent_authentication_required")
    return {
      status: "blocked",
      problem:
        "To protect your organisation, publishing needs a sign-in within the last 15 minutes.",
    };
  if (failure.kind === "dependency_unavailable")
    return {
      status: "blocked",
      problem:
        "A module or platform part this application uses is not available, so it cannot be published yet.",
    };
  if (failure.sentence !== undefined) return { status: "blocked", problem: failure.sentence };
  if (failure.kind === "conflict")
    return {
      status: "blocked",
      problem: "The draft changed while it was being checked. Open the application and try again.",
    };
  return {
    status: "blocked",
    problem:
      failure.kind === "refused"
        ? "The draft has a problem that blocks publishing. Open it in Studio, check its pages and flows, and try again."
        : "The draft could not be checked right now. Try again shortly.",
  };
};

const reviewInputSchema = z.object({ application_root_id: applicationRootIdSchema }).strict();

const publishInputSchema = z
  .object({
    application_root_id: applicationRootIdSchema,
    expected: z.unknown(),
    release_note: z.string().trim().min(1).max(2000),
  })
  .strict();

/**
 * Creating an application and publishing a version of it, as registered operations a flow calls:
 * Studio's App Store runs both, and so does the agent. Each resolves the person's own scope and
 * authority; nothing else decides or bypasses them.
 */
export const createApplicationAuthoringService = (environment: ApplicationAuthoringEnvironment) => {
  const publisher = createHumanDefinitionPublisher({
    requests: environment.requests,
    catalogue: environment.catalogue,
  });
  const writer = createHumanApplicationDraftWriter({
    requests: environment.requests,
    permissions: environment.permissions,
  });
  return {
    create: async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      inputs: Readonly<Record<string, unknown>>,
    ): Promise<ApplicationAuthoringResult> => {
      const parsed = createInputSchema.safeParse({
        name: inputs.name,
        description: inputs.description,
        ...(typeof inputs.key === "string" && inputs.key.trim() !== "" ? { key: inputs.key } : {}),
      });
      if (!parsed.success) return refuse("application_input_invalid");
      const built = minimumApplicationSource({
        name: parsed.data.name,
        description: parsed.data.description,
        key: parsed.data.key ?? "",
      });
      if (built.kind !== "valid") return refuse("application_input_invalid");
      try {
        const written = await writer.createRoot(session, organizationOf(selection), {
          source: built.source,
        });
        if (written.kind !== "available") return draftFailure(written);
        return {
          kind: "available",
          value: {
            application_name: parsed.data.name,
            application_root_id: String(written.draft.rootId),
          },
        };
      } catch (error) {
        console.error(`[studio] application creation failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
    },
    /** What publishing the saved draft would do: its next version, a prefilled note, or why it cannot. */
    reviewPublication: async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      inputs: Readonly<Record<string, unknown>>,
    ): Promise<ApplicationAuthoringResult> => {
      const parsed = reviewInputSchema.safeParse(inputs);
      if (!parsed.success) return { kind: "unavailable" };
      const organizationId = organizationOf(selection);
      try {
        let draftRevision = 0;
        let applicationName = "";
        const read = await environment.requests.runChange(
          session,
          { organizationId },
          async (transaction, scope) => {
            const draft = await readApplicationDefinitionDraft(transaction, scope, {
              rootId: parsed.data.application_root_id,
            });
            draftRevision = draft.draftRevision;
            applicationName = draft.source.kind === "application" ? draft.source.body.name : "";
            return true;
          },
        );
        if (read.kind !== "available") return { kind: "unavailable" };
        const prepared = await publisher.prepare(session, organizationId, {
          rootId: parsed.data.application_root_id,
          expectedDraftRevision: draftRevision,
        });
        if (prepared.kind !== "available") {
          const { status, problem } = problemOf(prepared);
          return {
            kind: "available",
            value: {
              status,
              problem,
              application_name: applicationName,
              release_version: "",
              release_note: "",
              summary_lines: [],
              expected: {},
            },
          };
        }
        const { confirmation, componentLabels, addedFields } = prepared.preparation;
        const lines = [
          `Publishes version ${confirmation.assignedVersion}.`,
          ...(componentLabels.length === 0
            ? []
            : [`${componentLabels.length} changed parts of the application`]),
          ...(addedFields.length === 0
            ? []
            : [`${addedFields.length} new fields: ${addedFields.slice(0, 5).join(", ")}`]),
        ];
        return {
          kind: "available",
          value: {
            status: "ready",
            problem: "",
            application_name: applicationName,
            release_version: confirmation.assignedVersion,
            release_note: confirmation.assignedVersion === "1.0.0" ? "First release" : "",
            summary_lines: lines,
            expected: JSON.parse(JSON.stringify(confirmation)) as JsonValue,
          },
        };
      } catch (error) {
        console.error(`[studio] publication review failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
    },
    publish: async (
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      inputs: Readonly<Record<string, unknown>>,
    ): Promise<ApplicationAuthoringResult> => {
      const parsed = publishInputSchema.safeParse(inputs);
      if (!parsed.success) return refuse("application_input_invalid");
      let published: HumanDefinitionPublicationResult;
      try {
        published = await publisher.publish(session, organizationOf(selection), {
          confirmation: parsed.data.expected,
          releaseNote: parsed.data.release_note,
        });
      } catch (error) {
        console.error(`[studio] publication failed: ${describeFailure(error)}`);
        return { kind: "temporarily_unavailable" };
      }
      if (published.kind === "available")
        return {
          kind: "available",
          value: {
            release_version: published.publication.releaseVersion,
            application_root_id: String(published.publication.rootId),
          },
        };
      if (published.kind === "conflict") return "conflict";
      if (published.kind === "no_change") return refuse("application_publication_no_change");
      if (published.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      if (published.reason === "recent_authentication_required")
        return { kind: "unavailable", code: "recent_authentication_required" };
      return refuse("application_publication_blocked");
    },
  };
};
