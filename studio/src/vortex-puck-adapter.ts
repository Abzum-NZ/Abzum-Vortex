import type { ComponentData, Content, Data } from "@puckeditor/core";
import {
  applicationShellV2Schema,
  immutablePlatformBlockCatalogueV2Schema,
  placementSlotV2Schema,
  type ApplicationShellV2,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";

/** Actual Puck Data. Page, shell, and guided-step selection remain Vortex orchestration. */
export type VortexPuckDataV2 = Data;
export type VortexPuckContentV2 = Content;
export class VortexPuckAdapterError extends Error {
  readonly name = "VortexPuckAdapterError";
}
const clone = <T>(value: T): T => structuredClone(value);
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
type VortexSlot = ReturnType<typeof placementSlotV2Schema.parse>;

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
  const fromContent = (input: unknown, at = "content"): VortexSlot => {
    if (!Array.isArray(input))
      throw new VortexPuckAdapterError(`Invalid Puck adapter data at ${at}`);
    const placements: Record<string, unknown> = {};
    const desktop: string[] = [];
    let savedOrder: Record<string, unknown> = { desktop: [], tablet: [], phone: [] };
    for (const [index, raw] of input.entries()) {
      const node = exact(raw, ["type", "props", "readOnly"], `${at}[${index}]`);
      const props = asObject(node.props, `${at}[${index}].props`);
      const id = string(props.id, `${at}[${index}].props.id`);
      if (placements[id])
        throw new VortexPuckAdapterError(`Duplicate Puck placement identity ${id}`);
      const meta = exact(
        props.vortex,
        [
          "block",
          "viewPermissionKey",
          "usePermissionKey",
          "visibilityCondition",
          "queryId",
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
      const allowed = new Set([
        "id",
        "settings",
        "vortex",
        ...release.slots.map((slot) => slot.key),
      ]);
      if (Object.keys(props).some((key) => !allowed.has(key)))
        throw new VortexPuckAdapterError(`Private or transient Puck data at ${at}[${index}].props`);
      const slots: Record<string, VortexSlot> = {};
      for (const declaration of release.slots)
        if (props[declaration.key] !== undefined)
          slots[declaration.key] = fromContent(
            props[declaration.key],
            `${at}[${index}].props.${declaration.key}`,
          );
      savedOrder = exact(
        meta.order,
        ["desktop", "tablet", "phone"],
        `${at}[${index}].props.vortex.order`,
      );
      placements[id] = {
        block,
        settings: clone(asObject(props.settings, "settings")),
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
        themeOverrides: clone(asObject(meta.themeOverrides, "themeOverrides")),
        responsive: clone(asObject(meta.responsive, "responsive")),
        slots,
      };
      desktop.push(id);
    }
    return placementSlotV2Schema.parse({ placements, order: { ...clone(savedOrder), desktop } });
  };
  const toPuckData = (slot: unknown): Data => ({ root: {}, content: toContent(slot), zones: {} });
  const fromPuckData = (input: unknown): VortexSlot => {
    const data = exact(input, ["root", "content", "zones"], "data");
    exact(data.root, [], "data.root");
    if (data.zones === undefined || Object.keys(asObject(data.zones, "data.zones")).length)
      throw new VortexPuckAdapterError("Invalid Puck adapter zones");
    return fromContent(data.content);
  };
  return Object.freeze({
    toPuckData,
    fromPuckData,
    toPuckShell: (shell: ApplicationShellV2): Data =>
      toPuckData(applicationShellV2Schema.parse(shell).layout),
    fromPuckShell: (shell: ApplicationShellV2, data: unknown): ApplicationShellV2 => ({
      ...applicationShellV2Schema.parse(shell),
      layout: fromPuckData(data),
    }),
  });
};
