import {
  changeableByPeople,
  defaultSaveFlowSource,
  PLATFORM_BLOCK_RELEASE_IDENTITIES,
  sourcePageItems,
  sourcePageZones,
  standardPermissionKey,
  type SourceFlow,
  type SourceItem,
} from "@vortex/platform/schema";
import { applyStudioFlowCreate, type StudioFlowCreateCommand } from "./application-flow-create";
import { STUDIO_ROW_ACTION_EVENT_SETTING, studioRowActionEventId } from "./contextual-palette";
import { StoredCompositionRefusal, validateStoredZone } from "./stored-composition";
import {
  blockItem,
  emptyPageData,
  judged,
  blockRelease,
  placeNewPage,
  quoted,
  refuse,
  StructureRefusal,
  uniqueKey,
  type Page,
  type Source,
  type StructureRelease,
  type StudioStructureContext,
  type StudioStructureResult,
} from "./application-structure-common";

/**
 * The pages of one record type, written as ordinary explicit source in one draft edit: a list (a
 * records table on the record type's list query, a New button, rows that open the detail page), a
 * detail (the record's fields, an Edit button, a table of each record type that links to it), a
 * create or edit form (a form of field inputs, its submit bound to a Save flow of one
 * `record.save` step and an Open step), and a guided create form (the same, in steps).
 *
 * Nothing is generated at runtime: every block, query, flow, event and binding is written into the
 * draft by the one add-page, block, flow-create and binding paths, and can then be edited like any
 * other. A companion page that exists is linked both ways (adding the create form puts a New
 * button on the existing list); a companion that does not exist yet is named in the plan.
 */

export type StudioRecordPageKind = "list" | "detail" | "form_create" | "form_edit" | "guided";

export type StudioRecordPageCommand = Readonly<{
  kind: "add_record_page";
  /** The record type, qualified by its owned module: `module.key:record_key`. */
  recordType: string;
  type: StudioRecordPageKind;
  shellAlias: string | null;
  addToMenu: boolean;
}>;

export const studioRecordPageKinds: readonly Readonly<{
  kind: StudioRecordPageKind;
  label: string;
  hint: string;
}>[] = [
  {
    kind: "list",
    label: "List",
    hint: "A table of every record, with a New button; a row opens the record.",
  },
  {
    kind: "detail",
    label: "Detail",
    hint: "One record's fields, an Edit button and the records that link to it.",
  },
  {
    kind: "form_create",
    label: "Create form",
    hint: "A form that saves a new record, then opens it.",
  },
  {
    kind: "form_edit",
    label: "Edit form",
    hint: "A form that saves changes to a record, then opens it.",
  },
  {
    kind: "guided",
    label: "Guided create form",
    hint: "The create form, a few fields per step, then a check and save step.",
  },
];

type Module = Source["body"]["modules"][number];
type RecordType = Module["record_types"][number];
type Field = RecordType["fields"][number];
type Query = Module["queries"][number];

/** The record types a page can be made for: those of the modules this application owns. */
export const studioRecordPageChoices = (
  source: Source,
): readonly Readonly<{
  recordType: string;
  label: string;
  kinds: readonly StudioRecordPageKind[];
}>[] =>
  source.body.modules.flatMap((module) =>
    module.record_types.map((record) => ({
      recordType: `${module.key}:${record.key}`,
      label: `${record.plural_name} (${module.name})`,
      kinds: studioRecordPageKinds
        .filter(
          (entry) =>
            record.standard_actions.includes("read") &&
            (entry.kind === "form_create" || entry.kind === "guided"
              ? record.standard_actions.includes("create")
              : entry.kind === "form_edit"
                ? record.standard_actions.includes("update")
                : true),
        )
        .map((entry) => entry.kind),
    })),
  );

/** Field types an automatic field input draws; any other type has no input to put in a form. */
const inputTypes: ReadonlySet<string> = new Set([
  "text",
  "email_address",
  "phone_number",
  "web_address",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "link",
  "link_to_one_of_several",
  "table",
  "attachment",
]);
/** Field types a table column shows compactly. */
const columnTypes: ReadonlySet<string> = new Set([
  "reference_number",
  "text",
  "email_address",
  "web_address",
  "phone_number",
  "choice",
  "whole_number",
  "decimal_number",
  "money",
  "date",
  "date_time",
  "yes_no",
]);
const columnLimit = 5;
const fieldsPerStep = 3;
const pageSize = 40;

const lowerFirst = (name: string): string =>
  /^[A-Z][a-z]/.test(name) ? `${name[0]!.toLowerCase()}${name.slice(1)}` : name;
const listing = (labels: readonly string[]): string =>
  labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;

