import {
  applicationSourceDocumentSchema,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import { syncStoredBlockDependencies } from "./stored-composition";
import type { StudioPlacementDescriber } from "./semantic-outline";
import type { StudioSemanticSelection } from "./semantic-selection";
import { applyStudioMenuCommand } from "./application-menu-commands";
import { tokenName } from "./studio-words";

/**
 * What every Structure edit shares: the draft it is applied to, how a refusal is raised and
 * worded, fresh keys, the newest catalogue release of a block, a new block item, empty page data
 * in a frame, and the source schema's judgement of the result.
 */

export type Source = ApplicationSourceDocument;
export type Page = Source["body"]["pages"][number];
export type Shell = Source["body"]["shells"][number];
export type Navigation = Source["body"]["navigation"];

export type StudioStructureResult =
  | Readonly<{
      kind: "applied";
      source: Source;
      message: string;
      select: StudioSemanticSelection | null;
      /** What the edit made, in plain words, one entry per thing; empty for a one-thing edit. */
      details: readonly string[];
    }>
  | Readonly<{
      kind: "refused";
      message: string;
      where?: readonly ApplicationUsePlace[] | undefined;
      cause?: Readonly<{ part: string; reason: string }> | undefined;
    }>;

export type StudioStructureContext = Readonly<{
  source: Source;
  catalogue: ImmutablePlatformBlockCatalogue;
  describePlacement: StudioPlacementDescriber;
  /**
   * The fields of the application's own modules whose stored shape a published version fixed, as
   * `module.key:record_key.field_key`: their filter and sort choices can't change any more.
   */
  publishedFields: ReadonlySet<string>;
}>;

export class StructureRefusal extends Error {
  override readonly cause: Readonly<{ part: string; reason: string }>;
  constructor(
    message: string,
    readonly where?: readonly ApplicationUsePlace[],
  ) {
    super(message);
    this.cause = { part: "structure", reason: message };
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

export const newestRelease = (
  catalogue: ImmutablePlatformBlockCatalogue,
  identity: Readonly<{ blockId: string }>,
) => {
  const versions = catalogue.releases.filter(
    (release) => String(release.blockId) === identity.blockId,
  );
  const parts = (version: string) => version.split(".").map(Number);
  return versions.sort((left, right) => {
    const [a, b] = [parts(String(left.releaseVersion)), parts(String(right.releaseVersion))];
    return b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!;
  })[0];
};
export type StructureRelease = NonNullable<ReturnType<typeof newestRelease>>;

/** A new block item: its settings as given, every fixed slot present, the default desktop layout. */
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
  console.error(
    "[studio] structure edit refused by the source schema",
    issue.path.join("."),
    issue.code,
  );
  return refuse(
    `This change would leave ${describeIssuePath(candidate, issue.path)} invalid (${issue.message}). Nothing was changed.`,
  );
};

/** The fields of a new page beyond its name, key and composition: its type, permission and, for a record page, its record type and query. */
export type NewPageFields = Readonly<Record<string, unknown>> &
  Readonly<{ type: Page["type"]; permission: string }>;

/**
 * Adds one page to the candidate: a fresh key and alias from its name and the given composition,
 * with a menu entry made by the Menu tab's own add when asked for.
 */
export const placeNewPage = (
  candidate: Source,
  name: string,
  fields: NewPageFields,
  composition: unknown,
  addToMenu: boolean,
): Readonly<{ source: Source; page: Page }> => {
  const body = candidate.body;
  if (body.pages.length >= 100) refuse("An application can have at most 100 pages.");
  const key = uniqueKey(name, "", new Set(body.pages.map((page) => page.key)), 40);
  const id = uniqueKey(key, "page_", new Set(body.pages.map((page) => page.id)), 160);
  body.pages.push({ id, key, name, ...fields, composition } as unknown as Page);
  if (!addToMenu) return { source: candidate, page: body.pages.at(-1)! };
  const menu = applyStudioMenuCommand(judged(candidate), {
    kind: "add_entry",
    pageKey: key,
    headingAlias: null,
  });
  if (menu.kind === "refused") return refuse(menu.message);
  return { source: menu.source, page: menu.source.body.pages.find((entry) => entry.id === id)! };
};
