import { z } from "zod";
import { inspectApplicationPageReplacements } from "./application-page-replacement";
import {
  applicationDefinitionEnvelopeSchema,
  publishedApplicationReferenceSchema,
  publishedDefinitionReferenceSchema,
  recordTypeReferenceSchema,
  requireResolvedRecordTypeReferences,
  versionRequirementSchema,
} from "./definitions";
import type { ResolveRecordTypeReferences } from "./definitions";
import { refineActionTaskIds } from "./definition-source-common";
import {
  actionTaskSchema,
  conditionNodeSchema,
  eventDefinitionSchema,
} from "./module-contracts";
import { interfaceDefinitionSchema } from "./integration-contracts";
import {
  actionIdSchema,
  builderKeySchema,
  connectionTypeIdSchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  lineageIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  pageIdSchema,
  pipelineIdSchema,
  queryIdSchema,
  recordTypeIdSchema,
  roleIdSchema,
  semanticVersionSchema,
} from "./identifiers";
import { jsonValueSchema, labelSchema, safeHttpsUrlSchema } from "./common";
import { actionInputValueTypes, applicationExperienceStateSchema } from "./catalogues";
import { permissionDeclarationSchema } from "./permissions";
import {
  applicationShellV2Schema,
  applicationThemeV2Schema,
  canonicalPlacementEntriesV2,
  guidedFormPageCompositionV2Schema,
  pageCompositionV2Schema,
  platformBlockDependenciesV2Schema,
  type ComponentSettingValue,
} from "./application-composition-v2";
import { componentFlowBindingSchema } from "./application-flow-bindings";
import { flowSchema } from "./flow-contracts";