/** The record type, its owned module and its title field, or a located refusal. */
const resolveRecordType = (source: Source, reference: string) => {
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
  const standard = (action: "read" | "create" | "update") => {
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
  const permission = (target: Source, action: "read" | "create" | "update", details?: string[]) => {
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
      action === "read" ? "Open" : action === "create" ? "Open creation of" : "Open editing of";
    body.permissions.push({
      id: uniqueKey(
        `${record.key}_${action}`,
        "app_permission_",
        new Set(body.permissions.map((entry) => entry.id)),
        160,
      ),
      key,
      label: `${verb} ${record.plural_name.toLowerCase()}`.slice(0, 60),
      description: `Allows opening the ${action === "read" ? "" : `${action === "create" ? "creation" : "editing"} `}pages of ${record.plural_name.toLowerCase()} in ${module.name}.`,
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
type Resolved = ReturnType<typeof resolveRecordType>;

/** Every `id` in the source: a new block, query, step or flow alias is unique among them all. */
const takenIds = (source: Source): Set<string> => {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") names.add(record.id);
    Object.values(record).forEach(visit);
  };
  visit(source);
  return names;
};

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

/** A plan being written: the draft so far, the words describing it, and fresh aliases. */
type Plan = { source: Source; details: string[]; taken: Set<string> };
const freshAlias = (plan: Plan, base: string): string => {
  const alias = uniqueKey(base, "", plan.taken, 160);
  plan.taken.add(alias);
  return alias;
};

const release = (
  context: StudioStructureContext,
  identity: Readonly<{ blockId: string }>,
  what: string,
): StructureRelease =>
  blockRelease(context.catalogue, identity) ??
  refuse(`The block catalogue has no ${what} block, so the page was not added.`);

const field = (resolved: Readonly<{ module: Module; record: RecordType }>, entry: Field) =>
  `${resolved.module.key}:${resolved.record.key}.${entry.key}`;

/** The record type's list query: an existing unfiltered one that returns its title, or a new one. */
const listQuery = (
  plan: Plan,
  resolved: Resolved,
  columns: readonly Field[],
): Readonly<{ reference: string; select: readonly string[] }> => {
  const module = plan.source.body.modules.find((entry) => entry.key === resolved.module.key)!;
  const existing = module.queries.find(
    (query) =>
      query.record_type === resolved.record.key &&
      query.inputs.length === 0 &&
      query.filter === null &&
      query.group_by.length === 0 &&
      query.aggregates.length === 0 &&
      query.select.includes(resolved.title.key),
  );
  if (existing !== undefined) {
    plan.details.push(`It reads the existing query ${quoted(existing.label ?? existing.key)}.`);
    return { reference: `${module.key}:${existing.key}`, select: existing.select };
  }
  if (module.queries.length >= 100)
    refuse(
      `${quoted(module.name)} already holds 100 queries, so no list query can be added for ${resolved.record.plural_name.toLowerCase()}.`,
    );
  const key = uniqueKey(
    resolved.record.plural_name,
    "",
    new Set(module.queries.map((query) => query.key)),
    40,
  );
  const query = {
    id: freshAlias(plan, `qry_${key}`),
    key,
    label: resolved.record.plural_name,
    exposure: "private",
    record_type: resolved.record.key,
    inputs: [],
    select: columns.map((entry) => entry.key),
    filter: null,
    group_by: [],
    aggregates: [],
    sort: [{ field: resolved.title.key, direction: "ascending" }],
    page_size: pageSize,
    relationship_hops: 0,
  } as unknown as Query;
  module.queries.push(query);
  plan.details.push(
    `A new query ${quoted(resolved.record.plural_name)} in ${quoted(module.name)} returns every ${lowerFirst(resolved.record.name)}, sorted by ${resolved.title.label}.`,
  );
  return { reference: `${module.key}:${key}`, select: query.select };
};

/**
 * The fields a table of the record type shows: its numbers, its title, its first choice, then
 * compact fields, each one its read permission lets people read.
 */
const keyColumns = (record: RecordType, title: Field, readable: ReadonlySet<string>): Field[] => {
  const shown = record.fields.filter((entry) => readable.has(entry.key));
  const numbers = shown.filter((entry) => entry.type === "reference_number");
  const state = shown.find((entry) => entry !== title && entry.type === "choice");
  const rest = shown.filter(
    (entry) =>
      entry !== title &&
      entry !== state &&
      entry.type !== "reference_number" &&
      columnTypes.has(entry.type),
  );
  return [
    ...numbers.filter((entry) => entry !== title),
    title,
    ...(state === undefined ? [] : [state]),
    ...rest,
  ].slice(0, columnLimit);
};

/**
 * A table column of one field, visible by default, with its responsive priority: the numbers and
 * the title never hide, the first choice field (the record's state) stays on a phone, and the rest
 * hide on narrow screens.
 */
const tableColumns = (
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

/** Puts the page's blocks in its frame's first content area, judged as stored data and by what the area admits. */
const pageData = (
  context: StudioStructureContext,
  source: Source,
  shellAlias: string | null,
  items: SourceItem[],
  pageName: string,
) => {
  const data = emptyPageData(source, shellAlias);
  const shell = source.body.shells.find((entry) => entry.id === shellAlias);
  const area = shell?.content_slots[0];
  if (shell !== undefined && area === undefined)
    refuse(
      `The layout ${quoted(shell.name)} has no content area, so the page has nowhere to go. Choose another layout.`,
    );
  for (const item of items) {
    const group = context.catalogue.releases.find(
      (entry) =>
        String(entry.blockId) === item.props.vortex.block.block_id &&
        String(entry.releaseVersion) === item.props.vortex.block.release_version,
    )?.paletteGroup;
    if (
      area !== undefined &&
      (group === undefined || !area.allowed_child_categories.includes(group))
    )
      refuse(
        `The page ${quoted(pageName)} cannot use the layout ${quoted(shell!.name)}: its area ${quoted(area.label)} does not take ${group ?? "these"} blocks. Choose another layout.`,
      );
  }
  try {
    validateStoredZone(context.catalogue, { items });
  } catch (error) {
    // A refusal is the answer the preview shows, with its reason; anything else is a fault.
    if (!(error instanceof StoredCompositionRefusal)) throw error;
    refuse(
      `The page ${quoted(pageName)} could not be built from the block catalogue (${error.reason}), so nothing was changed.`,
    );
  }
  if (area === undefined) data.content = items;
  else (data.root.props as Record<string, unknown>)[area.id] = items;
  return data;
};

/** Creates one flow bound to a control, or binds one more control to it, by the one flow-create path. */
const flowCreate = (
  plan: Plan,
  command: StudioFlowCreateCommand,
  what: string,
): Readonly<{ id: string; eventId: string }> => {
  const result = applyStudioFlowCreate(judged(plan.source), command, null);
  if (result.kind === "refused") return refuse(`${what} could not be made: ${result.reason}`);
  plan.source = result.source;
  return result.binding!;
};

const textLiteral = (value: string) => ({
  kind: "literal" as const,
  literal: { type: "text" as const, value },
});
const navigateTask = (id: string, page: string, recordId?: string): SourceFlow["tasks"][number] =>
  ({
    id,
    type: "interface.navigate",
    version: "1.0.0",
    properties: {
      page: textLiteral(page),
      ...(recordId === undefined
        ? {}
        : { parameters: { kind: "map", entries: { record_id: recordId } } }),
    },
  }) as unknown as SourceFlow["tasks"][number];
const recordInput = (resolved: Resolved) =>
  ({
    record_id: { type: "record_reference", required: true, recordTypeIds: [resolved.qualified] },
  }) as unknown as SourceFlow["inputs"];

/** A flow bound to a row click or an action that opens one page, with the clicked or current record when given. */
const openFlow = (
  plan: Plan,
  controlAlias: string,
  event: "row_clicked" | "action",
  name: string,
  target: Page,
  resolved: Resolved | undefined,
): Readonly<{ id: string; eventId: string }> =>
  flowCreate(
    plan,
    {
      kind: "control",
      controlAlias,
      event,
      name,
      description: `Opens the page ${quoted(target.name)}${resolved === undefined ? "" : ` with the ${lowerFirst(resolved.record.name)}`}.`,
      inputs: resolved === undefined ? {} : recordInput(resolved),
      outputs: {},
      tasks: [
        navigateTask(
          "open_page",
          target.key,
          resolved === undefined ? undefined : "{{ inputs.record_id }}",
        ),
      ],
      bindingInputs:
        resolved === undefined ? {} : { record_id: { kind: "caller", name: "record_id" } },
    },
    `The flow ${quoted(name)}`,
  );

/** Finds a placed block by alias in the current draft, with the list that holds it. */
const placed = (
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
const openRows = (plan: Plan, tableAlias: string, resolved: Resolved, detail: Page): void => {
  openFlow(
    plan,
    tableAlias,
    "row_clicked",
    `Open ${lowerFirst(resolved.record.name)}`,
    detail,
    resolved,
  );
};

/** A button that opens a page, placed beside `besideAlias` (before it) or at `items`' start, and its flow. */
const openButton = (
  context: StudioStructureContext,
  plan: Plan,
  label: string,
  permission: string,
  target: Page,
  resolved: Resolved | undefined,
  place: Readonly<{ beside: string }> | Readonly<{ items: SourceItem[] }>,
): string => {
  const alias = freshAlias(plan, `button_${uniqueKey(label, "", new Set(), 40)}`);
  const button = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE, "button"),
    alias,
    { label, action_kind: "action", variant: "secondary" },
    {},
    { view_permission: permission },
  );
  if ("items" in place) place.items.unshift(button);
  else {
    const holder = placed(plan.source, place.beside);
    if (holder === undefined)
      return refuse(`The block ${quoted(place.beside)} is no longer in the draft.`);
    holder.siblings.splice(holder.siblings.indexOf(holder.item), 0, button);
  }
  openFlow(plan, alias, "action", label, target, resolved);
  return alias;
};

/** Every records table on a page that reads a query of the record type, including related records. */
const recordTables = (source: Source, page: Page, resolved: Pick<Resolved, "module" | "record">) =>
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
const linkTablesToDetail = (
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
const opensAny = (source: Source, page: Page, targets: readonly string[]): boolean => {
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

const addList = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
) => {
  const { record, title } = resolved;
  const wanted = keyColumns(record, title, resolved.readable);
  const query = listQuery(plan, resolved, wanted);
  const columns = wanted.filter((entry) => query.select.includes(entry.key));
  const tableAlias = freshAlias(plan, `table_${record.key}`);
  const table = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE, "records table"),
    tableAlias,
    {
      title: record.plural_name,
      empty_message: `There are no ${record.plural_name.toLowerCase()} yet.`,
      columns: tableColumns((entry) => field(resolved, entry), columns, title.key),
    },
    {},
    { query: query.reference },
  );
  const name = record.plural_name.slice(0, 60);
  const items = [table];
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "list",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "read", plan.details),
      query: query.reference,
    },
    pageData(context, plan.source, command.shellAlias, items, name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A page ${quoted(name)}, for people who can read ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  plan.details.push(`A records table shows ${listing(columns.map((entry) => entry.label))}.`);
  const phoneColumns = (table.props.columns as ReturnType<typeof tableColumns>).filter(
    (entry) => entry.priority !== "medium",
  );
  if (phoneColumns.length < columns.length)
    plan.details.push(`On a phone it shows ${listing(phoneColumns.map((entry) => entry.label))}.`);
  const found = companions(plan.source, resolved.qualified);
  if (found.detail !== undefined) {
    openRows(plan, tableAlias, resolved, found.detail);
    plan.details.push(`Clicking a row opens ${quoted(found.detail.name)}.`);
  } else
    plan.details.push(
      `Rows open nothing yet: ${record.plural_name.toLowerCase()} have no detail page. Adding one makes rows open it.`,
    );
  if (record.standard_actions.includes("create") && found.create !== undefined) {
    const label = `New ${lowerFirst(record.name)}`;
    openButton(
      context,
      plan,
      label,
      resolved.permission(plan.source, "create", plan.details),
      found.create,
      undefined,
      { beside: tableAlias },
    );
    plan.details.push(`A ${quoted(label)} button opens ${quoted(found.create.name)}.`);
  } else
    plan.details.push(
      `No New button yet: ${record.plural_name.toLowerCase()} have no create form. Adding one puts the button here.`,
    );
  return placedPage.page;
};

/**
 * A table of each owned record type that links to this one, on its own query of the linked
 * records, seen only by people who can open that record type's pages. A record type whose pages
 * cannot be made (no title field, no read permission, an unreadable link field) or whose module
 * has no room for one more query is named and left out; the rest of the page is still made.
 */
const relatedTables = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
): SourceItem[] =>
  plan.source.body.modules.flatMap((module) =>
    module.record_types.flatMap((child) =>
      child.relationships
        .filter(
          (relationship) =>
            relationship.to_record_type === resolved.qualified &&
            relationship.cardinality === "many_to_one",
        )
        .flatMap((relationship) => {
          let childResolved: Resolved;
          try {
            childResolved = resolveRecordType(plan.source, `${module.key}:${child.key}`);
          } catch (error) {
            if (!(error instanceof StructureRefusal)) throw error;
            plan.details.push(
              `${child.plural_name} link here but are not listed: ${error.message}`,
            );
            return [];
          }
          const link = child.fields.find((entry) => entry.key === relationship.from_field);
          if (link === undefined || !childResolved.readable.has(link.key)) {
            plan.details.push(
              `${child.plural_name} link here but are not listed: their link field is not readable under their read permission.`,
            );
            return [];
          }
          // The table's query keeps the records whose link is this record, and a query can only keep
          // records by a field people can filter by.
          if (!link.filterable) {
            if (context.publishedFields.has(`${module.key}:${child.key}.${link.key}`)) {
              plan.details.push(
                `${child.plural_name} link here but are not listed: their ${quoted(link.label)} field can't be filtered by, and a published version fixed that.`,
              );
              return [];
            }
            (link as { filterable: boolean }).filterable = true;
            plan.details.push(
              `People can now filter ${child.plural_name.toLowerCase()} by ${quoted(link.label)}, so a table can list those of one ${lowerFirst(resolved.record.name)}.`,
            );
          }
          const input = resolved.record.key;
          const select = [
            ...keyColumns(child, childResolved.title, childResolved.readable)
              .map((entry) => entry.key)
              .filter((key) => key !== link.key),
            link.key,
          ];
          const existing = module.queries.find(
            (query) =>
              query.record_type === child.key &&
              query.inputs.length === 1 &&
              query.inputs[0]!.key === input &&
              JSON.stringify(query.filter) ===
                JSON.stringify({ field: link.key, operator: "equals", parameter: input }),
          );
          let query = existing;
          if (query === undefined) {
            if (module.queries.length >= 100) {
              plan.details.push(
                `${child.plural_name} link here but are not listed: ${quoted(module.name)} already holds 100 queries.`,
              );
              return [];
            }
            const key = uniqueKey(
              `${child.plural_name} of ${resolved.record.name}`,
              "",
              new Set(module.queries.map((entry) => entry.key)),
              40,
            );
            query = {
              id: freshAlias(plan, `qry_${key}`),
              key,
              label: `${child.plural_name} of one ${lowerFirst(resolved.record.name)}`,
              exposure: "private",
              record_type: child.key,
              inputs: [
                {
                  key: input,
                  label: resolved.record.name,
                  required: true,
                  type: "record_reference",
                  record_types: [resolved.qualified],
                },
              ],
              select,
              filter: { field: link.key, operator: "equals", parameter: input },
              group_by: [],
              aggregates: [],
              sort: [{ field: childResolved.title.key, direction: "ascending" }],
              page_size: pageSize,
              relationship_hops: 0,
            } as unknown as Query;
            module.queries.push(query);
          }
          const shown = child.fields.filter(
            (entry) =>
              query.select.includes(entry.key) &&
              entry.key !== link.key &&
              childResolved.readable.has(entry.key),
          );
          const viewPermission = childResolved.permission(plan.source, "read", plan.details);
          plan.details.push(
            `A table of the ${child.plural_name.toLowerCase()} whose ${link.label} is this ${lowerFirst(resolved.record.name)}, showing ${listing(shown.map((entry) => entry.label))}, seen only by people who can open ${child.plural_name.toLowerCase()}${existing === undefined ? ` (a new query ${quoted(query.label ?? query.key)})` : ""}.`,
          );
          return [
            blockItem(
              release(
                context,
                PLATFORM_BLOCK_RELEASE_IDENTITIES.TABLE_BLOCK_RELEASE,
                "records table",
              ),
              freshAlias(plan, `table_${child.key}_of_${resolved.record.key}`),
              {
                title: child.plural_name,
                empty_message: `No ${child.plural_name.toLowerCase()} link to this ${lowerFirst(resolved.record.name)} yet.`,
                columns: tableColumns(
                  (entry) => `${module.key}:${child.key}.${entry.key}`,
                  shown,
                  childResolved.title.key,
                ),
                query_parameters: [{ input, source: "page_parameter", name: "record_id" }],
              },
              {},
              { query: `${module.key}:${query.key}`, view_permission: viewPermission },
            ),
          ];
        }),
    ),
  );

const addDetail = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
) => {
  const { record } = resolved;
  const shown = record.fields.filter(
    (entry) => entry.type !== "attachment" && resolved.readable.has(entry.key),
  );
  const detailAlias = freshAlias(plan, `detail_${record.key}`);
  const detail = blockItem(
    release(
      context,
      PLATFORM_BLOCK_RELEASE_IDENTITIES.RECORD_DETAIL_BLOCK_RELEASE,
      "record detail",
    ),
    detailAlias,
    {
      title: record.name,
      heading_source: "field",
      heading_field: field(resolved, resolved.title),
      [STUDIO_ROW_ACTION_EVENT_SETTING]: studioRowActionEventId(detailAlias),
      detail_fields: shown.map((entry) => ({ field: field(resolved, entry), label: entry.label })),
    },
    {},
  );
  const attachments = record.fields
    .filter((entry) => entry.type === "attachment" && resolved.readable.has(entry.key))
    .map((entry) =>
      blockItem(
        release(
          context,
          PLATFORM_BLOCK_RELEASE_IDENTITIES.ATTACHMENT_LIST_BLOCK_RELEASE,
          "attachment list",
        ),
        freshAlias(plan, `attachments_${record.key}_${entry.key}`),
        {
          title: entry.label.slice(0, 120),
          field: field(resolved, entry),
          empty_message: `Nothing is attached to ${entry.label} yet.`.slice(0, 200),
        },
        {},
      ),
    );
  const name = record.name.slice(0, 60);
  const related = relatedTables(context, plan, resolved);
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "detail",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "read", plan.details),
    },
    pageData(context, plan.source, command.shellAlias, [detail, ...attachments, ...related], name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  const page = placedPage.page;
  plan.details.unshift(
    `A page ${quoted(name)} that shows one ${lowerFirst(record.name)}, for people who can read ${record.plural_name.toLowerCase()}.`,
  );
  plan.details.splice(
    1,
    0,
    `A record detail shows ${listing(shown.map((entry) => entry.label))}.`,
    ...attachments.map(
      (item) => `An attachment list shows the files in ${String(item.props.title)}.`,
    ),
  );
  if (related.length === 0)
    plan.details.push(
      `No related tables: no record type of this application links to ${record.plural_name.toLowerCase()}.`,
    );
  const found = companions(plan.source, resolved.qualified);
  if (record.standard_actions.includes("update") && found.edit !== undefined) {
    openButton(
      context,
      plan,
      "Edit",
      resolved.permission(plan.source, "update", plan.details),
      found.edit,
      resolved,
      { beside: detailAlias },
    );
    plan.details.push(
      `An ${quoted("Edit")} button opens ${quoted(found.edit.name)} with this ${lowerFirst(record.name)}.`,
    );
  } else
    plan.details.push(
      `No Edit button yet: ${record.plural_name.toLowerCase()} have no edit form. Adding one puts the button here.`,
    );
  linkTablesToDetail(
    context,
    plan,
    resolved,
    page,
    plan.source.body.pages.map((entry) => entry.id),
  );
  for (const module of plan.source.body.modules) {
    for (const target of module.record_types) {
      const qualified = `${module.key}:${target.key}`;
      const targetDetail = companions(plan.source, qualified).detail;
      if (
        targetDetail === undefined ||
        qualified === resolved.qualified ||
        recordTables(plan.source, page, { module, record: target }).length === 0
      )
        continue;
      linkTablesToDetail(context, plan, resolveRecordType(plan.source, qualified), targetDetail, [
        page.id,
      ]);
    }
  }
  return page;
};

