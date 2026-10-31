import type { ApplicationSourceDocument } from "@vortex/platform/schema";

/** The inputs a flow of the draft declares. */
type FlowInputs = ApplicationSourceDocument["body"]["flows"][number]["inputs"];
type FlowTasks = ApplicationSourceDocument["body"]["flows"][number]["tasks"];
type FlowOutputs = ApplicationSourceDocument["body"]["flows"][number]["outputs"];
type SourceModule = ApplicationSourceDocument["body"]["modules"][number];
type Plain = Readonly<Record<string, unknown>>;

/** The flow input a declared action or query input feeds, keeping its type and whether it is required. */
const flowInputOf = (
  input: Readonly<{
    key: string;
    required: boolean;
    type: string;
    record_types?: readonly string[] | undefined;
  }>,
): FlowInputs[string] => ({
  ...(input.type === "record_reference"
    ? { type: "record_reference" as const, recordTypeIds: [...(input.record_types ?? [])] }
    : { type: input.type as FlowInputs[string]["type"] }),
  required: input.required,
});

/**
 * The inputs a new options flow declares: the ones the field's declared source already reads, so
 * switching a query or flow source to a new flow keeps every input the field maps.
 */
export const optionsFlowInputs = (
  declared: Plain | undefined,
  module: SourceModule,
): FlowInputs => {
  if (declared?.kind === "query" && typeof declared.query === "string") {
    const query = module.queries.find((entry) => `${module.key}:${entry.key}` === declared.query);
    return Object.fromEntries(
      (query?.inputs ?? []).map((input) => [input.key, flowInputOf(input)]),
    );
  }
  if (declared?.kind === "flow" && typeof declared.flow === "string") {
    const flow = module.flows.find(
      (entry) => entry.id === declared.flow || entry.key === declared.flow,
    );
    return Object.fromEntries(
      Object.entries(flow?.inputs ?? {}).map(([key, declaration]) => [
        key,
        {
          type: declaration.type,
          required: declaration.required,
          ...(declaration.recordTypeIds === undefined
            ? {}
            : { recordTypeIds: declaration.recordTypeIds }),
        },
      ]),
    );
  }
  return {};
};

/**
 * The steps a new options flow starts with. A field that already reads a query gets the one flow
 * shape that works: Query records, then Build list over its rows, and the `options` output takes
 * the built list. Any other source starts with a Stop and an empty list to fill in.
 */
export const optionsFlowSeed = (
  declared: Plain | undefined,
  module: SourceModule,
): Readonly<{ tasks: FlowTasks; outputs: FlowOutputs }> => {
  const textLiteral = (value: string) => ({
    kind: "literal" as const,
    literal: { type: "text" as const, value },
  });
  const queryRef =
    declared?.kind === "query" && typeof declared.query === "string" ? declared.query : undefined;
  const query = module.queries.find((entry) => `${module.key}:${entry.key}` === queryRef);
  const empty: Readonly<{ tasks: FlowTasks; outputs: FlowOutputs }> = {
    tasks: [{ id: "done", type: "stop", outcome: "completed" }],
    outputs: {
      options: {
        type: "json" as const,
        value: { kind: "literal" as const, literal: { type: "json" as const, value: [] } },
      },
    },
  };
  if (query === undefined) return empty;
  const recordType = module.record_types.find(
    (entry) =>
      entry.key === query.record_type || `${module.key}:${entry.key}` === query.record_type,
  );
  const labelField =
    recordType !== undefined && query.select.includes(recordType.title_field)
      ? recordType.title_field
      : query.select[0];
  if (labelField === undefined) return empty;
  return {
    tasks: [
      {
        id: "read",
        type: "record.query",
        version: "1.0.0",
        properties: {
          query: textLiteral(queryRef!),
          parameters: {
            kind: "map",
            entries: Object.fromEntries(
              query.inputs.map((input) => [
                input.key,
                { kind: "reference", reference: { source: "input", name: input.key } },
              ]),
            ),
          },
        },
      },
      {
        id: "build",
        type: "data.build_list",
        version: "1.0.0",
        properties: {
          items: {
            kind: "reference",
            reference: { source: "task_output", task: "read", key: "rows" },
          },
          value: textLiteral("record"),
          label: textLiteral(`values.${labelField}`),
        },
      },
    ],
    outputs: {
      options: {
        type: "json",
        value: {
          kind: "reference",
          reference: { source: "task_output", task: "build", key: "list" },
        },
      },
    },
  };
};
