import type { ComponentData, Content, Data } from "@puckeditor/core";
import {
  immutablePlatformBlockCatalogueV2Schema,
  isRepeatableSlotIdentityV2,
  repeatableSlotItemIdentitiesV2,
  repeatableSlotKeyV2,
  sourceApplicationShellV2Schema,
  sourceBlockPropertyValueV2Schema,
  sourcePlacementSlotV2Schema,
  sourceResponsivePlacementV2Schema,
  sourceThemeTokenValueV2Schema,
  validateComponentSettings,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";

type SourceSlot = ReturnType<typeof sourcePlacementSlotV2Schema.parse>;
type SourcePlacement = SourceSlot["placements"][string];
type SourceShell = ReturnType<typeof sourceApplicationShellV2Schema.parse>;
type SourceOrder = SourceSlot["order"];
type Reservations = ReadonlyMap<string, ReadonlySet<string>>;
type SlotIdentity =
  Readonly<{ kind: "root" }> | Readonly<{ kind: "child"; parentAlias: string; slotKey: string }>;

const refuse = (): never => {
  throw new TypeError("Invalid authored Puck composition");
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return refuse();
  if (
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (property) => property.get !== undefined || property.set !== undefined,
    )
  )
    refuse();
  return value as Record<string, unknown>;
};

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

// Puck slots use the same declared key the page renderer passes to the component.
const puckSlotKey = (sourceKey: string): string => sourceKey;

