import "server-only";

import type { JsonValue } from "../catalogue/common";
import { timestampSchema } from "../catalogue/identifiers";
import { isRecord, sameId } from "../catalogue/runtime-primitives";
import { pipelineAllowsMove, type RecordTypePipeline } from "../definition/record-type-pipelines";
import { exactDecimalTextSchema, moduleFieldValueSchemas } from "../records/module-field-values";
import { richTextDocumentSchema } from "../records/rich-text";
import {
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
} from "../definition/application-composition-catalogue";
import type { InstalledRuntimeContext } from "../definition/installed-runtime-context";
import type { RequestDatabaseTransaction } from "../db/request-transaction";
import { decideChoiceOptionPermission } from "../records/choice-option-permission";
import type { PageDataState, PlacementReadEntry } from "./placement-read/shared";

type PlacementParts = Pick<PlacementReadEntry, "vortex" | "settings">;
type Modules = InstalledRuntimeContext["releaseSet"]["modules"];
type RecordType = Modules[number]["content"]["recordTypes"][number];
type ModuleField = RecordType["fields"][number];
export type PermissionEntry = InstalledRuntimeContext["permissionRegistration"]["entries"][number];

/** The time zones a date-time field shows its value in. */
export type DateTimeZones = { personTimeZone?: string; organizationTimeZone?: string };

/** The record field one form field placement edits: by its field reference, else by its name. */
export const formFieldOf = (
  placement: Pick<PlacementReadEntry, "settings">,
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

/** The installed field a placement's `field` setting names, with the module that owns it. */
export const fieldForPlacement = (
  placement: Pick<PlacementReadEntry, "settings">,
  modules: Modules,
):
  Readonly<{ module: Modules[number]; recordType: RecordType; field: ModuleField }> | undefined => {
  const reference = placement.settings.field;
  if (!isRecord(reference)) return undefined;
  if (reference.kind !== "field_reference" || typeof reference.fieldId !== "string")
    return undefined;
  for (const module of modules)
    for (const recordType of module.content.recordTypes) {
      const field = recordType.fields.find((candidate) =>
        sameId(String(candidate.fieldId), reference.fieldId as string),
      );
      if (field !== undefined) return { module, recordType, field };
    }
  return undefined;
};

/** The control an automatic field input derives (its `control` setting), if it is one. */
export const fieldControl = (placement: PlacementParts): string | undefined => {
  const settings = placement.settings;
  const block = placement.vortex.block;
  return isRecord(block) &&
    typeof block.blockId === "string" &&
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) &&
    isRecord(settings.control) &&
    settings.control.kind === "choice" &&
    typeof settings.control.value === "string"
    ? settings.control.value
    : undefined;
};

