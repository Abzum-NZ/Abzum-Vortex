import { z } from "zod";
import { blockPaletteGroupSchema } from "../../catalogue/catalogues";
import { labelSchema } from "../../catalogue/common";
import {
  sourceAliasSchema,
  sourceProvenanceTarget,
  sourceProvenanceUnchanged,
} from "../definition-source-common";
import { conditionNodeSchema } from "../module-foundation-contracts";
import {
  builderKeySchema,
  containedComponentIdSchema,
  namespacedKeySchema,
  queryIdSchema,
  shellIdSchema,
} from "../../catalogue/identifiers";
import { positiveFiniteSchema } from "./shared";
import { type BlockPropertyValueContract, blockPropertyValueSchema } from "./block-property-values";
import {
  platformBlockDependenciesSchema,
  platformBlockReferenceSchema,
} from "./platform-block-release";
import { themeTokenValueSchema, applicationThemeSchema } from "./theme";

const widthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: sourceProvenanceUnchanged(z.literal("content")) }).strict(),
  z.object({ kind: sourceProvenanceUnchanged(z.literal("fill")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("grid")),
      startColumn: sourceProvenanceUnchanged(z.number().int().min(1).max(12)),
      span: sourceProvenanceUnchanged(z.number().int().min(1).max(12)),
    })
    .strict()
    .refine((value) => value.startColumn + value.span <= 13, {
      path: ["span"],
      message: "Placement exceeds the twelve-column grid",
    }),
]);

const sourceWidthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: sourceProvenanceUnchanged(z.literal("content")) }).strict(),
  z.object({ kind: sourceProvenanceUnchanged(z.literal("fill")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("grid")),
      start_column: sourceProvenanceTarget(z.number().int().min(1).max(12), ["startColumn"]),
      span: sourceProvenanceUnchanged(z.number().int().min(1).max(12)),
    })
    .strict()
    .refine((value) => value.start_column + value.span <= 13, {
      path: ["span"],
      message: "Placement exceeds the twelve-column grid",
    }),
]);

const heightSchema = z.discriminatedUnion("kind", [
  z.object({ kind: sourceProvenanceUnchanged(z.literal("content")) }).strict(),
  z
    .object({
      kind: sourceProvenanceUnchanged(z.literal("bounded")),
      units: sourceProvenanceUnchanged(positiveFiniteSchema),
    })
    .strict(),
]);

export const placementLayoutSchema = z
  .object({
    visible: sourceProvenanceUnchanged(z.boolean()),
    width: sourceProvenanceUnchanged(widthSchema),
    height: sourceProvenanceUnchanged(heightSchema),
  })
  .strict();

export const sourcePlacementLayoutSchema = z
  .object({
    visible: sourceProvenanceUnchanged(z.boolean()),
    width: sourceProvenanceUnchanged(sourceWidthSchema),
    height: sourceProvenanceUnchanged(heightSchema),
  })
  .strict();

export const responsivePlacementSchema = z
  .object({
    desktop: sourceProvenanceUnchanged(placementLayoutSchema),
    tablet: sourceProvenanceUnchanged(placementLayoutSchema),
    phone: sourceProvenanceUnchanged(placementLayoutSchema),
  })
  .strict();

/** Missing authored tablet/phone entries inherit from the next wider breakpoint. */
export const sourceResponsivePlacementSchema = z
  .object({
    desktop: sourceProvenanceUnchanged(sourcePlacementLayoutSchema),
    tablet: sourceProvenanceUnchanged(sourcePlacementLayoutSchema.optional()),
    phone: sourceProvenanceUnchanged(sourcePlacementLayoutSchema.optional()),
  })
  .strict();

/** The canonical form of one authored placement layout: only a grid width changes its keys. */
export const canonicalPlacementLayout = (value: Record<string, unknown>): Record<string, unknown> => {
  const width = value.width as Record<string, unknown>;
  return {
    visible: value.visible,
    width:
      width.kind === "grid"
        ? { kind: "grid", startColumn: width.start_column, span: width.span }
        : width,
    height: value.height,
  };
};

