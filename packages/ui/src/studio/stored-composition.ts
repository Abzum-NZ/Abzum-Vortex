import {
  isSourceItemShape,
  readSourceItem,
  reservedItemPropKeys,
  sourceApplicationShellSchema,
  sourceItemSchema,
  sourceSlotBreakpointOrders,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type PlatformBlockRelease,
  type SourceApplicationShell,
  type SourceItem,
  type SourceSlotOrder,
} from "@vortex/platform/schema";

/**
 * The stored composition Studio edits: Puck data is the stored page data itself. Every edit, from
 * the canvas or a command, is judged here as stored data before the draft history takes it, and a
 * refusal names where the data is invalid, never a value.
 */

/** One stored slot: its items in desktop order and its authored tablet and phone order. */
type StoredZone = { items: SourceItem[]; order: SourceSlotOrder | undefined };
type Location = readonly (string | number)[];
/** Shell placements whose named slot is reserved for page content and must stay empty. */
type StoredReservations = ReadonlyMap<string, ReadonlySet<string>>;

const settingReasons: Readonly<Record<string, string>> = {
  required_value: "needs a value",
  unknown_property: "is not a setting of this block",
  unsafe_content: "holds content that is not allowed",
};

/** A refusal of stored composition data. Its message names the place and the rule, never a value. */
export class StoredCompositionRefusal extends TypeError {
  readonly code = "STUDIO_COMPOSITION_REFUSED";
  constructor(
    /** Where in the slot the data is refused: item indexes, `props` and prop keys. */
    readonly location: Location,
    readonly reason: string,
    /** The refused block, as the person knows it, when the refusal is about one block. */
    readonly subject?: string,
  ) {
    super(
      `${subject ?? (location.length === 0 ? "This content area" : `Content at ${location.join(".")}`)}: ${reason}`,
    );
  }
}

const refuse = (location: Location, reason: string, subject?: string): never => {
  throw new StoredCompositionRefusal(location, reason, subject);
};

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (property) => property.get === undefined && property.set === undefined,
  );
};

const closed = (value: unknown, keys: readonly string[], location: Location): Record<string, unknown> => {
  if (!plainObject(value)) return refuse(location, "is not an object");
  const unknown = Reflect.ownKeys(value).find((key) => typeof key !== "string" || !keys.includes(key));
  if (unknown !== undefined) refuse(location, `has an unknown key '${String(unknown)}'`);
  return value;
};

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const releaseIndexes = new WeakMap<ImmutablePlatformBlockCatalogue, Map<string, PlatformBlockRelease>>();

/** The exact catalogue release an item names, or undefined when the catalogue lacks it. */
export const storedItemRelease = (
  catalogue: ImmutablePlatformBlockCatalogue,
  item: SourceItem,
): PlatformBlockRelease | undefined => {
  let index = releaseIndexes.get(catalogue);
  if (index === undefined) {
    index = new Map(catalogue.releases.map((release) => [`${release.blockId}:${release.releaseVersion}`, release]));
    releaseIndexes.set(catalogue, index);
  }
  const block = item.props.vortex.block;
  return index.get(`${block.block_id}:${block.release_version}`);
};

/** Bound the raw item tree (size, depth, cycles) before any recursive schema reads it. */
const boundItems = (catalogue: ImmutablePlatformBlockCatalogue, candidate: unknown, location: Location): void => {
  const pending = [{ value: candidate, depth: 1, exit: false, at: location }];
  const ancestors = new Set<object>();
  let count = 0;
  while (pending.length > 0) {
    const { value, depth, exit, at } = pending.pop()!;
    if (!Array.isArray(value)) return refuse(at, "is not a list of blocks");
    if (exit) {
      ancestors.delete(value);
      continue;
    }
    if (ancestors.has(value)) refuse(at, "contains itself");
    ancestors.add(value);
    pending.push({ value, depth, exit: true, at });
    for (const [index, raw] of value.entries()) {
      count += 1;
      if (count > catalogue.compositionPolicy.maximumPlacements)
        refuse(at, "has more blocks than a page may hold");
      if (depth > catalogue.compositionPolicy.maximumDepth) refuse(at, "nests blocks too deeply");
      if (!plainObject(raw) || !plainObject(raw.props)) return refuse([...at, index], "is not a block");
      for (const [key, child] of Object.entries(raw.props))
        if (
          !reservedItemPropKeys.has(key) &&
          Array.isArray(child) &&
          child.length > 0 &&
          child.every((entry: unknown) => plainObject(entry) && isSourceItemShape(entry))
        )
          pending.push({ value: child, depth: depth + 1, exit: false, at: [...at, index, "props", key] });
    }
  }
};

