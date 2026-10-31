import {
  defaultDeleteFlowSource,
  type DefaultFlowAfter,
  defaultOpenFlowSource,
  defaultRestoreFlowSource,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  sourcePageZones,
  standardPermissionKey,
  type SourceItem,
} from "@vortex/platform/schema";
import { columnLimit, columnTypes, listing, lowerFirst } from "./application-record-page-kinds";
import { applyStudioFlowCreate } from "./application-flow-create";
import { bindDefault, flowParts, freshAlias, type Plan } from "./application-record-plan";
import { ensureStudioRecordQuery } from "./default-record-query";
import {
  blockItem,
  blockRelease,
  judged,
  quoted,
  refuse,
  uniqueKey,
  type Page,
  type Source,
  type StructureRelease,
  type StudioStructureContext,
} from "./application-structure-common";

/**
 * What every generated record page shares: the record type resolved with its title field and
 * permissions, the page's companions, and the pieces a list, a detail page and a form are made
 * of (a table column set, an open-page flow, a placed button, a row menu action).
 */

type Module = Source["body"]["modules"][number];
export type RecordType = Module["record_types"][number];
export type Field = RecordType["fields"][number];
export type Query = Module["queries"][number];

/** The record type, its owned module and its title field, or a located refusal. */
export const resolveRecordType = (source: Source, reference: string) => {
  const separator = reference.lastIndexOf(":");
  const module = source.body.modules.find((entry) => entry.key === reference.slice(0, separator));
  const record = module?.record_types.find((entry) => entry.key === reference.slice(separator + 1));
  if (module === undefined || record === undefined)
    return refuse(
      "That record type is not in a module this application owns. Choose one of the application's own record types.",
    );
  const title = record.fields.find((field) => field.key === record.title_field);
  if (title === undefined)
    return refuse(
      `The record type ${quoted(record.name)} has no title field, so its pages cannot name a record. Choose its title field in Data first.`,
    );
  /** The record type's standard permission for one action, or a located refusal. */
  const standard = (action: "read" | "create" | "update" | "soft_delete") => {
    if (!record.standard_actions.includes(action))
      return refuse(
        `${record.name} does not allow ${action}. Enable it under Standard actions in Data first.`,
      );
    const key = standardPermissionKey(module.key, record.key, action);
    return (
      module.permissions.find((entry) => entry.key === key) ??
      refuse(
        `The record type ${quoted(record.name)} has no standard ${action} permission in ${quoted(module.name)}, so no page can be made for it. Restore it in Data first.`,
      )
    );
  };
  /** The fields the standard permission for an action lets people read or change; every field when it sets no field policy. */
  const fieldAccess = (
    action: "read" | "create" | "update",
    access: "readable_fields" | "changeable_fields",
  ): ReadonlySet<string> => {
    const policy = standard(action).field_policy as
      Record<"readable_fields" | "changeable_fields", string[]> | undefined;
    return new Set(policy === undefined ? record.fields.map((entry) => entry.key) : policy[access]);
  };
  const readable = fieldAccess("read", "readable_fields");
  if (!readable.has(title.key))
    refuse(
      `${quoted(title.label)}, the title field of ${quoted(record.name)}, is not readable under its read permission, so its pages cannot name a record. Change that permission in Access first.`,
    );
  /**
   * The application permission that opens a page of the record type for one standard action:
   * `<application>.<module>.<record>.<action>` (the module in it, so two modules' record types of
   * the same key never share one), made when missing and then granted to each access group that
   * holds the record type's standard permission for that action at that moment. A page opens with
   * an application permission; the record permission still governs the records it shows.
   */
  const permission = (
    target: Source,
    action: "read" | "create" | "update" | "soft_delete",
    details?: string[],
  ) => {
    const recordPermission = standard(action).key;
    const body = target.body;
    const key = `${target.key}.${module.key.replaceAll(".", "_")}.${record.key}.${action}`;
    const existing = body.permissions.find((entry) => entry.key === key);
    if (existing !== undefined) {
      if (existing.action_kind !== "named" || existing.record_type !== undefined)
        refuse(
          `The application permission ${quoted(existing.label)} already uses the key ${key} for something other than opening pages. Rename it in Access first.`,
        );
      return key;
    }
    if (key.length > 120)
      refuse(
        `The page permission key for ${quoted(record.name)} would be longer than 120 characters. Use a shorter module or record type key.`,
      );
    if (body.permissions.length >= 100)
      refuse(
        "The application already declares 100 permissions, so no page permission can be added.",
      );
    const verb =
      action === "read"
        ? "Open"
        : action === "create"
          ? "Open creation of"
          : action === "update"
            ? "Open editing of"
            : "Delete";
    body.permissions.push({
      id: uniqueKey(
        `${record.key}_${action}`,
        "app_permission_",
        new Set(body.permissions.map((entry) => entry.id)),
        160,
      ),
      key,
      label: `${verb} ${record.plural_name.toLowerCase()}`.slice(0, 60),
      description:
        action === "soft_delete"
          ? `Allows deleting ${record.plural_name.toLowerCase()} in ${module.name} from their pages.`
          : `Allows opening the ${action === "read" ? "" : `${action === "create" ? "creation" : "editing"} `}pages of ${record.plural_name.toLowerCase()} in ${module.name}.`,
      action_kind: "named",
      named_action: uniqueKey(
        `${record.key}_${action}`,
        "",
        new Set(body.permissions.flatMap((entry) => entry.named_action ?? [])),
        40,
      ),
      administrative: false,
    });
    const granted = body.roles.filter((role) => {
      const held = role.permissions as string[];
      if (held.includes("*") || !held.includes(recordPermission)) return false;
      held.push(key);
      return true;
    });
    details?.push(
      `A new permission ${quoted(`${verb} ${record.plural_name.toLowerCase()}`)}, given now to ${granted.length === 0 ? "no access group" : listing(granted.map((role) => quoted(role.name)))} (those that can ${action} ${record.plural_name.toLowerCase()}). Access groups changed later get it in Access.`,
    );
    return key;
  };
  return {
    module,
    record,
    title,
    qualified: `${module.key}:${record.key}`,
    permission,
    readable,
    fieldAccess,
  };
};
export type Resolved = ReturnType<typeof resolveRecordType>;

