import type { ComponentData, Content, Data } from "@puckeditor/core";
import {
  applicationPuckRootShellSchema,
  immutablePlatformBlockCatalogueSchema,
  isSourceItemShape,
  plainSourceSettingValue,
  readSourceItem,
  reservedItemPropKeys,
  sourceApplicationShellSchema,
  sourceItemSchema,
  sourceResponsivePlacementSchema,
  sourceSlotBreakpointOrders,
  sourceThemeTokenValueSchema,
  type PlatformBlockRelease,
  type SourceApplicationShell,
  type SourceBlockPropertyValueContract,
  type SourceItem,
  type SourceItemVortex,
  type SourcePageZone,
  type SourceSlotOrder,
} from "@vortex/platform/schema";

type Zone = { items: SourceItem[]; order: SourceSlotOrder | undefined };
/** The private Puck order of one slot: its desktop order and any authored tablet and phone order. */
type PuckOrder = { desktop: string[]; tablet?: string[] | undefined; phone?: string[] | undefined };
type TypedSettings = Record<string, SourceBlockPropertyValueContract>;
type Reservations = ReadonlyMap<string, ReadonlySet<string>>;
type SlotIdentity =
  Readonly<{ kind: "root" }> | Readonly<{ kind: "child"; parentAlias: string; slotKey: string }>;

const refuse = (): never => {
  throw new TypeError("Invalid authored Puck composition");
};

/** A refusal whose reason is safe to show: it names the block and setting, never a value. */
export class AuthoredPuckSettingRefusal extends TypeError {
  readonly code = "AUTHORED_PUCK_SETTING_REFUSED";
  constructor(
    readonly blockName: string,
    readonly settingPath: readonly (string | number)[],
    readonly family: string,
  ) {
    super(
      `${blockName}: setting '${settingPath.join(".")}' ${
        family === "required_value" ? "needs a value" : `is not valid (${family})`
      }`,
    );
  }
}

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (property) => property.get === undefined && property.set === undefined,
  );
};

const object = (value: unknown): Record<string, unknown> =>
  plainObject(value) ? value : refuse();

const closed = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = object(value);
  if (Reflect.ownKeys(record).some((key) => typeof key !== "string" || !keys.includes(key)))
    refuse();
  return record;
};

const text = (value: unknown): string =>
  typeof value === "string" && value.length > 0 ? value : refuse();

const clone = <Value>(value: Value): Value => structuredClone(value);
const sourceAliasPattern = /^[a-z][a-z0-9_]*$/;

const sourceAliasBase = (puckId: string): string => {
  const readable = puckId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 140);
  return `${/^[a-z]/.test(readable) ? "" : "block_"}${readable || "item"}`.slice(0, 140);
};

const generatedAlias = (puckId: string, reserved: ReadonlySet<string>): string => {
  const base = sourceAliasBase(puckId);
  let suffix = 2;
  let alias = base;
  while (reserved.has(alias)) {
    const ending = `_${suffix++}`;
    alias = `${base.slice(0, 160 - ending.length)}${ending}`;
  }
  return alias;
};

const sameJsonValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  const a = object(left);
  const b = object(right);
  const keys = Object.keys(a).sort();
  const otherKeys = Object.keys(b).sort();
  return keys.length === otherKeys.length && keys.every((key, index) =>
    key === otherKeys[index] && sameJsonValue(a[key], b[key]));
};

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const puckResponsive = (value: SourceItemVortex["responsive"]) => {
  const layout = (source: SourceItemVortex["responsive"]["desktop"]) => ({
    visible: source.visible,
    width:
      source.width.kind === "grid"
        ? { kind: "grid", startColumn: source.width.start_column, span: source.width.span }
        : { kind: source.width.kind },
    height: source.height,
  });
  const desktop = layout(value.desktop);
  const tablet = layout(value.tablet ?? value.desktop);
  const phone = layout(value.phone ?? value.tablet ?? value.desktop);
  return { desktop, tablet, phone };
};

