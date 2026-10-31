"use client";
import { useState } from "react";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { StudioOptionControl } from "@vortex/ui/studio";
import {
  describeFailure,
  flowTaskRegistry,
  type JsonValue,
  type SourceFlow,
} from "@vortex/platform/schema";
import type { StudioFlowTestRunReply } from "../../_lib/studio-flow-test-run";
import { readStudioDataRecords } from "../_lib/studio-reads";

type Declaration = NonNullable<SourceFlow["inputs"]>[string];
type Reply = Extract<StudioFlowTestRunReply, { kind: "ran" }>;
type Step = Reply["steps"][number];
type RecordChoice = Readonly<{ id: string; label: string }>;

const notRunSentences: Readonly<Record<NonNullable<Step["notRun"]>, string>> = {
  multi_transaction: "Not run in a test run: this step works across several transactions.",
  access_change: "Not run in a test run: this step changes who has access.",
  scope_lock: "Not run in a test run: this step locks the account it changes.",
  external_effect: "Not run in a test run: this step sends or calls out, so nothing was sent.",
  needs_a_person: "Not run in a test run: this step waits for a person to answer.",
};

const failureSentences: Readonly<
  Record<Exclude<StudioFlowTestRunReply["kind"], "ran" | "temporarily_unavailable">, string>
> = {
  open_preview_first: "Open the preview first, then run the test again.",
  flow_missing: "This flow is not in the saved draft. Save it, then run the test again.",
  refused: "Your account cannot test flows of this application.",
  conflict: "The saved draft changed. Reload Studio, then run the test again.",
};

const titleOf = (type: string): string =>
  type === "after_save_subscriber"
    ? "After-save subscriber"
    : (Object.values(flowTaskRegistry).find((entry) => entry.type === type)?.title ?? type);

const locationLabels: Readonly<Record<Step["location"], string>> = {
  page: "Page",
  server: "Server",
  "back end": "Back end",
};