/** The typed inputs and shape of one Application-owned action. */
const actionInputBase = {
  key: builderKeySchema,
  label: labelSchema,
  required: z.boolean(),
};
const textActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal(actionInputValueTypes.text),
    validation: z
      .object({
        minimumLength: z.number().int().min(0).optional(),
        maximumLength: z.number().int().positive().optional(),
        pattern: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const formattedTextActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal(actionInputValueTypes.formatted_text),
    validation: z
      .object({
        allowedBlocks: z
          .array(z.enum(["paragraph", "heading", "list", "link", "attachment"]))
          .min(1),
        maximumLength: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const numberActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal(actionInputValueTypes.number),
    validation: z
      .object({ minimum: z.number().finite().optional(), maximum: z.number().finite().optional() })
      .strict()
      .optional(),
  })
  .strict();
const dateActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal(actionInputValueTypes.date),
    validation: z
      .object({
        earliest: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        latest: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const dateTimeActionInputSchema = z
  .object({
    ...actionInputBase,
    type: z.literal(actionInputValueTypes.date_time),
    validation: z
      .object({
        earliest: z.string().datetime({ offset: true }).optional(),
        latest: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const actionInputDefinitionSchema = z
  .discriminatedUnion("type", [
    textActionInputSchema,
    formattedTextActionInputSchema,
    numberActionInputSchema,
    z.object({ ...actionInputBase, type: z.literal(actionInputValueTypes.boolean) }).strict(),
    dateActionInputSchema,
    dateTimeActionInputSchema,
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.record_reference),
        recordTypes: z.array(recordTypeReferenceSchema).min(1).max(20),
      })
      .strict(),
    z
      .object({
        ...actionInputBase,
        type: z.literal(actionInputValueTypes.organization_account_reference),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      value.type === "text" &&
      value.validation?.minimumLength !== undefined &&
      value.validation.maximumLength !== undefined &&
      value.validation.minimumLength > value.validation.maximumLength
    )
      context.addIssue({
        code: "custom",
        path: ["validation", "maximumLength"],
        message: "Maximum length cannot be below minimum length",
      });
    if (
      value.type === "number" &&
      value.validation?.minimum !== undefined &&
      value.validation.maximum !== undefined &&
      value.validation.minimum > value.validation.maximum
    )
      context.addIssue({
        code: "custom",
        path: ["validation", "maximum"],
        message: "Maximum cannot be below minimum",
      });
  });
export const actionDefinitionSchema = z
  .object({
    actionId: actionIdSchema,
    key: namespacedKeySchema,
    label: labelSchema,
    subjectRecordTypeId: recordTypeIdSchema,
    permissionKey: namespacedKeySchema.optional(),
    permissionKeys: z.array(namespacedKeySchema).min(2).optional(),
    sharing: z.enum(["refused", "allowed"]),
    inputs: z.array(actionInputDefinitionSchema).max(50),
    precondition: conditionNodeSchema.optional(),
    tasks: z.array(actionTaskSchema).min(1).max(10).superRefine(refineActionTaskIds),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.permissionKey === undefined) === (value.permissionKeys === undefined))
      context.addIssue({
        code: "custom",
        path: ["permissionKeys"],
        message: "An action requires either one permission or canonical alternatives",
      });
    if (value.permissionKeys) {
      if (new Set(value.permissionKeys).size !== value.permissionKeys.length)
        context.addIssue({
          code: "custom",
          path: ["permissionKeys"],
          message: "Action permission alternatives must be unique",
        });
      if (
        value.permissionKeys.some(
          (permission, index) => index > 0 && value.permissionKeys![index - 1]! >= permission,
        )
      )
        context.addIssue({
          code: "custom",
          path: ["permissionKeys"],
          message: "Action permission alternatives must use canonical order",
        });
    }
    if (new Set(value.inputs.map((input) => input.key)).size !== value.inputs.length)
      context.addIssue({
        code: "custom",
        path: ["inputs"],
        message: "Action input keys must be unique",
      });
  });

export const moduleBindingSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    version: versionRequirementSchema,
    resolvedVersion: semanticVersionSchema,
    purpose: builderKeySchema,
    lineageId: lineageIdSchema.optional(),
  })
  .strict();

export const sortSchema = z
  .object({ fieldId: fieldIdSchema, direction: z.enum(["ascending", "descending"]) })
  .strict();
export const aggregateSchema = z
  .object({
    operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
    fieldId: fieldIdSchema.optional(),
    alias: builderKeySchema,
  })
  .strict();
export const queryDefinitionSchema = z
  .object({
    queryId: queryIdSchema,
    key: builderKeySchema,
    recordType: recordTypeReferenceSchema,
    selectedFieldIds: z.array(fieldIdSchema).min(1).max(200),
    filter: conditionNodeSchema.nullable().optional(),
    groupByFieldIds: z.array(fieldIdSchema).max(10),
    aggregates: z.array(aggregateSchema).max(20),
    sort: z.array(sortSchema).min(1).max(20),
    pageSize: z.number().int().min(1).max(200),
    relationshipHops: z.number().int().min(0).max(2),
  })
  .strict();

type NavigationItemValue =
  | {
      id: z.output<typeof containedComponentIdSchema>;
      type: "heading";
      label: string;
      children: NavigationItemValue[];
    }
  | {
      id: z.output<typeof containedComponentIdSchema>;
      type: "page";
      label: string;
      pageId: z.output<typeof pageIdSchema>;
      permissionKey: string;
    }
  | {
      id: z.output<typeof containedComponentIdSchema>;
      type: "external";
      label: string;
      address: string;
      permissionKey: string;
    };
export const navigationItemSchema: z.ZodType<NavigationItemValue> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: containedComponentIdSchema,
        type: z.literal("heading"),
        label: labelSchema,
        children: z.array(navigationItemSchema).min(1),
      })
      .strict(),
    z
      .object({
        id: containedComponentIdSchema,
        type: z.literal("page"),
        label: labelSchema,
        pageId: pageIdSchema,
        permissionKey: namespacedKeySchema,
      })
      .strict(),
    z
      .object({
        id: containedComponentIdSchema,
        type: z.literal("external"),
        label: labelSchema,
        address: safeHttpsUrlSchema,
        permissionKey: namespacedKeySchema,
      })
      .strict(),
  ]),
);

export const calendarMappingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("start_end"),
      startFieldId: fieldIdSchema,
      endFieldId: fieldIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("start_duration"),
      startFieldId: fieldIdSchema,
      durationFieldId: fieldIdSchema,
      durationUnit: z.enum(["minutes", "hours", "days"]),
    })
    .strict(),
]);

const boardCardFieldSchema = z
  .object({ field: fieldIdSchema, label: labelSchema.optional() })
  .strict();
const boardAggregateMetricSchema = z
  .object({ alias: builderKeySchema, label: labelSchema })
  .strict();

/** The closed settings a trusted query-bound board placement may display. */
export const boardPlacementContractSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    choiceField: fieldIdSchema,
    cardTitleField: fieldIdSchema,
    detailFields: z.array(boardCardFieldSchema).max(20),
    aggregateMetrics: z.array(boardAggregateMetricSchema).max(20),
    emptyMessage: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const fields = [value.cardTitleField, ...value.detailFields.map((entry) => entry.field)];
    if (new Set(fields.map((field) => field.toLowerCase())).size !== fields.length)
      context.addIssue({
        code: "custom",
        path: ["detailFields"],
        message: "A board card field is declared once",
      });
    const aliases = value.aggregateMetrics.map((metric) => metric.alias);
    if (new Set(aliases).size !== aliases.length)
      context.addIssue({
        code: "custom",
        path: ["aggregateMetrics"],
        message: "A displayed board aggregate is declared once",
      });
  });

