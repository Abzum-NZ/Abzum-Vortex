import { isRecord, type JsonValue } from "@vortex/platform/schema";
import type { FlowDispatchResult, FlowRuntimeState } from "../flow-runtime/flow-runtime";
import type { FlowConfirmAnswer, FlowConfirmIntent } from "../flow-runtime/intents";
import type { FieldOption } from "../controls/form-context";
import type { AgentButton, AgentControl, AgentGrid } from "./page-agent-controls";
import { createHeadlessPageDriver, type AgentGesture } from "./page-driver";

type JsonSchema = Readonly<Record<string, JsonValue>>;
/** A tool's answer: plain data the agent reads. */
type ToolAnswer = Readonly<Record<string, unknown>>;

/** One tool the page offers an agent, generated from the controls the page shows now. */
export type PageAgentTool = Readonly<{
  name: PageAgentToolName;
  description: string;
  inputSchema: Readonly<{
    type: "object";
    properties: Readonly<Record<string, JsonSchema>>;
    required: readonly string[];
    additionalProperties: false;
  }>;
  /** A tool that only reads is announced as such; every other tool is announced as consequential. */
  readOnly?: true;
}>;

type PageAgentToolName =
  | "read_page"
  | "set_field"
  | "list_options"
  | "click"
  | "open_row"
  | "row_action"
  | "edit_cell"
  | "select_rows"
  | "bulk_action";

/** The page an agent acts on: its runtime state and the person's own confirmation on it. */
export type AgentPage = Readonly<{
  state: FlowRuntimeState;
  confirm: (confirmation: FlowConfirmIntent, signal?: AbortSignal) => Promise<FlowConfirmAnswer>;
}>;

