import { z } from "zod";
import { blockPaletteGroupSchema } from "../../catalogue/catalogues";
import { labelSchema } from "../../catalogue/common";
import { sourceProvenanceTarget, sourceProvenanceUnchanged } from "../definition-source-common";
import { componentSemanticEventKindSchema } from "../application-flow-bindings";
import {
  blockIdSchema,
  builderKeySchema,
  fingerprintSchema,
  namespacedKeySchema,
  semanticVersionSchema,
} from "../../catalogue/identifiers";
import { iconKeySchema } from "./block-property-values";
import { type ComponentSettingValue, blockPropertySchema } from "./block-property-schema";
import { customComponentReleaseSchema } from "./custom-components";

export const blockSlotDeclarationSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
    allowedChildCategories: sourceProvenanceUnchanged(z.array(blockPaletteGroupSchema).min(1)),
    /**
     * Present on a repeatable slot. The release then owns one child slot per item of the list
     * property named by `items`, each keyed by the item's stable identity read from that item's
     * text property named by `identity`. Absent on a fixed slot, whose `key` is its one slot key.
     */
    repeats: sourceProvenanceUnchanged(
      z
        .object({
          items: sourceProvenanceUnchanged(builderKeySchema),
          identity: sourceProvenanceUnchanged(builderKeySchema),
        })
        .strict()
        .optional(),
    ),
  })
  .strict();

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

const blockCapabilitiesBase = {
  responsiveVisibility: sourceProvenanceUnchanged(z.boolean()),
  responsiveOrder: sourceProvenanceUnchanged(z.boolean()),
  gridWidth: sourceProvenanceUnchanged(z.boolean()),
  height: sourceProvenanceUnchanged(z.enum(["content", "content_or_bounded"])),
  publicSurface: sourceProvenanceUnchanged(z.enum(["refused", "allowed"])),
};

const blockCapabilitiesSchema = z.discriminatedUnion("accessibleName", [
  z
    .object({
      ...blockCapabilitiesBase,
      accessibleName: sourceProvenanceUnchanged(z.literal("not_applicable")),
    })
    .strict(),
  z
    .object({
      ...blockCapabilitiesBase,
      accessibleName: sourceProvenanceUnchanged(z.enum(["required", "optional"])),
      accessibleNamePropertyPath: sourceProvenanceUnchanged(z.array(builderKeySchema).min(1)),
    })
    .strict(),
]);

/**
 * State operations a flow may apply to a placed component. A release lists exactly the
 * operations it supports; none is implied by its palette group or renderer.
 */
export const componentStateOperationKindSchema = z.enum([
  "set_value",
  "reset",
  "select_tab",
  "open",
  "close",
]);

export const platformBlockReleaseSchema = z
  .object({
    blockId: sourceProvenanceUnchanged(blockIdSchema),
    key: sourceProvenanceUnchanged(namespacedKeySchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
    name: sourceProvenanceUnchanged(labelSchema),
    icon: sourceProvenanceUnchanged(iconKeySchema),
    paletteGroup: sourceProvenanceUnchanged(blockPaletteGroupSchema),
    rendererKey: sourceProvenanceUnchanged(namespacedKeySchema),
    properties: sourceProvenanceUnchanged(z.array(blockPropertySchema)),
    slots: sourceProvenanceUnchanged(z.array(blockSlotDeclarationSchema)),
    capabilities: sourceProvenanceUnchanged(blockCapabilitiesSchema),
    /** Semantic events the component emits: the only events a flow binding may name for it. */
    supportedEvents: sourceProvenanceUnchanged(z.array(componentSemanticEventKindSchema)),
    /** State operations a flow may apply to the component. */
    supportedStateOperations: sourceProvenanceUnchanged(z.array(componentStateOperationKindSchema)),
    /**
     * Present only on a custom component release: the owning application or module release, its
     * typed declared events, data contract, text alternative and bundle manifest. A platform block
     * release carries none, and a custom component release carries no built-in semantic events.
     */
    customComponent: sourceProvenanceUnchanged(customComponentReleaseSchema.optional()),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.customComponent !== undefined) {
      if (value.supportedEvents.length > 0)
        context.addIssue({
          code: "custom",
          path: ["supportedEvents"],
          message: "A custom component declares its own events, not built-in semantic events",
        });
      // A custom component is a page-level block rendered in a sandboxed frame: it hosts no child
      // placements, and the frame's title is always its accessible name.
      if (value.slots.length > 0)
        context.addIssue({
          code: "custom",
          path: ["slots"],
          message: "A custom component cannot contain other components",
        });
      if (value.capabilities.accessibleName !== "required")
        context.addIssue({
          code: "custom",
          path: ["capabilities", "accessibleName"],
          message: "A custom component requires an accessible name",
        });
    }
    if (new Set(value.supportedEvents).size !== value.supportedEvents.length)
      context.addIssue({
        code: "custom",
        path: ["supportedEvents"],
        message: "Supported events must be unique",
      });
    if (new Set(value.supportedStateOperations).size !== value.supportedStateOperations.length)
      context.addIssue({
        code: "custom",
        path: ["supportedStateOperations"],
        message: "Supported state operations must be unique",
      });
    if (new Set(value.properties.map((property) => property.key)).size !== value.properties.length)
      context.addIssue({
        code: "custom",
        path: ["properties"],
        message: "Property keys must be unique",
      });
    if (value.properties.filter((property) => property.derivesFieldInput === true).length > 1)
      context.addIssue({
        code: "custom",
        path: ["properties"],
        message: "A release may bind at most one automatic field input",
      });
    if (new Set(value.slots.map((slot) => slot.key)).size !== value.slots.length)
      context.addIssue({ code: "custom", path: ["slots"], message: "Slot keys must be unique" });
    for (const [index, slot] of value.slots.entries()) {
      const repeats = slot.repeats;
      if (repeats === undefined) continue;
      // A repeatable slot keys each item by a required text identity on the items of a declared
      // list of groups, and no other slot may share its item-key namespace.
      const list = value.properties.find((property) => property.key === repeats.items);
      const identity =
        list?.kind === "list" && list.item.kind === "group"
          ? list.item.properties.find((property) => property.key === repeats.identity)
          : undefined;
      if (identity?.kind !== "text" || !identity.required)
        context.addIssue({
          code: "custom",
          path: ["slots", index, "repeats"],
          message: "A repeatable slot must name a required text identity on a list of groups",
        });
      if (value.slots.some((other) => other !== slot && other.key.startsWith(`${slot.key}_`)))
        context.addIssue({
          code: "custom",
          path: ["slots", index, "key"],
          message: "A repeatable slot's item keys must not collide with another slot key",
        });
    }
    if (value.capabilities.accessibleName !== "not_applicable") {
      const propertyPath = value.capabilities.accessibleNamePropertyPath;
      let properties = value.properties;
      for (const [index, key] of propertyPath.entries()) {
        const property = properties.find((candidate) => candidate.key === key);
        const last = index === propertyPath.length - 1;
        if (
          property === undefined ||
          (last ? property.kind !== "text" : property.kind !== "group")
        ) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", "accessibleNamePropertyPath", index],
            message: "Accessible name must select a declared text property through groups only",
          });
          break;
        }
        if (property.kind === "group") properties = property.properties;
      }
    }
  });