/** Which existing page of the record type each companion kind is, judged by its type and its Save flow. */
export const companions = (source: Source, qualified: string) => {
  const pages = source.body.pages.filter(
    (page) => "record_type" in page && page.record_type === qualified,
  );
  const saveMode = (page: Page): "create" | "update" | undefined => {
    const controls = new Set(sourcePageItems(page.composition).map((item) => item.props.id));
    for (const binding of source.body.flow_bindings) {
      if (binding.event !== "form_submit" || !controls.has(binding.control)) continue;
      const flow = source.body.flows.find(
        (entry) => entry.key === binding.flow || entry.id === binding.flow,
      );
      const save = flow?.tasks.find((task) => task.type === "record.save");
      if (save !== undefined && "properties" in save)
        return "record" in (save.properties ?? {}) ? "update" : "create";
    }
    return undefined;
  };
  return {
    list: pages.filter((page) => page.type === "list"),
    detail: pages.find((page) => page.type === "detail"),
    create: pages.find(
      (page) =>
        (page.type === "form" || page.type === "guided_form") && saveMode(page) === "create",
    ),
    edit: pages.find((page) => page.type === "form" && saveMode(page) === "update"),
  };
};

export const release = (
  context: StudioStructureContext,
  identity: Readonly<{ blockId: string }>,
  what: string,
): StructureRelease =>
  blockRelease(context.catalogue, identity) ??
  refuse(`The block catalogue has no ${what} block, so the page was not added.`);

export const field = (resolved: Readonly<{ module: Module; record: RecordType }>, entry: Field) =>
  `${resolved.module.key}:${resolved.record.key}.${entry.key}`;

/** The record type's list query: an existing unfiltered one that returns its title, or a new one. */
export const listQuery = (
  plan: Plan,
  resolved: Resolved,
  columns: readonly Field[],
): Readonly<{ reference: string; select: readonly string[] }> => {
  const query = ensureStudioRecordQuery(
    plan.source,
    resolved.qualified,
    columns.map((entry) => entry.key),
  );
  plan.details.push(
    `${query.created ? "A new" : "The existing"} query returns all ${resolved.record.plural_name.toLowerCase()}, sorted by ${resolved.title.label}.`,
  );
  return query;
};

