import type { ApplicationSourceDocument, DefinitionProvenanceEntry } from "../../schema";
import { canonicalJson } from "../canonical-json-definition";
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

/** Theme token values keep their meaning; only multi-word keys change case. */
export const applicationThemeValueTargets = (
  sourcePath: Path,
  sourceValueRoot: Path,
  canonicalRoot: Path,
): Path[] => {
  const suffix = sourcePath.slice(sourceValueRoot.length);
  const mapped = suffix.map((segment) =>
    typeof segment === "string"
      ? ((
          {
            size_rem: "sizeRem",
            line_height: "lineHeight",
            width_rem: "widthRem",
            color_token: "colorToken",
            asset_id: "assetId",
          } as Readonly<Record<string, string>>
        )[segment] ?? segment)
      : segment,
  );
  return [[...canonicalRoot, ...mapped]];
};

/** Authored layout data: a shell's layout or a page's composition. */
export const isApplicationCompositionSourcePath = (path: Path): boolean =>
  path[0] === "body" &&
  typeof path[2] === "number" &&
  ((path[1] === "shells" && path[3] === "layout") ||
    (path[1] === "pages" && path[3] === "composition"));

type Target = Readonly<{ path: Path; setting: boolean }>;

const recordTypeLeaves: Path[] = [
  ["recordType", "state"],
  ["recordType", "moduleRootId"],
  ["recordType", "recordTypeId"],
];

/** The canonical leaf each value kind keeps its authored plain value in. */
const settingValueLeaf: Readonly<Record<string, string>> = {
  asset_reference: "assetId",
  icon: "iconKey",
  theme_token: "tokenKey",
  field_reference: "fieldId",
  relationship_reference: "relationshipId",
  action_reference: "actionKey",
  page_reference: "pageId",
  query_reference: "queryId",
  pipeline_reference: "pipelineId",
};

/** Kinds whose authored plain value names an identity that compilation resolves. */
const resolvedSettingKinds: ReadonlySet<string> = new Set([
  "action_reference",
  "field_reference",
  "page_reference",
  "pipeline_reference",
  "query_reference",
  "record_type_reference",
  "relationship_reference",
  "theme_token",
]);

/** The canonical leaves, relative to one canonical setting value, of one plain authored leaf. */
const settingLeafTargets = (value: unknown, rest: Path): Path[] => {
  const typed = asObject(value);
  switch (typed.kind) {
    case "group": {
      const key = String(rest[0]);
      return settingLeafTargets(asObject(typed.properties)[key], rest.slice(1)).map((path) => [
        "properties",
        key,
        ...path,
      ]);
    }
    case "list": {
      const index = rest[0];
      if (typeof index !== "number")
        return fail("vortex.definition.invalid_compilation_output", "invalid_value");
      return settingLeafTargets((typed.items as unknown[])[index], rest.slice(1)).map((path) => [
        "items",
        index,
        ...path,
      ]);
    }
    case "rich_text":
      return [["value", ...rest]];
    case "record_reference":
      return rest[0] === "record_id" ? [["recordId"]] : recordTypeLeaves;
    case "record_type_reference":
      return recordTypeLeaves;
    default:
      return [[settingValueLeaf[String(typed.kind)] ?? "value"]];
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
      if (field === "theme_overrides" && typeof suffix[3] === "string")
        return plain(
          applicationThemeValueTargets(
            sourcePath,
            [...itemPath, "props", "vortex", "theme_overrides", suffix[3]],
            [...canonicalVortex, "themeOverrides", suffix[3]],
          ),
        );
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
    if (prop !== "settings" && Array.isArray(compiledProps[prop])) {
      root = [...itemPath, "props", prop];
      zone = {
        items: [...placement, "props", prop],
        order: slotOrderPath(canonicalVortex, prop),
      };
      const orders = vortex.slot_orders === undefined ? {} : asObject(vortex.slot_orders);
      slotOrder = orders[prop] === undefined ? undefined : asObject(orders[prop]);
      continue;
    }
    const setting = asObject(compiledProps.settings)[prop];
    if (setting === undefined) return undefined;
    return settingLeafTargets(setting, suffix.slice(2)).map((path) => ({
      path: [...placement, "props", "settings", prop, ...path],
      setting: true,
    }));
  }
}

/** The authored zone a page-data leaf belongs to and the compiled zone it becomes. */
function pageDataTargets(
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
 * their identities, and a plain setting value lands in its typed canonical value. A text setting
 * keeps its value unchanged except a table behaviour's event alias, which resolves to the exact
 * event identity its flow binding uses.
 */
export function applicationCompositionProvenance(
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
    targets = pageDataTargets(source, canonical, sourcePath, dataRoot, canonicalData, resolution);
  }
  if (targets === undefined || targets.length === 0)
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  const sourceValue = valueAtPath(source, sourcePath);
  const sourceObject = source as unknown as JsonObject;
  return targets.map(({ path, setting }) => {
    const canonicalPath = setting
      ? path
      : applicationTypedValueTarget(sourceObject, sourcePath, path, canonicalLeafSet, positions);
    if (!canonicalLeafSet.has(pathKey(canonicalPath)))
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    const canonicalValue = valueAtPath(canonical, canonicalPath);
    const transformed = canonicalJson(sourceValue) !== canonicalJson(canonicalValue);
    let resolved: boolean;
    if (setting) {
      const leafKind = settingKindAt(canonical, canonicalPath);
      const eventReference =
        canonicalPath.at(-2) === "event_id" &&
        canonicalPath.at(-1) === "value" &&
        canonicalValue === resolution.id(source.key, "event", String(sourceValue), "content");
      const referenceLeaf =
        settingValueLeaf[leafKind] !== undefined ||
        leafKind === "record_reference" ||
        leafKind === "record_type_reference";
      // A text, number, choice or rich-text value never changes; only references resolve.
      if (transformed && !eventReference && !referenceLeaf)
        fail("vortex.definition.invalid_compilation_output", "invalid_value");
      resolved =
        eventReference ||
        (resolvedSettingKinds.has(leafKind) && canonicalPath.at(-1) !== "recordId") ||
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

/** The kind of the innermost typed setting value holding one canonical setting leaf. */
const settingKindAt = (canonical: unknown, canonicalPath: Path): string => {
  let at = canonicalPath.lastIndexOf("settings") + 2;
  let value = asObject(valueAtPath(canonical, canonicalPath.slice(0, at)));
  while (
    (value.kind === "group" && canonicalPath[at] === "properties") ||
    (value.kind === "list" && canonicalPath[at] === "items")
  ) {
    at += 2;
    value = asObject(valueAtPath(canonical, canonicalPath.slice(0, at)));
  }
  return String(value.kind);
};