/**
 * The fields a form of the record type asks for: those people change (not produced by the
 * platform), that the create or update permission lets them change, and that a form input draws.
 * A required field left out by either rule refuses the form, naming the field and the rule.
 */
const formFields = (
  resolved: Resolved,
  mode: "create" | "update",
): Readonly<{ fields: Field[]; left: string[] }> => {
  const changeable = resolved.fieldAccess(mode, "changeable_fields");
  const editable = resolved.record.fields.filter((entry) => changeableByPeople(entry));
  for (const entry of editable.filter((candidate) => candidate.required)) {
    if (!changeable.has(entry.key))
      refuse(
        `${quoted(entry.label)} is required, and the ${mode} permission of ${quoted(resolved.record.name)} does not let people change it, so a form cannot save ${resolved.record.plural_name.toLowerCase()}. Add it to that permission's changeable fields in Access first.`,
      );
    if (!inputTypes.has(entry.type))
      refuse(
        `${quoted(entry.label)} is required, and no form input exists for ${entry.type.replaceAll("_", " ")} fields, so a form cannot save ${resolved.record.plural_name.toLowerCase()}. Make it optional or change its type in Data first.`,
      );
  }
  const fields = editable.filter(
    (entry) => changeable.has(entry.key) && inputTypes.has(entry.type),
  );
  if (fields.length === 0)
    refuse(
      `${resolved.record.plural_name} have no field people can fill in under the ${mode} permission, so a form has nothing to ask.`,
    );
  const left = [
    ...editable
      .filter((entry) => !changeable.has(entry.key))
      .map((entry) => `${entry.label} (not changeable under the ${mode} permission)`),
    ...editable
      .filter((entry) => changeable.has(entry.key) && !inputTypes.has(entry.type))
      .map((entry) => `${entry.label} (no form input draws it)`),
  ];
  return { fields, left };
};