export type BoardPlacementContract = z.infer<typeof boardPlacementContractSchema>;

type BoardSettingValue = ComponentSettingValue;
type BoardSettings = Readonly<Record<string, BoardSettingValue>>;

const boardGroup = (value: BoardSettingValue | undefined): BoardSettings | undefined =>
  value?.kind === "group" ? value.properties : undefined;
const boardItems = (
  value: BoardSettingValue | undefined,
): readonly BoardSettingValue[] | undefined => (value?.kind === "list" ? value.items : undefined);
const boardText = (value: BoardSettingValue | undefined): string | undefined =>
  value?.kind === "text" && value.value.trim().length > 0 ? value.value.trim() : undefined;
const boardField = (value: BoardSettingValue | undefined): string | undefined =>
  value?.kind !== "field_reference"
    ? undefined
    : "fieldId" in value
      ? String(value.fieldId)
      : String(value.field);

/**
 * Reads board settings after the block's shared property validator has accepted them. The reader
 * is also used by publication validation, so server projection and the published mapping agree.
 */
export const readBoardPlacementContract = (
  settings: BoardSettings,
): BoardPlacementContract | undefined => {
  const supportedKeys = new Set([
    "title",
    "choice_field",
    "card_title_field",
    "detail_fields",
    "aggregates",
    "empty_message",
    "refused_message",
    "error_message",
  ]);
  if (Object.keys(settings).some((key) => !supportedKeys.has(key))) return undefined;
  const choiceField = boardField(settings.choice_field);
  const cardTitleField = boardField(settings.card_title_field);
  if (choiceField === undefined || cardTitleField === undefined) return undefined;

  const detailItems = boardItems(settings.detail_fields);
  const aggregateItems = boardItems(settings.aggregates);
  if (
    (settings.detail_fields !== undefined && detailItems === undefined) ||
    (settings.aggregates !== undefined && aggregateItems === undefined)
  )
    return undefined;

  const detailFields: Array<{ field: string; label?: string }> = [];
  for (const item of detailItems ?? []) {
    const group = boardGroup(item);
    const field = group === undefined ? undefined : boardField(group.field);
    if (group === undefined || field === undefined) return undefined;
    const label = boardText(group.label);
    if (group.label !== undefined && label === undefined) return undefined;
    detailFields.push({ field, ...(label === undefined ? {} : { label }) });
  }

  const aggregateMetrics: Array<{ alias: string; label: string }> = [];
  for (const item of aggregateItems ?? []) {
    const group = boardGroup(item);
    const alias = group === undefined ? undefined : boardText(group.alias);
    const label = group === undefined ? undefined : boardText(group.label);
    if (group === undefined || alias === undefined || label === undefined) return undefined;
    aggregateMetrics.push({ alias, label });
  }

  const title = boardText(settings.title);
  const emptyMessage = boardText(settings.empty_message);
  if (
    (settings.title !== undefined && title === undefined) ||
    (settings.empty_message !== undefined && emptyMessage === undefined)
  )
    return undefined;

  const parsed = boardPlacementContractSchema.safeParse({
    ...(title === undefined ? {} : { title }),
    choiceField,
    cardTitleField,
    detailFields,
    aggregateMetrics,
    ...(emptyMessage === undefined ? {} : { emptyMessage }),
  });
  return parsed.success ? parsed.data : undefined;
};

/**
 * Whether the exact published Query and record type can back the declared board. Installed option
 * permissions remain a protected Query concern; publication validates only the bounded published
 * option set, and the Query producer returns the viewer's current installed subset.
 */
