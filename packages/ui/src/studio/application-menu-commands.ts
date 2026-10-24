import {
  applicationSourceDocumentSchema,
  safeHttpsUrlSchema,
  VORTEX_ICON_NAMES,
  type ApplicationSourceDocument,
  type VortexIconName,
} from "@vortex/platform/schema";

/**
 * The Menu tab's edits of the application's one navigation definition (`body.navigation`): add a
 * page entry, group entries under a heading, rename, choose the icon and the page of an entry, move
 * it (by drag or keyboard) and remove it. Who can see an entry is set in the Access tab. Each edit is applied to a copy of the draft
 * and judged by the source schema before it reaches the draft history; a refusal says where the
 * problem is and changes nothing. A page's removal already takes its entries with it (Structure).
 */

type Source = ApplicationSourceDocument;
export type StudioMenuItem = Source["body"]["navigation"][number];
type Heading = Extract<StudioMenuItem, { type: "heading" }>;

export type StudioMenuChanges = Readonly<{
  label?: string;
  icon?: VortexIconName;
  /** The key of the page a page entry opens. */
  page?: string;
  /** The https address an external entry opens. */
  address?: string;
}>;

export type StudioMenuCommand =
  | Readonly<{ kind: "add_entry"; pageKey: string; headingAlias: string | null }>
  | Readonly<{
      kind: "add_heading";
      label: string;
      first:
        Readonly<{ kind: "page"; pageKey: string }> | Readonly<{ kind: "item"; alias: string }>;
    }>
  | Readonly<{ kind: "change"; alias: string; changes: StudioMenuChanges }>
  /** Moves an entry into a list (the top level, or a heading's entries) at an index of that list without the entry. */
  | Readonly<{ kind: "move"; alias: string; headingAlias: string | null; index: number }>
  | Readonly<{ kind: "remove"; alias: string }>;

export type StudioMenuResult =
  | Readonly<{ kind: "applied"; source: Source; message: string; select: string | null }>
  | Readonly<{ kind: "refused"; message: string }>;

class MenuRefusal extends Error {}
const refuse = (message: string): never => {
  throw new MenuRefusal(message);
};
const quoted = (name: string) => `“${name}”`;
const menuLimit = 100;
const labelLimit = 60;

