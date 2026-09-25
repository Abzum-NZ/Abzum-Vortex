import type { ComponentData, Content, Data } from "@puckeditor/core";
import {
  applicationShellV2Schema,
  blockPropertyValueV2Schema,
  immutablePlatformBlockCatalogueV2Schema,
  placementSlotV2Schema,
  validateComponentSettings,
  type ApplicationShellV2,
  type BlockPropertySchemaV2Contract,
  type BlockPropertyValueV2Contract,
  type ComponentSettingFailure,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";

/** Actual Puck Data. Page, shell, and guided-step selection remain Vortex orchestration. */
export type VortexPuckDataV2 = Data;
export type VortexPuckContentV2 = Content;

export class VortexPuckAdapterError extends Error {
  override readonly name = "VortexPuckAdapterError";
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new VortexPuckAdapterError("Failed to clone Puck adapter data", { cause: error });
  }
};

const releaseKey = (block: { blockId: string; releaseVersion: string }) =>
  `${block.blockId}:${block.releaseVersion}`;

const asObject = (value: unknown, at: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new VortexPuckAdapterError(`Invalid Puck adapter data at ${at}`);
  return value as Record<string, unknown>;
};

const exact = (value: unknown, keys: readonly string[], at: string) => {
  const result = asObject(value, at);
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new VortexPuckAdapterError(`Private or transient Puck data at ${at}`);
  return result;
};

const string = (value: unknown, at: string) => {
  if (typeof value !== "string" || !value)
    throw new VortexPuckAdapterError(`Invalid Puck adapter data at ${at}`);
  return value;
};

/**
 * Tablet and phone orders are stored as a hint on each child. After the editor
 * adds, removes or moves blocks, the hint is stale: keep surviving placements in
 * their saved relative order, drop removed ones and insert new ones at their
 * desktop position, so every breakpoint lists exactly the slot's placements.
 */
const rebuildBreakpointOrder = (saved: unknown, desktop: readonly string[]): string[] => {
  const present = new Set(desktop);
  const result = Array.isArray(saved)
    ? [...new Set(saved.filter((id): id is string => typeof id === "string" && present.has(id)))]
    : [];
  const kept = new Set(result);
  desktop.forEach((id, index) => {
    if (!kept.has(id)) result.splice(Math.min(index, result.length), 0, id);
  });
  return result;
};

/**
 * Children moved in from another slot carry that slot's order, so use the hint
 * that names the most of this slot's placements (the first one on a tie).
 */
const bestOrderHint = (
  hints: readonly Record<string, unknown>[],
  desktop: readonly string[],
): Record<string, unknown> | undefined => {
  const present = new Set(desktop);
  const overlap = (hint: Record<string, unknown>): number =>
    Array.isArray(hint.desktop)
      ? hint.desktop.filter((id: unknown) => typeof id === "string" && present.has(id)).length
      : 0;
  let best: Record<string, unknown> | undefined;
  let bestOverlap = -1;
  for (const hint of hints) {
    const current = overlap(hint);
    if (current > bestOverlap) {
      best = hint;
      bestOverlap = current;
    }
  }
  return best;
};

type VortexSlot = ReturnType<typeof placementSlotV2Schema.parse>;

/** The exact setting a shared failure names, for an operator-readable adapter error. */
const describeSettingFailure = (failure: ComponentSettingFailure, at: string): string => {
  const located = failure.path.length === 0 ? at : `${at}.${failure.path.join(".")}`;
  switch (failure.family) {
    case "unknown_property":
      return `Undeclared property key at ${located}`;
    case "unsafe_content":
      return `Unsafe property value at ${located}`;
    case "required_value":
      return `Missing required property at ${located}`;
    case "unsupported_choice":
      return `Unsupported property choice at ${located}`;
    case "too_few_items":
      return `Too few list items at ${located}`;
    case "too_many_items":
      return `Too many list items at ${located}`;
    default:
      return `Invalid property value at ${located}`;
  }
};

const validateSettings = (
  rawSettings: unknown,
  declarations: readonly BlockPropertySchemaV2Contract[],
  at: string,
): Record<string, unknown> => {
  const settings = asObject(rawSettings, at);

  for (const declaration of declarations) {
    const value = settings[declaration.key];
    if (value === undefined) continue;
    try {
      blockPropertyValueV2Schema.parse(value);
    } catch (error) {
      throw new VortexPuckAdapterError(`Invalid property value at ${at}.${declaration.key}`, {
        cause: error,
      });
    }
  }

  for (const failure of validateComponentSettings(
    settings as Readonly<Record<string, BlockPropertyValueV2Contract>>,
    declarations,
  ))
    throw new VortexPuckAdapterError(describeSettingFailure(failure, at));

  return settings;
};