export const boardBlockSourceIsSupported = (
  queryCandidate: unknown,
  fieldsCandidate: readonly unknown[],
  contract: BoardPlacementContract,
): boolean => {
  if (
    queryCandidate === null ||
    typeof queryCandidate !== "object" ||
    Array.isArray(queryCandidate) ||
    !Array.isArray(fieldsCandidate)
  )
    return false;
  const query = queryCandidate as Record<string, unknown>;
  if (
    !Array.isArray(query.selectedFieldIds) ||
    !Array.isArray(query.groupByFieldIds) ||
    !Array.isArray(query.aggregates) ||
    typeof query.relationshipHops !== "number" ||
    typeof query.pageSize !== "number" ||
    !Number.isInteger(query.pageSize) ||
    query.pageSize < 1 ||
    query.pageSize > 200 ||
    query.relationshipHops !== 0 ||
    query.groupByFieldIds.length !== 1 ||
    typeof query.groupByFieldIds[0] !== "string" ||
    query.groupByFieldIds[0].toLowerCase() !== contract.choiceField.toLowerCase()
  )
    return false;

  const selected = new Set(
    query.selectedFieldIds.flatMap((fieldId) =>
      typeof fieldId === "string" ? [fieldId.toLowerCase()] : [],
    ),
  );
  if (selected.size !== query.selectedFieldIds.length) return false;
  const displayFields = [
    contract.choiceField,
    contract.cardTitleField,
    ...contract.detailFields.map((entry) => entry.field),
  ];
  if (displayFields.some((fieldId) => !selected.has(fieldId.toLowerCase()))) return false;

  const fieldById = new Map<string, Record<string, unknown>>();
  for (const candidate of fieldsCandidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return false;
    const field = candidate as Record<string, unknown>;
    if (typeof field.fieldId !== "string") return false;
    const key = field.fieldId.toLowerCase();
    if (fieldById.has(key)) return false;
    fieldById.set(key, field);
  }
  const choiceField = fieldById.get(contract.choiceField.toLowerCase());
  const choiceSettings = choiceField?.settings;
  if (
    choiceField?.type !== "choice" ||
    choiceField.filterable !== true ||
    choiceSettings === null ||
    typeof choiceSettings !== "object" ||
    Array.isArray(choiceSettings)
  )
    return false;
  const options = (choiceSettings as Record<string, unknown>).options;
  if (!Array.isArray(options) || options.length < 1 || options.length > 12) return false;
  const optionValues = new Set<string>();
  for (const option of options) {
    if (option === null || typeof option !== "object" || Array.isArray(option)) return false;
    const candidate = option as Record<string, unknown>;
    if (
      typeof candidate.value !== "string" ||
      candidate.value.length < 1 ||
      candidate.value.length > 120 ||
      typeof candidate.label !== "string" ||
      candidate.label.trim().length === 0 ||
      optionValues.has(candidate.value)
    )
      return false;
    optionValues.add(candidate.value);
  }

  for (const fieldId of [
    contract.cardTitleField,
    ...contract.detailFields.map((entry) => entry.field),
  ])
    if (!fieldById.has(fieldId.toLowerCase())) return false;

  const aliases = new Set<string>();
  for (const aggregate of query.aggregates) {
    if (aggregate === null || typeof aggregate !== "object" || Array.isArray(aggregate))
      return false;
    const alias = (aggregate as Record<string, unknown>).alias;
    if (typeof alias !== "string" || aliases.has(alias)) return false;
    aliases.add(alias);
  }
  return contract.aggregateMetrics.every((metric) => aliases.has(metric.alias));
};

/** The closed selector carried by a single board-column continuation request. */
export const boardColumnSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("option"), value: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("unassigned") }).strict(),
]);

/** The browser may name one bucket and its opaque token; every source/authority fact is rebound. */
export const boardColumnContinuationRequestSchema = z
  .object({
    column: boardColumnSelectorSchema,
    continuationToken: z.string().min(1).max(65_536),
  })
  .strict();

export type BoardColumnSelector = z.infer<typeof boardColumnSelectorSchema>;
export type BoardColumnContinuationRequest = z.infer<typeof boardColumnContinuationRequestSchema>;

/** Query shapes and title fields that a query-bound Calendar block can display. */
export const calendarBlockSourceIsSupported = (query: unknown, titleFieldType: unknown): boolean => {
  if (query === null || typeof query !== "object" || Array.isArray(query)) return false;
  const source = query as Record<string, unknown>;
  if (
    !Array.isArray(source.inputs) ||
    !Array.isArray(source.groupByFieldIds) ||
    !Array.isArray(source.aggregates) ||
    typeof source.relationshipHops !== "number"
  )
    return false;
  if (
    source.groupByFieldIds.length > 0 ||
    source.aggregates.length > 0 ||
    source.relationshipHops !== 0
  )
    return false;
  if (
    source.inputs.some(
      (input) =>
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof (input as { required?: unknown }).required !== "boolean" ||
        (input as { required: boolean }).required,
    )
  )
    return false;
  return (
    typeof titleFieldType === "string" &&
    calendarTitleFieldTypes.has(titleFieldType)
  );
};

const calendarTitleFieldTypes: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "formatted_text",
  "whole_number",
  "decimal_number",
  "yes_no",
  "date",
  "date_time",
  "choice",
  "several_choices",
  "reference_number",
  "email_address",
  "phone_number",
  "web_address",
]);

// Retired page settings (#1011): page-level states and standard page replacement, and
// list arrangements and calendar mapping, were compiled but never rendered. The compiler
// no longer emits them. Releases published before their removal still carry them and
// their content fingerprints cover them, so they stay decodable as opaque, unused JSON.
const retiredPageSettingV2Schema = jsonValueSchema.optional();

/**
 * One declared application experience page: a normal page rendered for a fixed state. A
 * refused page and a missing page both resolve to `not_found`, so the two surfaces stay
 * identical and never disclose why an address is unavailable.
 */