const puckThemeOverrides = (values: SourceItemVortex["theme_overrides"]) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      switch (value.kind) {
        case "typography":
          return [key, { ...value, sizeRem: value.size_rem, lineHeight: value.line_height }];
        case "border":
          return [
            key,
            {
              kind: value.kind,
              widthRem: value.width_rem,
              style: value.style,
              colorToken: value.color_token,
            },
          ];
        case "focus":
          return [
            key,
            { kind: value.kind, colorToken: value.color_token, widthRem: value.width_rem },
          ];
        case "asset":
          return [key, { kind: value.kind, assetId: value.asset_id }];
        default:
          return [key, value];
      }
    }),
  );

const sourceThemeOverrides = (candidate: unknown): SourceItemVortex["theme_overrides"] => {
  const values = object(candidate);
  const source = Object.fromEntries(
    Object.entries(values)
      .filter(([, raw]) => raw !== undefined)
      .map(([key, raw]) => {
      const value = object(raw);
      switch (value.kind) {
        case "typography":
          return [
            key,
            {
              kind: value.kind,
              family: value.family,
              size_rem: value.sizeRem,
              line_height: value.lineHeight,
              weight: value.weight,
            },
          ];
        case "border":
          return [
            key,
            {
              kind: value.kind,
              width_rem: value.widthRem,
              style: value.style,
              color_token: value.colorToken,
            },
          ];
        case "focus":
          return [
            key,
            {
              kind: value.kind,
              color_token: value.colorToken,
              width_rem: value.widthRem,
            },
          ];
        case "asset":
          return [key, { kind: value.kind, asset_id: value.assetId }];
        default:
          return [key, value];
      }
    }),
  );
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, sourceThemeTokenValueSchema.parse(value)]),
  ) as SourceItemVortex["theme_overrides"];
};

const sourceResponsive = (candidate: unknown): SourceItemVortex["responsive"] => {
  const responsive = closed(candidate, ["desktop", "tablet", "phone"]);
  const layout = (raw: unknown) => {
    const value = closed(raw, ["visible", "width", "height"]);
    const width = closed(value.width, ["kind", "startColumn", "span"]);
    const sourceWidth =
      width.kind === "grid"
        ? { kind: width.kind, start_column: width.startColumn, span: width.span }
        : { kind: width.kind };
    return { visible: value.visible, width: sourceWidth, height: value.height };
  };
  return sourceResponsivePlacementSchema.parse({
    desktop: layout(responsive.desktop),
    tablet: layout(responsive.tablet),
    phone: layout(responsive.phone),
  });
};

// A Puck setting value is the typed source value or, for a compiled value the canvas shows, its
// canonical spelling. Each reference kind names its source key and its canonical key.
const referenceKeys: Readonly<Record<string, readonly [source: string, canonical: string]>> = {
  asset_reference: ["asset_id", "assetId"],
  icon: ["icon_key", "iconKey"],
  theme_token: ["token", "tokenKey"],
  field_reference: ["field", "fieldId"],
  relationship_reference: ["relationship", "relationshipId"],
  action_reference: ["action", "actionKey"],
  page_reference: ["page", "pageId"],
  query_reference: ["query", "queryId"],
  pipeline_reference: ["pipeline", "pipelineId"],
  record_type_reference: ["record_type", "recordType"],
};

const sourcePropertyValue = (candidate: unknown): SourceBlockPropertyValueContract => {
  const raw = object(candidate);
  const kind = text(raw.kind);
  if (Object.hasOwn(referenceKeys, kind)) {
    const [sourceKey, canonicalKey] = referenceKeys[kind]!;
    const value = Object.hasOwn(raw, sourceKey)
      ? closed(raw, ["kind", sourceKey])[sourceKey]
      : closed(raw, ["kind", canonicalKey])[canonicalKey];
    return { kind, [sourceKey]: text(value) } as unknown as SourceBlockPropertyValueContract;
  }
  switch (kind) {
    case "record_reference": {
      const source = Object.hasOwn(raw, "record_type") || Object.hasOwn(raw, "record_id");
      const value = source
        ? closed(raw, ["kind", "record_type", "record_id"])
        : closed(raw, ["kind", "recordType", "recordId"]);
      return {
        kind,
        record_type: text(source ? value.record_type : value.recordType),
        record_id: text(source ? value.record_id : value.recordId),
      };
    }
    case "group":
      return {
        kind,
        properties: Object.fromEntries(
          Object.entries(object(closed(raw, ["kind", "properties"]).properties)).map(
            ([key, value]) => [key, sourcePropertyValue(value)],
          ),
        ),
      };
    case "list": {
      const items = closed(raw, ["kind", "items"]).items;
      if (!Array.isArray(items)) return refuse();
      return { kind, items: items.map(sourcePropertyValue) };
    }
    default:
      return {
        kind,
        value: closed(raw, ["kind", "value"]).value,
      } as unknown as SourceBlockPropertyValueContract;
  }
};

