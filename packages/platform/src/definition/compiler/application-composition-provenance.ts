import {
  controlReferenceSettingKeys,
  releaseSettingDeclarations,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type DefinitionProvenanceEntry,
  type PlatformBlockRelease,
} from "../../schema";
import { sameCanonicalValue } from "../canonical-json-definition";
import { applicationTypedValueTarget, sourceResolvesIdentity } from "./provenance";
import type { Resolution } from "./resolution";
import {
  asObject,
  fail,
  type JsonObject,
  type Path,
  pathKey,
  RESOLUTION_RULE,
  TRANSFORM_RULE,
  valueAtPath,
} from "./shared";
import type { SourceContractPositions } from "./source-paths";
import { conditionSourceTargets } from "./source-target-helpers";

/** Authored layout data: a shell's layout or a page's composition. */
export const isApplicationCompositionSourcePath = (path: Path): boolean =>
  path[0] === "body" &&
  typeof path[2] === "number" &&
  ((path[1] === "shells" && path[3] === "layout") ||
    (path[1] === "pages" && path[3] === "composition"));

/** A canonical leaf one authored leaf feeds; a setting leaf names the kind of value it lies in. */
type Target = Readonly<{ path: Path; setting: boolean; kind?: string }>;

const isCompiledItem = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as JsonObject;
  const props = item.props;
  return (
    typeof item.type === "string" &&
    props !== null &&
    typeof props === "object" &&
    !Array.isArray(props) &&
    typeof (props as JsonObject).vortex === "object"
  );
};

/**
 * Where the compiled setting holding one canonical leaf starts: the index of its setting key, the
 * segment after the innermost item's `props` that is not `id`, `vortex` or a child slot its
 * `vortex.slotOrders` orders. Undefined when the leaf is not inside a setting value.
 */
export const compiledSettingStart = (
  canonical: unknown,
  canonicalPath: Path,
): number | undefined => {
  for (let at = canonicalPath.length - 2; at >= 1; at -= 1) {
    const key = canonicalPath[at + 1];
    if (canonicalPath[at] !== "props" || typeof key !== "string") continue;
    const item = valueAtPath(canonical, canonicalPath.slice(0, at));
    if (!isCompiledItem(item)) continue;
    if (key === "id" || key === "vortex") return undefined;
    const slotOrders = asObject(asObject(asObject(asObject(item).props).vortex).slotOrders);
    return Object.hasOwn(slotOrders, key) ? undefined : at + 1;
  }
  return undefined;
};

const recordTypeLeaves: Path[] = [["state"], ["moduleRootId"], ["recordTypeId"]];

/** Kinds whose authored plain value names an identity that compilation resolves. */
const resolvedSettingKinds: ReadonlySet<string> = new Set([
  "action_reference",
  "field_reference",
  "page_reference",
  "query_reference",
  "record_type_reference",
  "relationship_reference",
]);

/** Kinds whose plain value is one reference that compilation resolves to a canonical identity. */
const referenceSettingKinds: ReadonlySet<string> = new Set([
  "asset_reference",
  "icon",
  "field_reference",
  "relationship_reference",
  "action_reference",
  "page_reference",
  "query_reference",
]);

/**
 * The canonical leaves, relative to one compiled setting value, of one plain authored leaf, read by
 * the declaration the setting fills: a compiled setting keeps the authored plain shape, except that
 * a record reference spells its keys in camel case and a record type resolves to its reference.
 */
const settingLeafTargets = (
  declaration: BlockPropertySchemaContract,
  rest: Path,
  authored: unknown,
): { path: Path; kind: string }[] => {
  switch (declaration.kind) {
    case "group": {
      const key = String(rest[0]);
      const property = declaration.properties.find((candidate) => candidate.key === key);
      if (property === undefined)
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
      return settingLeafTargets(property, rest.slice(1), asObject(authored)[key]).map(
        ({ path, kind }) => ({
          path: [key, ...path],
          kind,
        }),
      );
    }
    case "list": {
      const index = rest[0];
      if (typeof index !== "number")
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
      return settingLeafTargets(
        declaration.item,
        rest.slice(1),
        Array.isArray(authored) ? (authored as unknown[])[index] : undefined,
      ).map(({ path, kind }) => ({
        path: [index, ...path],
        kind,
      }));
    }
    case "condition": {
      // An authored condition takes the query filter's short form; its leaves feed the canonical
      // condition tree exactly as a placement's visibility condition does.
      const targets = conditionSourceTargets(
        { condition: authored } as JsonObject,
        ["condition", ...rest],
        {
          sourceRoot: ["condition"],
          canonicalRoot: ["condition"],
        },
      );
      if (targets === undefined)
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
      return targets.map((path) => ({ path: path.slice(1), kind: declaration.kind }));
    }
    case "record_reference":
      return (
        rest[0] === "record_id"
          ? [["recordId"]]
          : recordTypeLeaves.map((leaf) => ["recordType", ...leaf])
      ).map((path) => ({ path, kind: declaration.kind }));
    case "record_type_reference":
      return recordTypeLeaves.map((path) => ({ path, kind: declaration.kind }));
    default:
      return [{ path: rest, kind: declaration.kind }];
  }
};