export const applicationExperienceV2Schema = z
  .object({ state: applicationExperienceStateSchema, pageId: pageIdSchema })
  .strict();
export type ApplicationExperienceV2 = z.infer<typeof applicationExperienceV2Schema>;

/** Placement bindings that gate, condition or load data; none may appear on an experience page. */
const experienceGatedPlacementKeys = [
  "viewPermissionKey",
  "usePermissionKey",
  "visibilityCondition",
  "queryId",
  "readModel",
] as const;

const declaresGatedPlacement = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(declaresGatedPlacement);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("block" in record && experienceGatedPlacementKeys.some((key) => record[key] !== undefined))
    return true;
  return Object.values(record).some(declaresGatedPlacement);
};

/**
 * An experience page is shown in place of a page the viewer cannot open, before any placement
 * authority or data is projected for it, so it must be presentation-only: neither the page nor
 * the application shell it uses may hold a placement with a view or use permission, a visibility
 * condition, a query or a read model.
 */
export function isPresentationOnlyApplicationExperience(
  page: Readonly<{ composition: Readonly<{ shellKind: string; shellId?: string }> }>,
  shells: readonly Readonly<{ shellId: string; layout: unknown }>[],
): boolean {
  const composition = page.composition;
  if (declaresGatedPlacement(composition)) return false;
  if (composition.shellKind !== "application") return true;
  const shell = shells.find((candidate) => candidate.shellId === composition.shellId);
  return shell !== undefined && !declaresGatedPlacement(shell.layout);
}

const pageV2Common = {
  pageId: pageIdSchema,
  replacementOfPageId: pageIdSchema.optional(),
  key: builderKeySchema,
  name: labelSchema,
  accessPermissionKey: namespacedKeySchema,
  states: retiredPageSettingV2Schema,
  standardPageReplacement: retiredPageSettingV2Schema,
};

const pageV2Base = {
  ...pageV2Common,
  composition: pageCompositionV2Schema,
};

const listPageV2Schema = z
  .object({
    ...pageV2Base,
    type: z.literal("list"),
    recordType: recordTypeReferenceSchema,
    queryId: queryIdSchema,
    arrangements: retiredPageSettingV2Schema,
    calendarMapping: retiredPageSettingV2Schema,
  })
  .strict();

const guidedFormStepV2Schema = z
  .object({
    id: containedComponentIdSchema,
    name: labelSchema,
    summary: z.boolean(),
  })
  .strict();

export const pageDefinitionV2Schema = z.discriminatedUnion("type", [
  listPageV2Schema,
  z
    .object({ ...pageV2Base, type: z.literal("detail"), recordType: recordTypeReferenceSchema })
    .strict(),
  z.object({ ...pageV2Base, type: z.literal("dashboard") }).strict(),
  z
    .object({
      ...pageV2Base,
      type: z.literal("form"),
      recordType: recordTypeReferenceSchema,
    })
    .strict(),
  z
    .object({
      ...pageV2Common,
      type: z.literal("guided_form"),
      recordType: recordTypeReferenceSchema,
      steps: z.array(guidedFormStepV2Schema).min(2).max(20),
      composition: guidedFormPageCompositionV2Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const stepIds = value.steps.map((step) => String(step.id));
      if (value.steps.filter((step) => step.summary).length !== 1)
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: "A guided form has exactly one summary step",
        });
      if (new Set(stepIds).size !== stepIds.length)
        context.addIssue({
          code: "custom",
          path: ["steps"],
          message: "Guided-form step identities must be unique",
        });
      const contentIds = Object.keys(value.composition.stepContent);
      if (
        contentIds.length !== stepIds.length ||
        contentIds.some((stepId) => !stepIds.includes(stepId))
      )
        context.addIssue({
          code: "custom",
          path: ["composition", "stepContent"],
          message: "Guided-form step content must match every declared step exactly once",
        });
    }),
  z
    .object({
      ...pageV2Base,
      type: z.literal("public"),
      recordType: recordTypeReferenceSchema.optional(),
      publicFieldIds: z.array(fieldIdSchema),
      publicActionKey: namespacedKeySchema.optional(),
      rateLimitPerMinute: z.number().int().min(1).max(10_000),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.recordType === undefined &&
        (value.publicFieldIds.length > 0 || value.publicActionKey !== undefined)
      )
        context.addIssue({
          code: "custom",
          path: ["recordType"],
          message: "A public record field or action requires an explicit record type",
        });
    }),
]);