const sourceSettings = (
  candidate: unknown,
  allowed: ReadonlySet<string>,
  original: TypedSettings | undefined,
  compiled: Readonly<Record<string, unknown>>,
): TypedSettings => Object.fromEntries(
  Object.entries(object(candidate)).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!allowed.has(key) && Object.hasOwn(compiled, key)) return [];
    if (original?.[key] === undefined && Object.hasOwn(compiled, key) &&
      sameJsonValue(value, compiled[key])) return [];
    return [[key, sourcePropertyValue(value)]];
  }),
);

const sameSlot = (left: SlotIdentity, right: SlotIdentity): boolean =>
  left.kind === "root"
    ? right.kind === "root"
    : right.kind === "child" &&
      left.parentAlias === right.parentAlias &&
      left.slotKey === right.slotKey;

const sameOrder = (left: PuckOrder, right: PuckOrder): boolean =>
  (["desktop", "tablet", "phone"] as const).every((breakpoint) => {
    const a = left[breakpoint];
    const b = right[breakpoint];
    return a === undefined ? b === undefined : b !== undefined && sameList(a, b);
  });

const puckOrderOf = (items: readonly SourceItem[], order: SourceSlotOrder | undefined): PuckOrder => ({
  desktop: items.map((item) => item.props.id),
  ...(order?.tablet === undefined ? {} : { tablet: [...order.tablet] }),
  ...(order?.phone === undefined ? {} : { phone: [...order.phone] }),
});

/** The authored tablet and phone order of a Puck order; undefined when neither is declared. */
const slotOrderOf = (order: PuckOrder): SourceSlotOrder | undefined =>
  order.tablet === undefined && order.phone === undefined
    ? undefined
    : {
        ...(order.tablet === undefined ? {} : { tablet: order.tablet }),
        ...(order.phone === undefined ? {} : { phone: order.phone }),
      };

/** Retain surviving explicit order and insert new children at their desktop positions. */
const adjustedOrder = (saved: readonly string[], desktop: readonly string[]): string[] => {
  const present = new Set(desktop);
  const result = saved.filter((id) => present.has(id));
  const kept = new Set(result);
  desktop.forEach((id, index) => {
    if (!kept.has(id)) result.splice(Math.min(index, result.length), 0, id);
  });
  return result;
};

/**
 * Puck owns desktop position. Order hints retain authored declarations, including
 * omission. Only hints proved to come from this destination's original slot are
 * supplied here. The explicit baseline also covers empty slots and moved children
 * carrying another slot's declarations. Genuine responsive edits update all of
 * the destination's hints consistently, retaining their original provenance.
 */
const sourceOrder = (
  desktop: string[],
  original: PuckOrder | undefined,
  hints: readonly PuckOrder[],
): PuckOrder => {
  let saved = original;
  if (hints.length > 0) {
    saved = hints[0]!;
    if (hints.some((hint) => !sameOrder(hint, saved!))) refuse();
  }
  return {
    desktop,
    ...(saved?.tablet === undefined ? {} : { tablet: adjustedOrder(saved.tablet, desktop) }),
    ...(saved?.phone === undefined ? {} : { phone: adjustedOrder(saved.phone, desktop) }),
  };
};