/**
 * The canonical tablet and phone order leaves one authored order position feeds. A desktop
 * position is an item's place in its slot array; a missing tablet or phone order inherits it.
 */
const orderTargets = (
  canonicalOrder: Path,
  breakpoint: "desktop" | "tablet" | "phone",
  index: number,
  order: Readonly<{ tablet?: unknown; phone?: unknown }> | undefined,
): Path[] => {
  const inherited =
    breakpoint === "desktop"
      ? [
          ...(order?.tablet === undefined ? ["tablet"] : []),
          ...(order?.tablet === undefined && order?.phone === undefined ? ["phone"] : []),
        ]
      : breakpoint === "tablet"
        ? ["tablet", ...(order?.phone === undefined ? ["phone"] : [])]
        : ["phone"];
  return inherited.map((target) => [...canonicalOrder, target, index]);
};

/** The compiled slot one authored item list becomes: its item array and its order. */
type CanonicalZone = Readonly<{ items: Path; order: Path }>;

const slotOrderPath = (holder: Path, key: string): Path => [...holder, "slotOrders", key];

/**
 * The canonical leaves one authored leaf inside an item list feeds. `itemsRoot` is the source path
 * of the list, `zone` the compiled slot it becomes and `order` the list's authored tablet and
 * phone order. Each item keeps its array position, so its compiled item is at the same index.
 */
function itemTargets(
  releases: readonly PlatformBlockRelease[],
  source: ApplicationSourceDocument,
  canonical: unknown,
  sourcePath: Path,
  itemsRoot: Path,
  canonicalZone: CanonicalZone,
  order: Readonly<{ tablet?: unknown; phone?: unknown }> | undefined,
): Target[] | undefined {
  let root = itemsRoot;
  let zone = canonicalZone;
  let slotOrder = order;
  while (true) {
    const index = sourcePath[root.length];
    if (typeof index !== "number") return undefined;
    const itemPath = [...root, index];
    const item = asObject(valueAtPath(source, itemPath));
    const props = asObject(item.props);
    const vortex = asObject(props.vortex);
    const placement: Path = [...zone.items, index];
    const canonicalVortex: Path = [...placement, "props", "vortex"];
    const suffix = sourcePath.slice(itemPath.length);
    const plain = (paths: Path[]): Target[] => paths.map((path) => ({ path, setting: false }));
    if (suffix[0] === "type") return plain([[...placement, "type"]]);
    if (suffix[0] !== "props") return undefined;
    const prop = suffix[1];
    if (prop === "id")
      return plain([
        [...placement, "props", "id"],
        ...orderTargets(zone.order, "desktop", index, slotOrder),
      ]);
    if (prop === "vortex") {
      const field = suffix[2];
      if (field === "block")
        return plain([
          [...canonicalVortex, "block", suffix[3] === "block_id" ? "blockId" : "releaseVersion"],
        ]);
      if (field === "view_permission") return plain([[...canonicalVortex, "viewPermissionKey"]]);
      if (field === "use_permission") return plain([[...canonicalVortex, "usePermissionKey"]]);
      if (field === "query") return plain([[...canonicalVortex, "queryId"]]);
      if (field === "visibility_condition") {
        const targets = conditionSourceTargets(source as unknown as JsonObject, sourcePath, {
          sourceRoot: [...itemPath, "props", "vortex", "visibility_condition"],
          canonicalRoot: [...canonicalVortex, "visibilityCondition"],
        });
        return targets === undefined ? undefined : plain(targets);
      }
      if (field === "responsive" && typeof suffix[3] === "string") {
        const responsive = asObject(vortex.responsive);
        const breakpoint = suffix[3];
        const inherited = [
          breakpoint,
          ...(breakpoint === "desktop" && responsive.tablet === undefined ? ["tablet"] : []),
          ...((
            breakpoint === "desktop"
              ? responsive.tablet === undefined && responsive.phone === undefined
              : breakpoint === "tablet" && responsive.phone === undefined
          )
            ? ["phone"]
            : []),
        ];
        return plain(
          inherited.map((target) => [
            ...canonicalVortex,
            "responsive",
            target,
            ...suffix
              .slice(4)
              .map((segment) => (segment === "start_column" ? "startColumn" : segment)),
          ]),
        );
      }
      if (
        field === "slot_orders" &&
        typeof suffix[3] === "string" &&
        (suffix[4] === "tablet" || suffix[4] === "phone") &&
        typeof suffix[5] === "number"
      )
        return plain(
          orderTargets(
            slotOrderPath(canonicalVortex, suffix[3]),
            suffix[4],
            suffix[5],
            asObject(asObject(vortex.slot_orders)[suffix[3]]),
          ),
        );
      return undefined;
    }
    if (typeof prop !== "string") return undefined;
    const compiledProps = asObject(valueAtPath(canonical, [...placement, "props"]));
    const compiledSlots = asObject(asObject(compiledProps.vortex).slotOrders);
    if (Object.hasOwn(compiledSlots, prop)) {
      root = [...itemPath, "props", prop];
      zone = {
        items: [...placement, "props", prop],
        order: slotOrderPath(canonicalVortex, prop),
      };
      const orders = vortex.slot_orders === undefined ? {} : asObject(vortex.slot_orders);
      slotOrder = orders[prop] === undefined ? undefined : asObject(orders[prop]);
      continue;
    }
    if (compiledProps[prop] === undefined) return undefined;
    const block = asObject(vortex.block);
    const release = releases.find(
      (candidate) =>
        String(candidate.blockId) === String(block.block_id) &&
        String(candidate.releaseVersion) === String(block.release_version),
    );
    const declaration =
      release === undefined
        ? undefined
        : releaseSettingDeclarations(release).find((property) => property.key === prop);
    if (declaration === undefined)
      return fail("vortex.definition.invalid_compilation_output", "invalid_value");
    return settingLeafTargets(
      declaration,
      suffix.slice(2),
      valueAtPath(source, [...itemPath, "props", prop]),
    ).map(({ path, kind }) => ({
      path: [...placement, "props", prop, ...path],
      setting: true,
      kind,
    }));
  }
}

