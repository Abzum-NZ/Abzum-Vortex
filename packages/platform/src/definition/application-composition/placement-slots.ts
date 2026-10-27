import { builderKeySchema } from "../../catalogue/identifiers";
import type { BlockPropertySchemaContract, ComponentSettingValue } from "./block-property-schema";

/*
 * How a placement's settings name its slots and declarations, apart from the block release
 * contracts, so the renderer reads them without loading those contracts.
 */

/**
 * The exact placement slot key one repeatable item owns: `${family}_${identity}`. The family is
 * the repeatable slot declaration's key, so every slot the release declares stays a valid builder
 * key and two repeatable slot families on one release never collide.
 */
export const repeatableSlotKey = (family: string, identity: string): string =>
  `${family}_${identity}`;

/**
 * The stable item identities one repeatable slot declaration owns, read from a placement's
 * settings. An absent or wrong-kind list owns none. Every item of the list contributes exactly
 * one identity, returned verbatim in item order and including duplicates: an item that is not a
 * group or whose identity is not text contributes the empty identity. Callers therefore judge
 * every item with `isRepeatableSlotIdentity` and refuse a duplicate, rather than silently
 * dropping a malformed item or collapsing two items onto one slot.
 */
export const repeatableSlotItemIdentities = (
  declaration: Readonly<{
    key: string;
    repeats?: Readonly<{ items: string; identity: string }> | undefined;
  }>,
  settings: Readonly<Record<string, ComponentSettingValue>>,
): readonly string[] => {
  const repeats = declaration.repeats;
  if (repeats === undefined) return [];
  const list = settings[repeats.items];
  if (list?.kind !== "list") return [];
  const identities: string[] = [];
  for (const item of list.items) {
    const identity = item.kind === "group" ? item.properties[repeats.identity] : undefined;
    identities.push(identity?.kind === "text" ? identity.value : "");
  }
  return identities;
};

/**
 * Whether one repeatable item identity is admissible: the identity itself and the slot key it
 * names under `family` must both be builder keys, so an identity never needs trimming or escaping
 * and the renderer, designer and publication all key the item's slot identically.
 */
export const isRepeatableSlotIdentity = (family: string, identity: string): boolean =>
  builderKeySchema.safeParse(identity).success &&
  builderKeySchema.safeParse(repeatableSlotKey(family, identity)).success;

/**
 * Every setting a placement of a release carries: its own properties, then the properties the
 * compiler derives for it. A reader tells an item's settings from its slots by this declaration.
 */
export const releaseSettingDeclarations = (
  release: Readonly<{
    properties: readonly BlockPropertySchemaContract[];
    derivedProperties?: readonly BlockPropertySchemaContract[] | undefined;
  }>,
): readonly BlockPropertySchemaContract[] => [
  ...release.properties,
  ...(release.derivedProperties ?? []),
];
