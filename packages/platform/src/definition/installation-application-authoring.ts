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
import { asRecord, describeFailure } from "../catalogue/runtime-primitives";
import type { ApplicationSourceDocument } from "./application-source-contracts";
import {
  countSourceChange,
  describeSourceChange,
  summarizeSourceChange,
} from "./source-change-summary";
import {
  flowRefusalFeedbackSentences,
  type FlowRefusalFeedback,
} from "../workflows/flow-refusal-feedback";
import { minimumApplicationSource } from "./application-authoring/new-application-source";
import { readApplicationDefinitionDraft } from "./definition-draft-read";
import { definitionPublicationConfirmationSchema } from "./definition-store-contracts";
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

const refuse = (
  code: FlowRefusalFeedback["code"],
  ruleRefusal?: NonNullable<FlowRefusalFeedback["ruleRefusal"]>,
): ApplicationAuthoringResult => ({
  kind: "confirmed_failure",
  outcome: "refused",
  diagnostic: ruleRefusal === undefined ? { code } : { code, ruleRefusal },
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

/**
 * One mapping from a publication that cannot go ahead to its refusal: the review step shows its
 * sentence and the publish step returns its code, so one cause reads the same at both. A refusal
 * the compiler worded carries that sentence. The cause is already in the server log.
 */
const publicationProblem = (
  failure: Exclude<
    HumanDefinitionPublicationPreparationResult | HumanDefinitionPublicationResult,
    { kind: "available" }
  >,
): Readonly<{
  status: "no_change" | "blocked";
  code: FlowRefusalFeedback["code"];
  sentence: string;
  authored: boolean;
}> => {
  const known = (status: "no_change" | "blocked", code: FlowRefusalFeedback["code"]) => ({
    status,
    code,
    sentence: flowRefusalFeedbackSentences[code],
    authored: false,
  });
  if (failure.kind === "no_change") return known("no_change", "application_publication_no_change");
  if (failure.kind === "dependency_unavailable")
    return known("blocked", "application_publication_dependency");
  if (failure.reason === "release_permission_missing")
    return known("blocked", "application_publication_permission");
  if (failure.sentence !== undefined)
    return {
      status: "blocked",
      code: "application_publication_blocked",
      sentence: failure.sentence,
      authored: true,
    };
  return known("blocked", "application_publication_blocked");
};

/** The sentence for a publication that cannot go ahead; the cause is already in the server log. */
const problemOf = (
  failure: Exclude<HumanDefinitionPublicationPreparationResult, { kind: "available" }>,
): { status: "no_change" | "blocked"; problem: string } => {
  if (failure.reason === "recent_authentication_required")
    return {
      status: "blocked",
      problem:
        "To protect your organisation, publishing needs a sign-in within the last 15 minutes.",
    };
  if (failure.kind === "conflict")
    return {
      status: "blocked",
      problem: "The draft changed while it was being checked. Open the application and try again.",
    };
  if (failure.kind === "temporarily_unavailable")
    return {
      status: "blocked",
      problem: "The draft could not be checked right now. Try again shortly.",
    };
  const { status, sentence } = publicationProblem(failure);
  return { status, problem: sentence };
};

/** The one published version `read_application_release_history_page` returns for a page of one at the anchor. */
const publishedSourcePageSchema = z
  .object({
    entries: z.array(z.object({ authoredSource: z.unknown() }).passthrough()).max(1),
  })
  .passthrough();

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
        // What the draft changes against the published version, counted as the version history
        // counts it (undefined for a first release or when nothing changed).
        let changeSentence: string | undefined;
        const read = await environment.requests.runChange(
          session,
          { organizationId },
          async (transaction, scope) => {
            const draft = await readApplicationDefinitionDraft(transaction, scope, {
              rootId: parsed.data.application_root_id,
            });
            draftRevision = draft.draftRevision;
            applicationName = draft.source.kind === "application" ? draft.source.body.name : "";
            const published = draft.publishedRevision;
            if (published !== undefined && draft.source.kind === "application") {
              // The published version is the page of one that ends at the anchor.
              const rows = await transaction.query`
                select vortex_definition.read_application_release_history_page(
                  ${String(draft.rootId)}::uuid, ${published}::bigint, ${published + 1}::bigint,
                  'older'::text, 1::integer
                ) as release_page
              `;
              const page = publishedSourcePageSchema.safeParse(
                (rows[0] as { release_page?: unknown } | undefined)?.release_page,
              );
              const before = page.success ? page.data.entries[0]?.authoredSource : undefined;
              if (before === undefined || asRecord(asRecord(before)?.body) === undefined)
                console.error("[studio] publication review could not read the published source");
              else
                changeSentence = describeSourceChange(
                  countSourceChange(
                    summarizeSourceChange(before as ApplicationSourceDocument, draft.source),
                  ),
                );
            }
            return true;
          },
        );
        if (read.kind !== "available") return { kind: "unavailable" };
        const prepared = await publisher.prepare(session, organizationId, {
          rootId: parsed.data.application_root_id,
          expectedDraftRevision: draftRevision,
        });
        // The same up-front step-up the install review asks for: the dialog asks to sign in again.
        if (prepared.kind === "refused" && prepared.reason === "recent_authentication_required")
          return { kind: "unavailable", code: "recent_authentication_required" };
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
        const { confirmation, addedFields } = prepared.preparation;
        const lines = [
          `Publishes version ${confirmation.assignedVersion}.`,
          ...(changeSentence === undefined ? [] : [changeSentence]),
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
      // The confirmation the review handed out must be for the application being published.
      const confirmation = definitionPublicationConfirmationSchema.safeParse(parsed.data.expected);
      if (
        !confirmation.success ||
        String(confirmation.data.rootId).toLowerCase() !==
          String(parsed.data.application_root_id).toLowerCase()
      )
        return refuse("application_input_invalid");
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
      if (published.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
      if (published.reason === "recent_authentication_required")
        return { kind: "unavailable", code: "recent_authentication_required" };
      const problem = publicationProblem(published);
      return problem.authored
        ? // Only an invalid-command refusal carries a rule's own sentence to the person.
          refuse("invalid_command", {
            code: "publication_refused",
            message: problem.sentence.slice(0, 300),
          })
        : refuse(problem.code);
    },
  };
};