/** One authored slot order: closed, and each declared breakpoint a permutation of the slot. */
const parseSlotOrder = (candidate: unknown, desktop: readonly string[], location: Location): SourceSlotOrder => {
  const order = closed(candidate, ["tablet", "phone"], location);
  const result: SourceSlotOrder = {};
  for (const breakpoint of ["tablet", "phone"] as const) {
    const value = order[breakpoint];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length !== desktop.length ||
      new Set(value).size !== value.length ||
      value.some((id) => typeof id !== "string" || !desktop.includes(id))
    )
      refuse([...location, breakpoint], "must name every block of its slot once");
    result[breakpoint] = [...(value as string[])];
  }
  return result;
};

/** The items of a raw slot, parsed with the source item schema; the first issue is located. */
const parseItems = (catalogue: ImmutablePlatformBlockCatalogue, candidate: unknown, location: Location): SourceItem[] => {
  boundItems(catalogue, candidate, location);
  const parsed = sourceItemSchema.array().safeParse(candidate);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const at = [...location, ...issue.path.map((part) => (typeof part === "number" ? part : String(part)))];
  return refuse(
    at,
    issue.code === "unrecognized_keys"
      ? `has an unknown key '${issue.keys.join("', '")}'`
      : issue.code === "custom"
        ? issue.message
        : `is not valid (${issue.code})`,
  );
};

/**
 * Judges one stored slot against the catalogue the way publication does: every item names a
 * catalogue release whose renderer it uses and whose palette its parent slot admits, every prop is
 * a declared setting or slot, settings read as their declared kinds, required slots are filled,
 * reserved shell slots are empty and layouts and orders respect the release's capabilities.
 */
const validateTree = (
  catalogue: ImmutablePlatformBlockCatalogue,
  zone: StoredZone,
  reservations: StoredReservations,
  location: Location,
): void => {
  const seen = new Set<string>();
  const visit = (
    items: readonly SourceItem[],
    order: SourceSlotOrder | undefined,
    at: Location,
    parentDeclaration?: PlatformBlockRelease["slots"][number],
    responsiveOrderAllowed = true,
  ): void => {
    const orders = sourceSlotBreakpointOrders(items, order);
    if (!responsiveOrderAllowed && (!sameList(orders.tablet, orders.desktop) || !sameList(orders.phone, orders.desktop)))
      refuse(at, "cannot have its own tablet or phone order");
    for (const [index, item] of items.entries()) {
      const itemAt = [...at, index];
      const alias = item.props.id;
      if (seen.has(alias)) refuse([...itemAt, "props", "id"], `repeats the block name '${alias}'`);
      seen.add(alias);
      const release = storedItemRelease(catalogue, item);
      if (release === undefined) return refuse([...itemAt, "props", "vortex", "block"], "names a block release the catalogue does not hold", `Block '${alias}'`);
      const subject = `${release.name} '${alias}'`;
      if (item.type !== release.rendererKey) refuse([...itemAt, "type"], "does not match its block release", subject);
      if (parentDeclaration !== undefined && !parentDeclaration.allowedChildCategories.includes(release.paletteGroup))
        refuse(itemAt, "is not allowed in this slot", subject);
      const reading = readSourceItem(item, release);
      if (reading.unknownKeys.length > 0)
        refuse([...itemAt, "props", reading.unknownKeys[0]!], `has an unknown slot '${reading.unknownKeys[0]}'`, subject);
      if (reading.malformedSlots.length > 0)
        refuse([...itemAt, "props", reading.malformedSlots[0]!], `slot '${reading.malformedSlots[0]}' is not a list of blocks`, subject);
      if (reading.repeatableFailures.length > 0)
        refuse([...itemAt, "props"], `repeats a ${reading.repeatableFailures[0]!.declaration.label} entry`, subject);
      const failure = reading.settingFailures[0];
      if (failure !== undefined)
        refuse(
          [...itemAt, "props", ...failure.path],
          `setting '${failure.path.join(".")}' ${settingReasons[failure.family] ?? `is not valid (${failure.family})`}`,
          subject,
        );

      const vortex = item.props.vortex;
      const desktop = vortex.responsive.desktop;
      const tablet = vortex.responsive.tablet ?? desktop;
      const phone = vortex.responsive.phone ?? tablet;
      const responsiveAt = [...itemAt, "props", "vortex", "responsive"];
      if (!release.capabilities.responsiveVisibility && (tablet.visible !== desktop.visible || phone.visible !== desktop.visible))
        refuse(responsiveAt, "cannot be hidden on one screen size only", subject);
      for (const layout of [desktop, tablet, phone]) {
        if (!release.capabilities.gridWidth && layout.width.kind === "grid")
          refuse(responsiveAt, "cannot take a grid width", subject);
        if (release.capabilities.height === "content" && layout.height.kind !== "content")
          refuse(responsiveAt, "cannot take a fixed height", subject);
      }

      const slotOrders = vortex.slot_orders ?? {};
      for (const key of Object.keys(slotOrders))
        if (reading.slots.get(key)?.items === undefined)
          refuse([...itemAt, "props", "vortex", "slot_orders", key], "orders a slot the block does not fill", subject);
      for (const [key, { declaration, items: child }] of reading.slots) {
        const reserved = reservations.get(alias)?.has(key) === true;
        if (declaration.required && declaration.repeats === undefined && !reserved && (child === undefined || child.length === 0))
          refuse([...itemAt, "props", key], `slot '${declaration.label}' needs a block`, subject);
        if (reserved && (child === undefined || child.length > 0))
          refuse([...itemAt, "props", key], `slot '${declaration.label}' is reserved for page content`, subject);
        if (child !== undefined)
          visit(child, slotOrders[key], [...itemAt, "props", key], declaration, release.capabilities.responsiveOrder);
      }
    }
  };
  visit(zone.items, zone.order, location);
};

