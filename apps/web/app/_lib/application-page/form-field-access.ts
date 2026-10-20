import {
  type InstalledRuntimeContext,
  type ProtectedQueryRow,
  decideRecordTypeFieldIds,
  runtimePreviewOf,
} from "@vortex/platform/server";
import {
  type FlowTask,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  flowTaskChildLists,
  isRecord,
  sameId,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";
import { type collectPlacements, isEditFieldPlacement } from "./placement-helpers";
import type { ModuleField } from "./types";

type Placement = ReturnType<typeof collectPlacements>[number];
type RecordType =
  InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number];
type Flow = InstalledRuntimeContext["releaseSet"]["application"]["content"]["flows"][number];

/**
 * How one page shows the fields of its forms to this viewer. A page lists its fields once, in its
 * definition; the viewer's field policy decides each one when the page is read: a field the viewer
 * cannot read (or, on a create form, cannot set) is left out, a field they read but cannot change
 * is shown read-only, and a form whose required field they cannot fill in is refused, naming it.
 * This only narrows what is shown. Every save is still decided by the record writer.
 */
export type FormFieldAccess = Readonly<{
  /** Field placements left out of the page, by lowercase placement identity. */
  omitted: ReadonlySet<string>;
  /** Field placements shown read-only, by lowercase placement identity. */
  readOnly: ReadonlySet<string>;
  /** Refused forms, by lowercase placement identity, with the reason that names the field. */
  refused: ReadonlyMap<string, string>;
}>;

/** The record field one form field placement edits: by its field reference, else by its name. */
export const formFieldOf = (
  placement: Readonly<{ settings: Readonly<Record<string, unknown>> }>,
  recordType: RecordType,
): ModuleField | undefined => {
  const fieldSetting = placement.settings.field;
  const nameSetting = placement.settings.name;
  return recordType.fields.find((candidate) =>
    isRecord(fieldSetting) &&
    fieldSetting.kind === "field_reference" &&
    typeof fieldSetting.fieldId === "string"
      ? sameId(String(candidate.fieldId), fieldSetting.fieldId)
      : isRecord(nameSetting) &&
        nameSetting.kind === "text" &&
        typeof nameSetting.value === "string" &&
        candidate.key === nameSetting.value,
  );
};

/** The record types a flow creates with a `record.save` that names no existing record. */
export const flowCreatedRecordTypeIds = (
  flows: readonly Flow[],
  flowId: string,
): ReadonlySet<string> => {
  const flowsById = new Map(flows.map((flow) => [String(flow.id).toLowerCase(), flow] as const));
  const created = new Set<string>();
  const visited = new Set<string>();
  const visitFlow = (id: string): void => {
    if (visited.has(id.toLowerCase())) return;
    visited.add(id.toLowerCase());
    const flow = flowsById.get(id.toLowerCase());
    if (flow === undefined) return;
    const visitTasks = (tasks: readonly FlowTask[]): void => {
      for (const task of tasks) {
        const properties = "properties" in task ? task.properties : undefined;
        const recordType = properties?.record_type;
        if (
          task.type === "record.save" &&
          properties !== undefined &&
          !Object.hasOwn(properties, "record") &&
          isRecord(recordType) &&
          recordType.kind === "literal" &&
          isRecord(recordType.literal) &&
          recordType.literal.type === "text" &&
          typeof recordType.literal.value === "string"
        )
          created.add(recordType.literal.value.toLowerCase());
        if (task.type === "run_flow")
          visitFlow(String((task as Extract<FlowTask, { type: "run_flow" }>).flowId));
        for (const child of flowTaskChildLists(task)) visitTasks(child.tasks);
      }
    };
    visitTasks(flow.tasks);
    visitTasks(flow.errors);
    visitTasks(flow.finally);
  };
  visitFlow(flowId);
  return created;
};

/**
 * The fields this viewer may set when they create a record of one type. A draft preview gives its
 * builder every field, so it narrows nothing (`undefined`).
 */
export const readCreatableFieldIds = async (
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  context: InstalledRuntimeContext,
  recordTypeId: string,
): Promise<
  | Readonly<{ kind: "available"; fieldIds: ReadonlySet<string> | undefined }>
  | Readonly<{ kind: "temporarily_unavailable" }>
  | Readonly<{ kind: "unavailable" }>
> => {
  if (runtimePreviewOf(context) !== undefined) return { kind: "available", fieldIds: undefined };
  const decided = await humanOrganizationRequests().run(session, selection, (transaction, scope) =>
    decideRecordTypeFieldIds(transaction, scope, context, recordTypeId, "create"),
  );
  if (decided.kind !== "available") return decided;
  return { kind: "available", fieldIds: decided.value };
};

const isEmptyValue = (value: JsonValue | undefined): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/** The label a form shows for one field: its placement's own label, else the field's. */
const fieldLabel = (placement: Placement, field: ModuleField): string => {
  const label = placement.settings.label;
  return isRecord(label) &&
    label.kind === "text" &&
    typeof label.value === "string" &&
    label.value.trim() !== ""
    ? label.value.trim()
    : field.label;
};