const text = (description: string): JsonSchema => ({ type: "string", description });
const anyValue: JsonSchema = {
  description:
    'The value as the field stores it: text, a whole number, decimal and money amounts as text ("12500.50"), true or false, an ISO date, an option or record id from list_options, a list of option ids, or null to clear it.',
};
const schema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): PageAgentTool["inputSchema"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const buttonsOf = (controls: readonly AgentControl[]): AgentButton[] =>
  controls.filter((control): control is AgentButton => control.kind === "button");
const gridsOf = (controls: readonly AgentControl[]): AgentGrid[] =>
  controls.filter((control): control is AgentGrid => control.kind === "grid");

/** The kinds of controls a page's model holds, which decide the tools it offers. */
export type PageAgentToolKinds = Readonly<{ forms: boolean; buttons: boolean; grids: boolean }>;

/**
 * The tools of a page, generated from the controls its model holds. They name no control
 * themselves: `read_page` lists the forms, fields, buttons and grids the person sees now, by id,
 * and each tool acts on one of them through the same flow, runner and gate as the person's own
 * gesture on that control. The set stays the same while the page is open, so the agent's tools are
 * registered once per page.
 */
export function pageAgentTools(kinds: PageAgentToolKinds): readonly PageAgentTool[] {
  const tools: PageAgentTool[] = [
    {
      name: "read_page",
      description:
        "Reads the page as the person sees it: its forms with their fields and values, its buttons and whether they can be used, its grids with the rows on screen, and the messages shown. Use the ids it gives in the other tools.",
      inputSchema: schema({}, []),
      readOnly: true,
    },
  ];
  if (kinds.forms)
    tools.push(
      {
        name: "set_field",
        description:
          "Sets one field of a form, as the person typing or choosing it would; the field's own change flow runs. A hidden, read-only or disabled field refuses.",
        inputSchema: schema(
          {
            form: text("The form, by its id from read_page."),
            field: text("The field, by its key from read_page."),
            value: anyValue,
          },
          ["form", "field", "value"],
        ),
      },
      {
        name: "list_options",
        description:
          "Lists the options a choice or link field offers now, read the way its picker reads them; set_field takes one of their values.",
        inputSchema: schema(
          {
            form: text("The form, by its id from read_page."),
            field: text("The field, by its key from read_page."),
            search: text("Optional search text."),
          },
          ["form", "field"],
        ),
        readOnly: true,
      },
    );
  if (kinds.buttons || kinds.forms)
    tools.push({
      name: "click",
      description:
        "Clicks a button by its id from read_page, as the person would. A disabled button refuses. A delete, bulk change or back-end run waits for the person to confirm it on the page.",
      inputSchema: schema({ component: text("The button, by its id from read_page.") }, [
        "component",
      ]),
    });
  if (kinds.grids)
    tools.push(
      {
        name: "open_row",
        description: "Opens a row of a grid, as a click on the row does.",
        inputSchema: schema(
          {
            grid: text("The grid, by its id from read_page."),
            record: text("The row's record id from read_page."),
          },
          ["grid", "record"],
        ),
      },
      {
        name: "row_action",
        description:
          "Runs one of a row's actions (for example Delete), as its row command does; read_page lists each row's actions. A delete waits for the person to confirm it on the page.",
        inputSchema: schema(
          {
            grid: text("The grid, by its id from read_page."),
            record: text("The row's record id."),
            action: text("The row action, by its key from read_page."),
          },
          ["grid", "record", "action"],
        ),
      },
      {
        name: "edit_cell",
        description:
          "Edits one cell of a grid in place, as the person's in-place edit does; only an editable column of a row the person may change takes a value.",
        inputSchema: schema(
          {
            grid: text("The grid, by its id from read_page."),
            record: text("The row's record id."),
            field: text("The column's field."),
            value: anyValue,
          },
          ["grid", "record", "field", "value"],
        ),
      },
      {
        name: "select_rows",
        description: "Ticks or unticks rows of a grid for a bulk action.",
        inputSchema: schema(
          {
            grid: text("The grid, by its id from read_page."),
            records: { type: "array", items: { type: "string" }, description: "Record ids." },
            selected: { type: "boolean", description: "False unticks; ticks when left out." },
          },
          ["grid", "records"],
        ),
      },
      {
        name: "bulk_action",
        description:
          "Runs a grid's bulk action over its ticked rows; it waits for the person to confirm it on the page.",
        inputSchema: schema(
          {
            grid: text("The grid, by its id from read_page."),
            action: text("The bulk action, by its key from read_page."),
          },
          ["grid", "action"],
        ),
      },
    );
  return tools;
}

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const stringOf = (input: Readonly<Record<string, unknown>>, name: string): string | undefined =>
  typeof input[name] === "string" ? input[name] : undefined;
const refused = (reason: string) => ({ outcome: "refused", reason });

/** What one run came to, in the words the agent reads. */
const describeResult = (result: FlowDispatchResult): ToolAnswer => {
  switch (result.kind) {
    case "finished":
      return {
        outcome: result.failure === undefined ? result.descriptor.outcome : "failed",
        ...(result.failure === undefined ? {} : { failure: result.failure.code }),
        ...(result.descriptor.outputs === "available" ? { outputs: result.outputs } : {}),
      };
    case "refused":
      return {
        outcome: "refused",
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    case "unknown":
      return {
        outcome: "unknown",
        reason:
          "The page could not tell whether the server finished. Repeat the same call: a retry reaches the same run and commits once.",
      };
    case "cells_refused":
      return { outcome: "refused", reason: `${result.problems.length} cells were refused.` };
    default:
      return { outcome: result.kind };
  }
};

/**
 * Carries out one agent gesture on the page: the controls it uses are claimed for the agent, so the
 * runs the gesture starts go to the agent endpoint and use the agent's driver, and the call answers
 * once those runs have finished (a confirmation waits for the person).
 */
const gesture = async (
  page: AgentPage,
  controls: readonly string[],
  act: () => unknown,
  signal?: AbortSignal,
): Promise<ToolAnswer> => {
  const results: FlowDispatchResult[] = [];
  const driver = createHeadlessPageDriver(page.confirm);
  let running = 0;
  let idle: (() => void) | undefined;
  const claim: AgentGesture = {
    driver,
    started: () => {
      running += 1;
    },
    settled: (result) => {
      results.push(result);
      running -= 1;
      if (running === 0) idle?.();
    },
  };
  const releases = controls.map((control) => page.state.agent.claim(control, claim));
  try {
    const acted = act();
    if (acted instanceof Promise) await acted;
    // A gesture's runs start in its own turn; one more task lets a debounced or deferred start in.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (running > 0)
      await new Promise<void>((resolve) => {
        idle = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
  } finally {
    for (const release of releases) release();
  }
  const record = driver.record();
  return {
    runs: results.map(describeResult),
    ...(record.messages.length === 0 ? {} : { messages: record.messages }),
    ...(record.navigated.length === 0 ? {} : { navigated: record.navigated }),
  };
};

/** What the person sees on the page now, for `read_page`. */
const readPage = (state: FlowRuntimeState): ToolAnswer => ({
  forms: state.agent.forms().map((form) => ({
    form: form.formId,
    ...(form.label === undefined ? {} : { label: form.label }),
    fields: form
      .describe()
      .filter((field) => field.refusal !== "hidden")
      .map((field) => ({
        field: field.key,
        label: field.label,
        value: field.value,
        required: field.required,
        ...(field.refusal === undefined ? {} : { state: field.refusal }),
        ...(field.hasOptions ? { options: "list_options" } : {}),
        ...(field.error === undefined ? {} : { error: field.error }),
      })),
  })),
  buttons: buttonsOf(state.agent.controls()).flatMap((button) => {
    const refusal = button.refusal();
    return refusal === "hidden"
      ? []
      : [{ component: button.id, label: button.label, enabled: refusal === undefined }];
  }),
  grids: gridsOf(state.agent.controls()).map((grid) => ({
    grid: grid.id,
    label: grid.label,
    columns: grid.columns(),
    rows: grid.rows(),
    rowActions: grid.rowActions(),
    bulkActions: grid.bulkActions(),
    opensRows: grid.open !== undefined,
  })),
  messages: state.messages.list().map((message) => ({
    target: message.target,
    ...(message.component === undefined ? {} : { component: message.component }),
    severity: message.severity,
    text: message.text,
  })),
});

/** Runs one page tool for the agent; every refusal names its reason. */
export async function runPageAgentTool(
  page: AgentPage,
  name: string,
  input: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<ToolAnswer> {
  const { state } = page;
  if (name === "read_page") return readPage(state);
  if (name === "set_field" || name === "list_options") {
    const formId = stringOf(input, "form");
    const fieldKey = stringOf(input, "field");
    const form = state.agent.forms().find((candidate) => sameId(candidate.formId, formId ?? ""));
    if (form === undefined || fieldKey === undefined) return refused("not_on_page");
    const field = form.describe().find((candidate) => candidate.key === fieldKey);
    if (field === undefined) return refused("not_on_page");
    if (field.refusal === "hidden") return refused("hidden");
    if (name === "list_options") {
      if (!field.hasOptions) return refused("no_options");
      const search = stringOf(input, "search");
      const read: { options?: readonly FieldOption[] | undefined } = {};
      const outcome = await gesture(
        page,
        [field.control],
        async () => {
          read.options = await form.options(fieldKey, search);
        },
        signal,
      );
      return { ...outcome, options: read.options ?? [] };
    }
    let written: ReturnType<typeof form.write> | undefined;
    const outcome = await gesture(
      page,
      [field.control],
      () => {
        written = form.write(fieldKey, input.value, "agent");
      },
      signal,
    );
    if (written?.kind !== "set") return refused(written?.reason ?? "not_on_page");
    const after = form.describe().find((candidate) => candidate.key === fieldKey);
    return {
      outcome: "set",
      ...outcome,
      ...(after?.error === undefined ? {} : { error: after.error }),
    };
  }
  if (name === "click") {
    const button = buttonsOf(state.agent.controls()).find((candidate) =>
      sameId(candidate.id, stringOf(input, "component") ?? ""),
    );
    if (button === undefined) return refused("not_on_page");
    const refusal = button.refusal();
    if (refusal !== undefined) return refused(refusal);
    return gesture(
      page,
      button.formId === undefined ? [button.id] : [button.id, button.formId],
      () => button.activate(),
      signal,
    );
  }
  const grid = gridsOf(state.agent.controls()).find((candidate) =>
    sameId(candidate.id, stringOf(input, "grid") ?? ""),
  );
  if (grid === undefined) return refused("not_on_page");
  const record = stringOf(input, "record");
  switch (name) {
    case "open_row": {
      const open = grid.open;
      if (open === undefined) return refused("opens_no_rows");
      if (record === undefined || !grid.rows().some((row) => sameId(row.record, record)))
        return refused("not_on_page");
      return gesture(page, [grid.id], () => open(record), signal);
    }
    case "row_action": {
      const action = stringOf(input, "action");
      if (record === undefined || action === undefined) return refused("not_on_page");
      let answer: unknown;
      const outcome = await gesture(
        page,
        [grid.id],
        () => {
          answer = grid.act(record, action);
          return answer;
        },
        signal,
      );
      return isRecord(answer) && typeof answer.refused === "string"
        ? refused(answer.refused)
        : outcome;
    }
    case "edit_cell": {
      const field = stringOf(input, "field");
      if (record === undefined || field === undefined) return refused("not_on_page");
      let edited: Awaited<ReturnType<AgentGrid["edit"]>> | undefined;
      const outcome = await gesture(
        page,
        [grid.id],
        async () => {
          edited = await grid.edit(record, field, (input.value ?? null) as JsonValue);
        },
        signal,
      );
      return edited?.kind === "saved"
        ? { outcome: "saved", ...outcome }
        : { ...refused(edited?.message ?? "not_available"), ...outcome };
    }
    case "select_rows": {
      const records = input.records;
      if (!Array.isArray(records) || !records.every((item) => typeof item === "string"))
        return refused("invalid_value");
      return grid.select(records, input.selected !== false)
        ? { outcome: "selected" }
        : refused("not_selectable");
    }
    case "bulk_action": {
      const action = stringOf(input, "action");
      if (!grid.bulkActions().some((candidate) => candidate.action === action))
        return refused("not_offered");
      if (!grid.rows().some((row) => row.selected)) return refused("nothing_selected");
      return gesture(page, [grid.id], () => grid.bulk(action!), signal);
    }
    default:
      return refused("unknown_tool");
  }
}
