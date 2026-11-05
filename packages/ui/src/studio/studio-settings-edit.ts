import { typedSourceSettingValue } from "@vortex/platform/schema";
import { describeStudioCompositionSettings } from "./application-composition-commands";
import type { StudioDraftChange, StudioCompositionContext } from "./application-composition-model";
import { followFieldLabels } from "./follow-field-labels";
import {
  settleStudioSetting,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "./studio-setting-model";

export type PuckItem = Readonly<{ type: string; props: Readonly<Record<string, unknown>> }>;

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

/** The two lists of a slot hold the same blocks (by name and type), whatever their props. */
const sameSlotBlocks = (was: unknown, now: unknown): boolean => {
  const before = slotItems(was) ?? [];
  const after = slotItems(now) ?? [];
  return (
    before.length === after.length &&
    before.every(
      (item, index) =>
        item === after[index] ||
        (item.type === after[index]?.type && item.props.id === after[index]?.props.id),
    )
  );
};

/**
 * What differs between the two states of one block: the keys of the values it holds itself, and
 * whether the blocks in one of its slots differ (by name and type: a slot's content is judged
 * where it changed, never through the block holding it). One block's props only.
 */
export const changedProps = (
  before: PuckItem,
  after: PuckItem,
): Readonly<{ keys: string[]; slots: boolean }> => {
  if (before.props === after.props) return { keys: [], slots: false };
  let slots = false;
  const keys = [...new Set([...Object.keys(before.props), ...Object.keys(after.props)])].filter(
    (key) => {
      const was = before.props[key];
      const now = after.props[key];
      if (Object.is(was, now) || (emptyList(was) && emptyList(now))) return false;
      if (slotItems(was) !== undefined || slotItems(now) !== undefined) {
        slots ||= !sameSlotBlocks(was, now);
        return false;
      }
      return JSON.stringify(was) !== JSON.stringify(now);
    },
  );
  return { keys, slots };
};

/** One block's settings edit: the block, the keys that changed and its props as Puck holds them. */
export type StudioSettingsEdit = Readonly<{
  alias: string;
  keys: readonly string[];
  props: Readonly<Record<string, unknown>>;
}>;

/**
 * The settings change for one block's edit in the inspector: each changed value is written whole,
 * the settings that no longer apply are dropped and the ones that now apply take their declared
 * default, copied field labels follow their field. A changed prop that is not a setting, or a value
 * that does not read as its declaration, is `invalid`: a settings edit never reaches the page
 * write. The runner applies the change to the context it was read from.
 */
export const settingsChangeOfPuckEdit = (
  context: StudioCompositionContext,
  choices: (query: string | null) => StudioSettingChoices,
  edit: StudioSettingsEdit,
):
  | Extract<StudioDraftChange, { kind: "settings" }>
  | Readonly<{ kind: "invalid" | "unsupported" }> => {
  const model = describeStudioCompositionSettings(context, {
    kind: "placement",
    placementAlias: edit.alias,
  });
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
  return { kind: "settings", settings: values, query: model.query };
};