/** The Save flow of a form: the one default `record.save` step, then opening the saved record's detail or the list. */
const saveFlowParts = (plan: Plan, resolved: Resolved, mode: "create" | "update") => {
  const base = defaultSaveFlowSource({
    id: "save",
    key: "save",
    recordType: resolved.qualified,
    mode,
    ownershipMode: resolved.record.ownership_mode as
      "none" | "organization_account" | "group" | "inherited",
  });
  const found = companions(plan.source, resolved.qualified);
  const after = found.detail ?? found.list[0];
  const recordId = mode === "create" ? "{{ outputs.save.record }}" : "{{ inputs.record }}";
  const tasks =
    after === undefined
      ? base.tasks
      : [
          ...base.tasks,
          navigateTask("open_page", after.key, after === found.detail ? recordId : undefined),
        ];
  plan.details.push(
    after === undefined
      ? `After saving, the form stays open: ${resolved.record.plural_name.toLowerCase()} have no detail or list page yet.`
      : `After saving, it opens ${quoted(after.name)}${after === found.detail ? ` with the saved ${lowerFirst(resolved.record.name)}` : ""}.`,
  );
  const bindingInputs = Object.fromEntries(
    Object.keys(base.inputs).map((name) => [name, { kind: "caller" as const, name }]),
  );
  return { inputs: base.inputs, outputs: base.outputs, tasks, bindingInputs };
};