const puckResponsive = (value: SourcePlacement["responsive"]) => {
  const layout = (source: SourcePlacement["responsive"]["desktop"]) => ({
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

const puckThemeOverrides = (values: SourcePlacement["theme_overrides"]) =>
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

const sourceThemeOverrides = (candidate: unknown): SourcePlacement["theme_overrides"] => {
  const values = object(candidate);
  const source = Object.fromEntries(
    Object.entries(values).map(([key, raw]) => {
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
    Object.entries(source).map(([key, value]) => [key, sourceThemeTokenValueV2Schema.parse(value)]),
  ) as SourcePlacement["theme_overrides"];
};

const sourceResponsive = (candidate: unknown): SourcePlacement["responsive"] => {
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
  return sourceResponsivePlacementV2Schema.parse({
    desktop: layout(responsive.desktop),
    tablet: layout(responsive.tablet),
    phone: layout(responsive.phone),
  });
};

const sourcePropertyValue = (candidate: unknown): unknown => {
  const raw = object(candidate);
  const source = sourceBlockPropertyValueV2Schema.safeParse(raw);
  if (source.success) return source.data;
  switch (raw.kind) {
    case "asset_reference":
      return { kind: raw.kind, asset_id: raw.assetId };
    case "icon":
      return { kind: raw.kind, icon_key: raw.iconKey };
    case "theme_token":
      return { kind: raw.kind, token: raw.tokenKey };
    case "field_reference":
      return { kind: raw.kind, field: raw.fieldId };
    case "relationship_reference":
      return { kind: raw.kind, relationship: raw.relationshipId };
    case "action_reference":
      return { kind: raw.kind, action: raw.actionKey };
    case "page_reference":
      return { kind: raw.kind, page: raw.pageId };
    case "query_reference":
      return { kind: raw.kind, query: raw.queryId };
    case "pipeline_reference":
      return { kind: raw.kind, pipeline: raw.pipelineId };
    case "record_type_reference":
      return { kind: raw.kind, record_type: raw.recordType };
    case "record_reference":
      return {
        kind: raw.kind,
        record_type: raw.recordType,
        record_id: raw.recordId,
      };
    case "group":
      return {
        kind: raw.kind,
        properties: Object.fromEntries(
          Object.entries(object(raw.properties)).map(([key, value]) => [
            key,
            sourcePropertyValue(value),
          ]),
        ),
      };
    case "list": {
      if (!Array.isArray(raw.items)) return refuse();
      return { kind: raw.kind, items: raw.items.map(sourcePropertyValue) };
    }
    default:
      return sourceBlockPropertyValueV2Schema.parse(raw);
  }
};

const sourceSettings = (
  candidate: unknown,
  allowed: ReadonlySet<string>,
  original: SourcePlacement["settings"] | undefined,
  compiled: Readonly<Record<string, unknown>>,
): SourcePlacement["settings"] => Object.fromEntries(
  Object.entries(object(candidate)).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!allowed.has(key) && Object.hasOwn(compiled, key)) return [];
    if (original?.[key] === undefined && Object.hasOwn(compiled, key) &&
      sameJsonValue(value, compiled[key])) return [];
    return [[key, sourceBlockPropertyValueV2Schema.parse(sourcePropertyValue(value))]];
  }),
) as SourcePlacement["settings"];

const sameSlot = (left: SlotIdentity, right: SlotIdentity): boolean =>
  left.kind === "root"
    ? right.kind === "root"
    : right.kind === "child" &&
      left.parentAlias === right.parentAlias &&
      left.slotKey === right.slotKey;

const sameOrder = (left: SourceOrder, right: SourceOrder): boolean =>
  (["desktop", "tablet", "phone"] as const).every((breakpoint) => {
    const a = left[breakpoint];
    const b = right[breakpoint];
    return a === undefined
      ? b === undefined
      : b !== undefined && a.length === b.length && a.every((id, index) => id === b[index]);
  });

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
  original: SourceOrder | undefined,
  hints: readonly SourceOrder[],
): SourceOrder => {
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

/**
 * A source-native, private Studio bridge. It resolves no identities and performs
 * no reads or writes. A caller applies the returned authored region to its own
 * current, revision-bound document before using ordinary draft history/save.
 */
export const createVortexAuthoredPuckAdapterV2 = (catalogueInput: unknown) => {
  try {
    const catalogue = immutablePlatformBlockCatalogueV2Schema.parse(catalogueInput);
    const releases = new Map(
      catalogue.releases.map((release) => [
        `${release.blockId}:${release.releaseVersion}`,
        release,
      ]),
    );
    const releaseFor = (placement: SourcePlacement): PlatformBlockReleaseV2 =>
      releases.get(`${placement.block.block_id}:${placement.block.release_version}`) ?? refuse();

    // Bound the raw placement tree before recursive source parsing or conversion.
    const boundSource = (candidate: unknown): void => {
      const pending = [{ value: candidate, depth: 1, exit: false }];
      const ancestors = new Set<object>();
      let count = 0;
      while (pending.length > 0) {
        const { value, depth, exit } = pending.pop()!;
        const slot = object(value);
        if (exit) {
          ancestors.delete(slot);
          continue;
        }
        if (ancestors.has(slot)) refuse();
        ancestors.add(slot);
        pending.push({ value, depth, exit: true });
        for (const placementValue of Object.values(object(slot.placements))) {
          count += 1;
          if (
            count > catalogue.compositionPolicy.maximumPlacements ||
            depth > catalogue.compositionPolicy.maximumDepth
          )
            refuse();
          const placement = object(placementValue);
          for (const child of Object.values(object(placement.slots)))
            pending.push({ value: child, depth: depth + 1, exit: false });
        }
      }
    };

    const parseSlot = (candidate: unknown): SourceSlot => {
      boundSource(candidate);
      return sourcePlacementSlotV2Schema.parse(candidate);
    };

    const parseShell = (candidate: unknown): SourceShell => {
      boundSource(object(candidate).layout);
      return sourceApplicationShellV2Schema.parse(candidate);
    };

    const reservationsFor = (shell: SourceShell): Reservations => {
      const reservations = new Map<string, Set<string>>();
      for (const slot of shell.content_slots) {
        const keys = reservations.get(slot.parent_placement) ?? new Set<string>();
        keys.add(slot.parent_slot);
        reservations.set(slot.parent_placement, keys);
      }
      return reservations;
    };

    const slotDeclarations = (placement: SourcePlacement, release: PlatformBlockReleaseV2) => {
      const declarations = new Map<string, PlatformBlockReleaseV2["slots"][number]>();
      for (const declaration of release.slots) {
        if (declaration.repeats === undefined) {
          declarations.set(declaration.key, declaration);
          continue;
        }
        const identities = repeatableSlotItemIdentitiesV2(declaration, placement.settings);
        if (
          new Set(identities).size !== identities.length ||
          identities.some((identity) => !isRepeatableSlotIdentityV2(declaration.key, identity))
        )
          refuse();
        for (const identity of identities)
          declarations.set(repeatableSlotKeyV2(declaration.key, identity), declaration);
      }
      return declarations;
    };

    const validateTree = (slot: SourceSlot, reservations: Reservations): void => {
      const seen = new Set<string>();
      const visit = (
        current: SourceSlot,
        parentDeclaration?: PlatformBlockReleaseV2["slots"][number],
        responsiveOrderAllowed = true,
      ): void => {
        const tablet = current.order.tablet ?? current.order.desktop;
        const phone = current.order.phone ?? tablet;
        if (
          !responsiveOrderAllowed &&
          (!sameOrder({ desktop: tablet }, { desktop: current.order.desktop }) ||
            !sameOrder({ desktop: phone }, { desktop: current.order.desktop }))
        )
          refuse();
        for (const [alias, placement] of Object.entries(current.placements)) {
          if (seen.has(alias)) refuse();
          seen.add(alias);
          const release = releaseFor(placement);
          if (
            parentDeclaration !== undefined &&
            !parentDeclaration.allowedChildCategories.includes(release.paletteGroup)
          )
            refuse();
          for (const value of Object.values(placement.settings))
            sourceBlockPropertyValueV2Schema.parse(value);
          if (validateComponentSettings(placement.settings, release.properties).length > 0)
            refuse();

          const desktop = placement.responsive.desktop;
          const tabletLayout = placement.responsive.tablet ?? desktop;
          const phoneLayout = placement.responsive.phone ?? tabletLayout;
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

          const declarations = slotDeclarations(placement, release);
          if (Object.keys(placement.slots).some((key) => !declarations.has(key))) refuse();
          for (const [key, declaration] of declarations) {
            const child = Object.hasOwn(placement.slots, key) ? placement.slots[key] : undefined;
            const reserved = reservations.get(alias)?.has(key) === true;
            if (declaration.required && declaration.repeats === undefined && !reserved) {
              if (child === undefined || Object.keys(child.placements).length === 0) refuse();
            }
            if (reserved && (child === undefined || Object.keys(child.placements).length > 0))
              refuse();
            if (child !== undefined)
              visit(child, declaration, release.capabilities.responsiveOrder);
          }
        }
      };
      visit(slot);
    };

    const toContent = (
      slot: SourceSlot,
      identity: SlotIdentity,
      runtimeSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    ): Content =>
      slot.order.desktop.map((id) => {
        const { settings, slots, ...metadata } = slot.placements[id]!;
        const release = releaseFor(slot.placements[id]!);
        const compiledSettings = runtimeSettings?.[id] ?? {};
        const props: Record<string, unknown> & { id: string } = {
          id,
          settings: { ...clone(compiledSettings), ...clone(settings) },
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
            baselineOrder: clone(slot.order),
            order: clone(slot.order),
          },
        };
        for (const [key, child] of Object.entries(slots))
          props[puckSlotKey(key)] = toContent(child, {
            kind: "child",
            parentAlias: id,
            slotKey: key,
          }, runtimeSettings);
        return { type: release.rendererKey, props } satisfies ComponentData;
      });

    const dataFor = (
      slot: SourceSlot,
      reservations: Reservations,
      runtimeSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    ): Data => {
      validateTree(slot, reservations);
      return {
        root: {
          props: { gap: "medium", padding: "medium" },
          readOnly: { gap: true, padding: true },
        } as unknown as Data["root"],
        content: toContent(slot, { kind: "root" }, runtimeSettings),
        zones: {},
      };
    };

    const inverse = (
      original: SourceSlot,
      candidate: unknown,
      reservations: Reservations,
    ): SourceSlot => {
      validateTree(original, reservations);
      const baselinePlacements = new Map<string, SourcePlacement>();
      const index = (slot: SourceSlot): void => {
        for (const [id, placement] of Object.entries(slot.placements)) {
          baselinePlacements.set(id, placement);
          for (const child of Object.values(placement.slots)) index(child);
        }
      };
      index(original);

      const data = closed(candidate, ["root", "content", "zones"]);
      const root = closed(data.root, ["props", "readOnly"]);
      if (root.props !== undefined) {
        const props = closed(root.props, ["gap", "padding"]);
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
      // source-safe aliases before they enter source records or private order declarations.
      const aliases = new Set(baselinePlacements.keys());
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
          const knownSourceId = baselinePlacements.has(puckId) && !assignedAliases.has(puckId);
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

      const parseOrder = (candidateOrder: unknown): SourceOrder => {
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
        const result: SourceOrder = {
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
        baseline: SourceSlot | undefined,
        destination: SlotIdentity,
      ): SourceSlot => {
        if (!Array.isArray(content)) return refuse();
        const placements: SourceSlot["placements"] = {};
        const desktop: string[] = [];
        const hints: SourceOrder[] = [];
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
              ? (baseline?.order ?? { desktop: [] })
              : parseOrder(baselineOrder);
          const editedOrder = order === undefined ? undefined : parseOrder(order);
          const slots: SourcePlacement["slots"] = {};
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
              : closed(authored, [
                  "block",
                  "view_permission",
                  "use_permission",
                  "visibility_condition",
                  "query",
                  "read_model",
                  "theme_overrides",
                  "responsive",
                ]);
          // First parse the source fields without accepting any private Puck properties.
          const authoredBlock = object(fields.block);
          const release = releases.get(
            `${text(authoredBlock.block_id)}:${text(authoredBlock.release_version)}`,
          ) ?? refuse();
          const compiledSettings = compiledSettingsValue === undefined
            ? {} : object(compiledSettingsValue);
          const fieldSlot = sourcePlacementSlotV2Schema.parse({
            placements: {
              [id]: {
                ...fields,
                settings: sourceSettings(props.settings, new Set(release.properties.map((property) =>
                  property.key)), baselinePlacements.get(id)?.settings, compiledSettings),
                slots: {},
              },
            },
            order: { desktop: [id] },
          });
          const placement = fieldSlot.placements[id]!;
          if (text(node.type) !== release.rendererKey) refuse();
          const declarations = slotDeclarations(placement, release);
          const allowed = [
            "id",
            "settings",
            "vortex",
            ...[...declarations.keys()].map(puckSlotKey),
          ];
          closed(props, allowed);
          if (node.readOnly !== undefined) {
            const readOnly = closed(node.readOnly, allowed);
            if (Object.values(readOnly).some((value) => typeof value !== "boolean")) refuse();
          }
          for (const key of declarations.keys()) {
            const privateKey = puckSlotKey(key);
            const child = Object.hasOwn(props, privateKey) ? props[privateKey] : undefined;
            if (child !== undefined)
              slots[key] = fromContent(child, baselinePlacements.get(id)?.slots[key], {
                kind: "child",
                parentAlias: id,
                slotKey: key,
              });
          }
          placements[id] = { ...placement, slots };
          desktop.push(id);
          if (
            editedOrder !== undefined &&
            sameSlot(origin, destination) &&
            (baseline === undefined || sameOrder(originalOrder, baseline.order))
          )
            hints.push(editedOrder);
        }
        return sourcePlacementSlotV2Schema.parse({
          placements,
          order: sourceOrder(desktop, baseline?.order, hints),
        });
      };
      const result = fromContent(data.content, original, { kind: "root" });
      validateTree(result, reservations);
      return clone(result);
    };

    // Never surface source values, raw schema issues, references or private metadata in errors.
    const safe = <Value>(operation: () => Value): Value => {
      try {
        return operation();
      } catch {
        return refuse();
      }
    };

    return Object.freeze({
      toPuckData: (
        sourceSlot: unknown,
        runtimeSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
      ): Data => safe(() => dataFor(parseSlot(sourceSlot), new Map(), runtimeSettings)),
      fromPuckData: (originalSourceSlot: unknown, data: unknown): SourceSlot =>
        safe(() => inverse(parseSlot(originalSourceSlot), data, new Map())),
      toPuckShell: (sourceShell: unknown): Data =>
        safe(() => {
          const shell = parseShell(sourceShell);
          return dataFor(shell.layout, reservationsFor(shell));
        }),
      fromPuckShell: (originalSourceShell: unknown, data: unknown): SourceShell =>
        safe(() => {
          const shell = parseShell(originalSourceShell);
          return sourceApplicationShellV2Schema.parse({
            ...shell,
            layout: inverse(shell.layout, data, reservationsFor(shell)),
          });
        }),
    });
  } catch {
    return refuse();
  }
};
