import {
  platformBlockReleaseIdentity,
  type BlockPaletteGroup,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type ImmutablePlatformBlockCatalogue,
  type PlatformBlockRelease,
  type PlatformBlockReleaseSummary,
  type ModuleQueryExposure,
} from "@vortex/platform/schema";
import { PALETTE_GROUP_TITLES } from "../palette-groups";
import { studioHasSlotStarter } from "./composition-starters";

/**
 * The Studio block palette for one place on a page: the newest release of each block the catalogue
 * admits there, by name, description and group, and what a new block of it needs before it can be
 * stored. A new block gets its catalogue defaults; a required setting without a default is asked
 * for when the block is added.
 */

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
  setup: readonly BlockPropertySchemaContract[];
  /** A declared selector that derives initial settings and, when needed, a source query. */
  studioSetup?: PlatformBlockRelease["studioSetup"];
  /** Why the block cannot be added yet; absent when it can. */
  unavailable?: string;
}>;

export type StudioPaletteGroup = Readonly<{
  group: BlockPaletteGroup;
  label: string;
  choices: readonly StudioPaletteChoice[];
}>;

const versionParts = (version: string): number[] =>
  version
    .split(/[.+-]/u)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
const newer = (left: string, right: string): boolean => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1)
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
};

/**
 * Every declared kind Studio's typed controls edit. `asset_reference` is the one kind left out:
 * Vortex has no asset library yet, so there is nothing to pick and the control refuses it.
 */
const editableKinds = new Set<BlockPropertySchemaContract["kind"]>([
  "text",
  "url",
  "number",
  "boolean",
  "choice",
  "rich_text",
  "icon",
  "field_reference",
  "query_reference",
  "page_reference",
  "record_type_reference",
  "action_reference",
  "relationship_reference",
  "record_reference",
]);

/** Whether Studio's typed setting controls edit a setting of this declaration, nested settings included. */
export const studioSettingEditable = (property: BlockPropertySchemaContract): boolean =>
  property.kind === "group"
    ? property.properties.every(studioSettingEditable)
    : property.kind === "list"
      ? studioSettingEditable(property.item)
      : editableKinds.has(property.kind);

/** Whether a block of this release reads its records from a query the person chooses. */
export const studioReleaseReadsQuery = (release: PlatformBlockRelease): boolean =>
  release.paletteGroup === "data" || release.paletteGroup === "figures";

/** What a new block of this release needs, or why Studio cannot create one yet. */
const choiceFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  release: PlatformBlockRelease,
): StudioPaletteChoice => {
  const setup: BlockPropertySchemaContract[] = [];
  let unavailable: string | undefined;
  for (const property of release.properties) {
    if (!property.required || property.defaultValue !== undefined) continue;
    if (studioSettingEditable(property)) setup.push(property);
    else unavailable ??= `It needs its ${property.label} setting, which Studio can't set yet.`;
  }
  const requiredSlot = release.slots.find(
    (slot) =>
      slot.required &&
      slot.repeats === undefined &&
      !studioHasSlotStarter(catalogue, release, slot.key),
  );
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
    needsQuery: studioReleaseReadsQuery(release),
    setup: Object.freeze(setup),
    ...(release.studioSetup === undefined ? {} : { studioSetup: release.studioSetup }),
    ...(unavailable === undefined ? {} : { unavailable }),
  });
};

const releaseIndexes = new WeakMap<
  ImmutablePlatformBlockCatalogue,
  Map<string, PlatformBlockRelease>
>();
const releaseIndex = (
  catalogue: ImmutablePlatformBlockCatalogue,
): Map<string, PlatformBlockRelease> => {
  let index = releaseIndexes.get(catalogue);
  if (index === undefined) {
    index = new Map(
      catalogue.releases.map((release) => [platformBlockReleaseIdentity(release), release]),
    );
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
    if (known === undefined || newer(release.releaseVersion, known.releaseVersion))
      newest.set(release.key, release);
  }
  return Object.freeze([...newest.values()].map((release) => choiceFor(catalogue, release)));
}

/** Whether a choice matches the search: its name, description, group or key holds every word. */
const matches = (choice: StudioPaletteChoice, words: readonly string[]): boolean => {
  const haystack =
    `${choice.name} ${choice.description} ${choice.groupLabel} ${choice.key}`.toLowerCase();
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
  const words = searchText
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const groups = new Map<BlockPaletteGroup, StudioPaletteChoice[]>();
  for (const group of Object.keys(PALETTE_GROUP_TITLES) as BlockPaletteGroup[])
    groups.set(group, []);
  for (const choice of choices) if (matches(choice, words)) groups.get(choice.group)?.push(choice);
  return Object.freeze(
    [...groups]
      .filter(([, list]) => list.length > 0)
      .map(([group, list]) =>
        Object.freeze({
          group,
          label: PALETTE_GROUP_TITLES[group],
          choices: Object.freeze([
            ...list.filter((choice) => choice.unavailable === undefined),
            ...list.filter((choice) => choice.unavailable !== undefined),
          ]),
        }),
      ),
  );
}

