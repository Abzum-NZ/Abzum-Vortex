import {
  type ReferenceChoiceInputValues,
  type PermittedApplicationsRead,
  type PermittedApplication,
  type InstalledRuntimeContext,
  createStoredPageCapabilityService,
} from "@vortex/platform/server";
import { FIELD_INPUT_BLOCK_RELEASE, FIELD_INPUT_CONTROL_RELEASES } from "@vortex/platform/server";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type JsonValue,
  exactDecimalTextSchema,
  timestampSchema,
  richTextDocumentSchema,
  sameId,
  isRecord,
} from "@vortex/platform/schema";
import { requestDependencies, loadInstalledContext } from "./load";
import type { DateTimeZones, PageDataState } from "./types";
import { platformPermissionSource } from "../platform-permission-source";
import { formFieldOf } from "./form-field-access";

export type ReferenceChoicePageResult =
  | Readonly<{ kind: "completed"; values: ReferenceChoiceInputValues }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export type ReferenceChoiceAddress = Readonly<{
  read: Extract<PermittedApplicationsRead, { kind: "available" }>;
  application: PermittedApplication;
  pageKey: string;
}>;

/** Reprojects the current addressed page under the actor and the exact installed release. */
export const projectReferenceChoicePage = async (
  session: IdentitySession,
  address: ReferenceChoiceAddress,
  request: Readonly<{ installationRevision: number; releaseKey: string; subjectRecordId?: string }>,
): Promise<
  | Readonly<{
      kind: "available";
      page: Readonly<Record<string, unknown>>;
      context: InstalledRuntimeContext;
      selection: OrganizationSelectionCandidate;
      dependencies: ReturnType<typeof requestDependencies>;
    }>
  | Exclude<ReferenceChoicePageResult, { kind: "completed" }>
> => {
  const dependencies = requestDependencies();
  const selection: OrganizationSelectionCandidate = {
    organizationId: address.read.organizationId,
    applicationRootId: address.application.applicationRootId,
    ...(address.application.previewInstallationId === undefined
      ? {}
      : { previewInstallationId: address.application.previewInstallationId }),
  };
  const loaded = await loadInstalledContext(session, dependencies, selection);
  if (loaded.kind !== "available")
    return loaded.kind === "temporarily_unavailable"
      ? { kind: "temporarily_unavailable" }
      : { kind: "refused" };
  const context = loaded.value;
  const application = context.releaseSet.application;
  if (!sameId(context.applicationRootId, address.application.applicationRootId))
    return { kind: "refused" };
  if (
    request.installationRevision !== context.applicationReleaseRevision ||
    request.releaseKey !==
      [
        application.releaseVersion,
        application.contentFingerprint,
        application.resolutionFingerprint,
      ].join(":")
  )
    return { kind: "reload" };
  const pageDefinition = application.content.pages.find((page) => page.key === address.pageKey);
  if (pageDefinition === undefined) return { kind: "refused" };
  const projected = await createStoredPageCapabilityService({
    ...dependencies,
    context,
    permissions: platformPermissionSource,
    selection: {
      pageId: pageDefinition.pageId,
      ...(request.subjectRecordId === undefined
        ? {}
        : { subjectRecordId: request.subjectRecordId }),
    },
  }).project(session, selection);
  if (projected.kind === "temporarily_unavailable") return { kind: "temporarily_unavailable" };
  if (projected.kind !== "available" || projected.value === undefined) return { kind: "refused" };
  return { kind: "available", page: projected.value, context, selection, dependencies };
};

/** A form field may show only a value the page subject read returned for its own record type. */
export const projectEditField = (
  placement: Readonly<{ vortex: Record<string, unknown>; settings: Record<string, unknown> }>,
  recordType: InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number],
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
      settings.input_type.value === "email"
        ? null
        : displayed,
    data: {
      status: "ready",
      values: { kind, value: displayed, ...(kind === "date_time_input" ? dateTimeZones : {}) },
    },
  };
};
