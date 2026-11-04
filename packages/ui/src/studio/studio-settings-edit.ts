import type { Data } from "@puckeditor/core";
import { typedSourceSettingValue } from "@vortex/platform/schema";
import {
  applyStudioCompositionCommand,
  describeStudioCompositionSettings,
} from "./application-composition-commands";
import type {
  StudioCompositionCommandResult,
  StudioCompositionContext,
} from "./application-composition-model";
import { followFieldLabels } from "./follow-field-labels";
import {
  settleStudioSetting,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "./studio-setting-model";

type PuckItem = Readonly<{ type: string; props: Readonly<Record<string, unknown>> }>;

const isItem = (value: unknown): value is PuckItem =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PuckItem).type === "string" &&
  typeof (value as PuckItem).props === "object" &&
  (value as PuckItem).props !== null &&
  typeof (value as PuckItem).props.id === "string";

const slotItems = (value: unknown): readonly PuckItem[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every(isItem) ? value : undefined;

/** An empty array is how Puck holds an empty slot, and a setting never holds one. */
const emptyList = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0);

/** The blocks of Puck data by name, each with the keys of its own (non-slot) props. */
const indexItems = (data: Data): Map<string, PuckItem> | undefined => {
  const index = new Map<string, PuckItem>();
  let duplicate = false;
  const visit = (items: readonly PuckItem[]) => {
    for (const item of items) {
      if (index.has(item.props.id as string)) duplicate = true;
      index.set(item.props.id as string, item);
      for (const value of Object.values(item.props)) {
        const children = slotItems(value);
        if (children !== undefined) visit(children);
      }
    }
  };
  const root = (data.root as { props?: Record<string, unknown> }).props ?? {};
  visit(((data.content ?? []) as unknown[]).filter(isItem));
  for (const value of Object.values(root)) {
    const children = slotItems(value);
    if (children !== undefined) visit(children);
  }
  return duplicate ? undefined : index;
};

/** The shape of a block: its name, type and the names of the blocks in each of its slots. */
const skeleton = (item: PuckItem): unknown => [
  item.type,
  item.props.id,
  Object.entries(item.props).flatMap(([key, value]) => {
    const children = slotItems(value);
    return children === undefined ? [] : [[key, children.map(skeleton)]];
  }),
];

const pageSkeleton = (data: Data): string =>
  JSON.stringify([
    ((data.content ?? []) as unknown[]).filter(isItem).map(skeleton),
    Object.entries((data.root as { props?: Record<string, unknown> }).props ?? {}).flatMap(
      ([key, value]) => {
        const children = slotItems(value);
        return children === undefined ? [] : [[key, children.map(skeleton)]];
      },
    ),
  ]);

/** What differs in the props of one block, other than its slots. */
const changedKeys = (before: PuckItem, after: PuckItem): string[] => {
  if (before.props === after.props) return [];
  const keys = new Set([...Object.keys(before.props), ...Object.keys(after.props)]);
  return [...keys].filter((key) => {
    const was = before.props[key];
    const now = after.props[key];
    if (Object.is(was, now) || (emptyList(was) && emptyList(now))) return false;
    return JSON.stringify(was) !== JSON.stringify(now) && slotItems(was) === undefined;
  });
};

/** The changed keys of an edit that are settings: the slot order (`vortex`) and `id` are not. */
export const settingKeysOf = (keys: readonly string[]): string[] =>
  keys.filter((key) => key !== "vortex" && key !== "id");

/** One block's settings edit: the block, the keys that changed and its props as Puck holds them. */
export type StudioSettingsEdit = Readonly<{
  alias: string;
  keys: readonly string[];
  props: Readonly<Record<string, unknown>>;
}>;

/**
 * The one block whose own props differ between two states of the page, when nothing else about
 * the page differs (no block added, removed or moved): a settings edit in the inspector.
 */
export const singleBlockPropsEdit = (
  shown: Data,
  candidate: Data,
): StudioSettingsEdit | undefined => {
  const before = indexItems(shown);
  const after = indexItems(candidate);
  if (before === undefined || after === undefined || before.size !== after.size) return undefined;
  if (pageSkeleton(shown) !== pageSkeleton(candidate)) return undefined;
  let found: StudioSettingsEdit | undefined;
  for (const [alias, item] of after) {
    const was = before.get(alias);
    if (was === undefined) return undefined;
    const keys = changedKeys(was, item);
    if (keys.length === 0) continue;
    if (found !== undefined) return undefined;
    found = { alias, keys, props: item.props };
  }
  return found;
};

/**
 * The source after the settings of one block changed: each changed value is written whole, the
 * settings that no longer apply are dropped and the ones that now apply take their declared
 * default, copied field labels follow their field, and the result goes through the one settings
 * command. A changed prop that is not a setting, or a value that does not read as its
 * declaration, is refused as `invalid`: a settings edit never reaches the page write.
 */
export const applySettingsEdit = (
  context: StudioCompositionContext,
  choices: (query: string | null) => StudioSettingChoices,
  edit: StudioSettingsEdit,
): StudioCompositionCommandResult => {
  const selection = { kind: "placement", placementAlias: edit.alias } as const;
  const model = describeStudioCompositionSettings(context, selection);
  if (model.kind !== "available") return { kind: model.kind };
  let values: StudioSettingValues = model.settings;
  for (const key of edit.keys) {
    const property = model.properties.find((candidate) => candidate.key === key);
    if (property === undefined) return { kind: "invalid" };
    const plain = edit.props[key];
    const next =
      plain === undefined ? undefined : typedSourceSettingValue(plain, property, [key], []);
    if (plain !== undefined && next === undefined) return { kind: "invalid" };
    values = settleStudioSetting(model.properties, values, key, next);
  }
  const fields = choices(model.query).fields;
  values = followFieldLabels(model.properties, values, model.settings, fields, fields);
  return applyStudioCompositionCommand(context, context, selection, {
    kind: "settings",
    settings: values,
    query: model.query,
  });
};
