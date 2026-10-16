import {
  applicationSourceDocumentSchema,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  readSourceItem,
  sourceItemTree,
  sourcePageItems,
  sourcePageShell,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import {
  StoredCompositionRefusal,
  studioPlacementRemovalReference,
  syncStoredBlockDependencies,
  validateStoredShell,
  type StudioCompositionRemovalReason,
  type StudioPlacementDescriber,
  type StudioSemanticSelection,
} from "@vortex/ui/studio";
import { applyStudioItemLabels } from "./application-item-labels";
import { tokenName } from "./studio-labels";

/**
 * The Structure tab's edits: add, rename and remove pages and layouts, and choose the home page.
 * Each edit is applied to a copy of the draft, keeps every reference intact (a removed page takes
 * its menu entries and its blocks' flow bindings with it) and is judged by the source schema
 * before it reaches the draft history. A refusal says where the problem is, in words a builder
 * reads, and changes nothing.
 */

type Source = ApplicationSourceDocument;
type Page = Source["body"]["pages"][number];
type Shell = Source["body"]["shells"][number];
type Navigation = Source["body"]["navigation"];

export type StudioStructureCommand =
  | Readonly<{ kind: "add_page"; name: string; shellAlias: string | null; addToMenu: boolean }>
  | Readonly<{ kind: "add_shell"; name: string }>
  | Readonly<{ kind: "rename"; selection: Extract<StudioSemanticSelection, { kind: "page" | "shell" }>; name: string }>
  | Readonly<{ kind: "remove_page"; pageAlias: string }>
  | Readonly<{ kind: "remove_shell"; shellAlias: string }>
  | Readonly<{ kind: "set_home_page"; pageAlias: string }>;

export type StudioStructureResult =
  | Readonly<{ kind: "applied"; source: Source; message: string; select: StudioSemanticSelection | null }>
  | Readonly<{ kind: "refused"; message: string }>;

/** A layout a new page can use, and why it cannot when it cannot. */
export type StudioStructureShellChoice = Readonly<{ shellAlias: string | null; label: string; unavailable?: string }>;

export type StudioStructureContext = Readonly<{
  source: Source;
  catalogue: ImmutablePlatformBlockCatalogue;
  describePlacement: StudioPlacementDescriber;
}>;

class StructureRefusal extends Error {}
const refuse = (message: string): never => { throw new StructureRefusal(message); };

const quoted = (name: string) => `“${name}”`;
const nameLimit = 60;

const cleanName = (name: string, what: string): string => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) refuse(`Give the ${what} a name.`);
  if (trimmed.length > nameLimit) refuse(`A ${what} name can be at most ${nameLimit} characters.`);
  return trimmed;
};

/** A lowercase key from a name, unique among `taken`, within `limit` characters. */
const uniqueKey = (name: string, prefix: string, taken: ReadonlySet<string>, limit: number): string => {
  const words = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const stem = `${prefix}${/^[a-z]/.test(words) ? "" : "item_"}${words || "item"}`.slice(0, limit).replace(/_+$/g, "");
  let key = stem;
  for (let suffix = 2; taken.has(key); suffix += 1) {
    const ending = `_${suffix}`;
    key = `${stem.slice(0, limit - ending.length).replace(/_+$/g, "")}${ending}`;
  }
  return key;
};

const navigationIds = (items: Navigation, into = new Set<string>()): Set<string> => {
  for (const item of items) {
    into.add(item.id);
    if (item.type === "heading") navigationIds(item.children, into);
  }
  return into;
};

const navigationCount = (items: Navigation): number =>
  items.reduce((count, item) => count + 1 + (item.type === "heading" ? navigationCount(item.children) : 0), 0);

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
  ...source.body.pages.flatMap((page) => sourcePageItems(page.composition)
    .map((item) => ({ item, where: `page ${quoted(page.name)}`, page: page.id as string | undefined, shell: undefined as string | undefined }))),
  ...source.body.shells.flatMap((shell) => sourceItemTree(shell.layout.content)
    .map((item) => ({ item, where: `layout ${quoted(shell.name)}`, page: undefined as string | undefined, shell: shell.id as string | undefined }))),
];

const releaseOf = (catalogue: ImmutablePlatformBlockCatalogue, item: SourceItem) =>
  catalogue.releases.find((release) => String(release.blockId) === item.props.vortex.block.block_id &&
    String(release.releaseVersion) === item.props.vortex.block.release_version);

/** Whether a typed setting value (at any depth of a group or list) links to the page. */
const linksTo = (value: unknown, pageKey: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => linksTo(entry, pageKey));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "page_reference") return record.page === pageKey;
  return Object.values(record).some((entry) => linksTo(entry, pageKey));
};

