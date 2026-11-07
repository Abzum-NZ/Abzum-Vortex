import "server-only";

import {
  createBackendRunHistoryReader,
  logRefusal,
  type BackendRunHistoryCursor,
  type BackendRunHistoryRequest,
} from "@vortex/platform/server";
import {
  applicationRootIdSchema,
  organizationIdSchema,
  type ApplicationRootId,
  type OrganizationId,
  studioFlowLabel,
} from "@vortex/platform/schema";
import { loadInstalledContext, requestDependencies } from "./application-page/installed-context";
import { resolveIdentitySession } from "../auth/_lib/session-server";
import { humanOrganizationRequests } from "./server-composition";

export type StudioBackendRun = Readonly<{
  backendRunId: string;
  /** The flow's name; null when the occurrence was refused before its subscribers could be listed. */
  flow: string | null;
  origin: "backend_run" | "event";
  state: "pending" | "running" | "succeeded" | "refused" | "failed";
  failureCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Where the page that follows or precedes this run starts. */
  cursor: BackendRunHistoryCursor;
}>;

export type StudioBackendRunHistoryResult =
  | Readonly<{
      kind: "available";
      runs: readonly StudioBackendRun[];
      hasOlder: boolean;
      hasNewer: boolean;
    }>
  | Readonly<{ kind: "refused" | "temporarily_unavailable"; reason: string }>;

/** The names of the flows the application's installed release runs, by flow identity. */
const installedFlowNames = async (
  session: Parameters<typeof loadInstalledContext>[0],
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
): Promise<ReadonlyMap<string, string>> => {
  const loaded = await loadInstalledContext(session, requestDependencies(), {
    organizationId,
    applicationRootId,
  });
  // The request runner logged an answer that is not available, once.
  if (loaded.kind !== "available") return new Map();
  const { application, modules } = loaded.value.releaseSet;
  return new Map(
    [...application.content.flows, ...modules.flatMap((module) => module.content.flows)].map(
      (flow) => [String(flow.id).toLowerCase(), studioFlowLabel(flow)],
    ),
  );
};

// The installed release is loaded in full to name flows, so the names are kept for five minutes
// per application: a page whose flows are all known (Older, Newer, Reload) loads nothing.
const flowNameLifetimeMs = 5 * 60_000;
const flowNameCache = new Map<
  string,
  Readonly<{ at: number; names: ReadonlyMap<string, string> }>
>();
const flowNamesFor = async (
  session: Parameters<typeof loadInstalledContext>[0],
  organizationId: OrganizationId,
  applicationRootId: ApplicationRootId,
  flowIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const key = `${organizationId}:${applicationRootId}`;
  const cached = flowNameCache.get(key);
  if (
    cached !== undefined &&
    Date.now() - cached.at < flowNameLifetimeMs &&
    flowIds.every((id) => cached.names.has(id))
  )
    return cached.names;
  const names = await installedFlowNames(session, organizationId, applicationRootId);
  // A release that could not be read is not remembered, so the next page tries again.
  if (names.size > 0) flowNameCache.set(key, { at: Date.now(), names });
  return names;
};

/**
 * One keyset page of the back-end runs of one application for its builders, newest first. The
 * database function decides the caller's authority from the request context; the history never
 * carries outputs.
 */
export const readStudioBackendRunHistory = async (
  candidateOrganizationId: string,
  candidateRootId: string,
  request: BackendRunHistoryRequest,
): Promise<StudioBackendRunHistoryResult> => {
  const organization = organizationIdSchema.safeParse(candidateOrganizationId);
  const root = applicationRootIdSchema.safeParse(candidateRootId);
  if (!organization.success || !root.success) return { kind: "refused", reason: "request_invalid" };
  try {
    const resolved = await resolveIdentitySession();
    if (resolved.kind === "temporarily_unavailable")
      return { kind: "temporarily_unavailable", reason: "session_unavailable" };
    if (resolved.kind !== "active") return { kind: "refused", reason: "session_ended" };
    const result = await createBackendRunHistoryReader({
      requests: humanOrganizationRequests(),
    }).read(resolved.session, organization.data, root.data, request);
    if (result.kind === "available") {
      const names = await flowNamesFor(
        resolved.session,
        organization.data,
        root.data,
        result.runs.flatMap((run) => (run.flowId === null ? [] : [run.flowId.toLowerCase()])),
      );
      return {
        kind: "available",
        hasOlder: result.hasOlder,
        hasNewer: result.hasNewer,
        runs: result.runs.map((run) => ({
          backendRunId: run.backendRunId,
          flow:
            run.flowId === null
              ? null
              : (names.get(run.flowId.toLowerCase()) ?? `Flow ${run.flowId.slice(0, 8)}`),
          origin: run.origin,
          state: run.state,
          failureCode: run.failureCode,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          cursor: run.cursor,
        })),
      };
    }
    return {
      kind: result.kind,
      reason: result.kind === "refused" ? "permission_missing" : "request_failed",
    };
  } catch (error) {
    logRefusal("studio", "back-end run history", "request_failed", error);
    return { kind: "temporarily_unavailable", reason: "request_failed" };
  }
};
