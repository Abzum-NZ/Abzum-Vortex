import {
  kindWords,
  lowerFirst,
  studioRecordPageChoices,
  studioRecordPageKinds,
  takenIds,
  type StudioRecordPageCommand,
} from "./application-record-page-kinds";
import { companions, resolveRecordType } from "./application-record-page-shared";
import { addDetail } from "./application-record-page-detail";
import { addList } from "./application-record-page-list";
import { addForm, addGuided } from "./application-record-page-form";
import { ensureHomeDashboard } from "./application-home-dashboard";
import {
  cleanName,
  judged,
  quoted,
  refuse,
  type Source,
  type StudioStructureContext,
  type StudioStructureResult,
} from "./application-structure-common";
import type { Plan } from "./application-record-plan";

export const addRecordPage = (
  context: StudioStructureContext,
  candidate: Source,
  command: StudioRecordPageCommand,
): StudioStructureResult => {
  const resolved = resolveRecordType(candidate, command.recordType);
  if (!studioRecordPageKinds.some((entry) => entry.kind === command.type))
    return refuse("Choose which page to add.");
  if (
    !studioRecordPageChoices(candidate)
      .find((choice) => choice.recordType === command.recordType)
      ?.kinds.includes(command.type)
  )
    return refuse(
      "This page needs actions the record type does not allow. Change Standard actions in Data first.",
    );
  if (command.addToMenu && (command.type === "detail" || command.type === "form_edit"))
    refuse(
      `${command.type === "detail" ? "A detail page" : "An edit form"} opens one ${lowerFirst(resolved.record.name)}, so it cannot be a menu entry. Add it without one.`,
    );
  const found = companions(candidate, resolved.qualified);
  // A record type can have several lists or boards; each further one needs a name of its own.
  const listName =
    (command.type !== "list" && command.type !== "board") ||
    command.name === undefined ||
    command.name.trim() === ""
      ? undefined
      : cleanName(command.name, "page");
  if (
    (command.type === "list" || command.type === "board") &&
    found.list.length > 0 &&
    listName === undefined
  )
    refuse(
      `${resolved.record.plural_name} already have a list: ${quoted(found.list[0]!.name)}. Give the new ${command.type} its own name.`,
    );
  if (
    listName !== undefined &&
    candidate.body.pages.some((entry) => entry.name.toLowerCase() === listName.toLowerCase())
  )
    refuse(
      `A page is already named ${quoted(listName)}. Give the new ${command.type} its own name.`,
    );
  const existing =
    command.type === "list" || command.type === "board"
      ? undefined
      : command.type === "detail"
        ? found.detail
        : command.type === "form_create"
          ? found.create
          : command.type === "form_edit"
            ? found.edit
            : candidate.body.pages.find(
                (entry) =>
                  entry.type === "guided_form" &&
                  "record_type" in entry &&
                  entry.record_type === resolved.qualified,
              );
  if (existing !== undefined)
    refuse(
      `${resolved.record.plural_name} already have ${/^[aeiou]/.test(kindWords[command.type]) ? "an" : "a"} ${kindWords[command.type]}: ${quoted(existing.name)}. Open it in Structure and change it there.`,
    );
  const plan: Plan = { source: candidate, details: [], taken: takenIds(candidate) };
  if (command.type === "list" || command.type === "board") {
    const companionCommand = { ...command, addToMenu: false };
    if (found.detail === undefined) addDetail(context, plan, resolved, companionCommand);
    if (found.create === undefined && resolved.record.standard_actions.includes("create"))
      addForm(context, plan, resolved, companionCommand, "create");
    // The Edit form belongs with List, Board, Detail and Create: a member can change a record from
    // the detail page's header and from each row's menu.
    if (found.edit === undefined && resolved.record.standard_actions.includes("update"))
      addForm(context, plan, resolved, companionCommand, "update");
  }
  const page =
    command.type === "list"
      ? addList(context, plan, resolved, command, listName)
      : command.type === "board"
        ? addList(context, plan, resolved, command, listName, true)
        : command.type === "detail"
          ? addDetail(context, plan, resolved, command)
          : command.type === "guided"
            ? addGuided(context, plan, resolved, command)
            : addForm(
                context,
                plan,
                resolved,
                command,
                command.type === "form_create" ? "create" : "update",
              );
  ensureHomeDashboard(context, plan, resolved.qualified);
  return {
    kind: "applied",
    source: judged(plan.source),
    select: { kind: "page", pageAlias: page.id },
    details: plan.details,
    message: `The ${kindWords[command.type]} ${quoted(page.name)} for ${resolved.record.plural_name.toLowerCase()} was added.`,
  };
};