const parsedInput = (declaration: Declaration, raw: string | boolean): JsonValue | undefined => {
  if (declaration.type === "yes_no") return raw === true;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return undefined;
  if (declaration.type === "whole_number" || declaration.type === "decimal_number")
    return Number.isFinite(Number(text)) ? Number(text) : text;
  if (declaration.type === "json") {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
};

function TraceStep({ step, flowKey }: Readonly<{ step: Step; flowKey: string }>) {
  const ended = step.outcome === "refused" || step.outcome === "failed";
  return (
    <li className="space-y-1 border-b py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{titleOf(step.taskType)}</span>
        <code className="text-xs text-muted-foreground">
          {step.flow === flowKey || step.taskType === "after_save_subscriber"
            ? step.taskId
            : `${step.flow} / ${step.taskId}`}
        </code>
        <Badge variant="outline">{locationLabels[step.location]}</Badge>
        <Badge variant={ended ? "destructive" : "secondary"}>
          {step.outcome.replace("_", " ")}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">{step.ms} ms</span>
      </div>
      {step.notRun !== undefined ? (
        <p className="text-muted-foreground">{notRunSentences[step.notRun]}</p>
      ) : null}
      {step.refusal !== undefined ? (
        <p role="alert">
          {step.refusal.sentence} <code className="text-xs">{step.refusal.code}</code>
        </p>
      ) : null}
      {Object.keys(step.outputs).length > 0 ? (
        <pre className="m-0 overflow-x-auto rounded bg-muted p-2 text-xs">
          {JSON.stringify(step.outputs, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

/**
 * A test of one flow against the preview's real data: the builder picks the inputs, the server runs
 * the draft flow and rolls everything back, and each step comes back with where it ran, how long
 * it took, what it produced and, for a refusal, the sentence a person would be given.
 */
export function StudioFlowTestRun({
  organizationId,
  rootId,
  draftRevision,
  flow,
  moduleKey,
  blocked,
}: Readonly<{
  organizationId: string;
  rootId: string;
  /** The saved revision the preview runs; a test runs the saved flow. */
  draftRevision: number;
  flow: SourceFlow;
  moduleKey: string | null;
  /** Why a test cannot start now, or nothing. */
  blocked: string | undefined;
}>) {
  const inputs = Object.entries(flow.inputs ?? {});
  const [values, setValues] = useState<Readonly<Record<string, string | boolean>>>({});
  const [records, setRecords] = useState<Readonly<Record<string, readonly RecordChoice[]>>>({});
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState<StudioFlowTestRunReply | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  if (flow.execution !== "interactive")
    return (
      <p className="text-sm text-muted-foreground">
        A test run starts flows that a person starts from a page. This flow runs on its own.
      </p>
    );

  const loadRecords = async (name: string, declaration: Declaration) => {
    const reference = declaration.recordTypeIds?.[0];
    if (reference === undefined) return;
    const [owner, record] = reference.includes(":")
      ? (reference.split(":") as [string, string])
      : [moduleKey, reference];
    if (owner === null || owner === undefined || record === undefined) return;
    setProblem(undefined);
    try {
      const read = await readStudioDataRecords(organizationId, {
        rootId,
        draftRevision,
        moduleKey: owner,
        recordKey: record,
        pageSize: 40,
      });
      if (read.kind !== "available") {
        setProblem("The records could not be read. Open the preview first, then try again.");
        return;
      }
      setRecords((held) => ({
        ...held,
        [name]: read.rows.map((row) => ({
          id: row.id,
          label:
            (read.titleColumn === undefined ? undefined : row.cells[read.titleColumn]) ?? row.id,
        })),
      }));
    } catch (error) {
      console.error("[studio] test run records failed", describeFailure(error));
      setProblem("The records could not be read. Try again.");
    }
  };

  const run = async () => {
    const supplied: Record<string, JsonValue> = {};
    for (const [name, declaration] of inputs) {
      const value = parsedInput(
        declaration,
        values[name] ?? (declaration.type === "yes_no" ? false : ""),
      );
      if (value === undefined) {
        if (declaration.required) {
          setProblem(`Enter a value for ${name}.`);
          return;
        }
        continue;
      }
      supplied[name] = value;
    }
    setRunning(true);
    setProblem(undefined);
    setReply(undefined);
    try {
      const response = await fetch("/api/studio/flow-test-run", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          rootId,
          draftRevision,
          flowKey: flow.key,
          moduleKey,
          inputs: supplied,
        }),
      });
      if (!response.ok) throw new Error(`STUDIO_FLOW_TEST_RUN_HTTP_${response.status}`);
      setReply((await response.json()) as StudioFlowTestRunReply);
    } catch (error) {
      console.error("[studio] flow test run failed", describeFailure(error));
      setProblem("The test run could not be completed. Try again.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-label="Test run" className="space-y-3 border-t p-3">
      <h3 className="m-0 text-sm font-semibold">Test run</h3>
      <p className="m-0 text-xs text-muted-foreground">
        Runs the saved flow on the preview&apos;s records as you. Nothing is saved, sent or
        announced.
      </p>
      {inputs.map(([name, declaration]) => (
        <div key={name} className="space-y-1">
          <Label htmlFor={`test-run-${name}`}>
            {name}
            {declaration.required ? " (required)" : ""}
          </Label>
          {declaration.recordTypeIds !== undefined && declaration.recordTypeIds.length > 0 ? (
            <div className="flex items-center gap-2">
              <StudioOptionControl
                id={`test-run-${name}`}
                value={typeof values[name] === "string" ? values[name] : ""}
                disabled={false}
                options={[
                  { value: "", label: "Choose a record" },
                  ...(records[name] ?? []).map((choice) => ({
                    value: choice.id,
                    label: choice.label,
                  })),
                ]}
                onChange={(value) => setValues((held) => ({ ...held, [name]: value }))}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadRecords(name, declaration)}
              >
                Load records
              </Button>
            </div>
          ) : declaration.type === "yes_no" ? (
            <Checkbox
              id={`test-run-${name}`}
              checked={values[name] === true}
              onCheckedChange={(checked) =>
                setValues((held) => ({ ...held, [name]: checked === true }))
              }
            />
          ) : (
            <Input
              id={`test-run-${name}`}
              value={typeof values[name] === "string" ? values[name] : ""}
              onChange={(event) => setValues((held) => ({ ...held, [name]: event.target.value }))}
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={running || blocked !== undefined}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Test run"}
        </Button>
        {blocked !== undefined ? (
          <span className="text-xs text-muted-foreground">{blocked}</span>
        ) : null}
      </div>
      {problem !== undefined ? <p role="alert">{problem}</p> : null}
      {reply === undefined ? null : reply.kind === "ran" ? (
        <div className="space-y-2" aria-label="Step trace">
          <p className="m-0 text-sm" role="status">
            {reply.end.kind === "finished"
              ? reply.end.refusal === undefined
                ? `Finished: ${reply.end.outcome}.`
                : `${reply.end.refusal.sentence} (${reply.end.refusal.code})`
              : reply.end.reason === "refused"
                ? "The test run was refused."
                : notRunSentences[reply.end.reason]}{" "}
            <span className="text-muted-foreground">
              {reply.totalMs} ms in total. Nothing was saved.
            </span>
          </p>
          <ol className="m-0 list-none p-0">
            {reply.steps.map((step, index) => (
              <TraceStep
                key={`${step.taskId}:${step.iteration}:${index}`}
                step={step}
                flowKey={flow.key}
              />
            ))}
          </ol>
        </div>
      ) : reply.kind === "temporarily_unavailable" ? (
        <p role="alert">The test run is temporarily unavailable. Try again.</p>
      ) : (
        <p role="alert">{failureSentences[reply.kind]}</p>
      )}
    </section>
  );
}