/** The complete canonical responsive layout of an authored one: each missing size inherits. */
export const canonicalResponsivePlacement = (
  authored: Readonly<Record<string, unknown>>,
): Record<"desktop" | "tablet" | "phone", Record<string, unknown>> => {
  const desktop = authored.desktop as Record<string, unknown>;
  const tablet = (authored.tablet as Record<string, unknown> | undefined) ?? desktop;
  const phone = (authored.phone as Record<string, unknown> | undefined) ?? tablet;
  return {
    desktop: canonicalPlacementLayout(desktop),
    tablet: canonicalPlacementLayout(tablet),
    phone: canonicalPlacementLayout(phone),
  };
};

/** The canonical form of one authored theme token value: only multi-word keys change case. */
export const canonicalThemeTokenValue = (value: Record<string, unknown>): unknown => {
  switch (value.kind) {
    case "typography":
      return {
        kind: value.kind,
        family: value.family,
        sizeRem: value.size_rem,
        lineHeight: value.line_height,
        weight: value.weight,
      };
    case "border":
      return {
        kind: value.kind,
        widthRem: value.width_rem,
        style: value.style,
        colorToken: value.color_token,
      };
    case "focus":
      return { kind: value.kind, colorToken: value.color_token, widthRem: value.width_rem };
    case "asset":
      return { kind: value.kind, assetId: value.asset_id };
    default:
      return value;
  }
};

/**
 * The compiled, engine-facing layout takes Puck 0.23's data shape, exactly as the runtime renders
 * it, and the same shape as the authored item. An item is `{ type, props }`: `type` is the block
 * release's renderer key, `props.id` the placement identity, every other prop but `vortex` either
 * one setting (its typed canonical value, an object tagged with its `kind`) or one child slot (an
 * array of items, in desktop order), and `props.vortex` the resolved
 * Vortex metadata: the exact block release, access and data bindings, theme overrides, the complete
 * responsive layout and the complete tablet and phone order of every child slot.
 */
export type BreakpointOrder = { tablet: string[]; phone: string[] };

export type CompiledItemVortex = {
  block: z.infer<typeof platformBlockReferenceSchema>;
  viewPermissionKey?: string | undefined;
  usePermissionKey?: string | undefined;
  visibilityCondition?: z.infer<typeof conditionNodeSchema> | undefined;
  queryId?: string | undefined;
  themeOverrides: Record<string, z.infer<typeof themeTokenValueSchema>>;
  responsive: z.infer<typeof responsivePlacementSchema>;
  slotOrders: Record<string, BreakpointOrder>;
};

export type CompiledItemProps = {
  id: string;
  vortex: CompiledItemVortex;
  /** One setting (its typed canonical value) or one child slot (an array of items). */
  [key: string]: unknown;
};

export type CompiledItem = { type: string; props: CompiledItemProps };

/** A compiled item after permission projection: an unavailable use is marked on its metadata. */
export type ProjectedItem = {
  type: string;
  props: CompiledItemProps & {
    vortex: CompiledItemVortex & {
      availability?: "unavailable" | undefined;
      unavailableReason?: "operation_unavailable" | undefined;
    };
  };
};

/** The props of an item that are neither settings nor child slots. */
export const compiledItemReservedProps: ReadonlySet<string> = new Set(["id", "vortex"]);

/** The item's child slots, in prop order: every array prop but `id` and `vortex`. */
export const compiledItemSlots = (item: CompiledItem): [string, CompiledItem[]][] =>
  Object.entries(item.props).flatMap(([key, value]): [string, CompiledItem[]][] =>
    compiledItemReservedProps.has(key) || !Array.isArray(value)
      ? []
      : [[key, value as CompiledItem[]]],
  );

/**
 * The settings of an item's props, keyed by property: every kind-tagged object prop but `vortex`.
 * A setting is a kind-tagged object and a slot an array, so no release is needed to tell them
 * apart, and the settings the compiler derives beyond the block's own declarations (a field
 * input's control, name and requirement) are read like any other. Props a renderer receives
 * besides the item's own (Puck's context, host wrappers) carry no kind and are not settings.
 */
export const compiledPropsSettings = (
  props: Readonly<Record<string, unknown>>,
): Record<string, BlockPropertyValueContract> =>
  Object.fromEntries(
    Object.entries(props).filter(
      ([key, value]) =>
        !compiledItemReservedProps.has(key) &&
        value !== undefined &&
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { kind?: unknown }).kind === "string",
    ),
  ) as Record<string, BlockPropertyValueContract>;

