"use client";
import { StudioHelp } from "@vortex/ui/studio";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { StudioInspectorGroup, StudioOptionControl } from "@vortex/ui/studio";

type Plain = Readonly<Record<string, unknown>>;
type Input = Readonly<{ key: string; label: string; required: boolean }>;

/** Where a field's options come from, as the field declares it (Studio flows design §2). */
type Kind = "fixed" | "records" | "query" | "flow";

const kindOf = (source: Plain | undefined, link: boolean): Kind => {
  if (source?.kind === "flow") return "flow";
  if (link) return source?.query === undefined ? "records" : "query";
  return "fixed";
};

/**
 * Where a choice or link field's options come from: a fixed list (choice), the records the person
 * may read (link), a query over the record's own fields, or an options flow over them. It is
 * declared on the field, so every page, import and agent is held to it. A query or flow names, for
 * each of its inputs, the field of the same record type that supplies it.
 */
export function StudioOptionsSourceEditor({
  link,
  source,
  fieldLabel,
  fields,
  queries,
  flows,
  disabled,
  onChange,
  onNewFlow,
}: Readonly<{
  link: boolean;
  source: Plain | undefined;
  /** The field's label, which names a new options flow by default. */
  fieldLabel: string;
  /** The other fields of this record type, which an input can read. */
  fields: readonly Readonly<{ key: string; label: string }>[];
  /** The module's queries by qualified reference, with the inputs each declares. */
  queries: readonly Readonly<{ reference: string; label: string; inputs: readonly Input[] }>[];
  /** The module's flows by alias, with the inputs each declares. */
  flows: readonly Readonly<{ alias: string; label: string; inputs: readonly Input[] }>[];
  disabled: boolean;
  /** Writes the declared source; answers why it was refused, if it was. */
  onChange: (next: Plain) => string | undefined;
  /** Creates a new options flow over the field's declared inputs, declares it, and opens it. */
  onNewFlow: (name: string) => string | undefined;
}>) {
  const current = kindOf(source, link);
  const [kind, setKind] = useState<Kind>(current);
  const [query, setQuery] = useState(typeof source?.query === "string" ? source.query : "");
  const [flow, setFlow] = useState(typeof source?.flow === "string" ? source.flow : "");
  const [flowName, setFlowName] = useState(`${fieldLabel} options`);
  const [inputs, setInputs] = useState<Readonly<Record<string, string>>>(
    (source?.inputs as Readonly<Record<string, string>> | undefined) ?? {},
  );
  const [problem, setProblem] = useState("");
  const declared =
    kind === "query" ? queries.find((entry) => entry.reference === query) : undefined;
  const declaredFlow = kind === "flow" ? flows.find((entry) => entry.alias === flow) : undefined;
  const needed = declared?.inputs ?? declaredFlow?.inputs ?? [];
  const kinds: readonly Readonly<{ kind: Kind; label: string }>[] = link
    ? [
        { kind: "records", label: "The records the person may read" },
        { kind: "query", label: "A query over this record's fields" },
        { kind: "flow", label: "An options flow" },
      ]
    : [
        { kind: "fixed", label: "A fixed list" },
        { kind: "flow", label: "An options flow" },
      ];
  const apply = () => {
    if (kind === "fixed") return setProblem(onChange({ kind: "fixed" }) ?? "");
    if (kind === "records") return setProblem(onChange({ kind: "query" }) ?? "");
    const target = kind === "query" ? query : flow;
    if (target === "") return setProblem("Choose what supplies the options.");
    const missing = needed.find((input) => input.required && (inputs[input.key] ?? "") === "");
    if (missing !== undefined) return setProblem(`Choose the field that fills ${missing.label}.`);
    const filled = Object.fromEntries(
      needed.flatMap((input) =>
        (inputs[input.key] ?? "") === "" ? [] : [[input.key, inputs[input.key]]],
      ),
    );
    setProblem(
      onChange(
        kind === "query"
          ? { kind: "query", query, inputs: filled }
          : { kind: "flow", flow, inputs: filled },
      ) ?? "",
    );
  };
  return (
    <StudioInspectorGroup title="Where the options come from">
      <Label className="flex flex-col items-start gap-1 text-xs">
        Options source
        <StudioOptionControl
          value={kind}
          disabled={disabled}
          options={kinds.map((entry) => ({ value: entry.kind, label: entry.label }))}
          onChange={(value) => {
            setKind(value as Kind);
            setProblem("");
          }}
        />
      </Label>
      {kind === "query" && (
        <Label className="flex flex-col items-start gap-1 text-xs">
          Query
          <StudioOptionControl
            value={query}
            disabled={disabled}
            unset="Choose a query…"
            options={queries.map((entry) => ({ value: entry.reference, label: entry.label }))}
            onChange={(value) => {
              setQuery(value);
              setInputs({});
            }}
          />
        </Label>
      )}
      {kind === "flow" && (
        <>
          <Label className="flex flex-col items-start gap-1 text-xs">
            Options flow
            <StudioOptionControl
              value={flow}
              disabled={disabled}
              unset="Choose a flow…"
              options={flows.map((entry) => ({ value: entry.alias, label: entry.label }))}
              onChange={(value) => {
                setFlow(value);
                setInputs({});
              }}
            />
          </Label>
          <Label className="flex flex-col items-start gap-1 text-xs">
            New options flow
            <Input
              value={flowName}
              disabled={disabled}
              maxLength={100}
              onChange={(event) => setFlowName(event.target.value)}
            />
          </Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setProblem(onNewFlow(flowName) ?? "")}
          >
            New options flow
          </Button>
          <StudioHelp hint="Creates an interactive flow over the inputs this field declares, with an options output, and opens it in the flow editor." />
        </>
      )}
      {needed.map((input) => (
        <Label key={input.key} className="flex flex-col items-start gap-1 text-xs">
          {input.label} is filled by
          <StudioOptionControl
            value={inputs[input.key] ?? ""}
            disabled={disabled}
            unset={input.required ? "Choose a field…" : "Nothing"}
            options={fields.map((field) => ({ value: field.key, label: field.label }))}
            onChange={(value) => setInputs({ ...inputs, [input.key]: value })}
          />
        </Label>
      ))}
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={apply}>
        Use this source
      </Button>
      {problem !== "" && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </StudioInspectorGroup>
  );
}
