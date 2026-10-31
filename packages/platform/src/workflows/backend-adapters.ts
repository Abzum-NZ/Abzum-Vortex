import "server-only";

import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { withRuntimeTransaction } from "../db/request-transaction";

/**
 * The back-end adapter: the one place a flow run is handed to "the back end". It is simulated
 * in-process (the same interpreter and task runner on the server, under the acting organisation
 * account's authority, in its own transactions), so a flow keeps its meaning when a real back end
 * replaces it. Both a Run on back end child and an after-save subscriber enter here, keyed once per
 * origin, source and flow, so a retried click or a re-delivered occurrence never runs twice.
 */

type BackendRunMode = "await" | "start";
type BackendRunOrigin = "backend_run" | "event";
type BackendRunState = "pending" | "running" | "succeeded" | "refused" | "failed";

export type BackendRunRequest = Readonly<{
  organizationId: string;
  applicationRootId: string;
  actorId: string;
  flowId: string;
  origin: BackendRunOrigin;
  /** The caller's command id and task id, or the occurrence id: what makes the request once-only. */
  sourceKey: string;
  mode: BackendRunMode;
  inputs: Readonly<Record<string, JsonValue>>;
}>;

/** An occurrence that ran nothing because its account could not act; no flow is named. */
type BackendRunRefusal = Readonly<{
  organizationId: string;
  applicationRootId: string;
  actorId: string;
  origin: BackendRunOrigin;
  sourceKey: string;
  failureCode: string;
}>;

/** A run an executor has claimed and must now run to a final state. */
export type ClaimedBackendRun = Readonly<{
  backendRunId: string;
  organizationId: string;
  applicationRootId: string;
  flowId: string;
  actorId: string;
  origin: BackendRunOrigin;
  sourceKey: string;
  inputs: Readonly<Record<string, JsonValue>>;
}>;

export type BackendRunOutcome = Readonly<{
  state: "succeeded" | "refused" | "failed";
  outputs?: Readonly<Record<string, JsonValue>>;
  /** A stable code that names why the run was refused or failed; never customer data. */
  failureCode?: string;
}>;

export type BackendRunResult =
  | Readonly<{ kind: "finished"; backendRunId: string; outputs: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ kind: "started"; backendRunId: string }>
  | Readonly<{ kind: "not_finished"; backendRunId: string; state: "refused" | "failed"; failureCode: string }>
  | Readonly<{ kind: "unavailable" }>;

const requestedSchema = z
  .object({
    backendRunId: z.uuid(),
    state: z.enum(["pending", "running", "succeeded", "refused", "failed"]),
    outputs: z.record(z.string(), jsonValueSchema).nullable(),
    failureCode: z.string().nullable(),
  })
  .strict();
const claimedSchema = z
  .object({
    backendRunId: z.uuid(),
    organizationId: z.uuid(),
    applicationRootId: z.uuid(),
    flowId: z.uuid(),
    actorId: z.uuid(),
    originKind: z.enum(["backend_run", "event"]),
    sourceKey: z.string(),
    inputs: z.record(z.string(), jsonValueSchema),
  })
  .strict();
const resultRow = z.object({ result: z.unknown() });

const requestRun = async (request: BackendRunRequest) => {
  const rows = await withRuntimeTransaction(
    (transaction) => transaction.query`
      select vortex_platform.request_backend_run(
        ${request.organizationId}::uuid, ${request.applicationRootId}::uuid,
        ${request.flowId}::uuid, ${request.actorId}::uuid, ${request.origin}::text,
        ${request.sourceKey}::text, ${request.mode}::text,
        ${JSON.stringify(request.inputs)}::text::jsonb
      ) as result
    `,
  );
  if (rows.length !== 1) throw new Error("BACKEND_RUN_REQUEST_INVALID");
  return requestedSchema.parse(resultRow.parse(rows[0]).result);
};

const claimRun = async (backendRunId: string): Promise<ClaimedBackendRun | undefined> => {
  const rows = await withRuntimeTransaction(
    (transaction) => transaction.query`
      select vortex_platform.claim_backend_run(${backendRunId}::uuid) as result
    `,
  );
  if (rows.length !== 1) throw new Error("BACKEND_RUN_CLAIM_INVALID");
  const result = resultRow.parse(rows[0]).result;
  if (result === null) return undefined;
  const claimed = claimedSchema.parse(result);
  return {
    backendRunId: claimed.backendRunId,
    organizationId: claimed.organizationId,
    applicationRootId: claimed.applicationRootId,
    flowId: claimed.flowId,
    actorId: claimed.actorId,
    origin: claimed.originKind,
    sourceKey: claimed.sourceKey,
    inputs: claimed.inputs,
  };
};

