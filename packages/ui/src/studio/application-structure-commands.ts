import {
  applicationSourceDocumentSchema,
  applicationUses,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourceItemTree,
  sourcePageItems,
  sourcePageShell,
  type SourceItem,
} from "@vortex/platform/schema";
import { removeFlowBindingsOf } from "@vortex/platform/schema";
import {
  studioPlacementRemovalReference,
  type StudioCompositionRemovalReason,
} from "./application-composition-commands";
import { sourceNames, type StudioPlacementReference } from "./composition-references";
import type { StudioSemanticSelection } from "./semantic-selection";
import { applyStudioItemLabels } from "./application-item-labels";
import {
  blockItem,
  cleanName,
  emptyPageData,
  pageData,
  judged,
  blockRelease,
  placeNewPage,
  quoted,
  refuse,
  StructureRefusal,
  uniqueKey,
  type Navigation,
  type Source,
  type StudioStructureContext,
  type StudioStructureResult,
} from "./application-structure-common";
import { addRecordPage } from "./application-record-pages";
import { takenIds, type StudioRecordPageCommand } from "./application-record-page-kinds";
import {
  ensureDetailEdit,
  ensureListEdit,
  resolveRecordType,
} from "./application-record-page-shared";
import { ensureFormCancel } from "./application-record-page-form";
import { ensureHomeDashboard } from "./application-home-dashboard";
import type { Plan } from "./application-record-plan";
import { movePage, type StudioPageLayoutCommand } from "./application-page-layout";
import { editLayoutOutlet, type StudioLayoutOutletCommand } from "./application-layout-outlets";
import { placeMenuShell, placementsOf } from "@vortex/platform/schema";
export {
  studioLayoutOutletTargets,
  studioLayoutOutletPlacementUses,
  type StudioLayoutOutletValues,
} from "./application-layout-outlets";

/**
 * The Structure tab's edits: add, rename and remove pages and layouts, add the pages of a record
 * type (application-record-pages.ts), and choose the home page.
 * Each edit is applied to a copy of the draft, keeps every reference intact (a removed page takes
 * its menu entries and its blocks' flow bindings with it) and is judged by the source schema
 * before it reaches the draft history. A refusal says where the problem is, in words a builder
 * reads, and changes nothing.
 */

export type { StudioStructureContext, StudioStructureResult } from "./application-structure-common";

export type StudioStructureCommand =
  | (Readonly<{ kind: "add_page"; name: string; shellAlias: string | null; addToMenu: boolean }> &
      (Readonly<{ type: "dashboard" }> | Readonly<{ type: "form"; recordType: string }>))
  | StudioRecordPageCommand
  | Readonly<{ kind: "add_shell"; name: string }>
  | Readonly<{
      kind: "rename";
      selection: Extract<StudioSemanticSelection, { kind: "page" | "shell" }>;
      name: string;
    }>
  | Readonly<{ kind: "remove_page"; pageAlias: string }>
  | Readonly<{ kind: "remove_shell"; shellAlias: string }>
  | Readonly<{ kind: "set_home_page"; pageAlias: string }>
  /** A form page's Cancel: the form_cancel flow and its binding, for an app made before it. */
  | Readonly<{ kind: "ensure_form_cancel"; pageAlias: string }>
  /** Edit in the detail header and each list's row menu, for an app whose edit page predates them. */
  | Readonly<{ kind: "ensure_record_page_actions"; recordType: string }>
  /** Fill the home dashboard with a count, recent records and a stage chart per record type. */
  | Readonly<{ kind: "fill_home"; recordType?: string }>
  | StudioPageLayoutCommand
  | StudioLayoutOutletCommand;

/** A layout a page can use. */
export type StudioStructureShellChoice = Readonly<{ shellAlias: string | null; label: string }>;

