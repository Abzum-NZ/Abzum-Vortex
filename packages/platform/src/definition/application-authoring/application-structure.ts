import { PLATFORM_BLOCK_RELEASE_IDENTITIES } from "../application-composition-release-identities";
import type { ImmutablePlatformBlockCatalogue } from "../application-composition/platform-block-release";
import { plainSettingValue } from "../application-composition/component-setting-reading";
import {
  sourceItemTree,
  sourcePageItems,
  type SourceItem,
} from "../application-composition/source-composition";
import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
} from "../application-source-contracts";
import type { ApplicationUsePlace } from "../application-uses";
import { applyStudioMenuCommand } from "./application-menu-commands";
import {
  StoredCompositionRefusal,
  syncStoredBlockDependencies,
  validateStoredShell,
} from "./stored-composition";
import { tokenName } from "./studio-words";

/**
 * What every structure edit of an application source shares, and the new application's starting
 * frame: how a refusal is raised and worded, fresh keys, the catalogue release of a block, a new
 * block item, empty page data in a frame, the source schema's judgement of a result, and the layout
 * with the application menu. The Studio editor and the create-application operation both build
 * from these, so a new application's source is made in one place.
 */

export type Source = ApplicationSourceDocument;
export type Page = Source["body"]["pages"][number];
export type Shell = Source["body"]["shells"][number];
export type Navigation = Source["body"]["navigation"];

export class StructureRefusal extends Error {
  constructor(
    message: string,
    readonly where?: readonly ApplicationUsePlace[],
  ) {
    super(message);
  }
}
export const refuse = (message: string, where?: readonly ApplicationUsePlace[]): never => {
  throw new StructureRefusal(message, where);
};

export const quoted = (name: string) => `“${name}”`;
const nameLimit = 60;

export const cleanName = (name: string, what: string): string => {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) refuse(`Give the ${what} a name.`);
  if (trimmed.length > nameLimit) refuse(`A ${what} name can be at most ${nameLimit} characters.`);
  return trimmed;
};

/** A lowercase key from a name, unique among `taken`, within `limit` characters. */
export const uniqueKey = (
  name: string,
  prefix: string,
  taken: ReadonlySet<string>,
  limit: number,
): string => {
  const words = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = `${prefix}${/^[a-z]/.test(words) ? "" : "item_"}${words || "item"}`
    .slice(0, limit)
    .replace(/_+$/g, "");
  let key = stem;
  for (let suffix = 2; taken.has(key); suffix += 1) {
    const ending = `_${suffix}`;
    key = `${stem.slice(0, limit - ending.length).replace(/_+$/g, "")}${ending}`;
  }
  return key;
};

/** The one catalogue release of a block. */
export const blockRelease = (
  catalogue: ImmutablePlatformBlockCatalogue,
  identity: Readonly<{ blockId: string }>,
) => catalogue.releases.find((release) => String(release.blockId) === identity.blockId);
export type StructureRelease = NonNullable<ReturnType<typeof blockRelease>>;

/**
 * A new block item: every declared default the way a block inserted from the palette holds it (so a
 * Records table's draft carries every grid feature's settings, off), its settings as given, every
 * fixed slot present, the default desktop layout.
 */
export const blockItem = (
  release: StructureRelease,
  id: string,
  settings: Record<string, unknown>,
  slots: Record<string, SourceItem[]>,
  vortex: Readonly<{ query?: string; view_permission?: string }> = {},
): SourceItem =>
  ({
    type: String(release.rendererKey),
    props: {
      id,
      ...Object.fromEntries(
        release.properties.flatMap((property) =>
          property.defaultValue === undefined
            ? []
            : [[property.key, plainSettingValue(property.defaultValue)]],
        ),
      ),
      ...settings,
      ...Object.fromEntries(release.slots.map((slot) => [slot.key, slots[slot.key] ?? []])),
      vortex: {
        block: {
          block_id: String(release.blockId),
          release_version: String(release.releaseVersion),
        },
        ...vortex,
        responsive: {
          desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
        },
      },
    },
  }) as SourceItem;

/** Empty page data in a frame: each of a layout's content areas is present and holds no blocks. */
export const emptyPageData = (source: Source, shellAlias: string | null) => {
  const shell =
    shellAlias === null ? undefined : source.body.shells.find((entry) => entry.id === shellAlias);
  if (shellAlias !== null && shell === undefined)
    refuse("The chosen layout is no longer in this application. Choose another.");
  return {
    root: {
      props: {
        vortex: { shell: shellAlias, slot_orders: {} },
        ...Object.fromEntries((shell?.content_slots ?? []).map((slot) => [slot.id, []])),
      },
    },
    content: [] as SourceItem[],
  };
};

/** Words for where the schema refused the result, never a value. */
const describeIssuePath = (source: Source, path: readonly PropertyKey[]): string => {
  const [, collection, index] = path;
  if (collection === "pages" && typeof index === "number")
    return `the page ${quoted(source.body.pages[index]?.name ?? "")}`;
  if (collection === "shells" && typeof index === "number")
    return `the layout ${quoted(source.body.shells[index]?.name ?? "")}`;
  if (collection === "modules" && typeof index === "number")
    return `the module ${quoted(source.body.modules[index]?.name ?? "")}`;
  if (collection === "navigation") return "the menu";
  return typeof collection === "string" ? tokenName(collection).toLowerCase() : "the application";
};

export const judged = (candidate: Source): Source => {
  syncStoredBlockDependencies(candidate);
  const parsed = applicationSourceDocumentSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  return refuse(
    `This change would leave ${describeIssuePath(candidate, issue.path)} invalid (${issue.message}). Nothing was changed.`,
  );
};

/** Every block the draft places, with where it is, so a refusal can name it. */
export const placementsOf = (source: Source) => [
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

/**
 * A layout: a frame with the application menu beside one optional content area, so any page, a new
 * empty one included, can use it. It is added to the candidate.
 */
export const placeMenuShell = (
  catalogue: ImmutablePlatformBlockCatalogue,
  candidate: Source,
  name: string,
): Shell => {
  const body = candidate.body;
  if (body.shells.length >= 100) refuse("An application can have at most 100 layouts.");
  const container = blockRelease(
    catalogue,
    PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE,
  );
  const menu = blockRelease(
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

/**
 * A new application's starting frame, written into its definition: one layout with the
 * application menu (list pages added later go in it, and leave it when removed), and the home page
 * in that layout and in its menu. Authoring guidance belongs to the canvas, not the page source.
 * New pages start in the home page's layout.
 */
export const newApplicationStarterFrame = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: Source,
):
  | Readonly<{ kind: "applied"; source: Source }>
  | Readonly<{ kind: "refused"; message: string }> => {
  try {
    const candidate = applicationSourceDocumentSchema.parse(structuredClone(source));
    candidate.body.icon = "blocks";
    const shell = placeMenuShell(catalogue, candidate, "Main layout");
    const home = candidate.body.pages.find((page) => page.key === candidate.body.home_page);
    if (home === undefined)
      return refuse("The application's home page is missing, so it has no frame to start in.");
    const composition = emptyPageData(candidate, shell.id);
    home.composition = composition as unknown as Page["composition"];
    const menu = applyStudioMenuCommand(judged(candidate), {
      kind: "add_entry",
      pageKey: home.key,
      headingAlias: null,
    });
    if (menu.kind === "refused") return menu;
    return { kind: "applied", source: menu.source };
  } catch (error) {
    if (error instanceof StructureRefusal) return { kind: "refused", message: error.message };
    throw error;
  }
};
