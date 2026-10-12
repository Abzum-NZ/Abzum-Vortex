import type { z } from "zod";
import type { sourcePlacementSlotSchema } from "./application-composition";
import type { ApplicationSourceDocument } from "./application-source-contracts";

type SourcePage = ApplicationSourceDocument["body"]["pages"][number];
type SourceSlot = z.infer<typeof sourcePlacementSlotSchema>;

/**
 * One editable content slot of an authored page: the page's main slot, one shell content slot, a
 * guided step, or one shell content slot of a guided step. `key` is unique within its page.
 */
export type PageSlotAddress = Readonly<{
  key: string;
  label: string;
  step?: string;
  slot?: string;
}>;

const addressKey = (step: string | undefined, slot: string | undefined): string =>
  step === undefined ? (slot ?? "main") : slot === undefined ? step : `${step}/${slot}`;

const address = (step: string | undefined, slot: string | undefined): PageSlotAddress => ({
  key: addressKey(step, slot),
  label: [step, slot].filter((part) => part !== undefined).join(" / ") || "Page content",
  ...(step === undefined ? {} : { step }),
  ...(slot === undefined ? {} : { slot }),
});

/** Every content slot of the authored page, in authored order. */
export const sourcePageSlotAddresses = (page: SourcePage): readonly PageSlotAddress[] => {
  const composition = page.composition;
  if ("main" in composition) return [address(undefined, undefined)];
  if ("content" in composition)
    return Object.keys(composition.content).map((slot) => address(undefined, slot));
  if (composition.shell_kind === "default")
    return Object.keys(composition.step_content).map((step) => address(step, undefined));
  return Object.entries(composition.step_content).flatMap(([step, content]) =>
    Object.keys(content).map((slot) => address(step, slot)),
  );
};

/** The authored slot at the address, or undefined when the page has no such slot. */
export const sourcePageSlotAt = (page: SourcePage, at: PageSlotAddress): SourceSlot | undefined => {
  const composition = page.composition;
  if ("main" in composition) return composition.main;
  if ("content" in composition)
    return at.slot === undefined ? undefined : composition.content[at.slot];
  if (at.step === undefined) return undefined;
  const stepContent = composition.step_content[at.step];
  if (composition.shell_kind === "default") return stepContent as SourceSlot | undefined;
  return at.slot === undefined
    ? undefined
    : (stepContent as Record<string, SourceSlot> | undefined)?.[at.slot];
};

/** Replaces the authored slot at the address in place; false when the page has no such slot. */
export const setSourcePageSlot = (
  page: SourcePage,
  at: PageSlotAddress,
  value: SourceSlot,
): boolean => {
  if (sourcePageSlotAt(page, at) === undefined) return false;
  const composition = page.composition;
  if ("main" in composition) composition.main = value;
  else if ("content" in composition) composition.content[at.slot!] = value;
  else if (composition.shell_kind === "default") composition.step_content[at.step!] = value;
  else composition.step_content[at.step!]![at.slot!] = value;
  return true;
};