export const createVortexPuckAdapterV2 = (catalogueInput: unknown) => {
  const catalogue = immutablePlatformBlockCatalogueV2Schema.parse(catalogueInput);
  const releases = new Map(catalogue.releases.map((release) => [releaseKey(release), release]));
  const releaseFor = (block: {
    blockId: string;
    releaseVersion: string;
  }): PlatformBlockReleaseV2 => {
    const release = releases.get(releaseKey(block));
    if (!release)
      throw new VortexPuckAdapterError(
        `No platform renderer mapping exists for ${block.blockId}@${block.releaseVersion}`,
      );
    return release;
  };
  const toContent = (slotInput: unknown): Content => {
    const slot = placementSlotV2Schema.parse(slotInput);
    return slot.order.desktop.map((id) => {
      const placement = slot.placements[id]!;
      const release = releaseFor(placement.block);
      const props: Record<string, unknown> = {
        id,
        settings: clone(placement.settings),
        vortex: {
          block: clone(placement.block),
          ...(placement.viewPermissionKey === undefined
            ? {}
            : { viewPermissionKey: placement.viewPermissionKey }),
          ...(placement.usePermissionKey === undefined
            ? {}
            : { usePermissionKey: placement.usePermissionKey }),
          ...(placement.visibilityCondition === undefined
            ? {}
            : { visibilityCondition: clone(placement.visibilityCondition) }),
          ...(placement.queryId === undefined ? {} : { queryId: placement.queryId }),
          ...(placement.readModel === undefined ? {} : { readModel: clone(placement.readModel) }),
          themeOverrides: clone(placement.themeOverrides),
          responsive: clone(placement.responsive),
          order: clone(slot.order),
        },
      };
      for (const [key, child] of Object.entries(placement.slots)) {
        if (!release.slots.some((slot) => slot.key === key))
          throw new VortexPuckAdapterError(
            `Undeclared Puck slot ${key} for ${release.rendererKey}`,
          );
        props[key] = toContent(child);
      }
      return { type: release.rendererKey, props } as ComponentData;
    });
  };

  const fromContent = (
    input: unknown,
    depth: number,
    seenPlacementIds: Set<string>,
    state: { totalPlacements: number },
    parentSlotDecl?: PlatformBlockReleaseV2["slots"][number],
    at = "content",
  ): VortexSlot => {
    if (!Array.isArray(input))
      throw new VortexPuckAdapterError(`Invalid Puck adapter data at ${at}`);
    const placements: Record<string, unknown> = {};
    const desktop: string[] = [];
    const orderHints: Record<string, unknown>[] = [];
    for (const [index, raw] of input.entries()) {
      if (depth > catalogue.compositionPolicy.maximumDepth) {
        throw new VortexPuckAdapterError(
          `Composition depth ${depth} exceeds maximumDepth ${catalogue.compositionPolicy.maximumDepth}`,
        );
      }
      state.totalPlacements += 1;
      if (state.totalPlacements > catalogue.compositionPolicy.maximumPlacements) {
        throw new VortexPuckAdapterError(
          `Placement count ${state.totalPlacements} exceeds maximumPlacements ${catalogue.compositionPolicy.maximumPlacements}`,
        );
      }
      const node = exact(raw, ["type", "props", "readOnly"], `${at}[${index}]`);
      const props = asObject(node.props, `${at}[${index}].props`);
      const id = string(props.id, `${at}[${index}].props.id`);
      if (seenPlacementIds.has(id))
        throw new VortexPuckAdapterError(`Duplicate Puck placement identity ${id}`);
      seenPlacementIds.add(id);

      const meta = exact(
        props.vortex,
        [
          "block",
          "viewPermissionKey",
          "usePermissionKey",
          "visibilityCondition",
          "queryId",
          "readModel",
          "themeOverrides",
          "responsive",
          "order",
        ],
        `${at}[${index}].props.vortex`,
      );
      const block = exact(
        meta.block,
        ["blockId", "releaseVersion"],
        `${at}[${index}].props.vortex.block`,
      );
      const release = releaseFor({
        blockId: string(block.blockId, "blockId"),
        releaseVersion: string(block.releaseVersion, "releaseVersion"),
      });
      if (string(node.type, `${at}[${index}].type`) !== release.rendererKey)
        throw new VortexPuckAdapterError("Puck renderer does not match Vortex block");

      if (
        parentSlotDecl !== undefined &&
        !parentSlotDecl.allowedChildCategories.includes(release.paletteGroup)
      ) {
        throw new VortexPuckAdapterError(
          `Block palette group "${release.paletteGroup}" is not allowed in slot "${parentSlotDecl.key}"`,
        );
      }

      const allowed = new Set([
        "id",
        "settings",
        "vortex",
        ...release.slots.map((slot) => slot.key),
      ]);
      if (Object.keys(props).some((key) => !allowed.has(key)))
        throw new VortexPuckAdapterError(`Private or transient Puck data at ${at}[${index}].props`);

      const settings = validateSettings(
        props.settings,
        release.properties,
        `${at}[${index}].props.settings`,
      );

      const slots: Record<string, VortexSlot> = {};
      for (const declaration of release.slots) {
        const slotInput = props[declaration.key];
        if (slotInput === undefined) {
          if (declaration.required) {
            throw new VortexPuckAdapterError(
              `Missing required slot "${declaration.key}" at ${at}[${index}].props`,
            );
          }
          continue;
        }
        const childSlot = fromContent(
          slotInput,
          depth + 1,
          seenPlacementIds,
          state,
          declaration,
          `${at}[${index}].props.${declaration.key}`,
        );
        slots[declaration.key] = childSlot;
      }

      if (meta.order !== undefined)
        orderHints.push(
          exact(meta.order, ["desktop", "tablet", "phone"], `${at}[${index}].props.vortex.order`),
        );
      placements[id] = {
        block,
        settings: clone(settings),
        ...(meta.viewPermissionKey === undefined
          ? {}
          : { viewPermissionKey: string(meta.viewPermissionKey, "viewPermissionKey") }),
        ...(meta.usePermissionKey === undefined
          ? {}
          : { usePermissionKey: string(meta.usePermissionKey, "usePermissionKey") }),
        ...(meta.visibilityCondition === undefined
          ? {}
          : { visibilityCondition: clone(meta.visibilityCondition) }),
        ...(meta.queryId === undefined ? {} : { queryId: string(meta.queryId, "queryId") }),
        ...(meta.readModel === undefined
          ? {}
          : { readModel: clone(asObject(meta.readModel, "readModel")) }),
        themeOverrides: clone(asObject(meta.themeOverrides, "themeOverrides")),
        responsive: clone(asObject(meta.responsive, "responsive")),
        slots,
      };
      desktop.push(id);
    }
    try {
      // Every breakpoint is required, including for an empty slot or a slot
      // whose children carry no saved order.
      const savedOrder = bestOrderHint(orderHints, desktop);
      const order = {
        desktop,
        tablet: rebuildBreakpointOrder(savedOrder?.tablet, desktop),
        phone: rebuildBreakpointOrder(savedOrder?.phone, desktop),
      };
      return placementSlotV2Schema.parse({ placements, order });
    } catch (error) {
      throw new VortexPuckAdapterError("Invalid placement slot schema", { cause: error });
    }
  };

  const toPuckData = (slot: unknown): Data => ({ root: {}, content: toContent(slot), zones: {} });

  const fromPuckData = (input: unknown): VortexSlot => {
    try {
      const data = exact(input, ["root", "content", "zones"], "data");
      exact(data.root, [], "data.root");
      if (data.zones === undefined || Object.keys(asObject(data.zones, "data.zones")).length)
        throw new VortexPuckAdapterError("Invalid Puck adapter zones");
      const seenPlacementIds = new Set<string>();
      const state = { totalPlacements: 0 };
      return fromContent(data.content, 1, seenPlacementIds, state, undefined, "content");
    } catch (error) {
      if (error instanceof VortexPuckAdapterError) throw error;
      throw new VortexPuckAdapterError("Inbound Puck data validation failed", { cause: error });
    }
  };

  const fromPuckShell = (shell: ApplicationShellV2, data: unknown): ApplicationShellV2 => {
    let parsedShell: ApplicationShellV2;
    try {
      parsedShell = applicationShellV2Schema.parse(shell);
    } catch (error) {
      throw new VortexPuckAdapterError("Invalid application shell input", { cause: error });
    }
    const layout = fromPuckData(data);
    const assembled: ApplicationShellV2 = {
      ...parsedShell,
      layout,
    };
    try {
      return applicationShellV2Schema.parse(assembled);
    } catch (error) {
      throw new VortexPuckAdapterError("Invalid assembled application shell", { cause: error });
    }
  };

  return Object.freeze({
    toPuckData,
    fromPuckData,
    toPuckShell: (shell: ApplicationShellV2): Data =>
      toPuckData(applicationShellV2Schema.parse(shell).layout),
    fromPuckShell,
  });
};