/** Whether a flow task anywhere in the flow opens the page. */
const navigatesTo = (value: unknown, pageKey: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => navigatesTo(entry, pageKey));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "interface.navigate") {
    const page = (record.properties as Record<string, unknown> | undefined)?.page as Record<string, unknown> | undefined;
    const literal = page?.literal as Record<string, unknown> | undefined;
    const target = typeof literal?.value === "string" ? literal.value : undefined;
    if (target === pageKey || target?.endsWith(`:${pageKey}`)) return true;
  }
  return Object.values(record).some((entry) => navigatesTo(entry, pageKey));
};

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
const removeBlocks = (context: StudioStructureContext, source: Source, leaving: readonly SourceItem[], what: string): void => {
  const aliases = new Set(placementsOf(context.source).map(({ item }) => item.props.id));
  const removed = new Set(leaving.map((item) => item.props.id));
  source.body.flow_bindings = source.body.flow_bindings.filter((binding) => !removed.has(binding.control));
  for (const item of leaving) {
    const reason = studioPlacementRemovalReference(source, item.props.id, aliases);
    if (reason !== undefined) {
      const block = context.describePlacement({ block: item.props.vortex.block, settings: settingsOf(item) }) ?? "A block";
      refuse(`${what} cannot be removed: its block ${quoted(block)} ${flowReferenceWords[reason]}. Change that flow first.`);
    }
  }
};

/** A block's own settings (not its name, slots or layout), for naming it to a person. */
const settingsOf = (item: SourceItem): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item.props).filter(([key, value]) => key !== "id" && key !== "vortex" && !Array.isArray(value)));

/** Everything outside the page that still names it; the first one found refuses the removal. */
const pageReferences = (context: StudioStructureContext, page: Page): string | undefined => {
  const { body } = context.source;
  const subject = `The page ${quoted(page.name)}`;
  if (body.home_page === page.key)
    return `${subject} is the application's home page. Make another page the home page first.`;
  const role = body.roles.find((candidate) => candidate.home_page === page.key);
  if (role !== undefined) return `${subject} is where the role ${quoted(role.name)} starts. Give that role another start page first.`;
  if ((body.experiences ?? []).some((experience) => experience.page === page.key))
    return `${subject} is shown when a page cannot be opened. Choose another page for that first.`;
  if (body.public_addresses.some((address) => address.page === page.key))
    return `${subject} has a public address. Remove that address first.`;
  const search = body.search?.record_types.find((entry) => entry.target_page === page.key);
  if (search !== undefined)
    return `${subject} opens search results for ${tokenName(search.record_type.slice(search.record_type.lastIndexOf(":") + 1))}. Change the search settings in Data first.`;
  const replacing = body.pages.find((candidate) => candidate.replaces_page === page.id);
  if (replacing !== undefined) return `${subject} is replaced by the page ${quoted(replacing.name)}. Remove that page first.`;
  for (const { item, where, page: owner } of placementsOf(context.source)) {
    if (owner === page.id) continue;
    const release = releaseOf(context.catalogue, item);
    if (release === undefined || !linksTo(readSourceItem(item, release).settings, page.key)) continue;
    const block = context.describePlacement({ block: item.props.vortex.block, settings: settingsOf(item) }) ?? release.name;
    return `${subject} is linked from the block ${quoted(String(block))} on ${where}. Change that link first.`;
  }
  const flow = body.flows.find((candidate) => navigatesTo(candidate, page.key));
  if (flow !== undefined) return `${subject} is opened by the flow ${quoted(tokenName(flow.key))}. Change that flow first.`;
  return undefined;
};

/** Words for where the schema refused the result, never a value. */
const describeIssuePath = (source: Source, path: readonly PropertyKey[]): string => {
  const [, collection, index] = path;
  if (collection === "pages" && typeof index === "number")
    return `the page ${quoted(source.body.pages[index]?.name ?? "")}`;
  if (collection === "shells" && typeof index === "number")
    return `the layout ${quoted(source.body.shells[index]?.name ?? "")}`;
  if (collection === "navigation") return "the menu";
  return typeof collection === "string" ? tokenName(collection).toLowerCase() : "the application";
};

const judged = (candidate: Source): Source => {
  syncStoredBlockDependencies(candidate);
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  console.error("[studio] structure edit refused by the source schema", issue.path.join("."), issue.code);
  return refuse(`This change would leave ${describeIssuePath(candidate, issue.path)} invalid (${issue.message}). Nothing was changed.`);
};

/** The layouts a new page can use: the platform's default frame, and each layout with no required area. */
export const studioStructureShellChoices = (source: Source): readonly StudioStructureShellChoice[] => [
  { shellAlias: null, label: "Platform default frame" },
  ...source.body.shells.map((shell) => {
    const required = shell.content_slots.filter((slot) => slot.required).map((slot) => slot.label);
    return required.length === 0 ? { shellAlias: shell.id, label: shell.name }
      : { shellAlias: shell.id, label: shell.name,
        unavailable: `needs content in ${required.join(", ")}, which a new empty page does not have yet` };
  }),
];