export const applicationRoleSchema = z
  .object({
    roleId: roleIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    homePageId: pageIdSchema,
    permissionKeys: z.array(namespacedKeySchema).min(1),
    permissionSelection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("exact") }).strict(),
      z
        .object({
          kind: z.literal("application_wildcard"),
          catalogueFingerprint: fingerprintSchema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.permissionKeys).size !== value.permissionKeys.length)
      context.addIssue({
        code: "custom",
        path: ["permissionKeys"],
        message: "Compiled application-role permissions must be unique exact keys",
      });
  });
export const applicationConnectionBindingSchema = z
  .object({
    bindingId: containedComponentIdSchema,
    key: builderKeySchema,
    connectionTypeId: connectionTypeIdSchema,
    version: versionRequirementSchema,
    resolvedVersion: semanticVersionSchema,
    requiredOperationKeys: z.array(builderKeySchema).min(1),
  })
  .strict();
export const publicAddressSchema = z
  .object({
    addressId: containedComponentIdSchema,
    pageId: pageIdSchema,
    path: z.string().startsWith("/").max(500),
    state: z.enum(["draft", "active", "disabled"]),
    rateLimitPerMinute: z.number().int().min(1).max(10_000),
  })
  .strict();

export const pipelineSchema = z
  .object({
    pipelineId: pipelineIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    recordType: recordTypeReferenceSchema,
    stageFieldId: fieldIdSchema,
    stages: z
      .array(
        z
          .object({
            key: builderKeySchema,
            label: labelSchema,
            entryActionKeys: z.array(namespacedKeySchema).max(10),
            exitActionKeys: z.array(namespacedKeySchema).max(10),
          })
          .strict(),
      )
      .min(1),
    transitions: z
      .array(
        z
          .object({
            from: builderKeySchema,
            to: builderKeySchema,
            permissionKey: namespacedKeySchema.optional(),
            actionKey: namespacedKeySchema.optional(),
            gate: conditionNodeSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    timeTargets: z.array(
      z
        .object({
          stageKey: builderKeySchema,
          dateTimeFieldId: fieldIdSchema,
          escalationEventKey: namespacedKeySchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const stageKeys = new Set(value.stages.map((stage) => stage.key));
    if (stageKeys.size !== value.stages.length)
      context.addIssue({ code: "custom", path: ["stages"], message: "Stage keys must be unique" });
    for (const [index, transition] of value.transitions.entries()) {
      if (!stageKeys.has(transition.from))
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "from"],
          message: "Transition source stage must resolve inside this pipeline",
        });
      if (!stageKeys.has(transition.to))
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "to"],
          message: "Transition target stage must resolve inside this pipeline",
        });
    }
    for (const [index, target] of value.timeTargets.entries())
      if (!stageKeys.has(target.stageKey))
        context.addIssue({
          code: "custom",
          path: ["timeTargets", index, "stageKey"],
          message: "Time-target stage must resolve inside this pipeline",
        });
  });

/**
 * The definition-wide fields every Application release carries beside its shells, pages,
 * platform-block dependencies and theme. It is the current contract's own base, not a
 * separately decodable representation: only applicationContentV2Schema is ever parsed.
 */
const applicationSharedContentSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    icon: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    moduleBindings: z.array(moduleBindingSchema),
    navigation: z.array(navigationItemSchema),
    experiences: z.array(applicationExperienceV2Schema).max(3).optional(),
    roles: z.array(applicationRoleSchema).min(1),
    queries: z.array(queryDefinitionSchema),
    pipelines: z.array(pipelineSchema),
    permissions: z.array(permissionDeclarationSchema),
    actions: z.array(actionDefinitionSchema),
    events: z.array(eventDefinitionSchema),
    connectionBindings: z.array(applicationConnectionBindingSchema),
    interfaces: z.array(interfaceDefinitionSchema),
    publicAddresses: z.array(publicAddressSchema),
    homePageId: pageIdSchema,
    /** Every flow this Application owns (architecture decision 1); each has one owner. */
    flows: z.array(flowSchema).max(100),
    flowBindings: z.array(componentFlowBindingSchema),
  })
  .strict();

