import {
  FORM_CONTAINER_BLOCK_RELEASE,
  formFieldOf,
  logPlacementFailure,
  projectEditField,
  type DateTimeZones,
  type InstalledRuntimeContext,
  type PageSubjectReadResult,
  type RecordLinkResolver,
} from "@vortex/platform/server";
import { isRecord, sameId, type JsonValue } from "@vortex/platform/schema";
import { isEditFieldPlacement, type collectPlacements } from "./placement-helpers";
import { titleLinkInputs } from "./link-input";
import type { ApplicationPageLoaderAddress, PageDataState, PlacementFlowBinding } from "./types";

type Placements = ReturnType<typeof collectPlacements>;
type RecordType =
  InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number];

/**
 * The stored values the edit forms of a page start from. Detail and ordinary form edit surfaces
 * project their fields from the authorized subject read; guided-form fields instead come from the
 * person's revisioned draft. A field whose stored value its form cannot show is left out of the
 * form (its placement id in `unshown`) with the cause logged; the save then leaves that value as
 * it is. A form whose record the viewer cannot read is disabled and marks the page unreadable.
 */
export const projectEditForms = async (
  input: Readonly<{
    address: ApplicationPageLoaderAddress;
    placements: Placements;
    isGuidedForm: boolean;
    editFormPlacementIds: ReadonlySet<string>;
    bindings: Readonly<Record<string, PlacementFlowBinding[]>>;
    subjectRow: PageSubjectReadResult | undefined;
    hasSubject: boolean;
    subjectRecordType: RecordType | undefined;
    dateTimeZones: DateTimeZones;
    resolveRecordLinks: RecordLinkResolver;
    data: Record<string, PageDataState>;
  }>,
): Promise<
  Readonly<{
    editFormBaselines: Record<string, Record<string, JsonValue>>;
    unshown: Set<string>;
    subjectUnreadable: boolean;
  }>
> => {
  const {
    address,
    placements,
    editFormPlacementIds,
    bindings,
    subjectRow,
    subjectRecordType,
    dateTimeZones,
    resolveRecordLinks,
    data,
  } = input;
  let subjectUnreadable = false;
  const editFormBaselines: Record<string, Record<string, JsonValue>> = {};
  const unshown = new Set<string>();
  if (!input.isGuidedForm) {
    for (const { placementId, vortex } of placements) {
      if (!editFormPlacementIds.has(placementId)) continue;
      const block = vortex.block;
      if (
        !isRecord(block) ||
        typeof block.blockId !== "string" ||
        !sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
      )
        continue;
      const editBinding = bindings[placementId]?.some(
        (binding) => binding.event === "form_submit" && binding.callerInputs.includes("record"),
      );
      if (!editBinding) continue;
      if (subjectRow?.kind !== "read" || !input.hasSubject || subjectRecordType === undefined) {
        if (subjectRow === undefined || subjectRow.kind === "refused") subjectUnreadable = true;
        data[placementId] = { status: "disabled", reason: "Record unavailable" };
        continue;
      }
      const fields = placements.filter((entry) => {
        if (entry.formId !== placementId || entry.placementId === placementId) return false;
        // A form may carry the page record to an action and ask separate questions. Only
        // inputs that actually name its record fields receive stored values and field policy.
        return isEditFieldPlacement(entry) && formFieldOf(entry, subjectRecordType) !== undefined;
      });
      const baseline: Record<string, JsonValue> = {};
      const projected: Record<string, PageDataState> = {};
      const baselineKeys = new Map<string, string>();
      for (const entry of fields) {
        const projectedField = projectEditField(
          entry,
          subjectRecordType,
          subjectRow.row.values,
          dateTimeZones,
        );
        // A field whose stored value this form cannot show is left out of it, with the cause
        // logged; the save then leaves that value as it is.
        if (projectedField === undefined || Object.hasOwn(baseline, projectedField.key)) {
          logPlacementFailure(address, entry.placementId, "edit_field_unprojected");
          unshown.add(entry.placementId.toLowerCase());
          continue;
        }
        baseline[projectedField.key] = projectedField.value;
        baselineKeys.set(entry.placementId, projectedField.key);
        projected[entry.placementId] = projectedField.data;
      }
      // A linked record shows by its title, read under the viewer's access in one batched read; a
      // link whose record the viewer may not read is left out of the form, with the cause logged.
      for (const untitled of await titleLinkInputs(projected, resolveRecordLinks)) {
        logPlacementFailure(address, untitled, "link_titles_unavailable");
        unshown.add(untitled.toLowerCase());
        delete projected[untitled];
        const key = baselineKeys.get(untitled);
        if (key !== undefined) delete baseline[key];
      }
      Object.assign(data, projected);
      data[placementId] = { status: "ready", values: { kind: "form" } };
      editFormBaselines[placementId] = baseline;
    }
  }
  return { editFormBaselines, unshown, subjectUnreadable };
};

/**
 * A create form starts each field at its definition's default, the value the save stores when the
 * field is left as it is, so the person sees what will be saved.
 */
export const projectCreateFormDefaults = (
  input: Readonly<{
    address: ApplicationPageLoaderAddress;
    placements: Placements;
    formRecordType: RecordType | undefined;
    createFormIds: readonly string[];
    dateTimeZones: DateTimeZones;
    data: Record<string, PageDataState>;
  }>,
): void => {
  const { address, placements, formRecordType, createFormIds, dateTimeZones, data } = input;
  if (formRecordType !== undefined)
    for (const entry of placements) {
      if (
        entry.formId === undefined ||
        !createFormIds.some((formId) => sameId(formId, entry.formId!)) ||
        !isEditFieldPlacement(entry)
      )
        continue;
      const field = formFieldOf(entry, formRecordType);
      if (field?.default === undefined) continue;
      const projected = projectEditField(
        entry,
        formRecordType,
        { [String(field.fieldId)]: field.default as JsonValue },
        dateTimeZones,
      );
      if (projected === undefined) {
        logPlacementFailure(address, entry.placementId, "create_field_default_unprojected");
        continue;
      }
      data[entry.placementId] = projected.data;
    }
};