/** A readable-width frame holding one form of field inputs and its submit button. */
const formBlock = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  title: string,
  fields: readonly Field[],
  submit: string,
) => {
  const formAlias = freshAlias(plan, `form_${uniqueKey(title, "", new Set(), 40)}`);
  const inputs = fields.map((entry) =>
    blockItem(
      release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.FIELD_INPUT_BLOCK_RELEASE, "field input"),
      freshAlias(plan, `input_${resolved.record.key}_${entry.key}`),
      { field: field(resolved, entry) },
      {},
    ),
  );
  const button = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE, "button"),
    freshAlias(plan, `submit_${formAlias}`),
    { label: submit, action_kind: "submit", variant: "primary" },
    {},
  );
  const form = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE, "form"),
    formAlias,
    { title },
    { content: [...inputs, button] },
  );
  const frame = blockItem(
    release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.CONTAINER_BLOCK_RELEASE, "container"),
    freshAlias(plan, `${formAlias}_frame`),
    { direction: "column", gap: "medium", padding: "medium", content_width: "readable" },
    { content: [form] },
  );
  return { frame, formAlias };
};

const addForm = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
  mode: "create" | "update",
) => {
  const { record } = resolved;
  const { fields, left } = formFields(resolved, mode);
  const name = `${mode === "create" ? "New" : "Edit"} ${lowerFirst(record.name)}`.slice(0, 60);
  const { frame, formAlias } = formBlock(context, plan, resolved, name, fields, "Save");
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "form",
      record_type: resolved.qualified,
      permission: resolved.permission(
        plan.source,
        mode === "create" ? "create" : "update",
        plan.details,
      ),
    },
    pageData(context, plan.source, command.shellAlias, [frame], name),
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A page ${quoted(name)}, for people who can ${mode === "create" ? "create" : "change"} ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  plan.details.push(
    `A form asks for ${listing(fields.map((entry) => entry.label))}, with a Save button.`,
  );
  if (left.length > 0) plan.details.push(`Left out: ${listing(left)}.`);
  const flowName =
    mode === "create"
      ? `Save new ${lowerFirst(record.name)}`
      : `Save ${lowerFirst(record.name)} changes`;
  const parts = saveFlowParts(plan, resolved, mode);
  flowCreate(
    plan,
    {
      kind: "control",
      controlAlias: formAlias,
      event: "form_submit",
      name: flowName,
      description:
        mode === "create"
          ? `Saves a new ${lowerFirst(record.name)} from ${quoted(name)}.`
          : `Saves the changes to one ${lowerFirst(record.name)} from ${quoted(name)}.`,
      inputs: parts.inputs,
      tasks: parts.tasks,
      outputs: parts.outputs,
      bindingInputs: parts.bindingInputs,
    },
    `The flow ${quoted(flowName)}`,
  );
  plan.details.push(
    `Submitting the form runs the flow ${quoted(flowName)}: one Save record step${parts.tasks.length > 1 ? " and one Open page step" : ""}.`,
  );
  linkFormBack(context, plan, resolved, placedPage.page, mode);
  return placedPage.page;
};