/** The authored zone a page-data leaf belongs to and the compiled zone it becomes. */
function pageDataTargets(
  releases: readonly PlatformBlockRelease[],
  source: ApplicationSourceDocument,
  canonical: unknown,
  sourcePath: Path,
  dataRoot: Path,
  canonicalData: Path,
  resolution: Resolution,
): Target[] | undefined {
  const data = asObject(valueAtPath(source, dataRoot));
  const vortex = asObject(asObject(asObject(data.root).props).vortex);
  const orders = asObject(vortex.slot_orders);
  const isShell = vortex.shell !== null;
  const suffix = sourcePath.slice(dataRoot.length);
  const canonicalRootVortex: Path = [...canonicalData, "root", "props", "vortex"];
  const zoneKey = (zone: string): string =>
    isShell ? resolution.id(source.key, "shell_content_slot", zone, "content") : zone;
  const zoneOrder = (zone: string) =>
    orders[zone] === undefined ? undefined : asObject(orders[zone]);
  const zoneTarget = (zone: string): CanonicalZone => ({
    items:
      zone === "content" && !isShell
        ? [...canonicalData, "content"]
        : [...canonicalData, "root", "props", zoneKey(zone)],
    order: slotOrderPath(canonicalRootVortex, zoneKey(zone)),
  });
  const vortexSuffix = suffix.join("/");
  if (vortexSuffix === "root/props/vortex/shell")
    return [{ path: [...canonicalRootVortex, "shellId"], setting: false }];
  if (
    vortexSuffix.startsWith("root/props/vortex/slot_orders/") &&
    typeof suffix[4] === "string" &&
    (suffix[5] === "tablet" || suffix[5] === "phone") &&
    typeof suffix[6] === "number"
  )
    return orderTargets(
      zoneTarget(suffix[4]).order,
      suffix[5],
      suffix[6],
      zoneOrder(suffix[4]),
    ).map((path) => ({ path, setting: false }));
  if (suffix[0] === "content")
    return itemTargets(
      releases,
      source,
      canonical,
      sourcePath,
      [...dataRoot, "content"],
      zoneTarget("content"),
      zoneOrder("content"),
    );
  if (suffix[0] !== "root" || suffix[1] !== "props" || typeof suffix[2] !== "string")
    return undefined;
  if (suffix[2] !== "vortex")
    return itemTargets(
      releases,
      source,
      canonical,
      sourcePath,
      [...dataRoot, "root", "props", suffix[2]],
      zoneTarget(suffix[2]),
      zoneOrder(suffix[2]),
    );
  return undefined;
}

/**
 * The provenance of one authored layout leaf. The compiler maps each leaf itself: item aliases
 * resolve to placement identities and order positions, block and binding references resolve to
 * their identities, and a plain setting value lands in the same plain compiled value, read by the
 * declaration of its block release. A text setting keeps its value unchanged except a table
 * behaviour's event alias, which resolves to the exact event identity its flow binding uses.
 */