/** Every item in the list and their descendants, depth first in desktop order. */
export const compiledItemTree = (
  items: readonly CompiledItem[],
  result: CompiledItem[] = [],
): CompiledItem[] => {
  for (const item of items) {
    result.push(item);
    for (const [, children] of compiledItemSlots(item)) compiledItemTree(children, result);
  }
  return result;
};

const breakpointOrderSchema = z
  .object({
    tablet: z.array(containedComponentIdSchema),
    phone: z.array(containedComponentIdSchema),
  })
  .strict();

const sameMembers = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((entry) => expected.includes(entry));

/** Every zone has exactly one complete tablet and phone order, each a permutation of its items. */
const refineZoneOrders = (
  orders: Readonly<Record<string, BreakpointOrder>>,
  zones: ReadonlyMap<string, readonly CompiledItem[]>,
  context: z.RefinementCtx,
  path: (string | number)[],
): void => {
  if (!sameMembers(Object.keys(orders), [...zones.keys()]))
    context.addIssue({
      code: "custom",
      path,
      message: "Every slot has exactly one breakpoint order",
    });
  for (const [zone, items] of zones) {
    const order = orders[zone];
    if (order === undefined) continue;
    const ids = items.map((item) => item.props.id);
    for (const breakpoint of ["tablet", "phone"] as const)
      if (!sameMembers(order[breakpoint], ids))
        context.addIssue({
          code: "custom",
          path: [...path, zone, breakpoint],
          message: "Each breakpoint order must be one complete permutation of its slot",
        });
  }
};

const compiledItemVortexSchema = z
  .object({
    block: platformBlockReferenceSchema,
    viewPermissionKey: namespacedKeySchema.optional(),
    usePermissionKey: namespacedKeySchema.optional(),
    visibilityCondition: conditionNodeSchema.optional(),
    queryId: queryIdSchema.optional(),
    themeOverrides: z.record(builderKeySchema, themeTokenValueSchema),
    responsive: responsivePlacementSchema,
    slotOrders: z.record(builderKeySchema, breakpointOrderSchema),
  })
  .strict();

export const compiledItemSchema: z.ZodType<CompiledItem> = z.lazy(() =>
  z
    .object({
      type: namespacedKeySchema,
      props: z
        .object({
          id: containedComponentIdSchema,
          vortex: compiledItemVortexSchema,
        })
        .catchall(z.union([z.array(compiledItemSchema), blockPropertyValueSchema]))
        .superRefine((props, context) => {
          const zones = new Map<string, readonly CompiledItem[]>();
          for (const [key, value] of Object.entries(props)) {
            if (compiledItemReservedProps.has(key)) continue;
            if (!builderKeySchema.safeParse(key).success)
              context.addIssue({ code: "custom", path: [key], message: "Invalid prop key" });
            if (Array.isArray(value)) zones.set(key, value as CompiledItem[]);
          }
          refineZoneOrders(
            props.vortex.slotOrders as Record<string, BreakpointOrder>,
            zones,
            context,
            ["vortex", "slotOrders"],
          );
        }),
    })
    .strict(),
) as unknown as z.ZodType<CompiledItem>;

const compiledItemsSchema = z.array(compiledItemSchema);

/** The compiled root zone of a layout. */
export const compiledRootZone = "content";

/**
 * A resolved layout: one Puck data tree in the platform frame, with the complete tablet and phone
 * order of its root zone. A shell's layout has this shape, and so has every page once its shell is
 * resolved and its guided step selected: that is what the renderer draws.
 */
export type CompiledLayout = {
  root: { props: { vortex: { slotOrders: { content: BreakpointOrder } } } };
  content: CompiledItem[];
};