const addPage = (context: StudioStructureContext, candidate: Source,
  command: Extract<StudioStructureCommand, { kind: "add_page" }>): StudioStructureResult => {
  const name = cleanName(command.name, "page");
  const body = candidate.body;
  if (body.pages.length >= 100) refuse("An application can have at most 100 pages.");
  const choice = studioStructureShellChoices(context.source).find((entry) => entry.shellAlias === command.shellAlias);
  if (choice === undefined) refuse("The chosen layout is no longer in this application. Choose another.");
  if (choice!.unavailable !== undefined) refuse(`The layout ${quoted(choice!.label)} ${choice!.unavailable}. Choose another layout.`);
  const home = body.pages.find((page) => page.key === body.home_page);
  if (home === undefined) refuse("The application's home page is missing, so a new page has no access rule to start from.");
  const key = uniqueKey(name, "", new Set(body.pages.map((page) => page.key)), 40);
  const id = uniqueKey(key, "page_", new Set(body.pages.map((page) => page.id)), 160);
  // A valid empty Puck page: no blocks, in the chosen frame. Who can open it starts as who can open the home page.
  const page = {
    id, key, name, type: "dashboard", permission: home!.permission,
    composition: { root: { props: { vortex: { shell: command.shellAlias, slot_orders: {} } } }, content: [] },
  } as unknown as Page;
  body.pages.push(page);
  if (command.addToMenu) {
    if (navigationCount(body.navigation) >= 100) refuse("The menu is full, so the page cannot be added to it.");
    body.navigation.push({ id: uniqueKey(key, "nav_", navigationIds(body.navigation), 160), type: "page",
      label: name, icon: "grid", page: key, permission: home!.permission });
  }
  return { kind: "applied", source: judged(candidate), select: { kind: "page", pageAlias: id },
    message: `Page ${quoted(name)} added${command.addToMenu ? " to the menu" : ""}. Save to keep it.` };
};

const newestRelease = (catalogue: ImmutablePlatformBlockCatalogue, identity: Readonly<{ blockId: string }>) => {
  const versions = catalogue.releases.filter((release) => String(release.blockId) === identity.blockId);
  const parts = (version: string) => version.split(".").map(Number);
  return versions.sort((left, right) => {
    const [a, b] = [parts(String(left.releaseVersion)), parts(String(right.releaseVersion))];
    return (b[0]! - a[0]!) || (b[1]! - a[1]!) || (b[2]! - a[2]!);
  })[0];
};

const blockItem = (release: NonNullable<ReturnType<typeof newestRelease>>, id: string,
  settings: Record<string, unknown>, slots: Record<string, SourceItem[]>): SourceItem => ({
  type: String(release.rendererKey),
  props: {
    id, ...settings, ...Object.fromEntries(release.slots.map((slot) => [slot.key, slots[slot.key] ?? []])),
    vortex: {
      block: { block_id: String(release.blockId), release_version: String(release.releaseVersion) },
      theme_overrides: {},
      responsive: { desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } } },
    },
  },
} as SourceItem);

/**
 * A new layout: a frame with the application menu beside one optional content area, so any page,
 * a new empty one included, can use it.
 */
const addShell = (context: StudioStructureContext, candidate: Source,
  command: Extract<StudioStructureCommand, { kind: "add_shell" }>): StudioStructureResult => {
  const name = cleanName(command.name, "layout");
  const body = candidate.body;
  if (body.shells.length >= 100) refuse("An application can have at most 100 layouts.");
  const container = newestRelease(context.catalogue, PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE_1_3_0);
  const menu = newestRelease(context.catalogue, PLATFORM_BLOCK_RELEASE_IDENTITIES.APPLICATION_NAVIGATION_BLOCK_RELEASE);
  if (container === undefined || !container.slots.some((slot) => slot.key === "content") ||
    !container.slots.some((slot) => slot.key === "menu") || menu === undefined)
    refuse("The block catalogue has no frame block for a new layout, so none was added.");
  const key = uniqueKey(name, "", new Set(body.shells.map((shell) => shell.key)), 40);
  const id = uniqueKey(key, "shell_", new Set(body.shells.map((shell) => shell.id)), 160);
  const taken = new Set(placementsOf(candidate).map(({ item }) => item.props.id));
  const frameId = uniqueKey(key, "layout_", taken, 140);
  const menuId = uniqueKey(`${frameId}_menu`, "", taken, 160);
  const slotIds = new Set(body.shells.flatMap((shell) => shell.content_slots.map((slot) => slot.id)));
  const content = container!.slots.find((slot) => slot.key === "content")!;
  const title = body.name.slice(0, 60);
  const shell = {
    id, key, name,
    presentation: {
      sidebar: { collapsible: "icon", default_collapsed: false },
      top_bar: { breadcrumbs: true, organization_switcher: true, application_switcher: true, account_menu: true, appearance_toggle: true },
    },
    layout: {
      root: { props: { vortex: { slot_orders: {} } } },
      content: [blockItem(container!, frameId, { direction: "row", gap: "medium", padding: "medium", content_landmark: true, phone_direction: "column" },
        { menu: [blockItem(menu!, menuId, { title }, {})] })],
    },
    content_slots: [{
      id: uniqueKey(`${key}_content`, "slot_", slotIds, 160), key: "content", label: "Content", required: false,
      allowed_child_categories: [...content.allowedChildCategories], parent_placement: frameId, parent_slot: "content",
    }],
  } as unknown as Shell;
  try { validateStoredShell(context.catalogue, shell); }
  catch (error) {
    if (!(error instanceof StoredCompositionRefusal)) throw error;
    console.error("[studio] new layout refused", error.message);
    refuse("The new layout could not be built from the block catalogue, so none was added.");
  }
  body.shells.push(shell);
  return { kind: "applied", source: judged(candidate), select: { kind: "shell", shellAlias: id },
    message: `Layout ${quoted(name)} added. Save to keep it.` };
};

