import {
  defaultNewDialogFlowSource,
  sourceItemTree,
  sourcePageItems,
  type ApplicationSourceDocument,
  type RecordsTableBoardMode,
  type SourceItem,
} from "@vortex/platform/schema";
import { applyStudioFlowCreate } from "./application-flow-create";
import { companions, placed } from "./application-record-pages";
import { takenIds } from "./application-record-page-kinds";

type QuickAddResult =
  | Readonly<{ kind: "applied"; source: ApplicationSourceDocument }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** The flow input that carries the column's stage. */
const stageInputName = "stage";

const formContainerType = "platform.renderer.form_container";

/** A fresh alias for a copied placement, unique among every id of the draft. */
const freshId = (base: string, taken: Set<string>): string => {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
};

/**
 * Quick add on a board: each column a new record may start in opens a small form in a dialog with
 * that stage chosen, and the form's answers create the card. The dialog form is a copy of the
 * record type's create form fields, placed beside the board and hidden from the page itself; the
 * one default flow shows it, saves the record, says "Saved" and refreshes. Everything is ordinary
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
  const stageFieldKey = columnField.slice(separator + 1);
  const create = companions(source, recordType).create;
  if (create === undefined)
    return {
      kind: "refused",
      reason:
        "Adding from a column shows the fields of the create form of this record type in a dialog, and it has none yet. Add a create form first.",
    };
  const createForm = sourcePageItems(create.composition).find(
    (item) => item.type === formContainerType,
  );
  if (createForm === undefined)
    return {
      kind: "refused",
      reason: `The create form ${create.name} has no form to copy. Add its form first.`,
    };
  const modules = source.body.modules;
  const record = modules
    .flatMap((module) => module.record_types.map((entry) => ({ module, entry })))
    .find(({ module, entry }) => `${module.key}:${entry.key}` === recordType)?.entry;
  if (record?.ownership_mode === "group")
    return {
      kind: "refused",
      reason: `${record.name} records belong to a Group the person chooses, so a column cannot add them in a dialog. Use the create form.`,
    };
  const fieldInputs = sourceItemTree([createForm]).filter(
    (item) => item !== createForm && typeof item.props["field"] === "string",
  );
  const stageInput = fieldInputs.find(
    (item) =>
      typeof item.props["field"] === "string" &&
      item.props["field"].toLowerCase() === columnField.toLowerCase(),
  );
  if (stageInput === undefined)
    return {
      kind: "refused",
      reason: `The create form ${create.name} has no input for the board's stage field. Add it to the form first.`,
    };

  const candidate = structuredClone(source);
  const holder = placed(candidate, controlAlias);
  if (holder === undefined)
    return { kind: "refused", reason: "The board is no longer on the page." };

  // The dialog form: the create form's field inputs, hidden on the page, each named by its field.
  const taken = takenIds(candidate);
  const formAlias = freshId(`${controlAlias}_quick_add_form`, taken);
  const copy = structuredClone(createForm) as SourceItem;
  copy.props.id = formAlias;
  copy.props.title = `New ${record?.name.toLowerCase() ?? "card"}`.slice(0, 120);
  const vortex = copy.props.vortex as {
    responsive?: { desktop?: Record<string, unknown> };
  };
  vortex.responsive = {
    ...vortex.responsive,
    desktop: { ...vortex.responsive?.desktop, visible: false },
  };
  copy.props.content = (copy.props.content as SourceItem[]).filter(
    (item) => typeof item.props["field"] === "string",
  );
  for (const item of sourceItemTree([copy])) {
    if (item === copy) continue;
    item.props.id = freshId(`${formAlias}_${String(item.props.id)}`, taken);
    const field = String(item.props["field"]);
    item.props["name"] = field.slice(field.lastIndexOf(".") + 1);
    // The dialog is not a page: its inputs never publish an address value.
    delete item.props["publishes_parameter"];
  }
  holder.siblings.splice(holder.siblings.indexOf(holder.item) + 1, 0, copy);

  const flow = defaultNewDialogFlowSource({
    id: "quick_add",
    key: "quick_add",
    recordType,
    ownershipMode: (record?.ownership_mode ?? "none") as
      "none" | "organization_account" | "inherited",
    form: formAlias,
    prefill: { input: stageInputName, field: stageFieldKey },
  });
  const made = applyStudioFlowCreate(
    candidate,
    {
      kind: "control",
      controlAlias,
      event: "card_added",
      name: `Add ${record?.name.toLowerCase() ?? "card"} from a column`,
      description: `Asks for the ${record?.name.toLowerCase() ?? "card"} in a dialog, with the stage of the column chosen, and creates it.`,
      inputs: flow.inputs,
      tasks: flow.tasks,
      outputs: flow.outputs,
      bindingInputs: { [stageInputName]: { kind: "caller", name: "value" } },
    },
    null,
  );
  return made.kind === "applied"
    ? { kind: "applied", source: made.source }
    : { kind: "refused", reason: made.reason };
};