/** The menu without the page's entries; a heading left with no entries goes too. */
const withoutPageEntries = (items: Navigation, pageKey: string): Navigation =>
  items.flatMap((item): Navigation => {
    if (item.type === "page") return item.page === pageKey ? [] : [item];
    if (item.type !== "heading") return [item];
    const children = withoutPageEntries(item.children, pageKey);
    return children.length === 0 ? [] : [{ ...item, children }];
  });

const flowReferenceWords: Readonly<Record<StudioCompositionRemovalReason, string>> = {
  flow_input: "supplies an input a flow reads",
  flow_form: "is the form a flow waits for",
  flow_component: "is refreshed or filtered by a flow",
  flow_panel: "is a panel a flow opens",
  required_slot: "fills a required area",
  required_field: "contains an input for a required field with no default value",
  content_outlet: "holds a content outlet of its layout",
  unresolved_target: "is named by a flow step that cannot be checked",
};

/** The flow, and its step, that names a block, in words. */
export const flowStepWords = (reference: StudioPlacementReference): string =>
  reference.flow === undefined
    ? ""
    : reference.step === undefined
      ? ` (flow ${quoted(reference.flow)})`
      : ` (flow ${quoted(reference.flow)}, step ${quoted(reference.step)})`;

/**
 * Blocks leaving the draft: their own flow bindings go with them; a flow task that still targets
 * one of them refuses the removal, naming the block.
 */
const removeBlocks = (
  context: StudioStructureContext,
  source: Source,
  leaving: readonly SourceItem[],
  what: string,
): void => {
  const aliases = new Set(placementsOf(context.source).map(({ item }) => item.props.id));
  const removed = new Set(leaving.map((item) => item.props.id));
  removeFlowBindingsOf(source.body, removed);
  for (const item of leaving) {
    const reference = studioPlacementRemovalReference(source, item.props.id, aliases);
    if (reference !== undefined) {
      const block =
        context.describePlacement({ block: item.props.vortex.block, settings: settingsOf(item) }) ??
        "A block";
      refuse(
        `${what} cannot be removed: its block ${quoted(block)} ${flowReferenceWords[reference.reason]}${flowStepWords(reference)}. Change that flow first.`,
      );
    }
  }
};

/** A block's own settings (not its name, slots or layout), for naming it to a person. */
const settingsOf = (item: SourceItem): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(item.props).filter(
      ([key, value]) => key !== "id" && key !== "vortex" && !Array.isArray(value),
    ),
  );

/** The layouts a page can use: the application's layouts, then the platform's default frame. */
export const studioStructureShellChoices = (
  source: Source,
): readonly StudioStructureShellChoice[] => [
  ...source.body.shells.map((shell) => ({
    shellAlias: shell.id as string | null,
    label: shell.name,
  })),
  { shellAlias: null, label: "Platform default frame" },
];

/** The layout a new page starts in: the one the home page uses. */
export const studioStructureDefaultShell = (source: Source): string | null => {
  const home = source.body.pages.find((page) => page.key === source.body.home_page);
  return home === undefined ? null : sourcePageShell(home.composition);
};