const isRequired = (placement: Placement, field: ModuleField): boolean => {
  const required = placement.settings.required;
  return (
    field.required || (isRecord(required) && required.kind === "boolean" && required.value === true)
  );
};

/** The viewer's access, decided for each form of the page's record type. */
export const decideFormFieldAccess = (
  input: Readonly<{
    placements: readonly Placement[];
    recordType: RecordType;
    /** Forms that edit the page subject, with the subject as the viewer read it. */
    editForms: ReadonlyMap<string, ProtectedQueryRow>;
    /** Forms that create a record of the page's type, with the fields the viewer may set. */
    createForms: ReadonlyMap<string, ReadonlySet<string> | undefined>;
  }>,
): FormFieldAccess => {
  const omitted = new Set<string>();
  const readOnly = new Set<string>();
  const refused = new Map<string, string>();
  const refuse = (formId: string, placement: Placement, field: ModuleField): void => {
    if (!refused.has(formId))
      refused.set(
        formId,
        `You can't fill in ${fieldLabel(placement, field)}, which this form needs, so you can't use it.`,
      );
  };
  for (const placement of input.placements) {
    const formId = placement.formId?.toLowerCase();
    if (formId === undefined || formId === placement.placementId.toLowerCase()) continue;
    if (!isEditFieldPlacement(placement)) continue;
    const field = formFieldOf(placement, input.recordType);
    if (field === undefined) continue;
    const fieldId = String(field.fieldId).toLowerCase();
    const id = placement.placementId.toLowerCase();
    const subject = [...input.editForms].find(([candidate]) => candidate.toLowerCase() === formId);
    if (subject !== undefined) {
      const row = subject[1];
      const values: Readonly<Record<string, JsonValue>> = row.values;
      const valueKey = Object.keys(values).find((key) => sameId(key, fieldId));
      if (valueKey === undefined) {
        omitted.add(id);
        continue;
      }
      const changeable =
        row.capabilities?.changeableFieldIds.some((candidate) => sameId(candidate, fieldId)) ===
        true;
      if (changeable) continue;
      readOnly.add(id);
      if (isRequired(placement, field) && isEmptyValue(values[valueKey]))
        refuse(formId, placement, field);
      continue;
    }
    const create = [...input.createForms].find(([candidate]) => candidate.toLowerCase() === formId);
    if (create === undefined) continue;
    const creatable = create[1];
    if (creatable === undefined || creatable.has(fieldId)) continue;
    // A create form has no stored value to show, so a field the viewer cannot set is left out.
    omitted.add(id);
    if (isRequired(placement, field)) refuse(formId, placement, field);
  }
  return { omitted, readOnly, refused };
};

type JsonObject = Record<string, unknown>;

/** One item list without the omitted items, read-only items marked, slot orders kept in step. */
const applyToItems = (items: unknown, access: FormFieldAccess): unknown[] =>
  (Array.isArray(items) ? items : []).flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.props)) return [candidate];
    const props = candidate.props;
    const id = String(props.id).toLowerCase();
    if (access.omitted.has(id)) return [];
    if (access.readOnly.has(id)) props.disabled = true;
    const vortex = isRecord(props.vortex) ? props.vortex : undefined;
    const orders = vortex !== undefined && isRecord(vortex.slotOrders) ? vortex.slotOrders : {};
    for (const key of Object.keys(orders)) {
      const children = applyToItems(props[key], access);
      props[key] = children;
      orders[key] = keptOrder(orders[key], children);
    }
    return [candidate];
  });

const keptOrder = (order: unknown, items: readonly unknown[]): JsonObject => {
  const kept = new Set(
    items.flatMap((item) =>
      isRecord(item) && isRecord(item.props) ? [String(item.props.id)] : [],
    ),
  );
  return Object.fromEntries(
    Object.entries(isRecord(order) ? order : {}).map(([breakpoint, ids]) => [
      breakpoint,
      (Array.isArray(ids) ? ids : []).filter((entry) => kept.has(String(entry))),
    ]),
  );
};

const applyToLayout = (layout: unknown, access: FormFieldAccess): void => {
  if (!isRecord(layout)) return;
  layout.content = applyToItems(layout.content, access);
  const root = isRecord(layout.root) && isRecord(layout.root.props) ? layout.root.props : undefined;
  const vortex = root !== undefined && isRecord(root.vortex) ? root.vortex : undefined;
  if (vortex !== undefined && isRecord(vortex.slotOrders))
    vortex.slotOrders.content = keptOrder(vortex.slotOrders.content, layout.content as unknown[]);
};

/** Applies the decided access to the viewer's own copy of the projected page, in place. */
export const applyFormFieldAccess = (
  page: Record<string, unknown>,
  access: FormFieldAccess,
): void => {
  if (access.omitted.size === 0 && access.readOnly.size === 0) return;
  const composition = page.composition;
  if (!isRecord(composition)) return;
  if (isRecord(composition.stepContent))
    for (const layout of Object.values(composition.stepContent)) applyToLayout(layout, access);
  else applyToLayout(composition, access);
};
