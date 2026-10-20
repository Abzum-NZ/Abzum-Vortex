import {
  applicationSourceDocumentSchema,
  applicationUses,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourceItemTree,
  sourcePageItems,
  sourcePageShell,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import {
  StoredCompositionRefusal,
  removeFlowBindingsOf,
  validateStoredShell,
  validateStoredZone,
} from "./stored-composition";
import {
  studioPlacementRemovalReference,
  type StudioCompositionRemovalReason,
} from "./application-composition-commands";
import type { StudioSemanticSelection } from "./semantic-selection";
import { applyStudioItemLabels } from "./application-item-labels";
import {
  blockItem,
  cleanName,
  emptyPageData,
  judged,
  newestRelease,
  placeNewPage,
  quoted,
  refuse,
  StructureRefusal,
  uniqueKey,
  type Navigation,
  type Page,
  type Shell,
  type Source,
  type StudioStructureContext,
  type StudioStructureResult,
} from "./application-structure-common";
import { addRecordPage, type StudioRecordPageCommand } from "./application-record-pages";
import { movePage, type StudioPageLayoutCommand } from "./application-page-layout";
import { editLayoutOutlet, type StudioLayoutOutletCommand } from "./application-layout-outlets";
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
  | Readonly<{ kind: "add_page"; name: string; shellAlias: string | null; addToMenu: boolean }>
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

/** Every block the draft places, with where it is, so a refusal can name it. */
const placementsOf = (source: Source) => [
  ...source.body.pages.flatMap((page) =>
    sourcePageItems(page.composition).map((item) => ({
      item,
      where: `page ${quoted(page.name)}`,
      page: page.id as string | undefined,
      shell: undefined as string | undefined,
    })),
  ),
  ...source.body.shells.flatMap((shell) =>
    sourceItemTree(shell.layout.content).map((item) => ({
      item,
      where: `layout ${quoted(shell.name)}`,
      page: undefined as string | undefined,
      shell: shell.id as string | undefined,
    })),
  ),
];

const flowReferenceWords: Readonly<Record<StudioCompositionRemovalReason, string>> = {
  flow_control: "is bound to a flow",
  flow_form: "is the form a flow waits for",
  flow_component: "is refreshed or filtered by a flow",
  flow_panel: "is a panel a flow opens",
  required_slot: "fills a required area",
  unresolved_target: "is named by a flow step that cannot be checked",
};

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
    const reason = studioPlacementRemovalReference(source, item.props.id, aliases);
    if (reason !== undefined) {
      const block =
        context.describePlacement({ block: item.props.vortex.block, settings: settingsOf(item) }) ??
        "A block";
      refuse(
        `${what} cannot be removed: its block ${quoted(block)} ${flowReferenceWords[reason]}. Change that flow first.`,
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
  const composition = emptyPageData(context.source, command.shellAlias);
  const home = candidate.body.pages.find((page) => page.key === candidate.body.home_page);
  if (home === undefined)
    refuse(
      "The application's home page is missing, so a new page has no access rule to start from.",
    );
  // A valid empty Puck page: no blocks, in the chosen frame. Who can open it starts as who can open the home page.
  const placed = placeNewPage(
    candidate,
    name,
    { type: "dashboard", permission: home!.permission },
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

/**
 * A layout: a frame with the application menu beside one optional content area, so any page, a new
 * empty one included, can use it. It is added to the candidate.
 */
const placeMenuShell = (
  catalogue: ImmutablePlatformBlockCatalogue,
  candidate: Source,
  name: string,
): Shell => {
  const body = candidate.body;
  if (body.shells.length >= 100) refuse("An application can have at most 100 layouts.");
  const container = newestRelease(
    catalogue,
    PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE_1_3_0,
  );
  const menu = newestRelease(
    catalogue,
    PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_NAVIGATION_BLOCK_RELEASE,
  );
  if (
    container === undefined ||
    !container.slots.some((slot) => slot.key === "content") ||
    !container.slots.some((slot) => slot.key === "menu") ||
    menu === undefined
  )
    refuse("The block catalogue has no frame block for a new layout, so none was added.");
  const key = uniqueKey(name, "", new Set(body.shells.map((shell) => shell.key)), 40);
  const id = uniqueKey(key, "shell_", new Set(body.shells.map((shell) => shell.id)), 160);
  const taken = new Set(placementsOf(candidate).map(({ item }) => item.props.id));
  const frameId = uniqueKey(key, "layout_", taken, 140);
  const menuId = uniqueKey(`${frameId}_menu`, "", taken, 160);
  const slotIds = new Set(
    body.shells.flatMap((shell) => shell.content_slots.map((slot) => slot.id)),
  );
  const content = container!.slots.find((slot) => slot.key === "content")!;
  const title = body.name.slice(0, 60);
  const shell = {
    id,
    key,
    name,
    presentation: {
      sidebar: { collapsible: "icon", default_collapsed: false },
      top_bar: {
        breadcrumbs: true,
        organization_switcher: true,
        application_switcher: true,
        account_menu: true,
        appearance_toggle: true,
      },
    },
    layout: {
      root: { props: { vortex: { slot_orders: {} } } },
      content: [
        blockItem(
          container!,
          frameId,
          {
            direction: "row",
            gap: "medium",
            padding: "medium",
            content_landmark: true,
            phone_direction: "column",
          },
          { menu: [blockItem(menu!, menuId, { title }, {})] },
        ),
      ],
    },
    content_slots: [
      {
        id: uniqueKey(`${key}_content`, "slot_", slotIds, 160),
        key: "content",
        label: "Content",
        required: false,
        allowed_child_categories: [...content.allowedChildCategories],
        parent_placement: frameId,
        parent_slot: "content",
      },
    ],
  } as unknown as Shell;
  try {
    validateStoredShell(catalogue, shell);
  } catch (error) {
    if (!(error instanceof StoredCompositionRefusal)) throw error;
    console.error("[studio] new layout refused", error.message);
    refuse("The new layout could not be built from the block catalogue, so none was added.");
  }
  body.shells.push(shell);
  return shell;
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

/**
 * A new application's starting frame, written into its definition: one layout with the
 * application menu (list pages added later go in it, and leave it when removed), and the home page
 * in that layout with a text saying what to do next. New pages start in the home page's layout.
 */
export const studioStarterFrame = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: Source,
):
  | Readonly<{ kind: "applied"; source: Source }>
  | Readonly<{ kind: "refused"; message: string }> => {
  try {
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(source));
    const shell = placeMenuShell(catalogue, candidate, "Main layout");
    const home = candidate.body.pages.find((page) => page.key === candidate.body.home_page);
    if (home === undefined)
      return refuse("The application's home page is missing, so it has no frame to start in.");
    const text = newestRelease(catalogue, PLATFORM_BLOCK_RELEASE_IDENTITIES.TEXT_BLOCK_RELEASE);
    if (text === undefined)
      return refuse("The block catalogue has no text block for the home page.");
    const items = [
      blockItem(
        text,
        "home_next_steps",
        {
          title: `Welcome to ${candidate.body.name}`.slice(0, 120),
          text:
            "This application has nothing to show yet. To build it, open it in Studio: add a record type in Data, " +
            "then add a List page for it in Structure. Each list page gets an entry in the menu. " +
            "Replace this text with your own home page when you are ready.",
        },
        {},
      ),
    ];
    try {
      validateStoredZone(catalogue, { items });
    } catch (error) {
      if (!(error instanceof StoredCompositionRefusal)) throw error;
      console.error("[studio] starter home page refused", error.message);
      refuse("The home page could not be built from the block catalogue.");
    }
    const composition = emptyPageData(candidate, shell.id);
    (composition.root.props as Record<string, unknown>)[shell.content_slots[0]!.id] = items;
    home.composition = composition as unknown as Page["composition"];
    return { kind: "applied", source: judged(candidate) };
  } catch (error) {
    if (error instanceof StructureRefusal) return { kind: "refused", message: error.message };
    throw error;
  }
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
    if (error instanceof StructureRefusal) {
      console.error("[studio] structure edit refused", error.cause);
      return { kind: "refused", message: error.message, where: error.where, cause: error.cause };
    }
    throw error;
  }
};