/** A new create form gets a New button on each list of the record type; a new edit form an Edit button on its detail page. */
const linkFormBack = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  page: Page,
  mode: "create" | "update",
) => {
  const found = companions(plan.source, resolved.qualified);
  if (mode === "create") {
    for (const listId of found.list.map((entry) => entry.id)) {
      // Each button's flow-create replaces the draft, so the list page is read again from the current one.
      const list = plan.source.body.pages.find((entry) => entry.id === listId)!;
      if (
        opensAny(
          plan.source,
          list,
          plan.source.body.pages
            .filter(
              (entry) =>
                entry.id !== page.id &&
                (entry.type === "form" || entry.type === "guided_form") &&
                "record_type" in entry &&
                entry.record_type === resolved.qualified,
            )
            .map((entry) => entry.key),
        )
      )
        continue;
      const table = recordTables(plan.source, list, resolved)[0];
      const label = `New ${lowerFirst(resolved.record.name)}`;
      const data = list.composition as unknown as Parameters<typeof sourcePageZones>[0];
      const zone =
        sourcePageZones(data).find(([, items]) => items.length > 0)?.[1] ??
        sourcePageZones(data).at(-1)![1];
      openButton(
        context,
        plan,
        label,
        resolved.permission(plan.source, "create", plan.details),
        page,
        undefined,
        table === undefined ? { items: zone } : { beside: table.props.id },
      );
      plan.details.push(`A ${quoted(label)} button on ${quoted(list.name)} opens this form.`);
    }
    return;
  }
  const detail = found.detail;
  if (detail === undefined) {
    plan.details.push(
      `Nothing opens this form yet: ${resolved.record.plural_name.toLowerCase()} have no detail page. Adding one puts an Edit button there.`,
    );
    return;
  }
  if (opensAny(plan.source, detail, [page.key])) return;
  const shown = sourcePageItems(detail.composition).find(
    (item) => String(item.type) === "platform.renderer.record_detail",
  );
  const data = detail.composition as unknown as Parameters<typeof sourcePageZones>[0];
  openButton(
    context,
    plan,
    "Edit",
    resolved.permission(plan.source, "update", plan.details),
    page,
    resolved,
    shown === undefined
      ? {
          items:
            sourcePageZones(data).find(([, items]) => items.length > 0)?.[1] ??
            sourcePageZones(data).at(-1)![1],
        }
      : { beside: shown.props.id },
  );
  plan.details.push(
    `An ${quoted("Edit")} button on ${quoted(detail.name)} opens this form with the shown ${lowerFirst(resolved.record.name)}.`,
  );
};

