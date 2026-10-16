import {
  platformBlockReleaseIdentity,
  type BlockPaletteGroup,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type ImmutablePlatformBlockCatalogue,
  type PlatformBlockRelease,
  type PlatformBlockReleaseSummary,
} from "@vortex/platform/schema";
import { PALETTE_GROUP_TITLES } from "../palette-groups";

/**
 * The Studio block palette for one place on a page: the newest release of each block the catalogue
 * admits there, by name, description and group, and what a new block of it needs before it can be
 * stored. A new block gets its catalogue defaults; a required setting without a default is asked
 * for when the block is added.
 */

/** A required setting the person gives when adding the block: the catalogue has no default for it. */
export type StudioPaletteSetupField = Readonly<
  | Extract<BlockPropertySchemaContract, { kind: "text" | "boolean" | "choice" | "number" }>
  | (BlockPropertySchemaContract & { kind: "field_reference" })
>;

export type StudioPaletteChoice = Readonly<{
  /** Stable identity of this exact block release. */
  id: string;
  blockId: string;
  releaseVersion: string;
  key: string;
  rendererKey: string;
  name: string;
  description: string;
  icon: string;
  group: BlockPaletteGroup;
  groupLabel: string;
  /** The block reads its records from a query, chosen when it is added. */
  needsQuery: boolean;
  /** Required settings without a catalogue default, asked for when the block is added. */
  setup: readonly StudioPaletteSetupField[];
  /** Why the block cannot be added yet; absent when it can. */
  unavailable?: string;
}>;

export type StudioPaletteGroup = Readonly<{
  group: BlockPaletteGroup;
  label: string;
  choices: readonly StudioPaletteChoice[];
}>;

const versionParts = (version: string): number[] =>
  version.split(/[.+-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
const newer = (left: string, right: string): boolean => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1)
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
};

const setupKinds = new Set(["text", "boolean", "choice", "number", "field_reference"]);

/** What a new block of this release needs, or why Studio cannot create one yet. */
const choiceFor = (release: PlatformBlockRelease): StudioPaletteChoice => {
  const setup: StudioPaletteSetupField[] = [];
  let unavailable: string | undefined;
  for (const property of release.properties) {
    if (!property.required || property.defaultValue !== undefined) continue;
    if (setupKinds.has(property.kind)) setup.push(property as StudioPaletteSetupField);
    else unavailable ??= `It needs its ${property.label} setting, which can't be set when adding a block yet.`;
  }
  const requiredSlot = release.slots.find((slot) => slot.required && slot.repeats === undefined);
  if (requiredSlot !== undefined)
    unavailable ??= `Its ${requiredSlot.label} area must hold a block, so it can't start empty.`;
  return Object.freeze({
    id: platformBlockReleaseIdentity(release),
    blockId: release.blockId,
    releaseVersion: release.releaseVersion,
    key: release.key,
    rendererKey: release.rendererKey,
    name: release.name,
    description: release.description,
    icon: release.icon,
    group: release.paletteGroup,
    groupLabel: PALETTE_GROUP_TITLES[release.paletteGroup],
    needsQuery: release.paletteGroup === "data" || release.paletteGroup === "figures",
    setup: Object.freeze(setup),
    ...(unavailable === undefined ? {} : { unavailable }),
  });
};

const releaseIndexes = new WeakMap<ImmutablePlatformBlockCatalogue, Map<string, PlatformBlockRelease>>();
const releaseIndex = (catalogue: ImmutablePlatformBlockCatalogue): Map<string, PlatformBlockRelease> => {
  let index = releaseIndexes.get(catalogue);
  if (index === undefined) {
    index = new Map(catalogue.releases.map((release) => [platformBlockReleaseIdentity(release), release]));
    releaseIndexes.set(catalogue, index);
  }
  return index;
};

/**
 * The palette choices of the releases a place admits: one per block, its newest admitted release,
 * in catalogue order. A new block always takes the newest release.
 */
export function studioPaletteChoices(
  catalogue: ImmutablePlatformBlockCatalogue,
  admitted: readonly PlatformBlockReleaseSummary[],
): readonly StudioPaletteChoice[] {
  const index = releaseIndex(catalogue);
  const newest = new Map<string, PlatformBlockRelease>();
  for (const summary of admitted) {
    const release = index.get(platformBlockReleaseIdentity(summary));
    if (release === undefined) continue;
    const known = newest.get(release.key);
    if (known === undefined || newer(release.releaseVersion, known.releaseVersion)) newest.set(release.key, release);
  }
  return Object.freeze([...newest.values()].map(choiceFor));
}

/** Whether a choice matches the search: its name, description, group or key holds every word. */
const matches = (choice: StudioPaletteChoice, words: readonly string[]): boolean => {
  const haystack = `${choice.name} ${choice.description} ${choice.groupLabel} ${choice.key}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/**
 * The choices that match the search, in palette groups in catalogue group order; in each group the
 * blocks that can be added come first.
 */
export function groupStudioPaletteChoices(
  choices: readonly StudioPaletteChoice[],
  searchText: string,
): readonly StudioPaletteGroup[] {
  const words = searchText.trim().toLowerCase().split(/\s+/u).filter((word) => word.length > 0);
  const groups = new Map<BlockPaletteGroup, StudioPaletteChoice[]>();
  for (const group of Object.keys(PALETTE_GROUP_TITLES) as BlockPaletteGroup[]) groups.set(group, []);
  for (const choice of choices) if (matches(choice, words)) groups.get(choice.group)?.push(choice);
  return Object.freeze([...groups].filter(([, list]) => list.length > 0).map(([group, list]) =>
    Object.freeze({ group, label: PALETTE_GROUP_TITLES[group], choices: Object.freeze([
      ...list.filter((choice) => choice.unavailable === undefined),
      ...list.filter((choice) => choice.unavailable !== undefined),
    ]) })));
}

/** A query of one of the application's own Modules, and the fields it reads. */
export type StudioSourceQuery = Readonly<{
  /** The qualified query reference a block stores: `<module>:<query>`. */
  reference: string;
  label: string;
  /** The fields the query selects, as qualified field references: `<module>:<record>.<field>`. */
  fields: readonly Readonly<{ reference: string; label: string; type: string }>[];
}>;

/**
 * The queries a new data block can read: those of the Modules the application source holds. A
 * Module the application only uses from another application is not in its source, so its queries
 * are not offered here.
 */
export function studioSourceQueries(source: ApplicationSourceDocument): readonly StudioSourceQuery[] {
  return Object.freeze((source.body.modules ?? []).flatMap((module) => module.queries.map((query) => {
    const record = module.record_types.find((candidate) => candidate.key === query.record_type);
    const selected = query.select.length === 0 ? (record?.fields ?? []).map((field) => field.key) : query.select;
    const fields = selected.flatMap((key) => {
      const field = record?.fields.find((candidate) => candidate.key === key);
      return field === undefined ? [] : [Object.freeze({
        reference: `${module.key}:${query.record_type}.${field.key}`, label: field.label, type: field.type,
      })];
    });
    return Object.freeze({ reference: `${module.key}:${query.key}`, label: query.label ?? query.key,
      fields: Object.freeze(fields) });
  })));
}