/** A form field may show only a value the page subject read returned for its own record type. */
export const projectEditField = (
  placement: PlacementParts,
  recordType: RecordType,
  values: Readonly<Record<string, JsonValue>>,
  dateTimeZones: DateTimeZones,
): Readonly<{ key: string; value: JsonValue; data: PageDataState }> | undefined => {
  const settings = placement.settings;
  const block = placement.vortex.block;
  if (!isRecord(block) || typeof block.blockId !== "string") return undefined;
  const blockId = block.blockId;
  const field = formFieldOf(placement, recordType);
  if (field === undefined) return undefined;
  const fieldId = String(field.fieldId);
  const valueKey = Object.keys(values).find((key) => sameId(key, fieldId));
  if (valueKey === undefined) return undefined;
  const stored = values[valueKey]!;
  const control = sameId(blockId, FIELD_INPUT_BLOCK_RELEASE.blockId)
    ? isRecord(settings.control) && settings.control.kind === "choice"
      ? settings.control.value
      : undefined
    : Object.entries(FIELD_INPUT_CONTROL_RELEASES).find(([, release]) =>
        sameId(release.blockId, blockId),
      )?.[0];
  let kind: string;
  let displayed: JsonValue = stored;
  switch (control) {
    case "text":
      if (stored !== null && typeof stored !== "string") return undefined;
      kind = "text_input";
      displayed = stored ?? "";
      break;
    case "number":
      displayed =
        field.type === "money" && isRecord(stored) && typeof stored.amount === "string"
          ? stored.amount
          : stored;
      if (
        displayed !== null &&
        !(typeof displayed === "number" && Number.isFinite(displayed)) &&
        !(typeof displayed === "string" && exactDecimalTextSchema.safeParse(displayed).success)
      )
        return undefined;
      if (
        displayed !== null &&
        isRecord(settings.integer) &&
        settings.integer.kind === "boolean" &&
        settings.integer.value === true &&
        (typeof displayed !== "number" || !Number.isSafeInteger(displayed))
      )
        return undefined;
      kind = "number_input";
      break;
    case "boolean":
      if (typeof stored !== "boolean") return undefined;
      kind = "boolean_input";
      break;
    case "date":
      if (stored !== null) {
        if (typeof stored !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stored)) return undefined;
        const date = new Date(`${stored}T00:00:00Z`);
        if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== stored)
          return undefined;
      }
      kind = "date_input";
      break;
    case "date_time":
      if (
        stored !== null &&
        !(typeof stored === "string" && timestampSchema.safeParse(stored).success)
      )
        return undefined;
      kind = "date_time_input";
      break;
    case "choice":
      if (stored !== null && typeof stored !== "string") return undefined;
      if (stored !== null) {
        const options = settings.options;
        if (
          !isRecord(options) ||
          options.kind !== "list" ||
          !Array.isArray(options.items) ||
          !options.items.some(
            (item) =>
              isRecord(item) &&
              isRecord(item.properties) &&
              isRecord(item.properties.key) &&
              item.properties.key.value === stored,
          )
        )
          return undefined;
      }
      kind = "choice_input";
      break;
    case "several_choices": {
      const selected = stored === null ? [] : stored;
      if (
        !Array.isArray(selected) ||
        selected.length > 200 ||
        !selected.every((choice) => typeof choice === "string") ||
        new Set(selected).size !== selected.length
      )
        return undefined;
      const options = settings.options;
      if (!isRecord(options) || options.kind !== "list" || !Array.isArray(options.items))
        return undefined;
      const optionItems: unknown[] = options.items;
      if (
        !selected.every((choice) =>
          optionItems.some(
            (item) =>
              isRecord(item) &&
              isRecord(item.properties) &&
              isRecord(item.properties.key) &&
              item.properties.key.value === choice,
          ),
        )
      )
        return undefined;
      const maximumSelections = settings.maximum_selections;
      if (
        isRecord(maximumSelections) &&
        maximumSelections.kind === "number" &&
        typeof maximumSelections.value === "number" &&
        selected.length > maximumSelections.value
      )
        return undefined;
      displayed = selected;
      kind = "several_choices_input";
      break;
    }
    case "link":
      if (
        stored !== null &&
        (!isRecord(stored) ||
          typeof stored.recordTypeId !== "string" ||
          typeof stored.recordId !== "string")
      )
        return undefined;
      if (stored !== null && isRecord(stored)) {
        const targets = settings.record_types;
        if (
          !isRecord(targets) ||
          targets.kind !== "list" ||
          !Array.isArray(targets.items) ||
          !targets.items.some(
            (item) =>
              isRecord(item) &&
              item.kind === "record_type_reference" &&
              isRecord(item.recordType) &&
              item.recordType.state === "resolved" &&
              item.recordType.recordTypeId === stored.recordTypeId,
          )
        )
          return undefined;
      }
      kind = "link_input";
      break;
    case "attachment":
      if (stored !== null && !moduleFieldValueSchemas.attachment.safeParse(stored).success)
        return undefined;
      displayed = stored ?? [];
      kind = "attachment_input";
      break;
    case "table":
      if (stored !== null && !moduleFieldValueSchemas.table.safeParse(stored).success)
        return undefined;
      displayed = stored ?? [];
      kind = "table_input";
      break;
    case "rich_text":
      if (stored !== null && !richTextDocumentSchema.safeParse(stored).success) return undefined;
      kind = "rich_text_input";
      break;
    default:
      return undefined;
  }
  return {
    key: field.key,
    value:
      kind === "text_input" &&
      stored === null &&
      isRecord(settings.input_type) &&
      (settings.input_type.value === "email" ||
        settings.input_type.value === "tel" ||
        settings.input_type.value === "url")
        ? null
        : displayed,
    data: {
      status: "ready",
      values: {
        kind,
        value: displayed,
        ...(kind === "date_time_input" ? dateTimeZones : {}),
        ...(kind === "attachment_input" ? { files: [], uploadUrl: "/api/files/upload?" } : {}),
      },
    },
  };
};

