import {
  type InstalledRuntimeContext,
  type PageSubjectReadResult,
  type PageSubjectType,
  type ProtectedQueryRow,
  FORM_CONTAINER_BLOCK_RELEASE,
  decideRecordTypeCreatableFieldIds,
  formFieldOf,
  runtimePreviewOf,
} from "@vortex/platform/server";
import {
  type FlowTask,
  type IdentitySession,
  type JsonValue,
  type OrganizationSelectionCandidate,
  type PageDefinition,
  flowTaskChildLists,
  isRecord,
  sameId,
} from "@vortex/platform/schema";
import { humanOrganizationRequests } from "../server-composition";
import { collectPlacements, isEditFieldPlacement } from "./placement-helpers";
import type { ApplicationPageInternalResult, ModuleField } from "./types";

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
type FormFieldAccess = Readonly<{
  /** Field placements left out of the page, by lowercase placement identity. */
  omitted: ReadonlySet<string>;
  /** Field placements shown read-only, by lowercase placement identity. */
  readOnly: ReadonlySet<string>;
  /** Refused forms, by lowercase placement identity, with the reason that names the field. */
  refused: ReadonlyMap<string, string>;
}>;

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
const readCreatableFieldIds = async (
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
    decideRecordTypeCreatableFieldIds(transaction, scope, context, recordTypeId),
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
const decideFormFieldAccess = (
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

/**
 * Decides, once and before any placement is read, how the page's forms show each field to this
 * viewer (see FormFieldAccess), and applies it to the page. Returns the page's edit forms (those
 * that submit its own record), a form page's record type, its create forms, the forms refused for a
 * required field the viewer cannot fill in, and the placements as they now stand; or a refusal to
 * answer the page with.
 */
export const decideFormPolicy = async (
  input: Readonly<{
    session: IdentitySession;
    selection: OrganizationSelectionCandidate;
    context: InstalledRuntimeContext;
    page: Record<string, unknown>;
    pageDefinition: PageDefinition;
    subjectType: PageSubjectType | undefined;
    subjectId: string | undefined;
    allPlacements: readonly Placement[];
    readSubject: (recordTypeId: string, recordId: string) => Promise<PageSubjectReadResult>;
  }>,
): Promise<
  | Readonly<{
      kind: "decided";
      editFormPlacementIds: ReadonlySet<string>;
      formRecordType: RecordType | undefined;
      createFormIds: readonly string[];
      refusedForms: ReadonlyMap<string, string>;
      allPlacements: Placement[];
    }>
  | Readonly<{ kind: "refused"; result: ApplicationPageInternalResult }>
> => {
  const { session, selection, context, pageDefinition, subjectType } = input;
  const application = context.releaseSet.application;
  const editFormPlacementIds = new Set(
    input.allPlacements.flatMap(({ placementId, vortex }) => {
      const block = vortex.block;
      const isFormContainer =
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
      const submitsPageRecord = application.content.flowBindings.some(
        (binding) =>
          sameId(binding.controlId, placementId) &&
          binding.event === "form_submit" &&
          Object.values(binding.flow.inputs).some(
            (input) => isRecord(input) && input.kind === "caller" && input.name === "record",
          ),
      );
      return isFormContainer && submitsPageRecord ? [placementId] : [];
    }),
  );
  // The forms of a form page show each field as the viewer's field policy allows: decided once,
  // before any placement is read, so a field left out is never read or sent.
  const formRecordType =
    pageDefinition.type === "form" && subjectType !== undefined
      ? context.releaseSet.modules
          .flatMap((module) => module.content.recordTypes)
          .find((recordType) =>
            sameId(String(recordType.recordTypeId), String(subjectType.recordTypeId)),
          )
      : undefined;
  let refusedForms: ReadonlyMap<string, string> = new Map();
  let createFormIds: readonly string[] = [];
  let allPlacements = input.allPlacements;
  if (formRecordType !== undefined) {
    const recordTypeId = String(formRecordType.recordTypeId);
    const editForms = new Map<string, ProtectedQueryRow>();
    if (editFormPlacementIds.size > 0 && input.subjectId !== undefined) {
      const read = await input.readSubject(recordTypeId, input.subjectId);
      if (read.kind === "read")
        for (const formId of editFormPlacementIds) editForms.set(formId, read.row);
    }
    createFormIds = allPlacements.flatMap(({ placementId, vortex }) => {
      const block = vortex.block;
      return isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId) &&
        !editFormPlacementIds.has(placementId) &&
        application.content.flowBindings.some(
          (binding) =>
            sameId(binding.controlId, placementId) &&
            binding.event === "form_submit" &&
            flowCreatedRecordTypeIds(application.content.flows, String(binding.flow.flowId)).has(
              recordTypeId.toLowerCase(),
            ),
        )
        ? [placementId]
        : [];
    });
    const createForms = new Map<string, ReadonlySet<string> | undefined>();
    if (createFormIds.length > 0) {
      const creatable = await readCreatableFieldIds(session, selection, context, recordTypeId);
      if (creatable.kind !== "available") return { kind: "refused", result: creatable };
      for (const formId of createFormIds) createForms.set(formId, creatable.fieldIds);
    }
    const access = decideFormFieldAccess({
      placements: allPlacements,
      recordType: formRecordType,
      editForms,
      createForms,
    });
    applyFormFieldAccess(input.page, access);
    allPlacements = collectPlacements(input.page);
    refusedForms = access.refused;
  }
  return {
    kind: "decided",
    editFormPlacementIds,
    formRecordType,
    createFormIds,
    refusedForms,
    allPlacements: [...allPlacements],
  };
};