/**
 * One field a query reads, as the qualified field reference a block stores:
 * `<module>:<record>.<field>`, with the facts a Records table feature check needs: whether the
 * record type lets people sort, filter and search by it, and a choice field's number of options.
 */
export type StudioQueryField = Readonly<{
  reference: string;
  label: string;
  type: string;
  sortable: boolean;
  filterable: boolean;
  searchable: boolean;
  choiceCount?: number;
  choiceValues?: readonly string[];
  /** For a calculation or total, the type of the value it produces. */
  resultType?: string;
  /** The field is a one-record link from its record type to itself, so a record names its parent. */
  parentLink?: boolean;
}>;

/** The facts of one draft field, as a query field carries them. */
export const studioFieldFacts = (
  field: Readonly<{
    type: string;
    sortable: boolean;
    filterable: boolean;
    search_priority?: string | undefined;
    settings?: unknown;
  }>,
): Pick<
  StudioQueryField,
  "sortable" | "filterable" | "searchable" | "choiceCount" | "choiceValues" | "resultType"
> => {
  const options =
    field.type === "choice" && typeof field.settings === "object" && field.settings !== null
      ? (field.settings as { options?: unknown }).options
      : undefined;
  const declared =
    (field.type === "calculation" || field.type === "total") &&
    typeof field.settings === "object" &&
    field.settings !== null
      ? (field.settings as { result_type?: unknown }).result_type
      : undefined;
  const resultType = typeof declared === "string" ? declared : undefined;
  return {
    sortable: field.sortable,
    filterable: field.filterable,
    searchable: field.search_priority !== undefined,
    ...(Array.isArray(options)
      ? {
          choiceCount: options.length,
          choiceValues: options.map((option: { value: string }) => option.value),
        }
      : {}),
    ...(resultType === undefined ? {} : { resultType }),
  };
};

/** One input a query asks for, which a block binds to a value when it reads the query. */
export type StudioQueryInput = Readonly<{
  key: string;
  label: string;
  /** The input's value type, as the query declares it (for example `text` or `record_reference`). */
  type: string;
  required: boolean;
  /** For a record input, the record types it accepts, as `<module>:<record>`. */
  recordTypes?: readonly string[];
}>;

/** A query a data block can read, and the fields it reads. */
export type StudioQueryChoice = Readonly<{
  /** The qualified query reference a block stores: `<module>:<query>`. */
  reference: string;
  label: string;
  /** The record type the query reads, as `<module>:<record>`. */
  recordType: string;
  fields: readonly StudioQueryField[];
  /** The query groups or totals its rows, so its rows are not records a person can act on. */
  grouped: boolean;
  /** The values the query asks for. */
  inputs: readonly StudioQueryInput[];
  /** Whether the Applications that use its Module may read it. A borrowed query is always exposed. */
  exposure: ModuleQueryExposure;
  /**
   * For a query of a Module the application only uses, the application that owns it. Such a query
   * is chosen as it is: it is changed in its own application.
   */
  borrowedFrom?: string;
}>;

/** A module action a button or command can run, as the action key a block stores. */
export type StudioActionChoice = Readonly<{
  reference: string;
  label: string;
  /** For an action of a Module the application only uses, the application that owns it. */
  borrowedFrom?: string;
}>;

/** A relationship of a record type, as the qualified reference a block stores: `<module>:<record>.<relationship>`. */
export type StudioRelationshipChoice = Readonly<{
  reference: string;
  label: string;
  /** The record type the relationship starts from, as `<module>:<record>`. */
  recordType: string;
  /** The record types it links to, as `<module>:<record>`. */
  targets: readonly string[];
  borrowedFrom?: string;
}>;

/**
 * The queries, actions and relationships of the Modules an application uses, read on the server
 * from the exact Module releases its saved draft compiled against. They hold for as long as the
 * draft uses the same Modules (`usesSignature`).
 */
export type StudioBorrowedChoices = Readonly<{
  usesSignature: string;
  queries: readonly StudioQueryChoice[];
  actions: readonly StudioActionChoice[];
  relationships: readonly StudioRelationshipChoice[];
}>;

/** What the draft's used Modules offer while the draft still uses exactly those Modules. */
const borrowedFor = (
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
): StudioBorrowedChoices | null =>
  borrowed !== null && borrowed.usesSignature === studioUsesSignature(source) ? borrowed : null;

/** The Modules an application uses from other applications, in one comparable spelling. */
export const studioUsesSignature = (source: ApplicationSourceDocument): string =>
  JSON.stringify(source.body.uses.map((use) => `${use.application}/${use.module}`).sort());

/** The queries of the application's own Modules: they are in its source. */
/** Whether a draft field is a one-record link from its record type to itself. */
const isParentLink = (
  record:
    | Readonly<{
        key: string;
        relationships: readonly Readonly<{ from_field: string; cardinality: string }>[];
      }>
    | undefined,
  field: Readonly<{ key: string; type: string; settings?: unknown }>,
): boolean => {
  if (record === undefined || field.type !== "link") return false;
  const target = (field.settings as { target?: unknown } | undefined)?.target;
  return (
    typeof target === "string" &&
    target.slice(target.lastIndexOf(":") + 1) === record.key &&
    record.relationships.some(
      (relationship) =>
        relationship.from_field === field.key && relationship.cardinality === "many_to_one",
    )
  );
};