const addPage = (
  context: StudioStructureContext,
  candidate: Source,
  command: Extract<StudioStructureCommand, { kind: "add_page" }>,
): StudioStructureResult => {
  const name = cleanName(command.name, "page");
  let composition = emptyPageData(context.source, command.shellAlias);
  const home = candidate.body.pages.find((page) => page.key === candidate.body.home_page);
  if (home === undefined)
    refuse(
      "The application's home page is missing, so a new page has no access rule to start from.",
    );
  if (command.type === "form") {
    const recordExists = candidate.body.modules.some((module) =>
      module.record_types.some((record) => `${module.key}:${record.key}` === command.recordType),
    );
    if (!recordExists)
      refuse("Choose a record type from a module this application owns for the form's context.");
    const form = blockRelease(
      context.catalogue,
      PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
    );
    const button = blockRelease(
      context.catalogue,
      PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE,
    );
    if (form === undefined || button === undefined)
      refuse("The block catalogue has no form or submit button, so no page was added.");
    const taken = sourceNames(candidate);
    const formAlias = uniqueKey(name, "form_", taken, 140);
    const submitAlias = uniqueKey(`${formAlias}_submit`, "", taken, 160);
    composition = pageData(
      context,
      candidate,
      command.shellAlias,
      [
        blockItem(
          form!,
          formAlias,
          { title: name },
          {
            content: [
              blockItem(
                button!,
                submitAlias,
                { label: "Submit", action_kind: "submit", variant: "primary" },
                {},
              ),
            ],
          },
        ),
      ],
      name,
    );
  }
  // Who can open a new page starts as who can open the home page. Its submit flow is authored separately.
  const placed = placeNewPage(
    candidate,
    name,
    {
      type: command.type,
      permission: home!.permission,
      ...(command.type === "form" ? { record_type: command.recordType } : {}),
    },
    composition,
    command.addToMenu,
  );
  return {
    kind: "applied",
    source: judged(placed.source),
    select: { kind: "page", pageAlias: placed.page.id },
    details: [],
    message: `Page ${quoted(name)} added${command.addToMenu ? " to the menu" : ""}.`,
  };
};

const addShell = (
  context: StudioStructureContext,
  candidate: Source,
  command: Extract<StudioStructureCommand, { kind: "add_shell" }>,
): StudioStructureResult => {
  const name = cleanName(command.name, "layout");
  const shell = placeMenuShell(context.catalogue, candidate, name);
  return {
    kind: "applied",
    source: judged(candidate),
    select: { kind: "shell", shellAlias: shell.id },
    details: [],
    message: `Layout ${quoted(name)} added.`,
  };
};

const removePage = (
  context: StudioStructureContext,
  candidate: Source,
  pageAlias: string,
): StudioStructureResult => {
  const page = context.source.body.pages.find((entry) => entry.id === pageAlias);
  if (page === undefined) return refuse("That page is no longer in the draft.");
  // Everything outside the page that still names it refuses the removal; its menu entries go with it.
  const where = applicationUses(
    context.source,
    { kind: "page", pageAlias },
    (path) => path[1] === "navigation",
  );
  if (where.length > 0)
    refuse(
      `The page ${quoted(page.name)} is still used in ${where.length === 1 ? "one place" : `${where.length} places`}, so it was not removed. Change those first.`,
      where,
    );
  candidate.body.pages = candidate.body.pages.filter((entry) => entry.id !== pageAlias);
  candidate.body.navigation = withoutPageEntries(candidate.body.navigation, page.key);
  removeBlocks(
    context,
    candidate,
    sourcePageItems(page.composition),
    `The page ${quoted(page.name)}`,
  );
  return {
    kind: "applied",
    source: judged(candidate),
    select: null,
    details: [],
    message: `Page ${quoted(page.name)} removed, with its menu entries.`,
  };
};

const removeShell = (
  context: StudioStructureContext,
  candidate: Source,
  shellAlias: string,
): StudioStructureResult => {
  const shell = context.source.body.shells.find((entry) => entry.id === shellAlias);
  if (shell === undefined) return refuse("That layout is no longer in the draft.");
  const users = context.source.body.pages.filter(
    (page) => sourcePageShell(page.composition) === shellAlias,
  );
  if (users.length > 0)
    refuse(
      `The layout ${quoted(shell.name)} is used by ${users.length === 1 ? "the page" : `${users.length} pages, including`} ${quoted(users[0]!.name)}. Move or remove those pages first.`,
    );
  candidate.body.shells = candidate.body.shells.filter((entry) => entry.id !== shellAlias);
  removeBlocks(
    context,
    candidate,
    sourceItemTree(shell.layout.content),
    `The layout ${quoted(shell.name)}`,
  );
  return {
    kind: "applied",
    source: judged(candidate),
    select: null,
    details: [],
    message: `Layout ${quoted(shell.name)} removed.`,
  };
};

