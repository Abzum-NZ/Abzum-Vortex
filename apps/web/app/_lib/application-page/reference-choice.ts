import type {
  createReferenceChoiceService} from "@web/platform-server";
import {
  type ReferenceChoiceInputValues,
  type PermittedApplicationsRead,
  type PermittedApplication,
  type InstalledRuntimeContext,
  createStoredPageCapabilityService,
  type ReferenceChoiceOption,
  projectReferenceChoiceInputValues,
} from "@web/platform-server";
import { FIELD_INPUT_BLOCK_RELEASE, FIELD_INPUT_CONTROL_RELEASES } from "@vortex/platform/server";
import {
  type IdentitySession,
  type OrganizationSelectionCandidate,
  type JsonValue,
  exactDecimalTextSchema,
  timestampSchema,
  richTextDocumentSchema,
  recordLinkValueSchema,
  type ReferenceChoiceSelectionEvidence,
} from "@vortex/platform/schema";
import type { ReferenceChoiceFormField } from "../reference-choices";
import { requestDependencies, loadInstalledContext } from "./load";
import { sameId, isRecord } from "./placement-helpers";
import type { DateTimeZones, PageDataState, ModuleField } from "./types";

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
  request: Readonly<{ installationRevision: number; releaseKey: string }>,
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
    request.releaseKey !== [
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
    selection: { pageId: pageDefinition.pageId },
  }).project(session, selection);
  if (projected.kind === "temporarily_unavailable")
    return { kind: "temporarily_unavailable" };
  if (projected.kind !== "available" || projected.value === undefined)
    return { kind: "refused" };
  return { kind: "available", page: projected.value, context, selection, dependencies };
};

