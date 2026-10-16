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
import { platformBlockDependenciesSchema, platformBlockReferenceSchema } from "./platform-block-release";
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

type BlockPlacement = {
  block: z.infer<typeof platformBlockReferenceSchema>;
  viewPermissionKey?: z.infer<typeof namespacedKeySchema> | undefined;
  usePermissionKey?: z.infer<typeof namespacedKeySchema> | undefined;
  visibilityCondition?: z.infer<typeof conditionNodeSchema> | undefined;
  queryId?: z.infer<typeof queryIdSchema> | undefined;
  settings: Record<string, BlockPropertyValueContract>;
  themeOverrides: Record<string, z.infer<typeof themeTokenValueSchema>>;
  responsive: z.infer<typeof responsivePlacementSchema>;
  slots: Record<string, PlacementSlot>;
};
type PlacementSlot = {
  placements: Record<string, BlockPlacement>;
  order: { desktop: string[]; tablet: string[]; phone: string[] };
};

const sameMembers = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length &&
  new Set(actual).size === actual.length &&
  actual.every((entry) => expected.includes(entry));

export const blockPlacementSchema: z.ZodType<BlockPlacement> = z.lazy(() =>
  z
    .object({
      block: sourceProvenanceUnchanged(platformBlockReferenceSchema),
      viewPermissionKey: sourceProvenanceUnchanged(namespacedKeySchema.optional()),
      usePermissionKey: sourceProvenanceUnchanged(namespacedKeySchema.optional()),
      visibilityCondition: sourceProvenanceUnchanged(conditionNodeSchema.optional()),
      queryId: sourceProvenanceUnchanged(queryIdSchema.optional()),
      settings: sourceProvenanceUnchanged(z.record(builderKeySchema, blockPropertyValueSchema)),
      themeOverrides: sourceProvenanceUnchanged(z.record(builderKeySchema, themeTokenValueSchema)),
      responsive: sourceProvenanceUnchanged(responsivePlacementSchema),
      slots: sourceProvenanceUnchanged(z.record(builderKeySchema, placementSlotSchema)),
    })
    .strict(),
);

export const placementSlotSchema: z.ZodType<PlacementSlot> = z.lazy(() =>
  z
    .object({
      placements: sourceProvenanceUnchanged(
        z.record(containedComponentIdSchema, blockPlacementSchema),
      ),
      order: sourceProvenanceUnchanged(
        z
          .object({
            desktop: sourceProvenanceUnchanged(z.array(containedComponentIdSchema)),
            tablet: sourceProvenanceUnchanged(z.array(containedComponentIdSchema)),
            phone: sourceProvenanceUnchanged(z.array(containedComponentIdSchema)),
          })
          .strict(),
      ),
    })
    .strict()
    .superRefine((value, context) => {
      const placements = Object.keys(value.placements);
      for (const breakpoint of ["desktop", "tablet", "phone"] as const)
        if (!sameMembers(value.order[breakpoint], placements))
          context.addIssue({
            code: "custom",
            path: ["order", breakpoint],
            message: "Each breakpoint order must be one complete placement permutation",
          });
    }),
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

const collectCanonicalPlacementSlots = (
  slot: PlacementSlot,
  result = new Map<string, Record<string, PlacementSlot>>(),
): Map<string, Record<string, PlacementSlot>> => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.set(placementId, placement.slots);
    for (const child of Object.values(placement.slots))
      collectCanonicalPlacementSlots(child, result);
  }
  return result;
};

export const canonicalPlacementEntries = (
  slot: PlacementSlot,
  result: [string, BlockPlacement][] = [],
): [string, BlockPlacement][] => {
  for (const [placementId, placement] of Object.entries(slot.placements)) {
    result.push([placementId, placement]);
    for (const child of Object.values(placement.slots)) canonicalPlacementEntries(child, result);
  }
  return result;
};

export const applicationShellSchema = z
  .object({
    shellId: sourceProvenanceUnchanged(shellIdSchema),
    key: sourceProvenanceUnchanged(builderKeySchema),
    name: sourceProvenanceUnchanged(labelSchema),
    presentation: sourceProvenanceUnchanged(applicationShellPresentationSchema),
    layout: sourceProvenanceUnchanged(placementSlotSchema),
    contentSlots: sourceProvenanceUnchanged(z.array(shellContentSlotSchema).min(1)),
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
    const placements = collectCanonicalPlacementSlots(value.layout);
    for (const [index, slot] of value.contentSlots.entries()) {
      const target = placements.get(slot.parentPlacementId)?.[slot.parentSlotKey];
      if (target === undefined)
        context.addIssue({
          code: "custom",
          path: ["contentSlots", index, "parentSlotKey"],
          message: "A shell content slot must target a declared slot on one shell placement",
        });
      else if (
        Object.keys(target.placements).length > 0 ||
        target.order.desktop.length > 0 ||
        target.order.tablet.length > 0 ||
        target.order.phone.length > 0
      )
        context.addIssue({
          code: "custom",
          path: ["contentSlots", index, "parentSlotKey"],
          message: "An exposed shell content slot must reserve an empty target for page content",
        });
    }
  });

export const pageCompositionSchema = z.discriminatedUnion("shellKind", [
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("default")),
      main: sourceProvenanceUnchanged(placementSlotSchema),
    })
    .strict(),
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("application")),
      shellId: sourceProvenanceUnchanged(shellIdSchema),
      content: sourceProvenanceUnchanged(z.record(containedComponentIdSchema, placementSlotSchema)),
    })
    .strict(),
]);

/** One page shell with an exact, separately ordered content tree for every guided step. */
export const guidedFormPageCompositionSchema = z.discriminatedUnion("shellKind", [
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("default")),
      stepContent: sourceProvenanceUnchanged(
        z.record(containedComponentIdSchema, placementSlotSchema),
      ),
    })
    .strict(),
  z
    .object({
      shellKind: sourceProvenanceUnchanged(z.literal("application")),
      shellId: sourceProvenanceUnchanged(shellIdSchema),
      stepContent: sourceProvenanceUnchanged(
        z.record(
          containedComponentIdSchema,
          z.record(containedComponentIdSchema, placementSlotSchema),
        ),
      ),
    })
    .strict(),
]);

export type BlockPlacementContract = z.infer<typeof blockPlacementSchema>;
export type ApplicationShell = z.infer<typeof applicationShellSchema>;
export type ApplicationPuckRootShell = z.infer<typeof applicationPuckRootShellSchema>;
export type PageComposition = z.infer<typeof pageCompositionSchema>;
export type GuidedFormPageComposition = z.infer<typeof guidedFormPageCompositionSchema>;

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
