import {
  type SourceItem,
  type SourcePageData,
  type SourceSlotOrder,
  sourcePageRootSlots,
} from "./application-composition/source-composition";
import type { ApplicationSourceDocument } from "./application-source-contracts";

type SourcePage = ApplicationSourceDocument["body"]["pages"][number];

/**
 * One editable content zone of an authored page: the page's content in the default frame, one
 * shell content slot (a root slot of the page data), a guided step, or one shell content slot of
 * a guided step. `key` is unique within its page.
 */
export type PageSlotAddress = Readonly<{
  key: string;
  label: string;
  step?: string;
  slot?: string;
}>;

/** The items of one page zone and that zone's authored tablet and phone order. */
export type SourcePageZone = Readonly<{ items: SourceItem[]; order: SourceSlotOrder | undefined }>;

const contentZone = "content";

const addressKey = (step: string | undefined, slot: string | undefined): string =>
  step === undefined ? (slot ?? "main") : slot === undefined ? step : `${step}/${slot}`;

const address = (step: string | undefined, slot: string | undefined): PageSlotAddress => ({
  key: addressKey(step, slot),
  label: [step, slot].filter((part) => part !== undefined).join(" / ") || "Page content",
  ...(step === undefined ? {} : { step }),
  ...(slot === undefined ? {} : { slot }),
});

const dataAddresses = (data: SourcePageData, step: string | undefined): PageSlotAddress[] =>
  data.root.props.vortex.shell === null
    ? [address(step, undefined)]
    : sourcePageRootSlots(data).map(([slot]) => address(step, slot));

/** Every content zone of the authored page, in authored order. */
export const sourcePageSlotAddresses = (page: SourcePage): readonly PageSlotAddress[] => {
  const composition = page.composition;
  if (!("step_content" in composition)) return dataAddresses(composition, undefined);
  return Object.entries(composition.step_content).flatMap(([step, data]) =>
    dataAddresses(data, step),
  );
};

const dataAt = (page: SourcePage, at: PageSlotAddress): SourcePageData | undefined => {
  const composition = page.composition;
  if (!("step_content" in composition)) return at.step === undefined ? composition : undefined;
  return at.step === undefined ? undefined : composition.step_content[at.step];
};

const zoneKeyAt = (data: SourcePageData, at: PageSlotAddress): string | undefined => {
  if (data.root.props.vortex.shell === null) return at.slot === undefined ? contentZone : undefined;
  return at.slot !== undefined && Array.isArray(data.root.props[at.slot]) ? at.slot : undefined;
};

/** The authored zone at the address, or undefined when the page has no such zone. */
export const sourcePageSlotAt = (
  page: SourcePage,
  at: PageSlotAddress,
): SourcePageZone | undefined => {
  const data = dataAt(page, at);
  const zone = data === undefined ? undefined : zoneKeyAt(data, at);
  if (data === undefined || zone === undefined) return undefined;
  const items =
    zone === contentZone && data.root.props.vortex.shell === null
      ? data.content
      : (data.root.props[zone] as SourceItem[]);
  return { items, order: data.root.props.vortex.slot_orders[zone] };
};

/** Replaces the authored zone at the address in place; false when the page has no such zone. */
export const setSourcePageSlot = (
  page: SourcePage,
  at: PageSlotAddress,
  value: SourcePageZone,
): boolean => {
  const data = dataAt(page, at);
  const zone = data === undefined ? undefined : zoneKeyAt(data, at);
  if (data === undefined || zone === undefined) return false;
  if (zone === contentZone && data.root.props.vortex.shell === null) data.content = value.items;
  else data.root.props[zone] = value.items;
  if (value.order === undefined) delete data.root.props.vortex.slot_orders[zone];
  else data.root.props.vortex.slot_orders[zone] = value.order;
  return true;
};