/** Parses and judges one raw stored slot `{ items, order }`; it throws a located refusal. */
export const validateStoredZone = (
  catalogue: ImmutablePlatformBlockCatalogue,
  candidate: unknown,
  reservations: StoredReservations = new Map(),
): StoredZone => {
  const zone = closed(candidate, ["items", "order"], []);
  const items = parseItems(catalogue, zone.items, []);
  const order = zone.order === undefined ? undefined : parseSlotOrder(zone.order, items.map((item) => item.props.id), ["order"]);
  const parsed = { items, order };
  validateTree(catalogue, parsed, reservations, []);
  return parsed;
};

/** The reserved targets of a shell: each content slot's parent placement and slot. */
const storedShellReservations = (shell: SourceApplicationShell): StoredReservations => {
  const reservations = new Map<string, Set<string>>();
  for (const slot of shell.content_slots) {
    const keys = reservations.get(slot.parent_placement) ?? new Set<string>();
    keys.add(slot.parent_slot);
    reservations.set(slot.parent_placement, keys);
  }
  return reservations;
};

/** Parses and judges one raw stored application shell, including its reserved content slots. */
export const validateStoredShell = (
  catalogue: ImmutablePlatformBlockCatalogue,
  candidate: unknown,
): SourceApplicationShell => {
  const layout = plainObject(candidate) && plainObject(candidate.layout) ? candidate.layout : undefined;
  boundItems(catalogue, layout?.content, ["layout", "content"]);
  const parsed = sourceApplicationShellSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return refuse(issue.path.map((part) => (typeof part === "number" ? part : String(part))), `is not valid (${issue.code})`);
  }
  const shell = parsed.data;
  validateTree(
    catalogue,
    { items: shell.layout.content, order: shell.layout.root.props.vortex.slot_orders.content },
    storedShellReservations(shell),
    [],
  );
  return shell;
};

/**
 * One slot's declared tablet or phone order after its members changed: surviving blocks keep their
 * authored order and each new block takes its desktop position.
 */
const adjustedOrder = (saved: readonly string[], desktop: readonly string[]): string[] => {
  const present = new Set(desktop);
  const result = saved.filter((id) => present.has(id));
  const kept = new Set(result);
  desktop.forEach((id, index) => {
    if (!kept.has(id)) result.splice(Math.min(index, result.length), 0, id);
  });
  return result;
};

/** A slot order kept in step with the slot's current members; undefined when none is declared. */
export const adjustedSlotOrder = (
  order: SourceSlotOrder | undefined,
  desktop: readonly string[],
): SourceSlotOrder | undefined =>
  order === undefined || (order.tablet === undefined && order.phone === undefined)
    ? undefined
    : {
        ...(order.tablet === undefined ? {} : { tablet: adjustedOrder(order.tablet, desktop) }),
        ...(order.phone === undefined ? {} : { phone: adjustedOrder(order.phone, desktop) }),
      };

