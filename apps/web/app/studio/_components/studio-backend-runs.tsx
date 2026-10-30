"use client";
import { useEffect, useState } from "react";
import { FormattedTime } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vortex/ui/components/table";
import type { StudioBackendRun } from "../../_lib/studio-backend-run-history";
import { readBackendRunHistory } from "../releases-actions";
import { unavailableMessage } from "./studio-refusal-messages";

type Load =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "available"; runs: readonly StudioBackendRun[] }>
  | Readonly<{ kind: "unavailable"; message: string }>;

const stateLabels: Record<StudioBackendRun["state"], string> = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Succeeded",
  refused: "Refused",
  failed: "Failed",
};

/** The newest back-end runs: which flow ran, what started it, how it ended and why it failed. */
export function StudioBackendRuns({
  organizationId,
  rootId,
  savedRevision,
}: Readonly<{ organizationId: string; rootId: string; savedRevision: number }>) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setLoad({ kind: "loading" });
    readBackendRunHistory(organizationId, rootId).then(
      (result) => {
        if (!current) return;
        setLoad(
          result.kind === "available"
            ? { kind: "available", runs: result.runs }
            : { kind: "unavailable", message: unavailableMessage(result.kind, result.reason) },
        );
      },
      (error: unknown) => {
        console.error("[studio] back-end run history failed to load", error);
        if (current)
          setLoad({
            kind: "unavailable",
            message: unavailableMessage("temporarily_unavailable", undefined),
          });
      },
    );
    return () => {
      current = false;
    };
  }, [organizationId, rootId, savedRevision, generation]);
  if (load.kind === "loading") return <p role="status">Loading the back-end runs…</p>;
  if (load.kind === "unavailable") return <p role="status">{load.message}</p>;
  return (
    <section aria-label="Back-end runs" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold">Back-end runs</h2>
        <button
          type="button"
          className="text-sm underline"
          onClick={() => setGeneration((n) => n + 1)}
        >
          Reload
        </button>
      </div>
      {load.runs.length === 0 ? (
        <p role="status">Nothing has run on the back end yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Flow</TableHead>
              <TableHead>Started by</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Failure reason</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {load.runs.map((run) => (
              <TableRow key={run.backendRunId}>
                <TableCell>{run.flow ?? "Subscribers did not run"}</TableCell>
                <TableCell>
                  {run.origin === "event" ? "A saved record" : "Run on back end step"}
                </TableCell>
                <TableCell>
                  <Badge variant={run.state === "succeeded" ? "outline" : "secondary"}>
                    {stateLabels[run.state]}
                  </Badge>
                </TableCell>
                <TableCell>{run.failureCode ?? ""}</TableCell>
                <TableCell>
                  <FormattedTime iso={run.createdAt} />
                </TableCell>
                <TableCell>
                  {run.finishedAt === null ? "" : <FormattedTime iso={run.finishedAt} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