/**
 * The fields a table of the record type shows: its numbers, its title, its first choice, its links
 * to other records, then compact fields, each one its read permission lets people read.
 */
export const keyColumns = (
  record: RecordType,
  title: Field,
  readable: ReadonlySet<string>,
): Field[] => {
  const shown = record.fields.filter((entry) => readable.has(entry.key));
  const numbers = shown.filter((entry) => entry.type === "reference_number");
  const state = shown.find((entry) => entry !== title && entry.type === "choice");
  const links = shown.filter(
    (entry) => entry !== title && entry.type !== "reference_number" && entry.type === "link",
  );
  const rest = shown.filter(
    (entry) =>
      entry !== title &&
      entry !== state &&
      entry.type !== "reference_number" &&
      entry.type !== "link" &&
      columnTypes.has(entry.type),
  );
  return [
    ...numbers.filter((entry) => entry !== title),
    title,
    ...(state === undefined ? [] : [state]),
    ...links,
    ...rest,
  ].slice(0, columnLimit);
};

/**
 * A table column of one field, visible by default, with its responsive priority: the numbers and
 * the title never hide, the first choice field (the record's state) stays on a phone, and the rest
 * hide on narrow screens.
 */
export const tableColumns = (
  reference: (entry: Field) => string,
  columns: readonly Field[],
  titleKey: string,
) => {
  const state = columns.find((entry) => entry.type === "choice")?.key;
  return columns.map((entry) => ({
    field: reference(entry),
    label: entry.label,
    priority:
      entry.type === "reference_number" || entry.key === titleKey
        ? "essential"
        : entry.key === state
          ? "high"
          : "medium",
    visible: true,
  }));
};

/** A flow bound to a row click or an action that opens one page, with the clicked or current record when given. */
export const openFlow = (
  plan: Plan,
  controlAlias: string,
  event: "row_clicked" | "action",
  name: string,
  target: Page,
  resolved: Resolved | undefined,
) =>
  bindDefault(
    plan,
    controlAlias,
    event,
    defaultOpenFlowSource({
      id: "open",
      key: "open",
      description: `Opens the page ${quoted(target.name)}${resolved === undefined ? "" : ` with the ${lowerFirst(resolved.record.name)}`}.`,
      page: target.key,
      ...(resolved === undefined ? {} : { recordType: resolved.qualified }),
    }),
    name,
  );

/** Finds a placed block by alias in the current draft, with the list that holds it. */
export const placed = (
  source: Source,
  alias: string,
): Readonly<{ item: SourceItem; siblings: SourceItem[] }> | undefined => {
  const search = (
    items: SourceItem[],
  ): Readonly<{ item: SourceItem; siblings: SourceItem[] }> | undefined => {
    for (const item of items) {
      if (item.props.id === alias) return { item, siblings: items };
      for (const [key, value] of Object.entries(item.props))
        if (
          key !== "vortex" &&
          Array.isArray(value) &&
          value.every((entry) => entry !== null && typeof entry === "object" && "props" in entry)
        ) {
          const found = search(value as SourceItem[]);
          if (found !== undefined) return found;
        }
    }
    return undefined;
  };
  for (const page of source.body.pages)
    for (const data of "step_content" in page.composition
      ? Object.values(page.composition.step_content)
      : [page.composition])
      for (const [, items] of sourcePageZones(data as Parameters<typeof sourcePageZones>[0])) {
        const found = search(items);
        if (found !== undefined) return found;
      }
  return undefined;
};

/** Sets a row click on a records table: its row_click setting names the event the binding declares. */
export const openRows = (
  plan: Plan,
  tableAlias: string,
  resolved: Resolved,
  detail: Page,
): void => {
  openFlow(
    plan,
    tableAlias,
    "row_clicked",
    `Open ${lowerFirst(resolved.record.name)}`,
    detail,
    resolved,
  );
};