/** Applies one Structure edit to the draft, or refuses it with a located message. */
export const applyStudioStructureCommand = (
  context: StudioStructureContext,
  command: StudioStructureCommand,
): StudioStructureResult => {
  try {
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(context.source));
    switch (command.kind) {
      case "add_page":
        return addPage(context, candidate, command);
      case "add_record_page":
        return addRecordPage(context, candidate, command);
      case "add_shell":
        return addShell(context, candidate, command);
      case "add_layout_outlet":
      case "edit_layout_outlet":
      case "remove_layout_outlet":
        return editLayoutOutlet(context, candidate, command);
      case "remove_page":
        return removePage(context, candidate, command.pageAlias);
      case "remove_shell":
        return removeShell(context, candidate, command.shellAlias);
      case "move_page":
        return movePage(context, candidate, command);
      case "set_home_page": {
        const page = candidate.body.pages.find((entry) => entry.id === command.pageAlias);
        if (page === undefined) return refuse("That page is no longer in the draft.");
        if (candidate.body.home_page === page.key)
          return refuse(`${quoted(page.name)} is already the home page.`);
        candidate.body.home_page = page.key;
        return {
          kind: "applied",
          source: judged(candidate),
          select: { kind: "page", pageAlias: page.id },
          details: [],
          message: `${quoted(page.name)} is now the home page.`,
        };
      }
      case "ensure_form_cancel": {
        const page = candidate.body.pages.find((entry) => entry.id === command.pageAlias);
        if (page === undefined) return refuse("That form page is no longer in the draft.");
        const plan: Plan = { source: candidate, details: [], taken: takenIds(candidate) };
        if (!ensureFormCancel(context, plan, page))
          return refuse(`${quoted(page.name)} already offers Cancel.`);
        return {
          kind: "applied",
          source: judged(plan.source),
          select: { kind: "page", pageAlias: page.id },
          details: plan.details,
          message: plan.details[0] ?? `${quoted(page.name)} now offers Cancel.`,
        };
      }
      case "ensure_record_page_actions": {
        const resolved = resolveRecordType(candidate, command.recordType);
        const plan: Plan = { source: candidate, details: [], taken: takenIds(candidate) };
        ensureDetailEdit(context, plan, resolved);
        ensureListEdit(context, plan, resolved);
        if (plan.details.length === 0)
          return refuse(
            `The pages of ${quoted(resolved.record.plural_name)} already offer Edit wherever an edit page exists.`,
          );
        return {
          kind: "applied",
          source: judged(plan.source),
          select: null,
          details: plan.details,
          message: plan.details[0]!,
        };
      }
      case "fill_home": {
        const plan: Plan = { source: candidate, details: [], taken: takenIds(candidate) };
        if (!ensureHomeDashboard(context, plan, command.recordType))
          return refuse("The home page already shows its dashboard.");
        return {
          kind: "applied",
          source: plan.source,
          select: null,
          details: plan.details,
          message: `The home page now shows ${plan.details.length === 0 ? "the dashboard" : plan.details[0]!.replace(/^A query /u, "a query ")}.`,
        };
      }
      case "rename": {
        const what = command.selection.kind === "page" ? "page" : "layout";
        const name = cleanName(command.name, what);
        const result = applyStudioItemLabels(
          context.source,
          command.selection,
          name,
          context.source.body.description,
        );
        if (result.kind === "not_found") return refuse(`That ${what} is no longer in the draft.`);
        if (result.kind === "invalid")
          return refuse(
            `The ${what} name was refused (${result.issues[0]?.message ?? "invalid"}). Nothing was changed.`,
          );
        return {
          kind: "applied",
          source: result.source,
          select: command.selection,
          details: [],
          message: `Renamed to ${quoted(name)}.`,
        };
      }
    }
  } catch (error) {
    if (error instanceof StructureRefusal)
      return { kind: "refused", message: error.message, where: error.where };
    throw error;
  }
};
