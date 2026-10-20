import {
  isPageParameterName,
  sourcePageItems,
  type ApplicationSourceDocument,
  type RecordsTableBoardMode,
  type SourceFlow,
} from "@vortex/platform/schema";
import { applyStudioFlowCreate } from "./application-flow-create";
import { companions } from "./application-record-pages";

type QuickAddResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** The flow input that carries the column's stage. */
const stageInputName = "stage";
const stageValue = `{{ inputs.${stageInputName} }}`;

type NavigateProperties = Record<string, unknown> & {
  page?: { kind?: unknown; literal?: { value?: unknown } };
  parameters?: { kind?: unknown; entries?: Record<string, unknown> };
};

/** The one Navigate task of a flow that only opens this page, if the flow is one. */
const openPageTask = (flow: SourceFlow, pageKey: string): NavigateProperties | undefined => {
  if (flow.execution !== "interactive" || flow.recordInput !== undefined || flow.tasks.length !== 1)
    return undefined;
  const task = flow.tasks[0] as { type?: unknown; properties?: NavigateProperties };
  const page = task.properties?.page;
  return task.type === "interface.navigate" &&
    page?.kind === "literal" &&
    page.literal?.value === pageKey
    ? task.properties
    : undefined;
};

/**
 * Quick add on a board: each column a new record may start in opens the record type's existing
 * create form with that stage chosen. The create form's stage input publishes the page parameter,
 * and the one flow that opens the create form takes the stage as an optional input and is bound to
 * the board's card additions; when the draft has no such flow, one is made. Everything is ordinary
 * source, edited like any other; the binding stays when quick add is switched off and is reused
 * when it is switched on. Nothing already authored is overwritten: a conflict is refused.
 */
export const ensureStudioBoardQuickAdd = (
  source: ApplicationSourceDocument,
  controlAlias: string,
  board: RecordsTableBoardMode,
): QuickAddResult => {
  if (board.quickAdd !== true || board.columnField === undefined)
    return { kind: "applied", source };
  if (
    source.body.flow_bindings.some(
      (binding) => binding.control === controlAlias && binding.event === "card_added",
    )
  )
    return { kind: "applied", source };
  const columnField = board.columnField;
  const separator = columnField.lastIndexOf(".");
  const recordType = columnField.slice(0, separator);
  const create = companions(source, recordType).create;
  if (create === undefined)
    return {
      kind: "refused",
      reason:
        "Adding from a column opens the create form of this record type, and it has none yet. Add a create form first.",
    };
  const items = sourcePageItems(create.composition);
  const stageInput = items.find(
    (item) =>
      typeof item.props["field"] === "string" &&
      item.props["field"].toLowerCase() === columnField.toLowerCase(),
  );
  if (stageInput === undefined)
    return {
      kind: "refused",
      reason: `The create form ${create.name} has no input for the board's stage field. Add it to the form first.`,
    };

  // The stage input publishes the page parameter the flow fills: the one it already publishes, or
  // one named after the stage field that no other input of the form publishes.
  const published = stageInput.props["publishes_parameter"];
  const parameter =
    typeof published === "string"
      ? published
      : columnField
          .slice(separator + 1)
          .toLowerCase()
          .slice(0, 40);
  if (typeof published !== "string") {
    if (!isPageParameterName(parameter))
      return {
        kind: "refused",
        reason: `The stage field's name cannot be a page address name, so ${create.name} cannot take the column's stage. Make its stage input publish a page parameter first.`,
      };
    if (
      items.some((item) => item !== stageInput && item.props["publishes_parameter"] === parameter)
    )
      return {
        kind: "refused",
        reason: `Another input of ${create.name} already publishes the page parameter ${parameter}. Make the stage input publish its own page parameter first.`,
      };
  }

  const candidate = structuredClone(source);
  if (typeof published !== "string") {
    const candidateInput = sourcePageItems(
      candidate.body.pages.find((page) => page.id === create.id)!.composition,
    ).find((item) => item.props.id === stageInput.props.id)!;
    candidateInput.props["publishes_parameter"] = parameter;
  }

  // The flow that opens the create form also opens it from a column: it takes the stage as an
  // optional input, so a control that opens the form without a stage keeps working.
  const opening = candidate.body.flows.find((flow) => openPageTask(flow, create.key) !== undefined);
  if (opening !== undefined) {
    const properties = openPageTask(opening, create.key)!;
    const declared = opening.inputs[stageInputName];
    if (declared !== undefined && declared.type !== "text")
      return {
        kind: "refused",
        reason: `The flow ${opening.labels.name} already has a ${stageInputName} input that is not text. Rename that input, then add from a column.`,
      };
    if (
      Object.entries(opening.inputs).some(
        ([name, input]) => name !== stageInputName && input.required,
      )
    )
      return {
        kind: "refused",
        reason: `The flow ${opening.labels.name} needs inputs a column cannot give. Make them optional, then add from a column.`,
      };
    const parameters = properties.parameters;
    if (parameters !== undefined && parameters.kind !== "map")
      return {
        kind: "refused",
        reason: `The flow ${opening.labels.name} fills the page parameters of ${create.name} another way. Fill them one by one, then add from a column.`,
      };
    const filled = parameters?.entries?.[parameter];
    if (filled !== undefined && filled !== stageValue)
      return {
        kind: "refused",
        reason: `The flow ${opening.labels.name} already fills the page parameter ${parameter} with another value. Change it to the stage, then add from a column.`,
      };
    if (declared === undefined)
      opening.inputs[stageInputName] = {
        type: "text",
        required: false,
      } as SourceFlow["inputs"][string];
    if (filled === undefined)
      properties.parameters = {
        kind: "map",
        entries: { ...parameters?.entries, [parameter]: stageValue },
      };
    const bound = applyStudioFlowCreate(
      candidate,
      {
        kind: "bind",
        controlAlias,
        event: "card_added",
        flowKey: opening.key,
        bindingInputs: { [stageInputName]: { kind: "caller", name: "value" } },
      },
      null,
    );
    return bound.kind === "applied"
      ? { kind: "applied", source: bound.source }
      : { kind: "refused", reason: bound.reason };
  }

  const flow = applyStudioFlowCreate(
    candidate,
    {
      kind: "control",
      controlAlias,
      event: "card_added",
      name: `Open ${create.name}`,
      description: `Opens ${create.name}, with the stage chosen when one is given.`,
      inputs: {
        [stageInputName]: { type: "text", required: false },
      } as unknown as SourceFlow["inputs"],
      tasks: [
        {
          id: "open_page",
          type: "interface.navigate",
          version: "1.0.0",
          properties: {
            page: { kind: "literal", literal: { type: "text", value: create.key } },
            parameters: { kind: "map", entries: { [parameter]: stageValue } },
          },
        },
      ] as unknown as SourceFlow["tasks"],
      outputs: {},
      bindingInputs: { [stageInputName]: { kind: "caller", name: "value" } },
    },
    null,
  );
  return flow.kind === "applied"
    ? { kind: "applied", source: flow.source }
    : { kind: "refused", reason: flow.reason };
};