export const applicationContentV2Schema = applicationSharedContentSchema
  .extend({
    platformBlockDependencies: platformBlockDependenciesV2Schema,
    shells: z.array(applicationShellV2Schema),
    pages: z.array(pageDefinitionV2Schema).min(1),
    theme: applicationThemeV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const experiences = value.experiences ?? [];
    for (const issue of inspectApplicationPageReplacements(
      value.pages.map((page) => ({
        identities: [page.pageId],
        type: page.type,
        permission: page.accessPermissionKey,
        replaces: page.replacementOfPageId,
        subject:
          "recordType" in page && page.recordType !== undefined
            ? page.recordType.state === "resolved"
              ? ([page.recordType.moduleRootId, page.recordType.recordTypeId] as const)
              : null
            : undefined,
      })),
    ))
      context.addIssue({
        code: "custom",
        path: ["pages", issue.index, issue.kind === "identity" ? "pageId" : "replacementOfPageId"],
        message: issue.message,
      });
    if (new Set(experiences.map((experience) => experience.state)).size !== experiences.length)
      context.addIssue({
        code: "custom",
        path: ["experiences"],
        message: "Each application experience state may be declared only once",
      });
    for (const [experienceIndex, experience] of experiences.entries()) {
      const page = value.pages.find((candidate) => candidate.pageId === experience.pageId);
      if (page === undefined)
        context.addIssue({
          code: "custom",
          path: ["experiences", experienceIndex, "pageId"],
          message: "An application experience page must resolve inside the same application",
        });
      else if (!isPresentationOnlyApplicationExperience(page, value.shells))
        context.addIssue({
          code: "custom",
          path: ["experiences", experienceIndex, "pageId"],
          message:
            "An application experience page must be presentation-only: no permission-gated, conditional or data-bound placements",
        });
    }
    const shellIds = value.shells.map((shell) => shell.shellId);
    const shellKeys = value.shells.map((shell) => shell.key);
    if (new Set(shellIds).size !== shellIds.length)
      context.addIssue({
        code: "custom",
        path: ["shells"],
        message: "Shell identities must be unique",
      });
    if (new Set(shellKeys).size !== shellKeys.length)
      context.addIssue({ code: "custom", path: ["shells"], message: "Shell keys must be unique" });
    const contentSlotIds = value.shells.flatMap((shell) =>
      shell.contentSlots.map((slot) => slot.slotId),
    );
    if (new Set(contentSlotIds).size !== contentSlotIds.length)
      context.addIssue({
        code: "custom",
        path: ["shells"],
        message: "Shell content-slot identities must be unique across the application",
      });

    const placementEntries = value.shells.flatMap((shell) =>
      canonicalPlacementEntriesV2(shell.layout),
    );
    const shellsById = new Map(value.shells.map((shell) => [String(shell.shellId), shell]));
    const validateShellContent = (
      content: Record<string, { placements: Record<string, unknown> }>,
      shell: (typeof value.shells)[number],
      path: (string | number)[],
    ) => {
      const allowed = new Set(shell.contentSlots.map((slot) => String(slot.slotId)));
      const required = shell.contentSlots
        .filter((slot) => slot.required)
        .map((slot) => String(slot.slotId));
      const supplied = Object.keys(content);
      if (supplied.some((slotId) => !allowed.has(slotId)))
        context.addIssue({
          code: "custom",
          path,
          message: "Page content may bind only slots declared by its shell",
        });
      if (
        required.some((slotId) => {
          const slot = content[slotId];
          return slot === undefined || Object.keys(slot.placements).length === 0;
        })
      )
        context.addIssue({
          code: "custom",
          path,
          message: "Page content must bind non-empty content to every required shell slot",
        });
    };
    for (const [pageIndex, page] of value.pages.entries()) {
      const composition = page.composition;
      if ("stepContent" in composition) {
        if (composition.shellKind === "default") {
          for (const slot of Object.values(composition.stepContent))
            placementEntries.push(...canonicalPlacementEntriesV2(slot));
          continue;
        }
        const shell = shellsById.get(String(composition.shellId));
        if (shell === undefined)
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "composition", "shellId"],
            message: "A page shell must resolve inside the same application",
          });
        for (const [stepId, content] of Object.entries(composition.stepContent)) {
          if (shell !== undefined)
            validateShellContent(content, shell, [
              "pages",
              pageIndex,
              "composition",
              "stepContent",
              stepId,
            ]);
          for (const slot of Object.values(content))
            placementEntries.push(...canonicalPlacementEntriesV2(slot));
        }
        continue;
      }
      if (composition.shellKind === "default")
        placementEntries.push(...canonicalPlacementEntriesV2(composition.main));
      else {
        const shell = shellsById.get(String(composition.shellId));
        if (shell === undefined)
          context.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "composition", "shellId"],
            message: "A page shell must resolve inside the same application",
          });
        else
          validateShellContent(composition.content, shell, [
            "pages",
            pageIndex,
            "composition",
            "content",
          ]);
        for (const slot of Object.values(composition.content))
          placementEntries.push(...canonicalPlacementEntriesV2(slot));
      }
    }

    const placementIds = placementEntries.map(([placementId]) => placementId);
    if (new Set(placementIds).size !== placementIds.length)
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: "Placement identities must be unique across the application",
      });

    const manifest = new Set(
      value.platformBlockDependencies.map(
        (dependency) => `${dependency.blockId}@${dependency.releaseVersion}`,
      ),
    );
    const used = new Set<string>();
    for (const [, placement] of placementEntries) {
      const identity = `${placement.block.blockId}@${placement.block.releaseVersion}`;
      used.add(identity);
      if (!manifest.has(identity))
        context.addIssue({
          code: "custom",
          path: ["platformBlockDependencies"],
          message: "Every placement must match one exact platform-block dependency",
        });
    }
    if ([...manifest].some((identity) => !used.has(identity)))
      context.addIssue({
        code: "custom",
        path: ["platformBlockDependencies"],
        message: "The platform-block dependency list cannot contain unused releases",
      });

    const flowIds = value.flows.map((flow) => String(flow.id));
    const flowKeys = value.flows.map((flow) => flow.key);
    if (new Set(flowIds).size !== flowIds.length)
      context.addIssue({ code: "custom", path: ["flows"], message: "Flow identities must be unique" });
    if (new Set(flowKeys).size !== flowKeys.length)
      context.addIssue({ code: "custom", path: ["flows"], message: "Flow keys must be unique" });

    const flowIdSet = new Set(flowIds);
    const placementIdSet = new Set(placementIds.map(String));
    const flowBindingIds = value.flowBindings.map((binding) => String(binding.bindingId));
    const flowBindingEvents = value.flowBindings.map(
      (binding) => `${String(binding.controlId)}:${String(binding.eventId)}`,
    );
    if (new Set(flowBindingIds).size !== flowBindingIds.length)
      context.addIssue({
        code: "custom",
        path: ["flowBindings"],
        message: "Flow binding identities must be unique",
      });
    if (new Set(flowBindingEvents).size !== flowBindingEvents.length)
      context.addIssue({
        code: "custom",
        path: ["flowBindings"],
        message: "A control event can have only one flow binding",
      });
    for (const [bindingIndex, binding] of value.flowBindings.entries()) {
      if (!flowIdSet.has(String(binding.flow.flowId)))
        context.addIssue({
          code: "custom",
          path: ["flowBindings", bindingIndex, "flow"],
          message: "A flow binding must resolve inside the same application",
        });
      if (!placementIdSet.has(String(binding.controlId)))
        context.addIssue({
          code: "custom",
          path: ["flowBindings", bindingIndex, "controlId"],
          message: "A flow binding control must resolve to a placement inside the application",
        });
    }
  });