/** One authored slot order: closed, and each declared breakpoint a permutation of the slot. */
const parseSlotOrder = (candidate: unknown, desktop: readonly string[]): SourceSlotOrder => {
  const order = closed(candidate, ["tablet", "phone"]);
  const result: SourceSlotOrder = {};
  for (const breakpoint of ["tablet", "phone"] as const) {
    const value = order[breakpoint];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return refuse();
    const ids = value.map(text);
    if (
      ids.length !== desktop.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !desktop.includes(id))
    )
      refuse();
    result[breakpoint] = ids;
  }
  return result;
};

/**
 * A source-native, private Studio bridge. It resolves no identities and performs
 * no reads or writes. A caller applies the returned authored zone to its own
 * current, revision-bound document before using ordinary draft history/save.
 */
export const createVortexAuthoredPuckAdapter = (catalogueInput: unknown) => {
  try {
    const catalogue = immutablePlatformBlockCatalogueSchema.parse(catalogueInput);
    const releases = new Map(
      catalogue.releases.map((release) => [
        `${release.blockId}:${release.releaseVersion}`,
        release,
      ]),
    );
    const releaseOf = (block: unknown): PlatformBlockRelease => {
      const reference = object(block);
      return releases.get(`${text(reference.block_id)}:${text(reference.release_version)}`) ??
        refuse();
    };
    const releaseFor = (item: SourceItem): PlatformBlockRelease =>
      releaseOf(item.props.vortex.block);

    // Bound the raw item tree before recursive source parsing or conversion.
    const boundSource = (candidate: unknown): void => {
      const pending = [{ value: candidate, depth: 1, exit: false }];
      const ancestors = new Set<object>();
      let count = 0;
      while (pending.length > 0) {
        const { value, depth, exit } = pending.pop()!;
        if (!Array.isArray(value)) return refuse();
        if (exit) {
          ancestors.delete(value);
          continue;
        }
        if (ancestors.has(value)) refuse();
        ancestors.add(value);
        pending.push({ value, depth, exit: true });
        for (const raw of value) {
          count += 1;
          if (
            count > catalogue.compositionPolicy.maximumPlacements ||
            depth > catalogue.compositionPolicy.maximumDepth
          )
            refuse();
          const props = object(object(raw).props);
          for (const [key, child] of Object.entries(props))
            if (
              !reservedItemPropKeys.has(key) &&
              Array.isArray(child) &&
              child.length > 0 &&
              child.every((entry: unknown) => plainObject(entry) && isSourceItemShape(entry))
            )
              pending.push({ value: child, depth: depth + 1, exit: false });
        }
      }
    };

    const parseZone = (candidate: unknown): Zone => {
      const zone = closed(candidate, ["items", "order"]);
      boundSource(zone.items);
      const items = sourceItemSchema.array().parse(zone.items);
      const order =
        zone.order === undefined
          ? undefined
          : parseSlotOrder(zone.order, items.map((item) => item.props.id));
      return { items, order };
    };

    const parseShell = (candidate: unknown): SourceApplicationShell => {
      boundSource(object(object(candidate).layout).content);
      return sourceApplicationShellSchema.parse(candidate);
    };

    const shellZone = (shell: SourceApplicationShell): Zone => ({
      items: shell.layout.content,
      order: shell.layout.root.props.vortex.slot_orders.content,
    });

    const reservationsFor = (shell: SourceApplicationShell): Reservations => {
      const reservations = new Map<string, Set<string>>();
      for (const slot of shell.content_slots) {
        const keys = reservations.get(slot.parent_placement) ?? new Set<string>();
        keys.add(slot.parent_slot);
        reservations.set(slot.parent_placement, keys);
      }
      return reservations;
    };

    const validateTree = (zone: Zone, reservations: Reservations): void => {
      const seen = new Set<string>();
      const visit = (
        items: readonly SourceItem[],
        order: SourceSlotOrder | undefined,
        parentDeclaration?: PlatformBlockRelease["slots"][number],
        responsiveOrderAllowed = true,
      ): void => {
        const orders = sourceSlotBreakpointOrders(items, order);
        if (
          !responsiveOrderAllowed &&
          (!sameList(orders.tablet, orders.desktop) || !sameList(orders.phone, orders.desktop))
        )
          refuse();
        for (const item of items) {
          const alias = item.props.id;
          if (seen.has(alias)) refuse();
          seen.add(alias);
          const release = releaseFor(item);
          if (item.type !== release.rendererKey) refuse();
          if (
            parentDeclaration !== undefined &&
            !parentDeclaration.allowedChildCategories.includes(release.paletteGroup)
          )
            refuse();
          const reading = readSourceItem(item, release);
          if (
            reading.unknownKeys.length > 0 ||
            reading.malformedSlots.length > 0 ||
            reading.repeatableFailures.length > 0
          )
            refuse();
          const failure = reading.settingFailures[0];
          if (failure !== undefined)
            throw new AuthoredPuckSettingRefusal(release.name, failure.path, failure.family);

          const vortex = item.props.vortex;
          const desktop = vortex.responsive.desktop;
          const tabletLayout = vortex.responsive.tablet ?? desktop;
          const phoneLayout = vortex.responsive.phone ?? tabletLayout;
          if (
            !release.capabilities.responsiveVisibility &&
            (tabletLayout.visible !== desktop.visible || phoneLayout.visible !== desktop.visible)
          )
            refuse();
          for (const layout of [desktop, tabletLayout, phoneLayout]) {
            if (!release.capabilities.gridWidth && layout.width.kind === "grid") refuse();
            if (release.capabilities.height === "content" && layout.height.kind !== "content")
              refuse();
          }

          const slotOrders = vortex.slot_orders ?? {};
          if (Object.keys(slotOrders).some((key) => reading.slots.get(key)?.items === undefined))
            refuse();
          for (const [key, { declaration, items: child }] of reading.slots) {
            const reserved = reservations.get(alias)?.has(key) === true;
            if (declaration.required && declaration.repeats === undefined && !reserved) {
              if (child === undefined || child.length === 0) refuse();
            }
            if (reserved && (child === undefined || child.length > 0)) refuse();
            if (child !== undefined)
              visit(child, slotOrders[key], declaration, release.capabilities.responsiveOrder);
          }
        }
      };
      visit(zone.items, zone.order);
    };

    const toContent = (
      items: readonly SourceItem[],
      order: SourceSlotOrder | undefined,
      identity: SlotIdentity,
      runtimeSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    ): Content => {
      const slotOrder = puckOrderOf(items, order);
      return items.map((item) => {
        const release = releaseFor(item);
        const reading = readSourceItem(item, release);
        const { slot_orders: slotOrders, ...metadata } = item.props.vortex;
        const id = item.props.id;
        const compiledSettings = runtimeSettings?.[id] ?? {};
        const props: Record<string, unknown> & { id: string } = {
          id,
          settings: { ...clone(compiledSettings), ...clone(reading.settings) },
          vortex: {
            block: {
              blockId: metadata.block.block_id,
              releaseVersion: metadata.block.release_version,
            },
            themeOverrides: puckThemeOverrides(metadata.theme_overrides),
            responsive: puckResponsive(metadata.responsive),
            authored: clone(metadata),
            compiledSettings: clone(compiledSettings),
            slot: clone(identity),
            baselineOrder: clone(slotOrder),
            order: clone(slotOrder),
          },
        };
        for (const [key, { items: child }] of reading.slots)
          if (child !== undefined)
            props[key] = toContent(child, slotOrders?.[key], {
              kind: "child",
              parentAlias: id,
              slotKey: key,
            }, runtimeSettings);
        return { type: release.rendererKey, props } satisfies ComponentData;
      });
    };

    const dataFor = (
      zone: Zone,
      reservations: Reservations,
      runtimeSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    ): Data => {
      validateTree(zone, reservations);
      return {
        root: {
          props: {
            gap: "medium",
            padding: "medium",
            applicationShell: { kind: "default" },
          },
          readOnly: { gap: true, padding: true },
        } as unknown as Data["root"],
        content: toContent(zone.items, zone.order, { kind: "root" }, runtimeSettings),
        zones: {},
      };
    };

    const inverse = (original: Zone, candidate: unknown, reservations: Reservations): Zone => {
      validateTree(original, reservations);
      const baselineItems = new Map<string, SourceItem>();
      const index = (items: readonly SourceItem[]): void => {
        for (const item of items) {
          baselineItems.set(item.props.id, item);
          for (const [, { items: child }] of readSourceItem(item, releaseFor(item)).slots)
            if (child !== undefined) index(child);
        }
      };
      index(original.items);
      const baselineReading = (id: string) => {
        const item = baselineItems.get(id);
        return item === undefined ? undefined : { item, reading: readSourceItem(item, releaseFor(item)) };
      };

      const data = closed(candidate, ["root", "content", "zones"]);
      const root = closed(data.root, ["props", "readOnly"]);
      if (root.props !== undefined) {
        const props = closed(root.props, ["gap", "padding", "applicationShell"]);
        const shell = applicationPuckRootShellSchema.parse(props.applicationShell);
        if (shell.kind !== "default") refuse();
        for (const key of ["gap", "padding"])
          if (
            props[key] !== undefined &&
            !["none", "small", "medium", "large"].includes(String(props[key]))
          )
            refuse();
      }
      if (root.readOnly !== undefined) {
        const readOnly = closed(root.readOnly, ["gap", "padding"]);
        if (Object.values(readOnly).some((value) => typeof value !== "boolean")) refuse();
      }
      closed(data.zones, []);

      // Puck-generated ids are opaque. Keep authored aliases and translate new ids to unique
      // source-safe aliases before they enter source items or private order declarations.
      const aliases = new Set(baselineItems.keys());
      const assignedAliases = new Set<string>();
      const aliasByPuckId = new Map<string, string>();
      const pending = [{ value: data.content, depth: 1, exit: false }];
      const ancestors = new Set<object>();
      let count = 0;
      while (pending.length > 0) {
        const { value, depth, exit } = pending.pop()!;
        if (!Array.isArray(value)) return refuse();
        if (exit) {
          ancestors.delete(value);
          continue;
        }
        if (ancestors.has(value)) refuse();
        ancestors.add(value);
        pending.push({ value, depth, exit: true });
        for (const raw of value) {
          count += 1;
          if (
            count > catalogue.compositionPolicy.maximumPlacements ||
            depth > catalogue.compositionPolicy.maximumDepth
          )
            refuse();
          const node = closed(raw, ["type", "props", "readOnly"]);
          const props = object(node.props);
          const puckId = text(props.id);
          if (aliasByPuckId.has(puckId)) refuse();
          const knownSourceId = baselineItems.has(puckId) && !assignedAliases.has(puckId);
          const safeNewId = sourceAliasPattern.test(puckId) && !aliases.has(puckId) &&
            !assignedAliases.has(puckId);
          const alias = knownSourceId || safeNewId
            ? puckId
            : generatedAlias(puckId, new Set([...aliases, ...assignedAliases]));
          aliasByPuckId.set(puckId, alias);
          assignedAliases.add(alias);
          aliases.add(alias);
          for (const [key, child] of Object.entries(props))
            if (key !== "id" && key !== "settings" && key !== "vortex")
              pending.push({ value: child, depth: depth + 1, exit: false });
        }
      }

      const parseOrder = (candidateOrder: unknown): PuckOrder => {
        const order = closed(candidateOrder, ["desktop", "tablet", "phone"]);
        const list = (value: unknown): string[] => {
          if (!Array.isArray(value)) return refuse();
          const ids = value.map((rawId) => {
            const puckId = text(rawId);
            return aliasByPuckId.get(puckId) ?? (aliases.has(puckId) ? puckId : refuse());
          });
          if (new Set(ids).size !== ids.length || ids.some((id) => !aliases.has(id))) refuse();
          return ids;
        };
        const result: PuckOrder = {
          desktop: list(order.desktop),
          ...(order.tablet === undefined ? {} : { tablet: list(order.tablet) }),
          ...(order.phone === undefined ? {} : { phone: list(order.phone) }),
        };
        for (const breakpoint of ["tablet", "phone"] as const) {
          const ids = result[breakpoint];
          if (
            ids !== undefined &&
            (ids.length !== result.desktop.length || ids.some((id) => !result.desktop.includes(id)))
          )
            refuse();
        }
        return result;
      };

      const seen = new Set<string>();
      const parseSlotIdentity = (value: unknown): SlotIdentity => {
        const candidate = object(value);
        if (candidate.kind === "root") {
          closed(candidate, ["kind"]);
          return { kind: "root" };
        }
        closed(candidate, ["kind", "parentAlias", "slotKey"]);
        if (candidate.kind !== "child") return refuse();
        const rawParentAlias = text(candidate.parentAlias);
        const parentAlias = aliasByPuckId.get(rawParentAlias) ?? rawParentAlias;
        const slotKey = text(candidate.slotKey);
        if (!aliases.has(parentAlias)) refuse();
        return { kind: "child", parentAlias, slotKey };
      };
      const fromContent = (
        content: unknown,
        baseline: PuckOrder | undefined,
        destination: SlotIdentity,
      ): Zone => {
        if (!Array.isArray(content)) return refuse();
        const items: SourceItem[] = [];
        const hints: PuckOrder[] = [];
        for (const raw of content) {
          const node = closed(raw, ["type", "props", "readOnly"]);
          const props = object(node.props);
          const puckId = text(props.id);
          const id = aliasByPuckId.get(puckId) ?? refuse();
          if (seen.has(id)) refuse();
          seen.add(id);
          const metadata = closed(props.vortex, [
            "block",
            "themeOverrides",
            "responsive",
            "authored",
            "compiledSettings",
            "slot",
            "baselineOrder",
            "order",
          ]);
          const { order, slot, baselineOrder, authored, compiledSettings: compiledSettingsValue,
            ...renderMetadata } = metadata;
          const origin = slot === undefined ? destination : parseSlotIdentity(slot);
          const originalOrder =
            baselineOrder === undefined
              ? (baseline ?? { desktop: [] })
              : parseOrder(baselineOrder);
          const editedOrder = order === undefined ? undefined : parseOrder(order);
          const fields =
            authored === undefined
              ? {
                  block: {
                    block_id: text(object(renderMetadata.block).blockId),
                    release_version: text(object(renderMetadata.block).releaseVersion),
                  },
                  theme_overrides: sourceThemeOverrides(renderMetadata.themeOverrides),
                  responsive: sourceResponsive(renderMetadata.responsive),
                }
              : { ...closed(authored, [
                  "block",
                  "view_permission",
                  "use_permission",
                  "visibility_condition",
                  "query",
                  "theme_overrides",
                  "responsive",
                ]) };
          // An edited Puck layout replaces only the authored responsive field; an unchanged one
          // keeps the authored item untouched.
          if (
            authored !== undefined &&
            renderMetadata.responsive !== undefined &&
            !sameJsonValue(
              renderMetadata.responsive,
              puckResponsive(sourceResponsivePlacementSchema.parse(fields.responsive)),
            )
          ) {
            fields.responsive = sourceResponsive(renderMetadata.responsive);
          }
          // The same holds for theme overrides: only a changed Puck value replaces the authored one.
          if (
            authored !== undefined &&
            renderMetadata.themeOverrides !== undefined &&
            !sameJsonValue(
              renderMetadata.themeOverrides,
              puckThemeOverrides(
                Object.fromEntries(
                  Object.entries(object(fields.theme_overrides)).map(([key, value]) => [
                    key,
                    sourceThemeTokenValueSchema.parse(value),
                  ]),
                ) as SourceItemVortex["theme_overrides"],
              ),
            )
          ) {
            fields.theme_overrides = sourceThemeOverrides(renderMetadata.themeOverrides);
          }
          // First read the source fields without accepting any private Puck properties.
          const release = releaseOf(fields.block);
          if (text(node.type) !== release.rendererKey) refuse();
          const compiledSettings = compiledSettingsValue === undefined
            ? {} : object(compiledSettingsValue);
          const baselineEntry = baselineReading(id);
          const settings = sourceSettings(props.settings, new Set(release.properties.map(
            (property) => property.key)), baselineEntry?.reading.settings, compiledSettings);
          if (Object.keys(settings).some((key) => reservedItemPropKeys.has(key))) refuse();
          const plainSettings = Object.fromEntries(
            Object.entries(settings).map(([key, value]) => [key, plainSourceSettingValue(value)]),
          );
          const vortex = fields as unknown as SourceItemVortex;
          const reading = readSourceItem(
            { type: release.rendererKey, props: { id, ...plainSettings, vortex } },
            release,
          );
          if (reading.repeatableFailures.length > 0 || reading.unknownKeys.length > 0) refuse();
          // A setting must read back as the same typed value, so its kind matches its declaration.
          for (const [key, value] of Object.entries(settings))
            if (reading.settings[key] !== undefined && !sameJsonValue(reading.settings[key], value))
              refuse();
          const allowed = ["id", "settings", "vortex", ...reading.slots.keys()];
          closed(props, allowed);
          if (node.readOnly !== undefined) {
            const readOnly = closed(node.readOnly, allowed);
            if (Object.values(readOnly).some((value) => typeof value !== "boolean")) refuse();
          }
          const slotProps: Record<string, SourceItem[]> = {};
          const slotOrders: Record<string, SourceSlotOrder> = {};
          for (const key of reading.slots.keys()) {
            const child = Object.hasOwn(props, key) ? props[key] : undefined;
            if (child === undefined) continue;
            const baselineChild = baselineEntry?.reading.slots.get(key)?.items;
            const childZone = fromContent(
              child,
              baselineChild === undefined
                ? undefined
                : puckOrderOf(baselineChild, baselineEntry!.item.props.vortex.slot_orders?.[key]),
              { kind: "child", parentAlias: id, slotKey: key },
            );
            slotProps[key] = childZone.items;
            if (childZone.order !== undefined) slotOrders[key] = childZone.order;
          }
          items.push({
            type: release.rendererKey,
            props: {
              id,
              ...plainSettings,
              ...slotProps,
              vortex: {
                ...vortex,
                ...(Object.keys(slotOrders).length === 0 ? {} : { slot_orders: slotOrders }),
              },
            },
          });
          if (
            editedOrder !== undefined &&
            sameSlot(origin, destination) &&
            (baseline === undefined || sameOrder(originalOrder, baseline))
          )
            hints.push(editedOrder);
        }
        const desktop = items.map((item) => item.props.id);
        return { items, order: slotOrderOf(sourceOrder(desktop, baseline, hints)) };
      };
      const result = fromContent(
        data.content,
        puckOrderOf(original.items, original.order),
        { kind: "root" },
      );
      const parsed: Zone = {
        items: sourceItemSchema.array().parse(result.items),
        order: result.order,
      };
      validateTree(parsed, reservations);
      return clone(parsed);
    };

    // Never surface source values, raw schema issues, references or private metadata in errors.
    const safe = <Value>(operation: () => Value): Value => {
      try {
        return operation();
      } catch (error: unknown) {
        if (error instanceof AuthoredPuckSettingRefusal) throw error;
        return refuse();
      }
    };

    return Object.freeze({
      toPuckData: (
        sourceZone: unknown,
        runtimeSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
      ): Data => safe(() => dataFor(parseZone(sourceZone), new Map(), runtimeSettings)),
      fromPuckData: (originalSourceZone: unknown, data: unknown): SourcePageZone =>
        safe(() => inverse(parseZone(originalSourceZone), data, new Map())),
      toPuckShell: (sourceShell: unknown): Data =>
        safe(() => {
          const shell = parseShell(sourceShell);
          return dataFor(shellZone(shell), reservationsFor(shell));
        }),
      fromPuckShell: (originalSourceShell: unknown, data: unknown): SourceApplicationShell =>
        safe(() => {
          const shell = parseShell(originalSourceShell);
          const zone = inverse(shellZone(shell), data, reservationsFor(shell));
          return sourceApplicationShellSchema.parse({
            ...shell,
            layout: {
              root: {
                props: {
                  vortex: { slot_orders: zone.order === undefined ? {} : { content: zone.order } },
                },
              },
              content: zone.items,
            },
          });
        }),
    });
  } catch {
    return refuse();
  }
};