const sourceAliasPattern = /^[a-z][a-z0-9_]*$/;
const aliasLimit = 160;

/** A source-safe block name for a Puck-generated id, unique among `reserved`. */
const generatedAlias = (puckId: string, reserved: ReadonlySet<string>): string => {
  const readable = puckId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, 140);
  const base = `${/^[a-z]/.test(readable) ? "" : "block_"}${readable || "item"}`.slice(0, 140);
  let suffix = 2;
  let alias = base;
  while (reserved.has(alias)) {
    const ending = `_${suffix++}`;
    alias = `${base.slice(0, aliasLimit - ending.length)}${ending}`;
  }
  return alias;
};

/** A source-safe block name for a new block, unique among `reserved`: `base`, or `base_2` and so on. */
export const freshBlockName = (base: string, reserved: ReadonlySet<string>): string =>
  generatedAlias(base, reserved);

const hasBlockReference = (props: Record<string, unknown>): boolean =>
  plainObject(props.vortex) && plainObject(props.vortex.block);

const childSlotsOf = (props: Record<string, unknown>): [string, unknown[]][] =>
  Object.entries(props).flatMap(([key, value]): [string, unknown[]][] =>
    !reservedItemPropKeys.has(key) && Array.isArray(value) && value.length > 0 && value.every(isSourceItemShape)
      ? [[key, value]]
      : [],
  );

/**
 * The stored slot a canvas edit produced. Puck's data is the stored data; Puck itself only adds a
 * root holding its config's root defaults and, on Duplicate, generated ids. Generated ids become unique block names, a copied block's
 * slot orders follow its copied children, and every declared tablet and phone order keeps its
 * authored sequence while blocks join or leave its slot. The result is judged like any stored slot,
 * and every copy Duplicate made is named, with each copied descendant, beside its original.
 */
