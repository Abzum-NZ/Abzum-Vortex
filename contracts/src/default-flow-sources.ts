import { flowContractVersion } from "./flow-contracts";
import type { SourceFlow } from "./flow-source-contracts";
import type { ProtectedOperationDescriptor } from "./application-flow-bindings";

/**
 * The generated default flows (architecture decision 2): the default Save of a form is one
 * `record.save` task and the default Query of a component is one `record.query` task. A builder
 * with the builder permission may add tasks before or after the one generated task; nothing else
 * about a default is special, so each is an ordinary application-owned flow with a permanent
 * identity once compiled.
 *
 * These builders are pure. They are called when a default is authored, never while a page renders
 * or a flow runs, and they only assemble source: every alias they carry is resolved, and every
 * placement, type and reference is checked, by the one flow compiler and validator.
 *
 * A refused, conflict, validation or uncertain result needs no task of its own. The flow's default
 * error handler shows each of them safely, so the one task is the whole flow.
 */

type DefaultFlowIdentity = Readonly<{
  /** The flow's owner alias and its readable key; both resolve to one permanent flow identity. */
  id: string;
  key: string;
  description?: string;
}>;

const taskVersion = "1.0.0";

const textLiteral = (value: string) =>
  ({ kind: "literal", literal: { type: "text", value } }) as const;

export type DefaultSaveFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The record type the form saves: `key` in the owning definition or `definition.key:key`. */
    recordType: string;
    /** `create` saves the form's values as a new record; `update` saves them onto `record`. */
    mode: "create" | "update";
  }>;

/**
 * The default Save flow of one form: one `record.save` task. The invoking form supplies its
 * answers as the `values` input and, when it edits a record, that record as the `record` input, so
 * a form binding maps both by name and no save is hidden in the page.
 */
export const defaultSaveFlowSource = (input: DefaultSaveFlowInput): SourceFlow => ({
  contractVersion: flowContractVersion,
  id: input.id,
  key: input.key,
  ...(input.description === undefined ? {} : { description: input.description }),
  labels: {},
  execution: "interactive",
  runAs: { kind: "initiator" },
  inputs: {
    ...(input.mode === "update"
      ? { record: { type: "record_reference", recordTypeIds: [input.recordType], required: true } }
      : {}),
    values: { type: "json", required: true },
  },
  variables: {},
  triggers: [],
  tasks: [
    {
      id: "save",
      type: "record.save",
      version: taskVersion,
      properties: {
        record_type: textLiteral(input.recordType),
        ...(input.mode === "update"
          ? { record: { kind: "reference", reference: { source: "input", name: "record" } } }
          : {}),
        values: { kind: "reference", reference: { source: "input", name: "values" } },
      },
    },
  ],
  outputs: {
    record: {
      type: "record_reference",
      recordTypeIds: [input.recordType],
      value: { kind: "reference", reference: { source: "task_output", task: "save", key: "record" } },
    },
  },
  errors: [],
  finally: [],
});

export type DefaultQueryFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The declared query the flow reads: its alias in the owning definition. */
    query: string;
    /** The record type of the rows the query returns, for the typed `records` output. */
    recordType: string;
    /** The query's typed parameters; the invoking component supplies each by name. */
    parameters?: Readonly<
      Record<
        string,
        Readonly<{ type: SourceFlowInputType; required: boolean; recordTypeIds?: readonly string[] }>
      >
    >;
  }>;
type SourceFlowInputType = SourceFlow["inputs"][string]["type"];

/**
 * The default Query flow of one data component: one `record.query` task that reads the declared
 * query under the viewer's authority and returns its records. The component's parameters arrive as
 * the flow's own inputs of the same names.
 */
export const defaultQueryFlowSource = (input: DefaultQueryFlowInput): SourceFlow => ({
  contractVersion: flowContractVersion,
  id: input.id,
  key: input.key,
  ...(input.description === undefined ? {} : { description: input.description }),
  labels: {},
  execution: "interactive",
  runAs: { kind: "initiator" },
  inputs: Object.fromEntries(
    Object.entries(input.parameters ?? {}).map(([name, declaration]) => [
      name,
      {
        type: declaration.type,
        required: declaration.required,
        ...(declaration.recordTypeIds === undefined
          ? {}
          : { recordTypeIds: [...declaration.recordTypeIds] }),
      },
    ]),
  ),
  variables: {},
  triggers: [],
  tasks: [
    {
      id: "query",
      type: "record.query",
      version: taskVersion,
      properties: { query: textLiteral(input.query) },
    },
  ],
  outputs: {
    records: {
      type: "record_reference_list",
      recordTypeIds: [input.recordType],
      value: {
        kind: "reference",
        reference: { source: "task_output", task: "query", key: "records" },
      },
    },
  },
  errors: [],
  finally: [],
});

/**
 * The readable key a Call protected operation task uses for a registered platform-service
 * operation: the operation's own key under the platform namespace. A named action of a Module is
 * called by the action's own namespaced key, so neither is ever chosen by a release or an id.
 */
export const platformOperationKey = (operationKey: string): string => `platform.${operationKey}`;

export type DefaultOperationFlowInput = DefaultFlowIdentity &
  Readonly<{
    /** The operation's key: `platformOperationKey(...)` or a named action's namespaced key. */
    operation: string;
    /** The operation's typed inputs; the invoking form supplies each by name. */
    inputs: ProtectedOperationDescriptor["inputs"];
    /** The operation's typed results, returned to the caller as one value. */
    returnsResult?: boolean;
  }>;

/**
 * A flow of one Call protected operation task. With no `inputs` property the task passes the
 * flow's own inputs to the operation by name, so the flow's declarations are the operation's typed
 * input map and publication checks them against the operation's own declaration. A refused,
 * conflict, validation or uncertain result needs no task of its own: the default error handler
 * shows each safely.
 */
export const defaultOperationFlowSource = (input: DefaultOperationFlowInput): SourceFlow => ({
  contractVersion: flowContractVersion,
  id: input.id,
  key: input.key,
  ...(input.description === undefined ? {} : { description: input.description }),
  labels: {},
  execution: "interactive",
  runAs: { kind: "initiator" },
  inputs: Object.fromEntries(
    Object.entries(input.inputs).map(([name, declaration]) => [
      name,
      { type: declaration.type, required: declaration.required },
    ]),
  ),
  variables: {},
  triggers: [],
  tasks: [
    {
      id: "call",
      type: "operation.call",
      version: taskVersion,
      properties: { operation: textLiteral(input.operation) },
    },
  ],
  outputs:
    input.returnsResult === true
      ? {
          result: {
            type: "json",
            value: {
              kind: "reference",
              reference: { source: "task_output", task: "call", key: "result" },
            },
          },
        }
      : {},
  errors: [],
  finally: [],
});