const addGuided = (
  context: StudioStructureContext,
  plan: Plan,
  resolved: Resolved,
  command: StudioRecordPageCommand,
) => {
  const { record } = resolved;
  const { fields, left } = formFields(resolved, "create");
  if (left.length > 0) plan.details.push(`Left out: ${listing(left)}.`);
  const name = `New ${lowerFirst(record.name)} step by step`.slice(0, 60);
  const chunks: Field[][] = [];
  for (let index = 0; index < fields.length; index += fieldsPerStep)
    chunks.push(fields.slice(index, index + fieldsPerStep));
  if (chunks.length + 1 > 20)
    refuse(`${record.plural_name} have too many fields for a guided form of at most 20 steps.`);
  const steps = [
    ...chunks.map((chunk, index) => ({
      id: freshAlias(plan, `step_${record.key}_${index + 1}`),
      name: `Step ${index + 1} of ${chunks.length + 1}`,
      summary: false,
      chunk,
    })),
    {
      id: freshAlias(plan, `step_${record.key}_check`),
      name: "Check and save",
      summary: true,
      chunk: [] as Field[],
    },
  ];
  const forms = steps.map((step) =>
    step.summary
      ? (() => {
          const formAlias = freshAlias(plan, `form_${record.key}_check`);
          const button = blockItem(
            release(context, PLATFORM_BLOCK_RELEASE_IDENTITIES.BUTTON_BLOCK_RELEASE, "button"),
            freshAlias(plan, `submit_${formAlias}`),
            { label: "Save", action_kind: "submit", variant: "primary" },
            {},
          );
          const form = blockItem(
            release(
              context,
              PLATFORM_BLOCK_RELEASE_IDENTITIES.FORM_CONTAINER_BLOCK_RELEASE,
              "form",
            ),
            formAlias,
            { title: `Check and save the ${lowerFirst(record.name)}` },
            { content: [button] },
          );
          return { frame: form, formAlias };
        })()
      : formBlock(
          context,
          plan,
          resolved,
          `${name}: ${step.name.toLowerCase()}`.slice(0, 120),
          step.chunk,
          "Continue",
        ),
  );
  const composition = {
    step_content: Object.fromEntries(
      steps.map((step, index) => [
        step.id,
        pageData(context, plan.source, command.shellAlias, [forms[index]!.frame], name),
      ]),
    ),
  };
  const placedPage = placeNewPage(
    plan.source,
    name,
    {
      type: "guided_form",
      record_type: resolved.qualified,
      permission: resolved.permission(plan.source, "create", plan.details),
      steps: steps.map(({ id, name: stepName, summary }) => ({ id, name: stepName, summary })),
    },
    composition,
    command.addToMenu,
  );
  plan.source = judged(placedPage.source);
  plan.details.unshift(
    `A guided page ${quoted(name)}, for people who can create ${record.plural_name.toLowerCase()}${command.addToMenu ? ", with a menu entry" : ""}.`,
  );
  for (const step of steps.filter((entry) => !entry.summary))
    plan.details.push(
      `${step.name} asks for ${listing(step.chunk.map((entry) => entry.label))}, with a Continue button.`,
    );
  plan.details.push("The last step, Check and save, shows the answers with a Save button.");
  const flowName = `Save new ${lowerFirst(record.name)}`;
  const parts = saveFlowParts(plan, resolved, "create");
  const summary = forms.at(-1)!.formAlias;
  flowCreate(
    plan,
    {
      kind: "control",
      controlAlias: summary,
      event: "form_submit",
      name: flowName,
      description: `Saves a new ${lowerFirst(record.name)} from ${quoted(name)}.`,
      inputs: parts.inputs,
      tasks: parts.tasks,
      outputs: parts.outputs,
      bindingInputs: parts.bindingInputs,
    },
    `The flow ${quoted(flowName)}`,
  );
  const flowKey = plan.source.body.flow_bindings.find(
    (binding) => binding.control === summary,
  )!.flow;
  for (const form of forms.slice(0, -1))
    flowCreate(
      plan,
      {
        kind: "bind",
        controlAlias: form.formAlias,
        event: "form_submit",
        flowKey,
        bindingInputs: parts.bindingInputs,
      },
      `The binding of ${quoted(name)}`,
    );
  plan.details.push(
    `Every step's form is bound to the flow ${quoted(flowName)}, which saves once, on Check and save.`,
  );
  linkFormBack(context, plan, resolved, placedPage.page, "create");
  return placedPage.page;
};

