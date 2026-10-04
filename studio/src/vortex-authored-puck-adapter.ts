import type { ComponentData, Content, Data } from "@puckeditor/core";
import {
  immutablePlatformBlockCatalogueV2Schema,
  isRepeatableSlotIdentityV2,
  repeatableSlotItemIdentitiesV2,
  repeatableSlotKeyV2,
  sourceApplicationShellV2Schema,
  sourceBlockPropertyValueV2Schema,
  sourcePlacementSlotV2Schema,
  validateComponentSettings,
  type PlatformBlockReleaseV2,
} from "@vortex/contracts";

type SourceSlot = ReturnType<typeof sourcePlacementSlotV2Schema.parse>;
type SourcePlacement = SourceSlot["placements"][string];
type SourceShell = ReturnType<typeof sourceApplicationShellV2Schema.parse>;
type SourceOrder = SourceSlot["order"];
type Reservations = ReadonlyMap<string, ReadonlySet<string>>;

const refuse = (): never => {
  throw new TypeError("Invalid authored Puck composition");
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return refuse();
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some((property) =>
    property.get !== undefined || property.set !== undefined,
  )) refuse();
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

// Source slot names never collide with Puck's private id/settings/vortex fields.
const puckSlotKey = (sourceKey: string): string => `slot_${sourceKey}`;

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
 * omission. Prefer this destination's original hint over a moved child's hint.
 * The explicit baseline also covers empty slots that have no child to carry one.
 */
