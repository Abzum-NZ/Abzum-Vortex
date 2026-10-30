import {
  formatPageValue,
  formatterCatalogue,
  unitCatalogue,
  type PageFormatter,
} from "../pages/value-format";
import { moneyValueSchema } from "../records/module-field-values";
import type { FlowRuntimeValue } from "./flow-formula";

type Properties = Readonly<Record<string, FlowRuntimeValue>>;

/** Uses the same exact-decimal formatter catalogue as the page renderer. */
export const formattedTaskValue = (properties: Properties): FlowRuntimeValue | undefined => {
  const formatter = properties.formatter?.value;
  const input = properties.input?.value;
  const places = properties.places?.value;
  const currency = properties.currency?.value;
  const unit = properties.unit?.value;
  if (
    typeof formatter !== "string" ||
    !formatterCatalogue.some((entry) => entry === formatter) ||
    (places !== undefined && typeof places !== "number") ||
    (currency !== undefined && typeof currency !== "string") ||
    (unit !== undefined && (typeof unit !== "string" || !Object.hasOwn(unitCatalogue, unit)))
  )
    return undefined;
  const money = moneyValueSchema.safeParse(input);
  const value = typeof input === "string" || typeof input === "number" ? input : money.data;
  if (value === undefined) return undefined;
  const formatted = formatPageValue(formatter as PageFormatter, value, {
    ...(places === undefined ? {} : { places }),
    ...(currency === undefined ? {} : { currency }),
    ...(unit === undefined ? {} : { unit: unit as keyof typeof unitCatalogue }),
  });
  return formatted === undefined ? undefined : { type: "text", value: formatted };
};