/** A form field may show only a value the page subject read returned for its own record type. */
export const projectEditField = (
  placement: Readonly<Record<string, unknown>>,
  recordType: InstalledRuntimeContext["releaseSet"]["modules"][number]["content"]["recordTypes"][number],
  values: Readonly<Record<string, JsonValue>>,
  dateTimeZones: DateTimeZones,
): Readonly<{ key: string; value: JsonValue; data: PageDataState }> | undefined => {
  const settings = placement.settings;
  const block = placement.block;
  if (!isRecord(settings) || !isRecord(block) || typeof block.blockId !== "string")
    return undefined;
  const blockId = block.blockId;
  const fieldSetting = settings.field;
  const nameSetting = settings.name;
  const field = recordType.fields.find((candidate) =>
    isRecord(fieldSetting) &&
    fieldSetting.kind === "field_reference" &&
    typeof fieldSetting.fieldId === "string"
      ? sameId(String(candidate.fieldId), fieldSetting.fieldId)
      : isRecord(nameSetting) &&
        nameSetting.kind === "text" &&
        typeof nameSetting.value === "string" &&
        candidate.key === nameSetting.value,
  );
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
      if (
        !isRecord(options) ||
        options.kind !== "list" ||
        !Array.isArray(options.items)
      )
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

export type ReferenceChoiceFirstPage = Readonly<{
  field: ReferenceChoiceFormField;
  choices: readonly ReferenceChoiceOption[];
  nextContinuationToken?: string;
}>;

/** Projects a saved record link only when the exact value is still offered by its declared Query. */
export const projectSelectedReferenceChoiceEditField = async (args: Readonly<{
  firstPage: ReferenceChoiceFirstPage | undefined;
  field: ModuleField | undefined;
  stored: JsonValue | undefined;
  service: ReturnType<typeof createReferenceChoiceService>;
  session: IdentitySession;
  selection: OrganizationSelectionCandidate;
}>): Promise<Readonly<{ key: string; value: JsonValue; data: PageDataState }> | undefined> => {
  const first = args.firstPage;
  const field = args.field;
  if (first === undefined || field === undefined || args.stored === undefined) return undefined;
  if (field.type !== "link" && field.type !== "link_to_one_of_several") return undefined;

  const fieldTargets = field.type === "link" ? [field.settings.target] : field.settings.targets;
  const resolvedFieldTargets = fieldTargets.filter((target) => target.state === "resolved");
  if (resolvedFieldTargets.length !== fieldTargets.length || resolvedFieldTargets.length === 0)
    return undefined;
  const command = first.field.command;
  if (command.kind !== "record_reference" || command.source.query.recordType.state !== "resolved")
    return undefined;
  const queryTarget = command.source.query.recordType;
  const queryAllowedTargets = command.allowedRecordTypes.filter((target) => target.state === "resolved");
  if (
    queryAllowedTargets.length !== command.allowedRecordTypes.length ||
    queryAllowedTargets.length === 0 ||
    !resolvedFieldTargets.some((target) =>
      sameId(target.moduleRootId, queryTarget.moduleRootId) &&
      sameId(target.recordTypeId, queryTarget.recordTypeId),
    ) ||
    !queryAllowedTargets.some((target) =>
      sameId(target.moduleRootId, queryTarget.moduleRootId) &&
      sameId(target.recordTypeId, queryTarget.recordTypeId),
    )
  )
    return undefined;

  if (args.stored === null) {
    if (field.required) return undefined;
    return {
      key: field.key,
      value: null,
      data: {
        status: "ready",
        values: projectReferenceChoiceInputValues(
          first.choices,
          null,
          undefined,
          first.nextContinuationToken === undefined
            ? {}
            : { nextContinuationToken: first.nextContinuationToken },
        ),
      },
    };
  }
  const storedLink = recordLinkValueSchema.safeParse(args.stored);
  if (!storedLink.success) return undefined;
  const storedValue = storedLink.data;
  const fieldTarget = resolvedFieldTargets.find((target) =>
    sameId(target.recordTypeId, storedValue.recordTypeId),
  );
  if (
    fieldTarget === undefined ||
    !sameId(fieldTarget.moduleRootId, queryTarget.moduleRootId) ||
    !sameId(fieldTarget.recordTypeId, queryTarget.recordTypeId) ||
    !queryAllowedTargets.some((target) => sameId(target.recordTypeId, storedValue.recordTypeId))
  )
    return undefined;

  const seenKeys = new Set<string>();
  const seenRowIds = new Set<string>();
  const seenTokens = new Set<string>();
  let selected: ReferenceChoiceOption | undefined;
  let selectedEvidence: ReferenceChoiceSelectionEvidence | undefined;
  let totalChoices = 0;
  const consumePage = (
    choices: readonly ReferenceChoiceOption[],
    requestToken: string | undefined,
  ): boolean => {
    if (choices.length > command.pageSize || totalChoices + choices.length > 1_000) return false;
    totalChoices += choices.length;
    for (const choice of choices) {
      const choiceValue = choice.value;
      if ("organizationAccountId" in choiceValue) return false;
      const rowId = `${choiceValue.recordTypeId.toLowerCase()}:${choiceValue.recordId.toLowerCase()}`;
      if (
        seenKeys.has(choice.key) ||
        seenRowIds.has(rowId) ||
        !sameId(choiceValue.recordTypeId, queryTarget.recordTypeId) ||
        !queryAllowedTargets.some((target) => sameId(target.recordTypeId, choiceValue.recordTypeId))
      )
        return false;
      seenKeys.add(choice.key);
      seenRowIds.add(rowId);
      if (
        sameId(choiceValue.recordTypeId, storedValue.recordTypeId) &&
        sameId(choiceValue.recordId, storedValue.recordId)
      ) {
        if (selected !== undefined) return false;
        selected = choice;
        selectedEvidence = requestToken === undefined ? {} : { continuationToken: requestToken };
      }
    }
    return true;
  };
  if (!consumePage(first.choices, undefined)) return undefined;

  let pageCount = 1;
  let requestToken = first.nextContinuationToken;
  while (requestToken !== undefined && selected === undefined) {
    if (pageCount >= 20 || seenTokens.has(requestToken)) return undefined;
    seenTokens.add(requestToken);
    const result = await args.service.run(args.session, args.selection, {
      ...command,
      continuationToken: requestToken,
    });
    if (result.kind !== "available" || result.value.outcome !== "completed") return undefined;
    const page = result.value;
    if (page.kind !== "record_reference" || !consumePage(page.choices, requestToken)) return undefined;
    pageCount += 1;
    requestToken = page.nextContinuationToken;
    if (selected === undefined && requestToken !== undefined && seenTokens.has(requestToken)) return undefined;
  }

  if (selected === undefined) return undefined;
  const visibleChoices = [...first.choices];
  if (!visibleChoices.some((choice) => choice.key === selected?.key)) visibleChoices.push(selected);
  const selectedToken = selectedEvidence?.continuationToken;
  const optionEvidenceOverrides = selectedToken === undefined
    ? {}
    : { [selected.key]: { continuationToken: selectedToken } };
  return {
    key: field.key,
    value: selected.key,
    data: {
      status: "ready",
      values: projectReferenceChoiceInputValues(
        visibleChoices,
        selected.key,
        undefined,
        {
          ...(first.nextContinuationToken === undefined
            ? {}
            : { nextContinuationToken: first.nextContinuationToken }),
          ...(Object.keys(optionEvidenceOverrides).length === 0
            ? {}
            : { optionEvidenceOverrides }),
        },
      ),
    },
  };
};