const kindWords: Readonly<Record<StudioRecordPageKind, string>> = {
  list: "list",
  detail: "detail page",
  form_create: "create form",
  form_edit: "edit form",
  guided: "guided create form",
};

/** Adds the page of one kind for a record type, with everything it needs, as one draft edit. */
export const addRecordPage = (
  context: StudioStructureContext,
  candidate: Source,
  command: StudioRecordPageCommand,
): StudioStructureResult => {
  const resolved = resolveRecordType(candidate, command.recordType);
  if (!studioRecordPageKinds.some((entry) => entry.kind === command.type))
    return refuse("Choose which page to add.");
  if (
    !studioRecordPageChoices(candidate)
      .find((choice) => choice.recordType === command.recordType)
      ?.kinds.includes(command.type)
  )
    return refuse(
      "This page needs actions the record type does not allow. Change Standard actions in Data first.",
    );
  if (command.addToMenu && (command.type === "detail" || command.type === "form_edit"))
    refuse(
      `${command.type === "detail" ? "A detail page" : "An edit form"} opens one ${lowerFirst(resolved.record.name)}, so it cannot be a menu entry. Add it without one.`,
    );
  const found = companions(candidate, resolved.qualified);
  const existing =
    command.type === "list"
      ? found.list[0]
      : command.type === "detail"
        ? found.detail
        : command.type === "form_create"
          ? found.create
          : command.type === "form_edit"
            ? found.edit
            : candidate.body.pages.find(
                (entry) =>
                  entry.type === "guided_form" &&
                  "record_type" in entry &&
                  entry.record_type === resolved.qualified,
              );
  if (existing !== undefined)
    refuse(
      `${resolved.record.plural_name} already have ${/^[aeiou]/.test(kindWords[command.type]) ? "an" : "a"} ${kindWords[command.type]}: ${quoted(existing.name)}. Open it in Structure and change it there.`,
    );
  const plan: Plan = { source: candidate, details: [], taken: takenIds(candidate) };
  const page =
    command.type === "list"
      ? addList(context, plan, resolved, command)
      : command.type === "detail"
        ? addDetail(context, plan, resolved, command)
        : command.type === "guided"
          ? addGuided(context, plan, resolved, command)
          : addForm(
              context,
              plan,
              resolved,
              command,
              command.type === "form_create" ? "create" : "update",
            );
  return {
    kind: "applied",
    source: judged(plan.source),
    select: { kind: "page", pageAlias: page.id },
    details: plan.details,
    message: `The ${kindWords[command.type]} ${quoted(page.name)} for ${resolved.record.plural_name.toLowerCase()} was added.`,
  };
};