/** A placement with the plain props the page payload carries, which the form renders. */
type GatedPlacement = PlacementParts & Readonly<{ props: Record<string, unknown> }>;

/** One choice placement's option list and, per option, the permission key that gates it. */
type ChoiceOptionGate = Readonly<{
  /** The placement's plain props: their `options` list is what the form renders. */
  props: Record<string, unknown>;
  /** The plain option list as projected, in the field's declared order. */
  items: readonly unknown[];
  permissionKeys: readonly (string | undefined)[];
  recordTypeId: string;
  fieldId: string;
  /** The record type's pipeline whose stage this field is, if it is one. */
  pipeline: RecordTypePipeline | undefined;
  /** The stages only a named action may set (such as Lost, with its reason): never offered here. */
  actionOwnedStages: ReadonlySet<string>;
}>;

/** The option permissions the projected page's choice placements name, planned for one page. */
export type ChoiceOptionPlan = Readonly<{
  gates: readonly ChoiceOptionGate[];
  /** The record type and permission each gated option needs, by `recordTypeId:permissionId` key. */
  permissions: ReadonlyMap<string, Readonly<{ recordTypeId: string; permissionId: string }>>;
}>;

/**
 * Reads every choice and several-choices placement against its installed field: the placement's
 * option list must be exactly the field's declared options, and each option that requires a
 * permission must name exactly one registered permission of its module. A mismatch is the page's
 * projection being out of step with the installed release, so the plan is refused.
 */