const finishRun = async (backendRunId: string, outcome: BackendRunOutcome): Promise<void> => {
  const rows = await withRuntimeTransaction(
    (transaction) => transaction.query`
      select vortex_platform.finish_backend_run(
        ${backendRunId}::uuid, ${outcome.state}::text,
        ${outcome.outputs === undefined ? null : JSON.stringify(outcome.outputs)}::text::jsonb,
        ${outcome.failureCode ?? null}::text
      ) as finished
    `,
  );
  if (rows.length !== 1) throw new Error("BACKEND_RUN_FINISH_INVALID");
};

const recordRefusal = async (refusal: BackendRunRefusal): Promise<void> => {
  const rows = await withRuntimeTransaction(
    (transaction) => transaction.query`
      select vortex_platform.record_refused_backend_run(
        ${refusal.organizationId}::uuid, ${refusal.applicationRootId}::uuid,
        ${refusal.actorId}::uuid, ${refusal.origin}::text, ${refusal.sourceKey}::text,
        ${refusal.failureCode}::text
      ) as recorded
    `,
  );
  if (rows.length !== 1) throw new Error("BACKEND_RUN_REFUSAL_INVALID");
};

const listPending = async (limit: number): Promise<readonly string[]> => {
  const rows = await withRuntimeTransaction(
    (transaction) => transaction.query`
      select vortex_platform.list_pending_backend_runs(${limit}::integer) as id
    `,
  );
  return rows.map((row) => z.object({ id: z.uuid() }).parse(row).id);
};

type BackendAdapterDependencies = Readonly<{
  /** Runs one claimed run to a final state, under the actor's authority. */
  execute: (claimed: ClaimedBackendRun) => Promise<BackendRunOutcome>;
  /** Runs work after the current reply (Next `after`). */
  schedule: (work: () => Promise<void>) => void;
}>;

const finishedResult = (
  backendRunId: string,
  state: BackendRunState,
  outputs: Readonly<Record<string, JsonValue>> | null,
  failureCode: string | null,
): BackendRunResult =>
  state === "succeeded"
    ? { kind: "finished", backendRunId, outputs: outputs ?? {} }
    : state === "refused" || state === "failed"
      ? { kind: "not_finished", backendRunId, state, failureCode: failureCode ?? "unspecified" }
      : { kind: "started", backendRunId };

export const createSimulatedBackendAdapter = (dependencies: BackendAdapterDependencies) => {
  /** Claims and runs one run; false when another executor holds it or it already finished. */
  const runClaimed = async (backendRunId: string): Promise<BackendRunOutcome | undefined> => {
    const claimed = await claimRun(backendRunId);
    if (claimed === undefined) return undefined;
    let outcome: BackendRunOutcome;
    try {
      outcome = await dependencies.execute(claimed);
    } catch (error) {
      console.error("[backend] run failed unexpectedly", error);
      outcome = { state: "failed", failureCode: "unexpected_failure" };
    }
    await finishRun(backendRunId, outcome);
    return outcome;
  };

  return Object.freeze({
    /**
     * `await` runs the child now, after the caller's own transaction has committed, and returns its
     * outputs; `start` records it and runs it after the reply. A repeat of the same request returns
     * the first run's reference and state.
     */
    async run(request: BackendRunRequest): Promise<BackendRunResult> {
      const recorded = await requestRun(request);
      if (recorded.state === "pending" || recorded.state === "running") {
        if (request.mode === "start") {
          dependencies.schedule(async () => {
            await runClaimed(recorded.backendRunId);
          });
          return { kind: "started", backendRunId: recorded.backendRunId };
        }
        const outcome = await runClaimed(recorded.backendRunId);
        if (outcome === undefined) return { kind: "unavailable" };
        return finishedResult(
          recorded.backendRunId,
          outcome.state,
          outcome.outputs ?? null,
          outcome.failureCode ?? null,
        );
      }
      return request.mode === "start"
        ? { kind: "started", backendRunId: recorded.backendRunId }
        : finishedResult(recorded.backendRunId, recorded.state, recorded.outputs, recorded.failureCode);
    },
    /** Records a run for later, for work whose caller does not wait (a subscriber). */
    async enqueue(request: BackendRunRequest): Promise<string> {
      return (await requestRun(request)).backendRunId;
    },
    /** Records once that an occurrence ran nothing, with the named reason. */
    recordRefusal,
    /** Runs one recorded run if it is still waiting; the recovery tick and `after` both call it. */
    runRecorded: runClaimed,
    /** The recovery tick: runs the oldest waiting runs, one at a time. */
    async sweep(limit: number): Promise<number> {
      let ran = 0;
      for (const backendRunId of await listPending(limit)) {
        if ((await runClaimed(backendRunId)) !== undefined) ran += 1;
      }
      return ran;
    },
  });
};

export type BackendAdapter = ReturnType<typeof createSimulatedBackendAdapter>;