/** A button placed before the block in `place.beside`, or at the start of `place.items`, seen only with `permission`. */
export const placeButton = (
  context: StudioStructureContext,
  plan: Plan,
  label: string,
  permission: string,
  place: Readonly<{ beside: string }> | Readonly<{ items: SourceItem[] }>,
  variant: "primary" | "danger" = "primary",
): string => {
  const alias = freshAlias(plan, `button_${uniqueKey(label, "", new Set(), 40)}`);
  const button = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE, "button"),
    alias,
    { label, action_kind: "action", variant },
    {},
    { view_permission: permission },
  );
  if ("items" in place) place.items.unshift(button);
  else {
    const holder = placed(plan.source, place.beside);
    if (holder === undefined)
      return refuse(`The block ${quoted(place.beside)} is no longer in the draft.`);
    const preceding = holder.siblings[holder.siblings.indexOf(holder.item) - 1];
    const header =
      holder.item.type === "platform.renderer.heading" ||
      holder.item.type === "platform.renderer.record_detail"
        ? holder.item
        : holder.item.type === "platform.renderer.table" &&
            preceding?.type === "platform.renderer.heading"
          ? preceding
          : undefined;
    if (header === undefined)
      holder.siblings.splice(holder.siblings.indexOf(holder.item), 0, button);
    else {
      if (!Array.isArray(header.props.actions)) header.props.actions = [];
      (header.props.actions as SourceItem[]).push(button);
    }
  }
  return alias;
};

/** A button that opens a page, placed before the block in `place.beside` or at the start of `place.items`, and its flow. */
export const openButton = (
  context: StudioStructureContext,
  plan: Plan,
  label: string,
  permission: string,
  target: Page,
  resolved: Resolved | undefined,
  place: Readonly<{ beside: string }> | Readonly<{ items: SourceItem[] }>,
): string => {
  const alias = placeButton(context, plan, label, permission, place);
  openFlow(plan, alias, "action", label, target, resolved);
  return alias;
};

/** The flow that brings a deleted record of the type back: made once, started by the Undo of a Deleted message. */
export const restoreFlowKey = (plan: Plan, resolved: Resolved): string => {
  const existing = plan.source.body.flows.find((flow) =>
    flow.tasks.some(
      (task) =>
        task.type === "record.restore" &&
        "properties" in task &&
        JSON.stringify(task.properties).includes(`"${resolved.qualified}"`),
    ),
  );
  if (existing !== undefined) return existing.key;
  const name = `Restore ${lowerFirst(resolved.record.name)}`;
  const flow = defaultRestoreFlowSource({
    id: "restore",
    key: "restore",
    recordType: resolved.qualified,
    recordName: lowerFirst(resolved.record.name),
    after: { kind: "refresh" },
  });
  const result = applyStudioFlowCreate(
    judged(plan.source),
    {
      kind: "flow",
      ...flowParts(flow, name),
      description: `Brings a deleted ${lowerFirst(resolved.record.name)} back.`,
    },
    null,
  );
  if (result.kind === "refused")
    return refuse(`The flow ${quoted(name)} could not be made: ${result.reason}`);
  plan.source = result.source;
  return result.selection.flowAlias;
};

/** The Delete flow of the type that ends on `after`, bound to `controlAlias`. */
export const bindDelete = (
  plan: Plan,
  resolved: Resolved,
  controlAlias: string,
  event: "action" | "row_action",
  after: DefaultFlowAfter,
  extra: Readonly<{
    rowActionLabel?: string;
    rowActionCapability?: "update" | "delete" | "restore";
  }> = {},
) => {
  const restoreFlow = restoreFlowKey(plan, resolved);
  return bindDefault(
    plan,
    controlAlias,
    event,
    defaultDeleteFlowSource({
      id: "delete",
      key: "delete",
      description: `Deletes one ${lowerFirst(resolved.record.name)} after asking, and offers Undo.`,
      recordType: resolved.qualified,
      recordName: lowerFirst(resolved.record.name),
      restoreFlow,
      after,
    }),
    `Delete ${lowerFirst(resolved.record.name)}`,
    extra,
  );
};

