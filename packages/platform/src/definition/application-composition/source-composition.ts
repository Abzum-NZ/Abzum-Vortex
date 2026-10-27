import { z } from "zod";
import { jsonValueSchema, labelSchema } from "../../catalogue/common";
import { builderKeySchema, namespacedKeySchema } from "../../catalogue/identifiers";
import {
  sourceAliasSchema,
  sourceQualifiedConditionSchema,
  sourceQualifiedQueryReferenceSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "../definition-source-common";
import { type ComponentSettingFailure, typedSourceSettings } from "./block-property-schema";
import type { SourceBlockPropertyValueContract } from "./block-property-values";
import {
  type PlatformBlockRelease,
  reservedItemPropKeys,
  sourcePlatformBlockReferenceSchema,
} from "./platform-block-release";
import {
  isRepeatableSlotIdentity,
  repeatableSlotItemIdentities,
  repeatableSlotKey,
} from "./placement-slots";
import {
  sourceApplicationShellPresentationSchema,
  sourceResponsivePlacementSchema,
  sourceShellContentSlotSchema,
} from "./page-composition";

/**
 * Authored page and shell layouts take Puck 0.23's data shape (`Data`, `ComponentData`).
 *
 * An item is `{ type, props }`: `type` is the block release's renderer key, `props.id` the item's
 * application-unique alias, every other prop either a plain setting value or one child slot (an
 * array of items, keyed by the release's slot key), and `props.vortex` the Vortex-only metadata:
 * the exact block release, access and data bindings, theme overrides, responsive layout and the
 * tablet and phone order of each child slot. A slot array's order is its desktop order; a missing
 * tablet or phone order inherits from the next wider breakpoint.
 *
 * Page data is `{ root, content }`. With the platform default frame (`root.props.vortex.shell` is
 * null) the page's blocks are `content`. With an application shell, `content` is empty and each
 * shell content slot the page fills is a root slot prop named by that content slot's alias. Root
 * slot orders are keyed by zone: `content` or the content slot alias.
 */

export type SourceSlotOrder = { tablet?: string[] | undefined; phone?: string[] | undefined };
export type SourceSlotOrders = Record<string, SourceSlotOrder>;

export type SourceItemVortex = {
  block: z.infer<typeof sourcePlatformBlockReferenceSchema>;
  view_permission?: string | undefined;
  use_permission?: string | undefined;
  visibility_condition?: z.infer<typeof sourceQualifiedConditionSchema> | undefined;
  query?: string | undefined;
  responsive: z.infer<typeof sourceResponsivePlacementSchema>;
  slot_orders?: SourceSlotOrders | undefined;
};

export type SourceItemProps = { id: string; vortex: SourceItemVortex } & Record<string, unknown>;
export type SourceItem = { type: string; props: SourceItemProps };

const rootZone = "content";

const plainRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Whether a value has the shape of an authored item. A prop holding a non-empty array of such
 * values is a child slot; any other prop is a setting value.
 */
export const isSourceItemShape = (value: unknown): value is SourceItem => {
  const item = plainRecord(value);
  const props = plainRecord(item?.props);
  return (
    item !== undefined &&
    props !== undefined &&
    Object.keys(item).every((key) => key === "type" || key === "props") &&
    typeof item.type === "string" &&
    typeof props.id === "string" &&
    plainRecord(props.vortex) !== undefined
  );
};

const isSourceSlotValue = (value: unknown): value is SourceItem[] =>
  Array.isArray(value) && value.length > 0 && value.every(isSourceItemShape);

/** The item's non-empty child slots, read from its props alone, in prop order. */
export const sourceItemChildSlots = (item: SourceItem): [string, SourceItem[]][] =>
  Object.entries(item.props).flatMap(([key, value]): [string, SourceItem[]][] =>
    reservedItemPropKeys.has(key) || !isSourceSlotValue(value) ? [] : [[key, value]],
  );

/** Every item in the list and their descendants, depth first in authored order. */
export const sourceItemTree = (
  items: readonly SourceItem[],
  result: SourceItem[] = [],
): SourceItem[] => {
  for (const item of items) {
    result.push(item);
    for (const [, children] of sourceItemChildSlots(item)) sourceItemTree(children, result);
  }
  return result;
};

/** The aliases in each breakpoint order of one slot: desktop is the authored array order. */
export const sourceSlotBreakpointOrders = (
  items: readonly SourceItem[],
  order: SourceSlotOrder | undefined,
): { desktop: string[]; tablet: string[]; phone: string[] } => {
  const desktop = items.map((item) => item.props.id);
  const tablet = order?.tablet ?? desktop;
  return { desktop, tablet, phone: order?.phone ?? tablet };
};

const sameMembers = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((entry) => expected.includes(entry));

/** Each declared order names exactly its slot's items, and only a slot that exists is ordered. */
const refineSlotOrders = (
  orders: SourceSlotOrders | undefined,
  zones: ReadonlyMap<string, readonly SourceItem[]>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void => {
  for (const [zone, order] of Object.entries(orders ?? {})) {
    const items = zones.get(zone);
    if (items === undefined) {
      context.addIssue({
        code: "custom",
        path: [...path, zone],
        message: "A slot order must name a slot of the same item",
      });
      continue;
    }
    const ids = items.map((item) => item.props.id);
    for (const breakpoint of ["tablet", "phone"] as const) {
      const declared = order[breakpoint];
      if (declared !== undefined && !sameMembers(declared, ids))
        context.addIssue({
          code: "custom",
          path: [...path, zone, breakpoint],
          message: "Each declared breakpoint order must be one complete permutation of its slot",
        });
    }
  }
};

const sourceSlotOrderSchema = z
  .object({
    tablet: sourceProvenanceUnchanged(z.array(sourceAliasSchema).optional()),
    phone: sourceProvenanceUnchanged(z.array(sourceAliasSchema).optional()),
  })
  .strict();

const sourceSlotOrdersSchema = z.record(sourceAliasSchema, sourceSlotOrderSchema);

const sourceItemVortexSchema = z
  .object({
    block: sourceProvenanceUnchanged(sourcePlatformBlockReferenceSchema),
    view_permission: sourceProvenanceTarget(namespacedKeySchema.optional(), ["viewPermissionKey"]),
    use_permission: sourceProvenanceTarget(namespacedKeySchema.optional(), ["usePermissionKey"]),
    visibility_condition: sourceProvenanceUnchanged(sourceQualifiedConditionSchema.optional()),
    query: sourceProvenanceTarget(sourceQualifiedQueryReferenceSchema.optional(), ["queryId"]),
    responsive: sourceProvenanceUnchanged(sourceResponsivePlacementSchema),
    slot_orders: sourceProvenanceUnchanged(sourceSlotOrdersSchema.optional()),
  })
  .strict();

/**
 * One authored item. Settings and child slots share the props object, so a child slot is
 * recognised by its shape here; publication judges every prop again against the release, which
 * declares exactly which keys are settings and which are slots.
 */
export const sourceItemSchema: z.ZodType<SourceItem> = z.lazy(() =>
  z
    .object({
      type: sourceProvenanceUnchanged(namespacedKeySchema),
      props: sourceProvenanceUnchanged(
        z
          .object({
            id: sourceProvenanceTarget(sourceAliasSchema, ["placementId"]),
            vortex: sourceProvenanceUnchanged(sourceItemVortexSchema),
          })
          .catchall(jsonValueSchema)
          .superRefine((props, context) => {
            const zones = new Map<string, readonly SourceItem[]>();
            for (const [key, value] of Object.entries(props)) {
              if (reservedItemPropKeys.has(key)) continue;
              if (Array.isArray(value) && value.length === 0) zones.set(key, []);
              if (!isSourceSlotValue(value)) continue;
              zones.set(key, value);
              value.forEach((child, index) => {
                const parsed = sourceItemSchema.safeParse(child);
                if (!parsed.success)
                  for (const issue of parsed.error.issues)
                    context.addIssue({
                      code: "custom",
                      path: [key, index, ...issue.path.map((part) => part as string | number)],
                      message: issue.message,
                    });
              });
            }
            refineSlotOrders(props.vortex.slot_orders, zones, context, ["vortex", "slot_orders"]);
          }),
      ),
    })
    .strict(),
) as unknown as z.ZodType<SourceItem>;

const sourceItemsSchema = z.array(sourceItemSchema);

export type SourcePageData = {
  root: {
    props: { vortex: { shell: string | null; slot_orders: SourceSlotOrders } } & Record<
      string,
      unknown
    >;
  };
  content: SourceItem[];
};

/** The root slots of page data: every root prop but `vortex`, each one shell content slot. */
export const sourcePageRootSlots = (data: SourcePageData): [string, SourceItem[]][] =>
  Object.entries(data.root.props).flatMap(([key, value]): [string, SourceItem[]][] =>
    key === "vortex" ? [] : [[key, value as SourceItem[]]],
  );

/** Every zone of page data with its items: `content` and each root slot. */
export const sourcePageZones = (data: SourcePageData): [string, SourceItem[]][] => [
  [rootZone, data.content],
  ...sourcePageRootSlots(data),
];

/** One page's (or one guided step's) Puck data. */
export const sourcePageDataSchema = z
  .object({
    root: sourceProvenanceUnchanged(
      z
        .object({
          props: sourceProvenanceUnchanged(
            z
              .object({
                vortex: sourceProvenanceUnchanged(
                  z
                    .object({
                      shell: sourceProvenanceTarget(sourceAliasSchema.nullable(), ["shellId"]),
                      slot_orders: sourceProvenanceUnchanged(sourceSlotOrdersSchema),
                    })
                    .strict(),
                ),
              })
              .catchall(sourceItemsSchema),
          ),
        })
        .strict(),
    ),
    content: sourceProvenanceUnchanged(sourceItemsSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const data = value as unknown as SourcePageData;
    const rootSlots = sourcePageRootSlots(data);
    if (data.root.props.vortex.shell === null && rootSlots.length > 0)
      context.addIssue({
        code: "custom",
        path: ["root", "props"],
        message: "A page in the default frame places its blocks in content, not in root slots",
      });
    if (data.root.props.vortex.shell !== null && data.content.length > 0)
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "A page in an application shell places its blocks in the shell's content slots",
      });
    const zones = new Map<string, readonly SourceItem[]>(
      data.root.props.vortex.shell === null ? [[rootZone, data.content]] : rootSlots,
    );
    refineSlotOrders(data.root.props.vortex.slot_orders, zones, context, [
      "root",
      "props",
      "vortex",
      "slot_orders",
    ]);
  }) as unknown as z.ZodType<SourcePageData>;

export type SourceGuidedFormPageComposition = { step_content: Record<string, SourcePageData> };

/** A guided form's Puck data for every step, keyed by step alias; every step uses one frame. */
export const sourceGuidedFormPageCompositionSchema = z
  .object({
    step_content: sourceProvenanceUnchanged(z.record(sourceAliasSchema, sourcePageDataSchema)),
  })
  .strict()
  .superRefine((value, context) => {
    const shells = new Set(
      Object.values(value.step_content as Record<string, SourcePageData>).map(
        (step) => step.root.props.vortex.shell,
      ),
    );
    if (shells.size > 1)
      context.addIssue({
        code: "custom",
        path: ["step_content"],
        message: "Every step of a guided form uses the same frame",
      });
  }) as unknown as z.ZodType<SourceGuidedFormPageComposition>;

export type SourceShellLayout = {
  root: { props: { vortex: { slot_orders: SourceSlotOrders } } };
  content: SourceItem[];
};

const sourceShellLayoutSchema = z
  .object({
    root: sourceProvenanceUnchanged(
      z
        .object({
          props: sourceProvenanceUnchanged(
            z
              .object({
                vortex: sourceProvenanceUnchanged(
                  z
                    .object({ slot_orders: sourceProvenanceUnchanged(sourceSlotOrdersSchema) })
                    .strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    content: sourceProvenanceUnchanged(sourceItemsSchema),
  })
  .strict()
  .superRefine((value, context) => {
    refineSlotOrders(
      value.root.props.vortex.slot_orders,
      new Map([[rootZone, value.content]]),
      context,
      ["root", "props", "vortex", "slot_orders"],
    );
  });

export const sourceApplicationShellSchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["shellId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    name: sourceProvenanceUnchanged(labelSchema),
    presentation: sourceProvenanceUnchanged(sourceApplicationShellPresentationSchema),
    layout: sourceProvenanceUnchanged(sourceShellLayoutSchema),
    content_slots: sourceProvenanceUnchanged(z.array(sourceShellContentSlotSchema).min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.content_slots.map((slot) => slot.id);
    const keys = value.content_slots.map((slot) => slot.key);
    const targets = value.content_slots.map(
      (slot) => `${slot.parent_placement}:${slot.parent_slot}`,
    );
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["content_slots"],
        message: "Shell content-slot aliases must be unique",
      });
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["content_slots"],
        message: "Shell content-slot keys must be unique",
      });
    if (new Set(targets).size !== targets.length)
      context.addIssue({
        code: "custom",
        path: ["content_slots"],
        message: "A shell location can expose only one content slot",
      });
    const items = new Map(
      sourceItemTree(value.layout.content).map((item) => [item.props.id, item]),
    );
    for (const [index, slot] of value.content_slots.entries()) {
      const target = items.get(slot.parent_placement)?.props[slot.parent_slot];
      if (!Array.isArray(target))
        context.addIssue({
          code: "custom",
          path: ["content_slots", index, "parent_slot"],
          message: "A shell content slot must target a declared slot on one shell item",
        });
      else if (target.length > 0)
        context.addIssue({
          code: "custom",
          path: ["content_slots", index, "parent_slot"],
          message: "An exposed shell content slot must reserve an empty target for page content",
        });
    }
  });

export type SourceApplicationShell = z.infer<typeof sourceApplicationShellSchema>;
export type SourcePageComposition = SourcePageData | SourceGuidedFormPageComposition;

/** The Puck data of every step of a guided form, or the page's one data otherwise. */
export const sourcePageDataOf = (composition: SourcePageComposition): SourcePageData[] =>
  "step_content" in composition ? Object.values(composition.step_content) : [composition];

/** The application shell alias a page's frame uses, or null for the platform default frame. */
export const sourcePageShell = (composition: SourcePageComposition): string | null =>
  sourcePageDataOf(composition)[0]?.root.props.vortex.shell ?? null;

/** Every item a page places, in every step and zone, depth first. */
export const sourcePageItems = (composition: SourcePageComposition): SourceItem[] =>
  sourcePageDataOf(composition).flatMap((data) =>
    sourcePageZones(data).flatMap(([, items]) => sourceItemTree(items)),
  );

/**
 * One authored item read against its exact block release: its typed settings and the failures
 * reading them produced, and every slot the release gives it with the items the author placed
 * there (`undefined` for a slot the author left out). Keys that are neither declared settings nor
 * slots the release gives this item are `unknownKeys`; a slot prop that is not an array of items
 * is in `malformedSlots`; repeatable item identities that are duplicated or inadmissible are
 * reported once per repeatable declaration in `repeatableFailures`.
 */
export type SourceItemReading = Readonly<{
  settings: Record<string, SourceBlockPropertyValueContract>;
  settingFailures: readonly ComponentSettingFailure[];
  slots: ReadonlyMap<
    string,
    Readonly<{
      declaration: PlatformBlockRelease["slots"][number];
      items: SourceItem[] | undefined;
    }>
  >;
  unknownKeys: readonly string[];
  malformedSlots: readonly string[];
  repeatableFailures: readonly Readonly<{
    declaration: PlatformBlockRelease["slots"][number];
    family: "duplicate_key" | "invalid_value";
  }>[];
}>;

export const readSourceItem = (
  item: SourceItem,
  release: PlatformBlockRelease,
): SourceItemReading => {
  const fixedSlots = new Map(
    release.slots
      .filter((declaration) => declaration.repeats === undefined)
      .map((declaration) => [declaration.key, declaration]),
  );
  const repeatableFamilies = release.slots.filter(
    (declaration) => declaration.repeats !== undefined,
  );
  const slotCandidate = (key: string): boolean =>
    fixedSlots.has(key) ||
    repeatableFamilies.some((declaration) => key.startsWith(`${declaration.key}_`));
  const authoredSettings = Object.fromEntries(
    Object.entries(item.props).filter(
      ([key]) => !reservedItemPropKeys.has(key) && !slotCandidate(key),
    ),
  );
  const typed = typedSourceSettings(authoredSettings, release.properties);
  const slots = new Map<
    string,
    { declaration: PlatformBlockRelease["slots"][number]; items: SourceItem[] | undefined }
  >();
  const malformedSlots: string[] = [];
  const read = (key: string, declaration: PlatformBlockRelease["slots"][number]): void => {
    const value = item.props[key];
    if (value === undefined) {
      slots.set(key, { declaration, items: undefined });
      return;
    }
    if (!Array.isArray(value) || !value.every(isSourceItemShape)) {
      malformedSlots.push(key);
      return;
    }
    slots.set(key, { declaration, items: value });
  };
  for (const [key, declaration] of fixedSlots) read(key, declaration);
  const repeatableFailures: {
    declaration: PlatformBlockRelease["slots"][number];
    family: "duplicate_key" | "invalid_value";
  }[] = [];
  for (const declaration of repeatableFamilies) {
    const identities = repeatableSlotItemIdentities(declaration, typed.settings);
    if (new Set(identities).size !== identities.length)
      repeatableFailures.push({ declaration, family: "duplicate_key" });
    for (const identity of identities) {
      if (!isRepeatableSlotIdentity(declaration.key, identity)) {
        repeatableFailures.push({ declaration, family: "invalid_value" });
        continue;
      }
      read(repeatableSlotKey(declaration.key, identity), declaration);
    }
  }
  const unknownKeys = Object.keys(item.props).filter(
    (key) =>
      !reservedItemPropKeys.has(key) &&
      slotCandidate(key) &&
      !slots.has(key) &&
      !malformedSlots.includes(key),
  );
  return {
    settings: typed.settings,
    settingFailures: typed.failures,
    slots,
    unknownKeys,
    malformedSlots,
    repeatableFailures,
  };
};
