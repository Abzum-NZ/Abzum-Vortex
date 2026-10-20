import {
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

/** The flow that opens the create form with the column's stage chosen. */
const quickAddFlowName = "Add card";

/**
 * Quick add on a board: each stage column opens the record type's existing create form with that
 * stage chosen. The create form's stage input publishes the page parameter the flow fills, and one
 * flow bound to the board's card additions navigates there. Both are ordinary source, edited like
 * any other; the flow stays when quick add is switched off and is reused when it is switched on.
 */
export const ensureStudioBoardQuickAdd = (
  source: ApplicationSourceDocument,
  controlAlias: string,
  board: RecordsTableBoardMode,
): QuickAddResult => {
  if (!board.quickAdd || board.columnField === undefined) return { kind: "applied", source };
  if (
    source.body.flow_bindings.some(
      (binding) => binding.control === controlAlias && binding.event === "card_added",
    )
  )
    return { kind: "applied", source };
  const separator = board.columnField.lastIndexOf(".");
  const recordType = board.columnField.slice(0, separator);
  const parameter = board.columnField
    .slice(separator + 1)
    .toLowerCase()
    .slice(0, 40);
  const create = companions(source, recordType).create;
  if (create === undefined)
    return {
      kind: "refused",
      reason:
        "Quick add opens the create form of this record type, and it has none yet. Add a create form first.",
    };
  const stageInput = sourcePageItems(create.composition).find(
    (item) =>
      typeof item.props["field"] === "string" &&
      item.props["field"].toLowerCase() === board.columnField!.toLowerCase(),
  );
  if (stageInput === undefined)
    return {
      kind: "refused",
      reason: `The create form ${create.name} has no input for the board's stage field. Add it to the form first.`,
    };
  const candidate = structuredClone(source);
  const candidateInput = sourcePageItems(
    candidate.body.pages.find((page) => page.id === create.id)!.composition,
  ).find((item) => item.props.id === stageInput.props.id)!;
  candidateInput.props["publishes_parameter"] = parameter;
  const flow = applyStudioFlowCreate(
    candidate,
    {
      kind: "control",
      controlAlias,
      event: "card_added",
      name: quickAddFlowName,
      description: `Opens ${create.name} with the stage of the column chosen.`,
      inputs: { stage: { type: "text", required: true } } as unknown as SourceFlow["inputs"],
      tasks: [
        {
          id: "open_page",
          type: "interface.navigate",
          version: "1.0.0",
          properties: {
            page: { kind: "literal", literal: { type: "text", value: create.key } },
            parameters: { kind: "map", entries: { [parameter]: "{{ inputs.stage }}" } },
          },
        },
      ] as unknown as SourceFlow["tasks"],
      outputs: {},
      bindingInputs: { stage: { kind: "caller", name: "value" } },
    },
    null,
  );
  return flow.kind === "applied"
    ? { kind: "applied", source: flow.source }
    : { kind: "refused", reason: flow.reason };
};