export const compiledLayoutSchema: z.ZodType<CompiledLayout> = z
  .object({
    root: z
      .object({
        props: z
          .object({
            vortex: z
              .object({ slotOrders: z.object({ content: breakpointOrderSchema }).strict() })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    content: compiledItemsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    refineZoneOrders(
      value.root.props.vortex.slotOrders as Record<string, BreakpointOrder>,
      new Map([[compiledRootZone, value.content as CompiledItem[]]]),
      context,
      ["root", "props", "vortex", "slotOrders"],
    );
  }) as unknown as z.ZodType<CompiledLayout>;

/**
 * One page's (or one guided step's) compiled Puck data. In the platform default frame
 * (`shellId` null) the blocks are `content`. In an application shell `content` is empty and each
 * shell content slot the page fills is a root slot prop named by the content slot's identity.
 */
export type PageComposition = {
  root: {
    props: {
      vortex: { shellId: string | null; slotOrders: Record<string, BreakpointOrder> };
      [contentSlotId: string]: unknown;
    };
  };
  content: CompiledItem[];
};

/** The root slots of compiled page data: every root prop but `vortex`. */
export const compiledPageRootSlots = (data: PageComposition): [string, CompiledItem[]][] =>
  Object.entries(data.root.props).flatMap(([key, value]): [string, CompiledItem[]][] =>
    key === "vortex" ? [] : [[key, value as CompiledItem[]]],
  );

/** Every zone of compiled page data with its items: `content` in the default frame, else root slots. */
export const compiledPageZones = (data: PageComposition): [string, CompiledItem[]][] =>
  data.root.props.vortex.shellId === null
    ? [[compiledRootZone, data.content]]
    : compiledPageRootSlots(data);

export const pageCompositionSchema: z.ZodType<PageComposition> = z
  .object({
    root: z
      .object({
        props: z
          .object({
            vortex: z
              .object({
                shellId: shellIdSchema.nullable(),
                slotOrders: z.record(z.string().min(1), breakpointOrderSchema),
              })
              .strict(),
          })
          .catchall(compiledItemsSchema),
      })
      .strict(),
    content: compiledItemsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const data = value as unknown as PageComposition;
    const rootSlots = compiledPageRootSlots(data);
    if (data.root.props.vortex.shellId === null && rootSlots.length > 0)
      context.addIssue({
        code: "custom",
        path: ["root", "props"],
        message: "A page in the default frame places its blocks in content, not in root slots",
      });
    if (data.root.props.vortex.shellId !== null && data.content.length > 0)
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "A page in an application shell places its blocks in the shell's content slots",
      });
    refineZoneOrders(data.root.props.vortex.slotOrders, new Map(compiledPageZones(data)), context, [
      "root",
      "props",
      "vortex",
      "slotOrders",
    ]);
  }) as unknown as z.ZodType<PageComposition>;

/** One page frame with an exact, separately ordered content tree for every guided step. */
export type GuidedFormPageComposition = { stepContent: Record<string, PageComposition> };

export const guidedFormPageCompositionSchema: z.ZodType<GuidedFormPageComposition> = z
  .object({ stepContent: z.record(containedComponentIdSchema, pageCompositionSchema) })
  .strict()
  .superRefine((value, context) => {
    const shells = new Set(
      Object.values(value.stepContent as Record<string, PageComposition>).map(
        (step) => step.root.props.vortex.shellId,
      ),
    );
    if (shells.size > 1)
      context.addIssue({
        code: "custom",
        path: ["stepContent"],
        message: "Every step of a guided form uses the same frame",
      });
  }) as unknown as z.ZodType<GuidedFormPageComposition>;

export type AnyPageComposition = PageComposition | GuidedFormPageComposition;

/** The compiled Puck data of every step of a guided form, or the page's one data otherwise. */
export const compiledPageDataOf = (composition: AnyPageComposition): PageComposition[] =>
  "stepContent" in composition ? Object.values(composition.stepContent) : [composition];

/** The application shell a page's frame uses, or null for the platform default frame. */
export const compiledPageShellId = (composition: AnyPageComposition): string | null =>
  compiledPageDataOf(composition)[0]?.root.props.vortex.shellId ?? null;

/** Every item a page places, in every step and zone, depth first. */
export const compiledPageItems = (composition: AnyPageComposition): CompiledItem[] =>
  compiledPageDataOf(composition).flatMap((data) =>
    compiledPageZones(data).flatMap(([, items]) => compiledItemTree(items)),
  );

export const shellContentSlotSchema = z
  .object({
    slotId: sourceProvenanceUnchanged(containedComponentIdSchema),
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    allowedChildCategories: sourceProvenanceUnchanged(z.array(blockPaletteGroupSchema).min(1)),
    parentPlacementId: sourceProvenanceUnchanged(containedComponentIdSchema),
    parentSlotKey: sourceProvenanceUnchanged(builderKeySchema),
  })
  .strict();

export const sourceShellContentSlotSchema = z
  .object({
    id: sourceProvenanceTarget(sourceAliasSchema, ["slotId"]),
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    allowed_child_categories: sourceProvenanceUnchanged(z.array(blockPaletteGroupSchema).min(1)),
    parent_placement: sourceProvenanceTarget(sourceAliasSchema, ["parentPlacementId"]),
    parent_slot: sourceProvenanceUnchanged(builderKeySchema),
  })
  .strict();

const applicationShellPresentationSchema = z
  .object({
    sidebar: z
      .object({
        collapsible: z.enum(["none", "icon"]),
        defaultCollapsed: z.boolean(),
      })
      .strict(),
    topBar: z
      .object({
        breadcrumbs: z.boolean(),
        organizationSwitcher: z.boolean(),
        applicationSwitcher: z.boolean(),
        accountMenu: z.boolean(),
        appearanceToggle: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const applicationPuckRootShellSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }).strict(),
  z
    .object({
      kind: z.literal("application"),
      shellId: sourceProvenanceUnchanged(shellIdSchema),
      key: sourceProvenanceUnchanged(builderKeySchema),
      name: sourceProvenanceUnchanged(labelSchema),
      presentation: sourceProvenanceUnchanged(applicationShellPresentationSchema),
    })
    .strict(),
]);

export const sourceApplicationShellPresentationSchema = z
  .object({
    sidebar: sourceProvenanceUnchanged(
      z
        .object({
          collapsible: sourceProvenanceUnchanged(z.enum(["none", "icon"])),
          default_collapsed: sourceProvenanceUnchanged(z.boolean()),
        })
        .strict(),
    ),
    top_bar: sourceProvenanceUnchanged(
      z
        .object({
          breadcrumbs: sourceProvenanceUnchanged(z.boolean()),
          organization_switcher: sourceProvenanceUnchanged(z.boolean()),
          application_switcher: sourceProvenanceUnchanged(z.boolean()),
          account_menu: sourceProvenanceUnchanged(z.boolean()),
          appearance_toggle: sourceProvenanceUnchanged(z.boolean()),
        })
        .strict(),
    ),
  })
  .strict();

export const applicationShellSchema = z
  .object({
    shellId: shellIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    presentation: applicationShellPresentationSchema,
    layout: compiledLayoutSchema,
    contentSlots: z.array(shellContentSlotSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.contentSlots.map((slot) => slot.slotId);
    const keys = value.contentSlots.map((slot) => slot.key);
    const targets = value.contentSlots.map(
      (slot) => `${slot.parentPlacementId}:${slot.parentSlotKey}`,
    );
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["contentSlots"],
        message: "Shell content-slot identities must be unique",
      });
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["contentSlots"],
        message: "Shell content-slot keys must be unique",
      });
    if (new Set(targets).size !== targets.length)
      context.addIssue({
        code: "custom",
        path: ["contentSlots"],
        message: "A shell location can expose only one content slot",
      });
    const items = new Map(
      compiledItemTree((value.layout as CompiledLayout).content).map((item) => [
        item.props.id,
        item,
      ]),
    );
    for (const [index, slot] of value.contentSlots.entries()) {
      const target = items.get(slot.parentPlacementId)?.props[slot.parentSlotKey];
      if (!Array.isArray(target))
        context.addIssue({
          code: "custom",
          path: ["contentSlots", index, "parentSlotKey"],
          message: "A shell content slot must target a declared slot on one shell placement",
        });
      else if (target.length > 0)
        context.addIssue({
          code: "custom",
          path: ["contentSlots", index, "parentSlotKey"],
          message: "An exposed shell content slot must reserve an empty target for page content",
        });
    }
  });

export type ApplicationShell = z.infer<typeof applicationShellSchema>;
export type ApplicationPuckRootShell = z.infer<typeof applicationPuckRootShellSchema>;
export type ResponsivePlacement = z.infer<typeof responsivePlacementSchema>;

/** The compiled composition one renderer input carries: dependencies, shells, pages and theme. */
export const materialisedApplicationCompositionSchema = z
  .object({
    platformBlockDependencies: platformBlockDependenciesSchema,
    shells: z.array(applicationShellSchema),
    pages: z.array(
      z
        .object({
          pageId: z.string().min(1),
          composition: z.union([pageCompositionSchema, guidedFormPageCompositionSchema]),
          steps: z
            .array(
              z.object({ id: z.string().min(1), name: z.string(), summary: z.boolean() }).strict(),
            )
            .optional(),
        })
        .strict(),
    ),
    theme: applicationThemeSchema,
  })
  .strict();