export function applicationCompositionProvenance(
  releases: readonly PlatformBlockRelease[],
  source: ApplicationSourceDocument,
  canonical: unknown,
  sourcePath: Path,
  resolution: Resolution,
  positions: SourceContractPositions,
  canonicalLeafSet: ReadonlySet<string>,
): DefinitionProvenanceEntry[] {
  const index = sourcePath[2] as number;
  let targets: Target[] | undefined;
  if (sourcePath[1] === "shells") {
    const layoutRoot: Path = ["body", "shells", index, "layout"];
    const canonicalLayout: Path = ["content", "shells", index, "layout"];
    const suffix = sourcePath.slice(layoutRoot.length);
    const order = asObject(
      asObject(asObject(asObject(source.body.shells[index]?.layout.root).props).vortex).slot_orders,
    ).content;
    const zone: CanonicalZone = {
      items: [...canonicalLayout, "content"],
      order: [...canonicalLayout, "root", "props", "vortex", "slotOrders", "content"],
    };
    if (suffix[0] === "content")
      targets = itemTargets(
        releases,
        source,
        canonical,
        sourcePath,
        [...layoutRoot, "content"],
        zone,
        order === undefined ? undefined : asObject(order),
      );
    else if (
      suffix.join("/").startsWith("root/props/vortex/slot_orders/content/") &&
      (suffix[5] === "tablet" || suffix[5] === "phone") &&
      typeof suffix[6] === "number"
    )
      targets = orderTargets(zone.order, suffix[5], suffix[6], asObject(order)).map((path) => ({
        path,
        setting: false,
      }));
  } else {
    const page = source.body.pages[index];
    const compositionRoot: Path = ["body", "pages", index, "composition"];
    const canonicalRoot: Path = ["content", "pages", index, "composition"];
    let dataRoot = compositionRoot;
    let canonicalData = canonicalRoot;
    if (page !== undefined && "step_content" in page.composition) {
      const step = sourcePath[5];
      if (sourcePath[4] !== "step_content" || typeof step !== "string")
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
      dataRoot = [...compositionRoot, "step_content", step];
      canonicalData = [
        ...canonicalRoot,
        "stepContent",
        resolution.id(source.key, "guided_step", step, `page:${page.key}`),
      ];
    }
    targets = pageDataTargets(
      releases,
      source,
      canonical,
      sourcePath,
      dataRoot,
      canonicalData,
      resolution,
    );
  }
  if (targets === undefined || targets.length === 0)
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  const sourceValue = valueAtPath(source, sourcePath);
  const sourceObject = source as unknown as JsonObject;
  return targets.map(({ path, setting, kind }) => {
    const canonicalPath = setting
      ? path
      : applicationTypedValueTarget(sourceObject, sourcePath, path, canonicalLeafSet, positions);
    if (!canonicalLeafSet.has(pathKey(canonicalPath)))
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    const canonicalValue = valueAtPath(canonical, canonicalPath);
    const transformed = !sameCanonicalValue(sourceValue, canonicalValue);
    let resolved: boolean;
    if (setting) {
      const leafKind = kind ?? "";
      const eventReference =
        (canonicalPath.at(-1) === "event_id" || canonicalPath.at(-1) === "row_action_event_id") &&
        canonicalValue === resolution.id(source.key, "event", String(sourceValue), "content");
      const controlReference =
        controlReferenceSettingKeys.has(String(canonicalPath.at(-1))) &&
        canonicalValue ===
          resolution.id(source.key, "block_placement", String(sourceValue), "content");
      // A condition's authored short form is reshaped into the canonical tree, and its fields resolve.
      const referenceLeaf =
        leafKind === "condition" ||
        referenceSettingKinds.has(leafKind) ||
        leafKind === "record_reference" ||
        leafKind === "record_type_reference";
      // A text, number, choice or rich-text value never changes; only references resolve.
      if (transformed && !eventReference && !controlReference && !referenceLeaf)
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      resolved =
        eventReference ||
        controlReference ||
        (resolvedSettingKinds.has(leafKind) && canonicalPath.at(-1) !== "recordId") ||
        (leafKind === "condition" && canonicalPath.at(-1) === "fieldId") ||
        (leafKind === "record_reference" && canonicalPath.at(-2) === "recordType");
    } else {
      const last = sourcePath.at(-1);
      resolved =
        sourceResolvesIdentity(sourcePath, positions) ||
        last === "shell" ||
        last === "view_permission" ||
        last === "use_permission" ||
        (sourcePath.includes("slot_orders") && typeof last === "number") ||
        (sourcePath.at(-2) === "props" && last === "id");
    }
    return {
      canonicalPath,
      origin: resolved ? ("resolved" as const) : ("source" as const),
      sourcePath,
      ...(resolved
        ? { ruleCode: RESOLUTION_RULE }
        : transformed
          ? { ruleCode: TRANSFORM_RULE }
          : {}),
    };
  });
}