export const applicationCompositionPolicySchema = z
  .object({
    maximumDepth: sourceProvenanceUnchanged(z.number().int().positive()),
    maximumPlacements: sourceProvenanceUnchanged(z.number().int().positive()),
  })
  .strict();

export const immutablePlatformBlockCatalogueSchema = z
  .object({
    compositionPolicy: sourceProvenanceUnchanged(applicationCompositionPolicySchema),
    releases: sourceProvenanceUnchanged(z.array(platformBlockReleaseSchema)),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.releases.map(
      (release) => `${release.blockId}:${release.releaseVersion}`,
    );
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["releases"],
        message: "Block releases must be unique",
      });
    const keysById = new Map<string, string>();
    const idsByKey = new Map<string, string>();
    for (const [index, release] of value.releases.entries()) {
      const id = String(release.blockId);
      if (
        (keysById.has(id) && keysById.get(id) !== release.key) ||
        (idsByKey.has(release.key) && idsByKey.get(release.key) !== id)
      )
        context.addIssue({
          code: "custom",
          path: ["releases", index, "key"],
          message: "A platform block key and permanent identity must map one to one",
        });
      keysById.set(id, release.key);
      idsByKey.set(release.key, id);
    }
  });

export const platformBlockDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_block")),
    blockId: sourceProvenanceUnchanged(blockIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
    contentFingerprint: sourceProvenanceUnchanged(fingerprintSchema),
  })
  .strict();

export const sourcePlatformBlockDependencySchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.literal("platform_block")),
    block_id: sourceProvenanceTarget(blockIdSchema, ["blockId"]),
    release_version: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

export const deterministicDependencyList = <
  Entry extends { blockId: string; releaseVersion: string },
>(
  entries: Entry[],
): boolean =>
  entries.every((entry, index) => {
    if (index === 0) return true;
    const previous = entries[index - 1]!;
    const previousBlock = String(previous.blockId);
    const currentBlock = String(entry.blockId);
    if (previousBlock !== currentBlock) return previousBlock < currentBlock;
    return previous.releaseVersion < entry.releaseVersion;
  });

export const platformBlockDependenciesSchema = z
  .array(platformBlockDependencySchema)
  .superRefine((entries, context) => {
    const identities = entries.map((entry) => `${entry.blockId}@${entry.releaseVersion}`);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        message: "An application may depend on each exact platform block release only once",
      });
    if (!deterministicDependencyList(entries))
      context.addIssue({
        code: "custom",
        message: "Platform block dependencies must use permanent-identity order",
      });
  });

export const sourcePlatformBlockDependenciesSchema = z
  .array(sourcePlatformBlockDependencySchema)
  .superRefine((entries, context) => {
    const normalized = entries.map((entry) => ({
      blockId: String(entry.block_id),
      releaseVersion: String(entry.release_version),
    }));
    const identities = normalized.map((entry) => `${entry.blockId}@${entry.releaseVersion}`);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        message: "An application may depend on each exact platform block release only once",
      });
    if (!deterministicDependencyList(normalized))
      context.addIssue({
        code: "custom",
        message: "Platform block dependencies must use permanent-identity order",
      });
  });

/** Placements name only their immutable block identity/version; fingerprints live in the manifest. */
export const platformBlockReferenceSchema = z
  .object({
    blockId: sourceProvenanceUnchanged(blockIdSchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

export const sourcePlatformBlockReferenceSchema = z
  .object({
    block_id: sourceProvenanceTarget(blockIdSchema, ["blockId"]),
    release_version: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

export type PlatformBlockRelease = z.infer<typeof platformBlockReleaseSchema>;
export type ComponentStateOperationKind = z.infer<typeof componentStateOperationKindSchema>;

export type ApplicationCompositionPolicy = z.infer<typeof applicationCompositionPolicySchema>;
export type ImmutablePlatformBlockCatalogue = z.infer<typeof immutablePlatformBlockCatalogueSchema>;
