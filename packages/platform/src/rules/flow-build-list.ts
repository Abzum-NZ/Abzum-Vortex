import type { JsonValue } from "../catalogue/common";
import { isRecord } from "../catalogue/runtime-primitives";

/** One entry of a built list: the value a picker stores, the label it shows, and an optional note. */
export type FlowBuiltListEntry = Readonly<{
  value: JsonValue;
  label: string;
  description?: string;
}>;

const pathOf = (item: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), item);

/**
 * The list one `data.build_list` step returns: each item's value, label and optional description,
 * read from the keys (or dotted paths) the step names. Undefined when the items are not a list or
 * an entry does not hold a value and a label of its own.
 */
export const buildFlowList = (
  items: unknown,
  valueKey: unknown,
  labelKey: unknown,
  descriptionKey: unknown,
): readonly FlowBuiltListEntry[] | undefined => {
  if (
    !Array.isArray(items) ||
    typeof valueKey !== "string" ||
    typeof labelKey !== "string" ||
    (descriptionKey !== undefined && typeof descriptionKey !== "string")
  )
    return undefined;
  const list: FlowBuiltListEntry[] = [];
  for (const item of items) {
    const value = pathOf(item, valueKey);
    const label = pathOf(item, labelKey);
    if (value === undefined || typeof label !== "string") return undefined;
    const description = descriptionKey === undefined ? undefined : pathOf(item, descriptionKey);
    list.push({
      value: value as JsonValue,
      label,
      ...(typeof description === "string" ? { description } : {}),
    });
  }
  return list;
};