/** Where an entry is: the list that holds it, its index there, and the heading that list belongs to. */
type Place = Readonly<{
  list: StudioMenuItem[];
  index: number;
  item: StudioMenuItem;
  heading: Heading | null;
}>;
const locate = (
  items: StudioMenuItem[],
  alias: string,
  heading: Heading | null = null,
): Place | undefined => {
  for (const [index, item] of items.entries()) {
    if (item.id === alias) return { list: items, index, item, heading };
    if (item.type === "heading") {
      const found = locate(item.children, alias, item);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};
const requirePlace = (items: StudioMenuItem[], alias: string): Place =>
  locate(items, alias) ?? refuse("That menu entry is no longer in the draft.");

const allItems = (items: readonly StudioMenuItem[]): StudioMenuItem[] =>
  items.flatMap((item) => (item.type === "heading" ? [item, ...allItems(item.children)] : [item]));

const cleanLabel = (label: string): string => {
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) refuse("Give the menu entry a label.");
  if (trimmed.length > labelLimit) refuse(`A menu label can be at most ${labelLimit} characters.`);
  return trimmed;
};

/** A new entry id, unique among every entry of the menu. */
const newAlias = (source: Source, stem: string): string => {
  const taken = new Set(allItems(source.body.navigation).map((item) => item.id));
  const base = `nav_${
    stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "entry"
  }`.slice(0, 150);
  let alias = base;
  for (let suffix = 2; taken.has(alias); suffix += 1) alias = `${base}_${suffix}`;
  return alias;
};

/** The pages an entry can open: every page except record detail pages, which need a record. */
export const studioMenuPageChoices = (source: Source) =>
  source.body.pages
    .filter((page) => page.type !== "detail" && page.type !== "public")
    .map((page) => ({ key: page.key, label: page.name }));

const requirePage = (source: Source, key: string) => {
  const page = studioMenuPageChoices(source).find((choice) => choice.key === key);
  if (page === undefined)
    refuse(
      source.body.pages.some((entry) => entry.key === key)
        ? "That page opens a single record, so it cannot be a menu entry. Choose a list, dashboard or form page."
        : "That page is no longer in this application. Choose another page.",
    );
  return page!;
};

const judged = (candidate: Source): Source => {
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  console.error(
    "[studio] menu edit refused by the source schema",
    issue.path.join("."),
    issue.code,
  );
  return refuse(
    `This change would leave ${issue.path[1] === "navigation" ? "the menu" : "the application"} invalid (${issue.message}). Nothing was changed.`,
  );
};

const pageEntry = (candidate: Source, pageKey: string): StudioMenuItem => {
  const choice = requirePage(candidate, pageKey);
  const page = candidate.body.pages.find((entry) => entry.key === choice.key)!;
  return {
    id: newAlias(candidate, page.key),
    type: "page",
    label: page.name.slice(0, labelLimit),
    icon: "grid",
    page: page.key,
    permission: page.permission,
  };
};

const addEntry = (
  candidate: Source,
  command: Extract<StudioMenuCommand, { kind: "add_entry" }>,
): StudioMenuResult => {
  if (allItems(candidate.body.navigation).length >= menuLimit)
    refuse(`The menu is full: it can have at most ${menuLimit} entries.`);
  const entry = pageEntry(candidate, command.pageKey);
  if (command.headingAlias === null) candidate.body.navigation.push(entry);
  else {
    const place = requirePlace(candidate.body.navigation, command.headingAlias);
    if (place.item.type !== "heading") refuse("Entries can only be added under a heading.");
    (place.item as Heading).children.push(entry);
  }
  return {
    kind: "applied",
    source: judged(candidate),
    select: entry.id,
    message: `Menu entry ${quoted(entry.label)} added.`,
  };
};

const addHeading = (
  candidate: Source,
  command: Extract<StudioMenuCommand, { kind: "add_heading" }>,
): StudioMenuResult => {
  const added = command.first.kind === "page" ? 2 : 1;
  if (allItems(candidate.body.navigation).length + added > menuLimit)
    refuse(`The menu is full: it can have at most ${menuLimit} entries, including headings.`);
  const label = cleanLabel(command.label);
  if (command.first.kind === "page")
    candidate.body.navigation.push(pageEntry(candidate, command.first.pageKey));
  const alias =
    command.first.kind === "item" ? command.first.alias : candidate.body.navigation.at(-1)!.id;
  const place = requirePlace(candidate.body.navigation, alias);
  if (place.heading !== null || place.item.type === "heading")
    refuse(
      "Choose a top-level page or link entry for the new heading. The menu has one level of headings.",
    );
  const heading: Heading = {
    id: newAlias(candidate, label),
    type: "heading",
    label,
    icon: "grid",
    children: [place.item],
  };
  place.list.splice(place.index, 1, heading);
  return {
    kind: "applied",
    source: judged(candidate),
    select: heading.id,
    message: `Heading ${quoted(label)} added with ${quoted(place.item.label)} under it.`,
  };
};

const change = (
  candidate: Source,
  command: Extract<StudioMenuCommand, { kind: "change" }>,
): StudioMenuResult => {
  const place = requirePlace(candidate.body.navigation, command.alias);
  const item = place.item;
  const next: Record<string, unknown> = { ...item };
  const { label, icon, page, address } = command.changes;
  if (label !== undefined) next.label = cleanLabel(label);
  if (icon !== undefined) {
    if (!(VORTEX_ICON_NAMES as readonly string[]).includes(icon))
      refuse("That icon is not in the icon set. Choose another.");
    next.icon = icon;
  }
  if (page !== undefined) {
    if (item.type !== "page") refuse("Only a page entry opens a page.");
    next.page = requirePage(candidate, page).key;
  }
  if (address !== undefined) {
    if (item.type !== "external") refuse("Only a link entry opens an address.");
    const parsed = safeHttpsUrlSchema.safeParse(address.trim());
    if (!parsed.success)
      refuse(`Enter an https:// address (${parsed.error.issues[0]!.message}).`);
    next.address = address.trim();
  }
  place.list[place.index] = next as StudioMenuItem;
  return {
    kind: "applied",
    source: judged(candidate),
    select: item.id,
    message: `Menu entry ${quoted(String(next.label))} changed.`,
  };
};

const move = (
  candidate: Source,
  command: Extract<StudioMenuCommand, { kind: "move" }>,
): StudioMenuResult => {
  const place = requirePlace(candidate.body.navigation, command.alias);
  if (command.headingAlias === command.alias) refuse("An entry cannot go under itself.");
  const target =
    command.headingAlias === null
      ? undefined
      : requirePlace(candidate.body.navigation, command.headingAlias);
  if (target !== undefined && target.item.type !== "heading")
    refuse("Entries can only go under a heading.");
  if (place.item.type === "heading" && target !== undefined)
    refuse(
      `The heading ${quoted(place.item.label)} cannot go under another heading: the menu has one level of headings.`,
    );
  if (place.heading !== null && place.list.length === 1 && target?.item.id !== place.heading.id)
    refuse("A heading needs at least one entry. Remove the heading instead.");
  place.list.splice(place.index, 1);
  const list = target === undefined ? candidate.body.navigation : (target.item as Heading).children;
  const index = Math.max(0, Math.min(command.index, list.length));
  list.splice(index, 0, place.item);
  const where = target === undefined ? "the menu" : `the heading ${quoted(target.item.label)}`;
  return {
    kind: "applied",
    source: judged(candidate),
    select: place.item.id,
    message: `${quoted(place.item.label)} moved to position ${index + 1} in ${where}.`,
  };
};

const remove = (candidate: Source, alias: string): StudioMenuResult => {
  const place = requirePlace(candidate.body.navigation, alias);
  if (place.heading !== null && place.list.length === 1)
    refuse("A heading needs at least one entry. Remove the heading instead.");
  // A removed heading's entries stay, in its place.
  place.list.splice(place.index, 1, ...(place.item.type === "heading" ? place.item.children : []));
  return {
    kind: "applied",
    source: judged(candidate),
    select: null,
    message:
      place.item.type === "heading"
        ? `Heading ${quoted(place.item.label)} removed; its entries stay in the menu.`
        : `Menu entry ${quoted(place.item.label)} removed.`,
  };
};

/** Applies one Menu edit to the draft, or refuses it with a located message. */
export const applyStudioMenuCommand = (
  source: Source,
  command: StudioMenuCommand,
): StudioMenuResult => {
  try {
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(source));
    switch (command.kind) {
      case "add_entry":
        return addEntry(candidate, command);
      case "add_heading":
        return addHeading(candidate, command);
      case "change":
        return change(candidate, command);
      case "move":
        return move(candidate, command);
      case "remove":
        return remove(candidate, command.alias);
    }
  } catch (error) {
    if (error instanceof MenuRefusal) return { kind: "refused", message: error.message };
    throw error;
  }
};

/** Where an entry sits, for the keyboard moves: its list's heading, its index and that list's length. */
export const studioMenuPosition = (source: Source, alias: string) => {
  const place = locate(source.body.navigation, alias);
  return place === undefined
    ? undefined
    : {
        headingAlias: place.heading?.id ?? null,
        index: place.index,
        length: place.list.length,
        item: place.item,
      };
};
