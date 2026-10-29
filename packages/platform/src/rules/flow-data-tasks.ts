import {
  formatPageValue,
  formatterCatalogue,
  unitCatalogue,
  type PageFormatter,
} from "../pages/value-format";
import { moneyValueSchema, recordLinkValueSchema } from "../records/module-field-values";
import type { FlowDefinition, FlowTask } from "../workflows/flow-contracts";
import type { FlowRuntimeValue } from "./flow-formula";

type Properties = Readonly<Record<string, FlowRuntimeValue>>;

/** A canonical link can only come from the task's single declared record input. */
export const recordLinkTaskValue = (
  task: Extract<FlowTask, { properties: unknown }>,
  properties: Properties,
  flow: FlowDefinition,
): FlowRuntimeValue | undefined => {
  const recordType = task.properties.record_type;
  const record = task.properties.record;
  if (
    recordType?.kind !== "literal" ||
    recordType.literal.type !== "text" ||
    typeof recordType.literal.value !== "string" ||
    record?.kind !== "reference" ||
    record.reference.source !== "input"
  )
    return undefined;
  const recordTypeId = recordType.literal.value;
  const declaration = flow.inputs[record.reference.name];
  if (
    declaration?.type !== "record_reference" ||
    declaration.recordTypeIds?.length !== 1 ||
    declaration.recordTypeIds[0] !== recordTypeId ||
    properties.record_type?.type !== "text" ||
    properties.record_type.value !== recordTypeId ||
    properties.record?.type !== "record_reference" ||
    typeof properties.record.value !== "string"
  )
    return undefined;
  const link = recordLinkValueSchema.safeParse({
    recordTypeId,
    recordId: properties.record.value,
  });
  return link.success ? { type: "json", value: link.data } : undefined;
};

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