export const storedZoneFromPuck = (
  catalogue: ImmutablePlatformBlockCatalogue,
  baseline: StoredZone,
  candidate: unknown,
  /** The root props the canvas gave Puck: its config's root defaults, which Puck writes back. */
  rootProps: Readonly<Record<string, unknown>>,
): Readonly<{ zone: StoredZone; copies: ReadonlyMap<string, string> }> => {
  const data = closed(candidate, ["root", "content", "zones"], []);
  const root = closed(data.root, ["props", "readOnly"], ["root"]);
  if (root.props !== undefined &&
    JSON.stringify(withoutIdentity(root.props)) !== JSON.stringify(withoutIdentity(rootProps)))
    refuse(["root", "props"], "changed the page root, which the canvas does not edit");
  if (root.readOnly !== undefined) closed(root.readOnly, [], ["root", "readOnly"]);
  if (data.zones !== undefined) closed(data.zones, [], ["zones"]);
  boundItems(catalogue, data.content, []);

  // Index the baseline: every block name, and the slot each block was in.
  const baselineAliases = new Set<string>();
  const baselineParent = new Map<string, { parent: SourceItem; key: string }>();
  const baselineItems = new Map<string, SourceItem>();
  const index = (items: readonly SourceItem[], parent?: SourceItem, key?: string): void => {
    for (const item of items) {
      baselineAliases.add(item.props.id);
      baselineItems.set(item.props.id, item);
      if (parent !== undefined && key !== undefined) baselineParent.set(item.props.id, { parent, key });
      for (const [slotKey, children] of childSlotsOf(item.props)) index(children as SourceItem[], item, slotKey);
    }
  };
  index(baseline.items);

  const assigned = new Set<string>();
  const rebuild = (content: unknown[], at: Location): SourceItem[] =>
    content.map((raw, position) => {
      const itemAt = [...at, position];
      const node = closed(raw, ["type", "props", "readOnly"], itemAt);
      if (node.readOnly !== undefined) closed(node.readOnly, [], [...itemAt, "readOnly"]);
      if (!plainObject(node.props) || typeof node.props.id !== "string" || node.props.id.length === 0)
        return refuse([...itemAt, "props", "id"], "has no block name");
      const puckId = node.props.id;
      const known = baselineAliases.has(puckId) && !assigned.has(puckId);
      const fresh = sourceAliasPattern.test(puckId) && puckId.length <= aliasLimit &&
        !baselineAliases.has(puckId) && !assigned.has(puckId);
      const alias = known || fresh ? puckId : generatedAlias(puckId, new Set([...baselineAliases, ...assigned]));
      assigned.add(alias);
      // A fresh copy: Puck shares unchanged values between its states and between a duplicate
      // and its original.
      const slots = new Map(childSlotsOf(node.props));
      const props = Object.fromEntries(Object.entries(node.props).map(([key, value]) => [
        key,
        key === "id" ? alias : slots.has(key)
          ? rebuild(slots.get(key)!, [...itemAt, "props", key]) : structuredClone(value),
      ]));
      // Puck writes an empty list for every slot the stored block leaves out; that is not an edit.
      const item = { type: node.type, props } as SourceItem;
      const release = hasBlockReference(props) ? storedItemRelease(catalogue, item) : undefined;
      const before = baselineItems.get(alias)?.props;
      if (release !== undefined)
        for (const key of readSourceItem(item, release).slots.keys()) {
          const value = props[key];
          if (Array.isArray(value) && value.length === 0 && (before === undefined || !(key in before))) delete props[key];
        }
      return item;
    });
  const items = rebuild(data.content as unknown[], []);

  // A copy's slot orders name the original's children; map them to the copied children by position.
  const remapCopiedOrders = (list: readonly SourceItem[]): void => {
    for (const item of list) {
      const orders = item.props.vortex?.slot_orders;
      if (!baselineAliases.has(item.props.id) && orders !== undefined && plainObject(orders))
        for (const [key, order] of Object.entries(orders)) {
          const copied = item.props[key];
          const named = order?.tablet?.[0] ?? order?.phone?.[0];
          const origin = named === undefined ? undefined : baselineParent.get(named);
          const originals = origin === undefined ? undefined : origin.parent.props[origin.key];
          if (!Array.isArray(copied) || !Array.isArray(originals) || originals.length !== copied.length) continue;
          const byOriginal = new Map(originals.map((child, position) =>
            [(child as SourceItem).props.id, (copied[position] as SourceItem).props.id]));
          const map = (ids: string[] | undefined) => ids?.map((id) => byOriginal.get(id) ?? id);
          orders[key] = {
            ...(order.tablet === undefined ? {} : { tablet: map(order.tablet) }),
            ...(order.phone === undefined ? {} : { phone: map(order.phone) }),
          };
        }
      for (const [, children] of childSlotsOf(item.props)) remapCopiedOrders(children as SourceItem[]);
    }
  };
  remapCopiedOrders(items);

  // Declared orders follow their slot's members: a block moved away leaves, a new one joins.
  const adjustNested = (list: readonly SourceItem[]): void => {
    for (const item of list) {
      const orders = item.props.vortex?.slot_orders;
      if (orders !== undefined && plainObject(orders)) {
        for (const key of Object.keys(orders)) {
          const children = item.props[key];
          if (!Array.isArray(children)) continue;
          const adjusted = adjustedSlotOrder(orders[key], (children as SourceItem[]).map((child) => child.props.id));
          if (adjusted === undefined) delete orders[key];
          else orders[key] = adjusted;
        }
        if (Object.keys(orders).length === 0) delete item.props.vortex.slot_orders;
      }
      for (const [, children] of childSlotsOf(item.props)) adjustNested(children as SourceItem[]);
    }
  };
  adjustNested(items);
  const order = adjustedSlotOrder(baseline.order, items.map((item) => item.props.id));
  const zone = validateStoredZone(catalogue, order === undefined ? { items } : { items, order });
  return { zone, copies: copiesOf(zone.items, baselineAliases) };
};

/** The item with every block name and slot order left out, to compare a copy with its original. */
const withoutIdentity = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "id" && key !== "slot_orders")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => [key, withoutIdentity(entry)]));
};

/**
 * The blocks Duplicate copied, as original name to copy name, descendants included. Puck places a
 * copy right after its original; a new block there with the same type and content is that copy.
 */
const copiesOf = (items: readonly SourceItem[], baseline: ReadonlySet<string>): Map<string, string> => {
  const copies = new Map<string, string>();
  const pair = (original: SourceItem, copy: SourceItem): void => {
    copies.set(original.props.id, copy.props.id);
    const copiedSlots = new Map(childSlotsOf(copy.props));
    for (const [key, children] of childSlotsOf(original.props)) {
      const copied = copiedSlots.get(key);
      if (copied === undefined || copied.length !== children.length) continue;
      children.forEach((child, index) => pair(child as SourceItem, copied[index] as SourceItem));
    }
  };
  const visit = (list: readonly SourceItem[]): void => {
    list.forEach((item, index) => {
      const previous = index === 0 ? undefined : list[index - 1]!;
      if (previous !== undefined && !baseline.has(item.props.id) && baseline.has(previous.props.id) &&
        item.type === previous.type &&
        JSON.stringify(withoutIdentity(item)) === JSON.stringify(withoutIdentity(previous)))
        pair(previous, item);
      for (const [, children] of childSlotsOf(item.props)) visit(children as SourceItem[]);
    });
  };
  visit(items);
  return copies;
};