/** Every records table on a page that reads a query of the record type, including related records. */
export const recordTables = (
  source: Source,
  page: Page,
  resolved: Pick<Resolved, "module" | "record">,
) =>
  sourcePageItems(page.composition).filter((item) => {
    const query = item.props.vortex.query;
    if (String(item.type) !== "platform.renderer.table" || query === undefined) return false;
    const owner = source.body.modules.find((entry) => entry.key === resolved.module.key);
    return (
      owner?.queries.some(
        (entry) =>
          `${owner.key}:${entry.key}` === query && entry.record_type === resolved.record.key,
      ) === true
    );
  });

/** Connect tables through the same row flow, whichever companion page was added first. */
export const linkTablesToDetail = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  detail: Page,
  pageIds: readonly string[],
) => {
  for (const pageId of pageIds) {
    const page = plan.source.body.pages.find((entry) => entry.id === pageId)!;
    for (const table of recordTables(plan.source, page, resolved)) {
      if (table.props.row_click !== undefined) continue;
      const tableRelease = context.catalogue.releases.find(
        (entry) =>
          String(entry.blockId) === table.props.vortex.block.block_id &&
          String(entry.releaseVersion) === table.props.vortex.block.release_version,
      );
      if (tableRelease?.properties.some((entry) => entry.key === "row_click") !== true) {
        plan.details.push(
          `The table on ${quoted(page.name)} cannot open records. Choose a records table that supports opening rows.`,
        );
        continue;
      }
      openRows(plan, table.props.id, resolved, detail);
      plan.details.push(
        `Rows of the ${resolved.record.plural_name.toLowerCase()} table on ${quoted(page.name)} now open ${quoted(detail.name)}.`,
      );
    }
  }
};

/** Whether any control on the page opens one of the given pages. */
export const opensAny = (source: Source, page: Page, targets: readonly string[]): boolean => {
  const controls = new Set(sourcePageItems(page.composition).map((item) => item.props.id));
  return source.body.flow_bindings.some(
    (binding) =>
      controls.has(binding.control) &&
      source.body.flows.some(
        (flow) =>
          (flow.key === binding.flow || flow.id === binding.flow) &&
          flow.tasks.some(
            (task) =>
              task.type === "interface.navigate" &&
              targets.includes(
                String(
                  (task.properties as { page?: { literal?: { value?: unknown } } }).page?.literal
                    ?.value,
                ),
              ),
          ),
      ),
  );
};

/** Whether a control of the page already starts a flow that deletes the record type's records. */
export const deletesFrom = (source: Source, page: Page, qualified: string): boolean => {
  const controls = new Set(sourcePageItems(page.composition).map((item) => item.props.id));
  const started = new Set(
    source.body.flow_bindings.filter((b) => controls.has(b.control)).map((b) => b.flow),
  );
  return source.body.flows.some((flow) => {
    const tasks = JSON.stringify(flow.tasks);
    return started.has(flow.key) && tasks.includes('"record.delete"') && tasks.includes(qualified);
  });
};

/**
 * A Delete button on the record type's detail page, once the type allows delete and has a list to
 * go back to. Whichever of the two pages is made second adds it.
 */
export const ensureDetailDelete = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
) => {
  const found = companions(plan.source, resolved.qualified);
  const list = found.list[0];
  if (
    !resolved.record.standard_actions.includes("soft_delete") ||
    found.detail === undefined ||
    list === undefined ||
    deletesFrom(plan.source, found.detail, resolved.qualified)
  )
    return;
  const shown = sourcePageItems(found.detail.composition).find(
    (item) => String(item.type) === "platform.renderer.record_detail",
  );
  const data = found.detail.composition as unknown as Parameters<typeof sourcePageZones>[0];
  const alias = placeButton(
    context,
    plan,
    "Delete",
    resolved.permission(plan.source, "soft_delete", plan.details),
    shown === undefined
      ? {
          items:
            sourcePageZones(data).find(([, items]) => items.length > 0)?.[1] ??
            sourcePageZones(data).at(-1)![1],
        }
      : { beside: shown.props.id },
    "danger",
  );
  bindDelete(plan, resolved, alias, "action", {
    kind: "navigate",
    page: list.key,
    withRecord: false,
  });
  plan.details.push(
    `A ${quoted("Delete")} button on ${quoted(found.detail.name)} asks to confirm, deletes the ${lowerFirst(resolved.record.name)} and opens ${quoted(list.name)}, with an Undo.`,
  );
};

