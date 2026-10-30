import "server-only";

import { z } from "zod";
import type { flowRefusalFeedbackSentences } from "@vortex/platform/schema";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  organizationSelectionCandidateSchema,
  revisionSchema,
  type ApplicationRootId,
  type IdentitySession,
  type OrganizationId,
} from "@vortex/platform/schema";
import {
  createHumanOrganizationRequestService,
  createInstalledContextLoader,
  runFlowTest,
  withResolvedRequestTransaction,
  withRuntimeTransaction,
  type FlowTestRunResult,
} from "@vortex/platform/server";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { applicationStoreService } from "./application-store-service";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { getQueryContinuationKey } from "./query-continuation-key";
import { appTelemetry } from "./server-composition";
import { readStudioPreviewState, studioPreviewRunsDraft } from "./studio-application-preview";
import {
  finishedNotice,
  refusalNotices,
} from "../[tenantShortName]/[organizationShortName]/[applicationKey]/[[...pageAddress]]/_components/application-page-view/notices";

export const studioFlowTestRunRequestSchema = z
  .object({
    organizationId: organizationIdSchema,
    rootId: applicationRootIdSchema,
    draftRevision: revisionSchema,
    flowKey: z.string().min(1).max(200),
    moduleKey: z.string().min(1).max(200).nullable(),
    inputs: z.record(z.string().min(1).max(200), z.unknown()),
  })
  .strict();

type TraceRefusal = Readonly<{ code: string; sentence: string }>;
type TraceStep = Omit<FlowTestRunResult["steps"][number], "refusal"> &
  Readonly<{ refusal?: TraceRefusal }>;

export type StudioFlowTestRunReply =
  | Readonly<{
      kind: "ran";
      steps: readonly TraceStep[];
      end: FlowTestRunResult["end"] & Readonly<{ refusal?: TraceRefusal }>;
      totalMs: number;
    }>
  | Readonly<{ kind: "open_preview_first" | "flow_missing" | "refused" | "conflict" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

/** Thrown with the reply so the one outer transaction ends in a rollback, whatever the flow did. */
class TestRunRolledBack extends Error {
  constructor(readonly reply: StudioFlowTestRunReply) {
    super("STUDIO_FLOW_TEST_RUN_ROLLBACK");
  }
}

/** The sentence a person would be given for this refusal, with its code. */
const refusalOf = (
  refusal: Readonly<{
    outcome: string;
    failureCode?: string;
    diagnostic?: Readonly<{
      code: keyof typeof flowRefusalFeedbackSentences;
      ruleRefusal?: Readonly<{ message: string }>;
      corrections?: readonly Readonly<{ message?: string }>[];
    }>;
    ruleRefusalMessage?: string;
  }>,
): TraceRefusal => {
  const diagnostic = refusal.diagnostic;
  const code = diagnostic?.code ?? refusal.failureCode ?? refusal.outcome;
  const sentence =
    refusal.ruleRefusalMessage ??
    diagnostic?.ruleRefusal?.message ??
    diagnostic?.corrections?.find((correction) => correction.message !== undefined)?.message ??
    (diagnostic === undefined ? undefined : refusalNotices[diagnostic.code]?.text) ??
    finishedNotice(refusal.outcome, refusal.failureCode, undefined).text;
  return { code, sentence };
};

/**
 * Runs a builder's test of one flow in their current preview: the draft's own flow, the preview's
 * real records, the builder's own authority. Everything happens in one transaction that always
 * rolls back, so the reply is the only thing that outlives it.
 */
export const runStudioFlowTest = async (
  session: IdentitySession,
  request: z.infer<typeof studioFlowTestRunRequestSchema>,
): Promise<StudioFlowTestRunReply> => {
  const organizationId: OrganizationId = request.organizationId;
  const rootId: ApplicationRootId = request.rootId;
  const state = await readStudioPreviewState(
    session,
    organizationId,
    rootId,
    request.draftRevision,
  );
  if (state.kind !== "read") {
    if (state.kind === "refused") return { kind: "refused" };
    return state.kind === "conflict" ? { kind: "conflict" } : { kind: "temporarily_unavailable" };
  }
  if (state.preview === undefined || studioPreviewRunsDraft(state.draft, state.preview) !== "ready")
    return { kind: "open_preview_first" };
  const previewInstallationId = state.preview.previewInstallationId;
  const requestDependencies = {
    identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
    channel: "web" as const,
    telemetry: appTelemetry,
  };
  const selection = organizationSelectionCandidateSchema.parse({
    organizationId,
    applicationRootId: rootId,
    previewInstallationId,
  });
  try {
    await withRuntimeTransaction(async (outer) => {
      const requests = createHumanOrganizationRequestService({
        ...requestDependencies,
        resolvedRequestTransaction: (resolve, operation) =>
          withResolvedRequestTransaction(resolve, operation, outer),
      });
      const scoped = await requests.run(
        session,
        selection,
        async (transaction, scope, issuedAt): Promise<StudioFlowTestRunReply> => {
          const context = await createInstalledContextLoader(transaction, scope).load();
          const { application, modules } = context.releaseSet;
          const flows =
            request.moduleKey === null
              ? application.content.flows
              : (modules.find((module) => module.definitionKey === request.moduleKey)?.content
                  .flows ?? []);
          const flow = flows.find((candidate) => candidate.key === request.flowKey);
          if (flow === undefined) return { kind: "flow_missing" };
          const result = await runFlowTest(
            { transaction, session, selection, scope, issuedAt, mode: "shared" },
            context,
            {
              requests: { ...requestDependencies, channel: "web" },
              applicationStore: applicationStoreService(),
              continuationKey: getQueryContinuationKey(),
              permissions: installedReleaseCatalogue.permissions,
            },
            { flowId: String(flow.id), inputs: request.inputs },
          );
          const end =
            result.end.kind === "finished" &&
            result.end.outcome !== "completed" &&
            result.end.outcome !== "committed"
              ? {
                  ...result.end,
                  refusal: refusalOf({
                    outcome: result.end.outcome,
                    ...(result.end.failureCode === undefined
                      ? {}
                      : { failureCode: result.end.failureCode }),
                    ...(result.end.diagnostic === undefined
                      ? {}
                      : { diagnostic: result.end.diagnostic as never }),
                    ...(result.end.ruleRefusalMessage === undefined
                      ? {}
                      : { ruleRefusalMessage: result.end.ruleRefusalMessage }),
                  }),
                }
              : result.end;
          return {
            kind: "ran",
            end,
            totalMs: result.totalMs,
            steps: result.steps.map(({ refusal, ...step }) => ({
              ...step,
              ...(refusal === undefined ? {} : { refusal: refusalOf(refusal as never) }),
            })),
          };
        },
      );
      throw new TestRunRolledBack(
        scoped.kind === "available"
          ? scoped.value
          : scoped.kind === "temporarily_unavailable"
            ? { kind: "temporarily_unavailable" }
            : { kind: "refused" },
      );
    });
  } catch (error) {
    if (error instanceof TestRunRolledBack) return error.reply;
    console.error("[studio] flow test run failed", error);
    return { kind: "temporarily_unavailable" };
  }
  throw new Error("STUDIO_FLOW_TEST_RUN_NOT_ROLLED_BACK");
};