const sourceOrder = (
  desktop: string[],
  original: SourceOrder | undefined,
  hints: readonly SourceOrder[],
): SourceOrder => {
  const matching = original === undefined
    ? hints
    : hints.filter((hint) =>
        sameOrder({ desktop: hint.desktop }, { desktop: original.desktop }) ||
        sameOrder({ desktop: hint.desktop }, { desktop }),
      );
  let saved = original;
  if (matching.length > 0) {
    const present = new Set(desktop);
    const overlap = (hint: SourceOrder): number =>
      hint.desktop.filter((id) => present.has(id)).length;
    const best = matching.reduce((maximum, hint) => Math.max(maximum, overlap(hint)), 0);
    const candidates = matching.filter((hint) => overlap(hint) === best);
    saved = candidates[0]!;
    if (candidates.some((hint) => !sameOrder(hint, saved!))) refuse();
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
          ) refuse();
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
        ) refuse();
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
        ) refuse();
        for (const [alias, placement] of Object.entries(current.placements)) {
          if (seen.has(alias)) refuse();
          seen.add(alias);
          const release = releaseFor(placement);
          if (
            parentDeclaration !== undefined &&
            !parentDeclaration.allowedChildCategories.includes(release.paletteGroup)
          ) refuse();
          for (const value of Object.values(placement.settings))
            sourceBlockPropertyValueV2Schema.parse(value);
          if (validateComponentSettings(placement.settings, release.properties).length > 0) refuse();

          const desktop = placement.responsive.desktop;
          const tabletLayout = placement.responsive.tablet ?? desktop;
          const phoneLayout = placement.responsive.phone ?? tabletLayout;
          if (
            !release.capabilities.responsiveVisibility &&
            (tabletLayout.visible !== desktop.visible || phoneLayout.visible !== desktop.visible)
          ) refuse();
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
            if (child !== undefined) visit(child, declaration, release.capabilities.responsiveOrder);
          }
        }
      };
      visit(slot);
    };

    const toContent = (slot: SourceSlot): Content =>
      slot.order.desktop.map((id) => {
        const { settings, slots, ...metadata } = slot.placements[id]!;
        const release = releaseFor(slot.placements[id]!);
        const props: Record<string, unknown> & { id: string } = {
          id,
          settings: clone(settings),
          vortex: { ...clone(metadata), order: clone(slot.order) },
        };
        for (const [key, child] of Object.entries(slots)) props[puckSlotKey(key)] = toContent(child);
        return { type: release.rendererKey, props } satisfies ComponentData;
      });

    const dataFor = (slot: SourceSlot, reservations: Reservations): Data => {
      validateTree(slot, reservations);
      return { root: {}, content: toContent(slot), zones: {} };
    };

    const inverse = (original: SourceSlot, candidate: unknown, reservations: Reservations): SourceSlot => {
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
      closed(data.root, []);
      closed(data.zones, []);

      // Retain only aliases found in this original or supplied private tree.
      const aliases = new Set(baselinePlacements.keys());
      const pending = [{ value: data.content, depth: 1, exit: false }];
      const ancestors = new Set<object>();
      let count = 0;
      while (pending.length > 0) {
        const { value, depth, exit } = pending.pop()!;
        if (!Array.isArray(value)) refuse();
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
          ) refuse();
          const node = closed(raw, ["type", "props", "readOnly"]);
          const props = object(node.props);
          aliases.add(text(props.id));
          for (const [key, child] of Object.entries(props))
            if (key !== "id" && key !== "settings" && key !== "vortex")
              pending.push({ value: child, depth: depth + 1, exit: false });
        }
      }

      const parseOrder = (candidateOrder: unknown): SourceOrder => {
        const order = closed(candidateOrder, ["desktop", "tablet", "phone"]);
        const list = (value: unknown): string[] => {
          if (!Array.isArray(value)) return refuse();
          const ids = value.map(text);
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
          if (ids !== undefined && (
            ids.length !== result.desktop.length ||
            ids.some((id) => !result.desktop.includes(id))
          )) refuse();
        }
        return result;
      };

      const seen = new Set<string>();
      const fromContent = (content: unknown, baseline: SourceSlot | undefined): SourceSlot => {
        if (!Array.isArray(content)) return refuse();
        const placements: SourceSlot["placements"] = {};
        const desktop: string[] = [];
        const hints: SourceOrder[] = [];
        for (const raw of content) {
          const node = closed(raw, ["type", "props", "readOnly"]);
          const props = object(node.props);
          const id = text(props.id);
          if (seen.has(id)) refuse();
          seen.add(id);
          const metadata = closed(props.vortex, [
            "block", "view_permission", "use_permission", "visibility_condition", "query",
            "read_model", "theme_overrides", "responsive", "order",
          ]);
          const { order, ...fields } = metadata;
          const slots: SourcePlacement["slots"] = {};
          // First parse the source fields without accepting any private Puck properties.
          const fieldSlot = sourcePlacementSlotV2Schema.parse({
            placements: { [id]: { ...fields, settings: props.settings, slots: {} } },
            order: { desktop: [id] },
          });
          const placement = fieldSlot.placements[id]!;
          const release = releaseFor(placement);
          if (text(node.type) !== release.rendererKey) refuse();
          const declarations = slotDeclarations(placement, release);
          const allowed = ["id", "settings", "vortex", ...[...declarations.keys()].map(puckSlotKey)];
          closed(props, allowed);
          if (node.readOnly !== undefined) {
            const readOnly = closed(node.readOnly, allowed);
            if (Object.values(readOnly).some((value) => typeof value !== "boolean")) refuse();
          }
          for (const key of declarations.keys()) {
            const privateKey = puckSlotKey(key);
            const child = Object.hasOwn(props, privateKey) ? props[privateKey] : undefined;
            if (child !== undefined)
              slots[key] = fromContent(child, baselinePlacements.get(id)?.slots[key]);
          }
          placements[id] = { ...placement, slots };
          desktop.push(id);
          if (order !== undefined) hints.push(parseOrder(order));
        }
        return sourcePlacementSlotV2Schema.parse({
          placements,
          order: sourceOrder(desktop, baseline?.order, hints),
        });
      };
      const result = fromContent(data.content, original);
      validateTree(result, reservations);
      return clone(result);
    };

    // Never surface source values, raw schema issues, references or private metadata in errors.
    const safe = <Value>(operation: () => Value): Value => {
      try { return operation(); } catch { return refuse(); }
    };

    return Object.freeze({
      toPuckData: (sourceSlot: unknown): Data =>
        safe(() => dataFor(parseSlot(sourceSlot), new Map())),
      fromPuckData: (originalSourceSlot: unknown, data: unknown): SourceSlot =>
        safe(() => inverse(parseSlot(originalSourceSlot), data, new Map())),
      toPuckShell: (sourceShell: unknown): Data => safe(() => {
        const shell = parseShell(sourceShell);
        return dataFor(shell.layout, reservationsFor(shell));
      }),
      fromPuckShell: (originalSourceShell: unknown, data: unknown): SourceShell => safe(() => {
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