type SourceFlowBinding = Readonly<{ id: string; control: string }> & Record<string, unknown>;

/**
 * A copied control works like its original: each flow binding of an original gains a copy bound to
 * the copied block under its own binding name, raising the same application event, so the copy is
 * never left unbound.
 */
export const withCopiedFlowBindings = <Binding extends SourceFlowBinding>(
  bindings: readonly Binding[],
  copies: ReadonlyMap<string, string>,
): Binding[] => {
  if (copies.size === 0) return [...bindings];
  const taken = new Set(bindings.map((binding) => binding.id));
  const fresh = (base: string): string => {
    const name = generatedAlias(`${base}_copy`, taken);
    taken.add(name);
    return name;
  };
  const result = [...bindings];
  for (const binding of bindings) {
    const copy = copies.get(binding.control);
    if (copy !== undefined)
      result.push({ ...structuredClone(binding), id: fresh(binding.id), control: copy });
  }
  return result;
};

/**
 * A binding belongs to its control: the bindings of blocks the canvas deleted go with them, as
 * Duplicate copies them with a copied block. Undo restores both, because history holds the whole
 * draft.
 */
export const removeFlowBindingsOf = (body: ApplicationSourceDocument["body"], removed: ReadonlySet<string>): void => {
  const unbound = new Set(body.flow_bindings.filter((binding) => removed.has(binding.control)).map((binding) => binding.event_id));
  body.flow_bindings = body.flow_bindings.filter((binding) => !removed.has(binding.control));
  pruneUnboundEvents(body, unbound);
};

/**
 * An event declared only for bindings that left goes with them; one that another binding or a
 * remaining block's setting still names stays.
 */
export const pruneUnboundEvents = (body: ApplicationSourceDocument["body"], candidates: ReadonlySet<string>): void => {
  const unbound = new Set(candidates);
  for (const binding of body.flow_bindings) unbound.delete(binding.event_id);
  if (unbound.size === 0) return;
  const named = JSON.stringify([...body.pages.map((page) => page.composition), ...body.shells.map((shell) => shell.layout)]);
  body.events = body.events.filter((event) => !unbound.has(event.id) || named.includes(`"event_id":"${event.id}"`));
};

/** Every block name in a slot, at any depth. */
export const storedZoneAliases = (zone: StoredZone): Set<string> => {
  const aliases = new Set<string>();
  const visit = (items: readonly SourceItem[]): void => {
    for (const item of items) {
      aliases.add(item.props.id);
      for (const [, children] of childSlotsOf(item.props)) visit(children as SourceItem[]);
    }
  };
  visit(zone.items);
  return aliases;
};

type StoredBlockDependency = ApplicationSourceDocument["body"]["platform_block_dependencies"][number];

/**
 * The dependency list names exactly the releases the placements use: an edit that adds, drops or
 * removes blocks (a canvas edit, a removed page or layout, a new layout) brings it in step.
 */
export const syncStoredBlockDependencies = (source: ApplicationSourceDocument): void => {
  const used = new Map<string, { block_id: string; release_version: string }>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const block = record.block as Record<string, unknown> | undefined;
    if (typeof block?.block_id === "string" && typeof block.release_version === "string")
      used.set(`${block.block_id}@${block.release_version}`,
        { block_id: block.block_id, release_version: block.release_version });
    Object.values(record).forEach(collect);
  };
  collect(source.body.pages);
  collect(source.body.shells);
  const kept = source.body.platform_block_dependencies.filter((dependency) =>
    used.has(`${dependency.block_id}@${dependency.release_version}`));
  for (const [identity, release] of used)
    if (!kept.some((dependency) => `${dependency.block_id}@${dependency.release_version}` === identity))
      kept.push({ kind: "platform_block", ...release } as StoredBlockDependency);
  kept.sort((left, right) => left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1
    : left.release_version < right.release_version ? -1 : left.release_version > right.release_version ? 1 : 0);
  source.body.platform_block_dependencies = kept;
};