const ownQueries = (source: ApplicationSourceDocument): StudioQueryChoice[] =>
  (source.body.modules ?? []).flatMap((module) =>
    module.queries.map((query) => {
      const recordType = query.record_type.includes(":")
        ? query.record_type
        : `${module.key}:${query.record_type}`;
      const [moduleKey, recordKey] = recordType.split(":");
      const record = source.body.modules
        .find((candidate) => candidate.key === moduleKey)
        ?.record_types.find((candidate) => candidate.key === recordKey);
      const selected =
        query.select.length === 0 ? (record?.fields ?? []).map((field) => field.key) : query.select;
      const fields = selected.flatMap((key) => {
        const field = record?.fields.find((candidate) => candidate.key === key);
        return field === undefined
          ? []
          : [
              Object.freeze({
                reference: `${recordType}.${field.key}`,
                label: field.label,
                type: field.type,
                ...studioFieldFacts(field),
                ...(isParentLink(record, field) ? { parentLink: true } : {}),
              }),
            ];
      });
      const inputs = query.inputs.map((input) =>
        Object.freeze({
          key: input.key,
          label: input.label,
          type: input.type,
          required: input.required,
          ...(input.type === "record_reference"
            ? {
                recordTypes: Object.freeze(
                  input.record_types.map((type) =>
                    type.includes(":") ? type : `${module.key}:${type}`,
                  ),
                ),
              }
            : {}),
        }),
      );
      return Object.freeze({
        reference: `${module.key}:${query.key}`,
        label: query.label ?? query.key,
        recordType,
        fields: Object.freeze(fields),
        grouped: query.group_by.length > 0 || query.aggregates.length > 0,
        inputs: Object.freeze(inputs),
        exposure: query.exposure,
      });
    }),
  );

/** The record types of the application's own Modules in the draft, as `<module>:<record>`. */
export const studioSourceRecordTypes = (
  source: ApplicationSourceDocument,
): readonly Readonly<{ key: string; label: string }>[] =>
  Object.freeze(
    (source.body.modules ?? []).flatMap((module) =>
      module.record_types.map((record) =>
        Object.freeze({ key: `${module.key}:${record.key}`, label: record.name }),
      ),
    ),
  );

/** Every field of the application's own record types, for a block that reads no query. */
export const studioSourceFields = (
  source: ApplicationSourceDocument,
): readonly StudioQueryField[] =>
  Object.freeze(
    (source.body.modules ?? []).flatMap((module) =>
      module.record_types.flatMap((record) =>
        record.fields.map((field) =>
          Object.freeze({
            reference: `${module.key}:${record.key}.${field.key}`,
            label: `${record.name}: ${field.label}`,
            type: field.type,
            ...studioFieldFacts(field),
          }),
        ),
      ),
    ),
  );

/**
 * Every query a data block can read: those of the application's own Modules, then those of the
 * Modules it uses while the draft still uses them. Creating a query is the Data tab's work; a
 * block only picks one that exists.
 */
export function studioQueryChoices(
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
): readonly StudioQueryChoice[] {
  return Object.freeze([...ownQueries(source), ...(borrowedFor(source, borrowed)?.queries ?? [])]);
}

/**
 * The module actions a block can run: those of the application's own Modules in the draft, then
 * those of the Modules it uses, which are run as they are and changed in their own application.
 */
export function studioActionChoices(
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
): readonly StudioActionChoice[] {
  const own = (source.body.modules ?? []).flatMap((module) =>
    module.actions.map((action) => Object.freeze({ reference: action.key, label: action.label })),
  );
  return Object.freeze([...own, ...(borrowedFor(source, borrowed)?.actions ?? [])]);
}

/** The relationships of every record type in the draft, then those of the Modules it uses. */
export function studioRelationshipChoices(
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
): readonly StudioRelationshipChoice[] {
  const own = (source.body.modules ?? []).flatMap((module) =>
    module.record_types.flatMap((record) =>
      record.relationships.map((relationship) => {
        const from = record.fields.find((field) => field.key === relationship.from_field);
        const qualified = (target: string) =>
          target.includes(":") ? target : `${module.key}:${target}`;
        return Object.freeze({
          reference: `${module.key}:${record.key}.${relationship.key}`,
          label: `${record.name}: ${from?.label ?? relationship.key}`,
          recordType: `${module.key}:${record.key}`,
          targets: (relationship.to_record_type === undefined
            ? (relationship.to_record_types ?? [])
            : [relationship.to_record_type]
          ).map(qualified),
        });
      }),
    ),
  );
  return Object.freeze([...own, ...(borrowedFor(source, borrowed)?.relationships ?? [])]);
}

/**
 * Whether a block may store this query reference: a query of one of the application's own
 * Modules, or an exposed query of a Module it uses, as its last compile read them. It is the
 * picker's own list, so a private query of another application is never stored.
 */
export const studioQueryOffered = (
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
  reference: string,
): boolean => studioQueryChoices(source, borrowed).some((query) => query.reference === reference);