export const planChoiceOptionGates = (
  placements: readonly GatedPlacement[],
  context: InstalledRuntimeContext,
): ChoiceOptionPlan | undefined => {
  const gates: ChoiceOptionGate[] = [];
  const permissions = new Map<string, { recordTypeId: string; permissionId: string }>();
  for (const placement of placements) {
    const control = fieldControl(placement);
    if (control !== "choice" && control !== "several_choices") continue;
    const source = fieldForPlacement(placement, context.releaseSet.modules);
    const options = placement.settings.options;
    const plainItems = placement.props.options;
    if (
      source === undefined ||
      (source.field.type !== "choice" && source.field.type !== "several_choices") ||
      source.field.type !== control ||
      !isRecord(options) ||
      options.kind !== "list" ||
      !Array.isArray(options.items) ||
      options.items.length !== source.field.settings.options.length ||
      !Array.isArray(plainItems) ||
      plainItems.length !== source.field.settings.options.length
    )
      return undefined;
    const recordTypeId = String(source.recordType.recordTypeId).toLowerCase();
    const permissionKeys: Array<string | undefined> = [];
    for (const [index, declared] of source.field.settings.options.entries()) {
      const item: unknown = options.items[index];
      const plain: unknown = plainItems[index];
      if (
        !isRecord(item) ||
        !isRecord(item.properties) ||
        !isRecord(item.properties.key) ||
        !isRecord(item.properties.label) ||
        item.properties.key.value !== declared.value ||
        item.properties.label.value !== declared.label ||
        !isRecord(plain) ||
        plain.key !== declared.value
      )
        return undefined;
      const permissionId = declared.requiredPermissionId;
      if (permissionId === undefined) {
        permissionKeys.push(undefined);
        continue;
      }
      const matches = context.permissionRegistration.entries.filter(
        (entry) =>
          entry.ownerKind === "module" &&
          sameId(String(entry.ownerId), String(source.module.rootId)) &&
          sameId(String(entry.permission.permissionId), String(permissionId)),
      );
      if (matches.length !== 1 || matches[0] === undefined) return undefined;
      const key = `${recordTypeId}:${String(permissionId).toLowerCase()}`;
      permissions.set(key, { recordTypeId, permissionId: String(permissionId) });
      permissionKeys.push(key);
    }
    gates.push({
      props: placement.props,
      items: plainItems,
      permissionKeys,
      recordTypeId,
      fieldId: String(source.field.fieldId).toLowerCase(),
      pipeline: source.recordType.pipelines.find((pipeline) =>
        sameId(String(pipeline.stageFieldId), String(source.field.fieldId)),
      ),
      actionOwnedStages: new Set(
        source.module.content.actions.flatMap((action) =>
          sameId(String(action.subjectRecordTypeId), recordTypeId) &&
          action.setsChoiceFieldId !== undefined &&
          sameId(String(action.setsChoiceFieldId), String(source.field.fieldId)) &&
          action.setsChoiceOption !== undefined
            ? [action.setsChoiceOption]
            : [],
        ),
      ),
    });
  }
  return { gates, permissions };
};

/**
 * The gated options the person may use now: for each distinct record-type permission the page
 * names, the one database decision the form save asks as well. A permission on the page subject's
 * record type is decided for that record; any other for a new record.
 */
export const decideChoiceOptionGates = async (
  transaction: RequestDatabaseTransaction,
  plan: ChoiceOptionPlan,
  subject: Readonly<{ recordTypeId: string; recordId: string }> | undefined,
): Promise<ReadonlySet<string>> => {
  const allowed = new Set<string>();
  for (const [key, { recordTypeId, permissionId }] of plan.permissions)
    if (
      await decideChoiceOptionPermission(
        transaction,
        recordTypeId,
        permissionId,
        subject !== undefined && sameId(subject.recordTypeId, recordTypeId)
          ? subject.recordId
          : undefined,
      )
    )
      allowed.add(key);
  return allowed;
};

/** The option values of one gate's field that the record being edited already holds. */
export type HeldChoiceOptions = (
  gate: Readonly<{ recordTypeId: string; fieldId: string }>,
) => ReadonlySet<string>;

/**
 * Leaves in each placement's option list, the page payload the form renders, only the options the
 * person may use. An option the record already holds stays, so the field keeps its value. A
 * pipeline's stage field offers only the stages the save accepts: those the held stage moves to,
 * or for a new record the start stage and the stages it moves to, and never a stage a named
 * action owns (the action sets it, with whatever it asks for).
 */
export const applyChoiceOptionGates = (
  plan: ChoiceOptionPlan,
  allowedKeys: ReadonlySet<string>,
  held: HeldChoiceOptions,
): void => {
  for (const gate of plan.gates) {
    const kept = held(gate);
    const stage = gate.pipeline === undefined ? undefined : [...kept][0];
    gate.props.options = gate.items.filter((item, index) => {
      const value = isRecord(item) && typeof item.key === "string" ? item.key : undefined;
      if (value !== undefined && kept.has(value)) return true;
      if (
        gate.pipeline !== undefined &&
        (!pipelineAllowsMove(gate.pipeline, stage, value) ||
          (value !== undefined && gate.actionOwnedStages.has(value)))
      )
        return false;
      const key = gate.permissionKeys[index];
      return key === undefined || allowedKeys.has(key);
    });
  }
};