export const applicationDraftV2Schema = z
  .object({ envelope: applicationDefinitionEnvelopeSchema, content: applicationContentV2Schema })
  .strict();

/** Standalone V2 canonical content is decoded only with its explicit validation version. */
export const applicationCanonicalDocumentV2Schema = z
  .object({
    validationContractVersion: z.literal("2.0.0"),
    canonical: applicationDraftV2Schema,
  })
  .strict();

export const publishedApplicationDefinitionV2Schema = z
  .object({
    publication: publishedApplicationReferenceSchema.extend({
      validationContractVersion: z.literal("2.0.0"),
    }),
    content: applicationContentV2Schema,
    dependencyManifest: z.array(publishedDefinitionReferenceSchema),
    releaseNote: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) =>
    requireResolvedRecordTypeReferences(applicationContentV2Schema, value.content, context, [
      "content",
    ]),
  )
  .transform(
    (
      value,
    ): Omit<typeof value, "content"> & {
      content: ResolveRecordTypeReferences<typeof value.content>;
    } =>
      value as unknown as Omit<typeof value, "content"> & {
        content: ResolveRecordTypeReferences<typeof value.content>;
      },
  );

/** The sole immutable Application release representation Definition consumers decode. */
export const publishedApplicationDefinitionSchema = publishedApplicationDefinitionV2Schema;

export type QueryDefinition = z.infer<typeof queryDefinitionSchema>;
export type Sort = z.infer<typeof sortSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
export type ModuleBinding = z.infer<typeof moduleBindingSchema>;
export type NavigationItem = z.infer<typeof navigationItemSchema>;
export type CalendarMapping = z.infer<typeof calendarMappingSchema>;
export type PageDefinitionV2 = z.infer<typeof pageDefinitionV2Schema>;
export type ApplicationContentV2 = z.infer<typeof applicationContentV2Schema>;
export type ApplicationDraftV2 = z.infer<typeof applicationDraftV2Schema>;
export type ApplicationCanonicalDocumentV2 = z.infer<typeof applicationCanonicalDocumentV2Schema>;
export type PublishedApplicationDefinitionV2 = z.infer<
  typeof publishedApplicationDefinitionV2Schema
>;
export type PublishedApplicationDefinition = z.infer<typeof publishedApplicationDefinitionSchema>;
export type ApplicationRole = z.infer<typeof applicationRoleSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;
export type ApplicationConnectionBinding = z.infer<typeof applicationConnectionBindingSchema>;
export type PublicAddress = z.infer<typeof publicAddressSchema>;