const removePage = (context: StudioStructureContext, candidate: Source, pageAlias: string): StudioStructureResult => {
  const page = context.source.body.pages.find((entry) => entry.id === pageAlias);
  if (page === undefined) return refuse("That page is no longer in the draft.");
  const blocked = pageReferences(context, page);
  if (blocked !== undefined) refuse(blocked);
  candidate.body.pages = candidate.body.pages.filter((entry) => entry.id !== pageAlias);
  candidate.body.navigation = withoutPageEntries(candidate.body.navigation, page.key);
  removeBlocks(context, candidate, sourcePageItems(page.composition), `The page ${quoted(page.name)}`);
  return { kind: "applied", source: judged(candidate), select: null,
    message: `Page ${quoted(page.name)} removed, with its menu entries. Save to keep it.` };
};

const removeShell = (context: StudioStructureContext, candidate: Source, shellAlias: string): StudioStructureResult => {
  const shell = context.source.body.shells.find((entry) => entry.id === shellAlias);
  if (shell === undefined) return refuse("That layout is no longer in the draft.");
  const users = context.source.body.pages.filter((page) => sourcePageShell(page.composition) === shellAlias);
  if (users.length > 0)
    refuse(`The layout ${quoted(shell.name)} is used by ${users.length === 1 ? "the page" : `${users.length} pages, including`} ${quoted(users[0]!.name)}. Move or remove those pages first.`);
  candidate.body.shells = candidate.body.shells.filter((entry) => entry.id !== shellAlias);
  removeBlocks(context, candidate, sourceItemTree(shell.layout.content), `The layout ${quoted(shell.name)}`);
  return { kind: "applied", source: judged(candidate), select: null,
    message: `Layout ${quoted(shell.name)} removed. Save to keep it.` };
};

/** Applies one Structure edit to the draft, or refuses it with a located message. */
export const applyStudioStructureCommand = (context: StudioStructureContext, command: StudioStructureCommand): StudioStructureResult => {
  try {
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(context.source));
    switch (command.kind) {
      case "add_page": return addPage(context, candidate, command);
      case "add_shell": return addShell(context, candidate, command);
      case "remove_page": return removePage(context, candidate, command.pageAlias);
      case "remove_shell": return removeShell(context, candidate, command.shellAlias);
      case "set_home_page": {
        const page = candidate.body.pages.find((entry) => entry.id === command.pageAlias);
        if (page === undefined) return refuse("That page is no longer in the draft.");
        if (candidate.body.home_page === page.key) return refuse(`${quoted(page.name)} is already the home page.`);
        candidate.body.home_page = page.key;
        return { kind: "applied", source: judged(candidate), select: { kind: "page", pageAlias: page.id },
          message: `${quoted(page.name)} is now the home page. Save to keep it.` };
      }
      case "rename": {
        const what = command.selection.kind === "page" ? "page" : "layout";
        const name = cleanName(command.name, what);
        const result = applyStudioItemLabels(context.source, command.selection, name, context.source.body.description);
        if (result.kind === "not_found") return refuse(`That ${what} is no longer in the draft.`);
        if (result.kind === "invalid") return refuse(`The ${what} name was refused (${result.issues[0]?.message ?? "invalid"}). Nothing was changed.`);
        return { kind: "applied", source: result.source, select: command.selection,
          message: `Renamed to ${quoted(name)}. Save to keep it.` };
      }
    }
  } catch (error) {
    if (error instanceof StructureRefusal) return { kind: "refused", message: error.message };
    throw error;
  }
};
