"use client";
import { useEffect, useState } from "react";
import { FormattedTime, Icon } from "@vortex/ui";
import { Alert, AlertAction, AlertDescription } from "@vortex/ui/components/alert";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { Skeleton } from "@vortex/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import type { BackendRunHistoryRequest } from "@vortex/platform/server";
import type { BackendRunNamedCode } from "@vortex/platform/schema";
import type { StudioBackendRun } from "../../_lib/studio-backend-run-history";
import { readBackendRunHistory } from "../releases-actions";
import { StudioPager } from "./studio-pager";
import { unavailableMessage } from "./studio-refusal-messages";

type Page = Readonly<{
  runs: readonly StudioBackendRun[];
  hasOlder: boolean;
  hasNewer: boolean;
}>;
type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "available"; page: Page }>
  | Readonly<{ kind: "unavailable"; message: string }>;

const stateLabels: Record<StudioBackendRun["state"], string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Succeeded",
  refused: "Refused",
  failed: "Failed",
};

/**
 * Why a run did not finish, in plain words, by the code the back end records. The record type has
 * one entry per code in `backendRunNamedCodes` (the codes the run emitters in
 * `flow-background-run.ts`, `resolve_backend_actor.sql` and `backend-adapters.ts` are typed with),
 * so a code added there does not compile until it has a sentence here.
 */
const failureReasons: Readonly<Record<BackendRunNamedCode, string>> = {
  flow_unavailable: "The flow is not part of the installed version any more.",
  flow_not_background: "The flow does not run on the back end.",
  record_unavailable: "The record the flow was started for could not be read.",
  step_not_available_on_back_end: "The flow has a step that cannot run on the back end.",
  application_unavailable: "The installed version of the application could not be loaded.",
  actor_unknown: "The person who started it could not be found.",
  actor_not_active: "The person who started it is no longer active in the organisation.",
  organization_not_active: "The organisation is not active.",
  unexpected_failure: "The run stopped because of an unexpected problem.",
  unspecified: "The run ended without a reason.",
};
const unnamedReason = "Failed for a reason Studio does not name yet.";
const reportedCodes = new Set<string>();

/** The plain reason for a run's failure code; a code Studio does not know is logged once and named as such. */
const failureReason = (code: string): string => {
  const known = Object.hasOwn(failureReasons, code)
    ? failureReasons[code as BackendRunNamedCode]
    : undefined;
  if (known !== undefined) return known;
  if (!reportedCodes.has(code)) {
    reportedCodes.add(code);
    console.error(`[studio] back-end run failure code without a message: ${code}`);
  }
  return unnamedReason;
};

/** The newest back-end runs, 40 to a page: which flow ran, what started it, how it ended and why it failed. */
export function StudioBackendRuns({
  organizationId,
  rootId,
}: Readonly<{ organizationId: string; rootId: string }>) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [request, setRequest] = useState<BackendRunHistoryRequest>({ kind: "newest" });
  const [generation, setGeneration] = useState(0);
  // A page is being read: the pager waits for it. The runs do not depend on the draft, so a save
  // changes nothing here; the Releases tab's Reload reads them again.
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let current = true;
    setPending(true);
    setLoad((previous) => (previous.kind === "available" ? previous : { kind: "loading" }));
    readBackendRunHistory(organizationId, rootId, request).then(
      (result) => {
        if (!current) return;
        setPending(false);
        setLoad(
          result.kind === "available"
            ? {
                kind: "available",
                page: { runs: result.runs, hasOlder: result.hasOlder, hasNewer: result.hasNewer },
              }
            : { kind: "unavailable", message: unavailableMessage(result.kind, result.reason) },
        );
      },
      (error: unknown) => {
        console.error("[studio] back-end run history failed to load", error);
        if (!current) return;
        setPending(false);
        setLoad({
          kind: "unavailable",
          message: unavailableMessage("temporarily_unavailable", undefined),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [organizationId, rootId, request, generation]);
  if (load.kind === "loading")
    return (
      <div className="space-y-2" role="status" aria-label="Loading the back-end runs">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  if (load.kind === "unavailable")
    return (
      <Alert variant="destructive">
        <AlertDescription>{load.message}</AlertDescription>
        <AlertAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRequest({ kind: "newest" });
              setGeneration((n) => n + 1);
            }}
          >
            Reload
          </Button>
        </AlertAction>
      </Alert>
    );
  const { runs, hasOlder, hasNewer } = load.page;
  const first = runs[0];
  const last = runs.at(-1);
  return (
    <section aria-label="Back-end runs" aria-busy={pending} className="space-y-3">
      {runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="workflow" />
            </EmptyMedia>
            <EmptyTitle>Nothing has run yet</EmptyTitle>
            <EmptyDescription>
              Runs appear here when a saved record or a back end step starts a flow.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Table aria-label="Back-end runs">
            <TableHeader>
              <TableRow>
                <TableHead>Flow</TableHead>
                <TableHead>Started by</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="hidden md:table-cell">Failure reason</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="hidden lg:table-cell">Finished</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const reason =
                  run.failureCode === null ? undefined : failureReason(run.failureCode);
                const badge = (
                  <Badge
                    variant={
                      run.state === "succeeded"
                        ? "outline"
                        : run.state === "failed" || run.state === "refused"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {stateLabels[run.state]}
                  </Badge>
                );
                return (
                  <TableRow key={run.backendRunId}>
                    <TableCell>{run.flow ?? "Subscribers did not run"}</TableCell>
                    <TableCell>
                      {run.origin === "event" ? "A saved record" : "Run on back end step"}
                    </TableCell>
                    <TableCell>
                      {reason === undefined ? (
                        badge
                      ) : (
                        // On a narrow screen the reason column is hidden: the badge carries it.
                        <Tooltip>
                          <TooltipTrigger
                            render={<span className="md:pointer-events-none" tabIndex={0} />}
                          >
                            {badge}
                          </TooltipTrigger>
                          <TooltipContent className="md:hidden">{reason}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {reason === undefined ? null : (
                        <Tooltip>
                          <TooltipTrigger render={<span tabIndex={0} />}>{reason}</TooltipTrigger>
                          <TooltipContent>{run.failureCode}</TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <FormattedTime iso={run.createdAt} relative />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {run.finishedAt === null ? (
                        ""
                      ) : (
                        <FormattedTime iso={run.finishedAt} relative />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <StudioPager
            noun="runs"
            hasNewer={hasNewer}
            hasOlder={hasOlder}
            disabled={pending}
            onNewer={() => first && setRequest({ kind: "newer", cursor: first.cursor })}
            onOlder={() => last && setRequest({ kind: "older", cursor: last.cursor })}
          />
        </>
      )}
    </section>
  );
}
