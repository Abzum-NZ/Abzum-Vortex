import { z } from "zod";
import {
  applicationDefinitionEnvelopeSchema,
  publishedApplicationReferenceSchema,
  publishedDefinitionReferenceSchema,
  recordTypeReferenceSchema,
  requireResolvedRecordTypeReferences,
  versionRequirementSchema,
} from "./definitions";
import type { ResolveRecordTypeReferences } from "./definitions";
import {
  blockPaletteGroupSchema,
  blockSettingControlSchema,
  listArrangementSchema,
  pageStateSchema,
} from "./catalogues";
import {
  actionDefinitionSchema,
  conditionNodeSchema,
  eventDefinitionSchema,
  ruleDefinitionSchema,
} from "./module-contracts";
import { workflowDefinitionSchema } from "./automation-contracts";
import { interfaceDefinitionSchema } from "./integration-contracts";
import {
  builderKeySchema,
  connectionTypeIdSchema,
  containedComponentIdSchema,
  fieldIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  pageIdSchema,
  platformIdSchema,
  recordIdSchema,
  roleIdSchema,
  semanticVersionSchema,
} from "./identifiers";
import { jsonValueSchema, labelSchema, safeHttpsUrlSchema } from "./common";

export const moduleBindingSchema = z
  .object({
    moduleRootId: moduleRootIdSchema,
    version: versionRequirementSchema,
    resolvedVersion: semanticVersionSchema,
    purpose: builderKeySchema,
    lineageId: platformIdSchema.optional(),
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
    queryId: platformIdSchema,
    key: builderKeySchema,
    recordType: recordTypeReferenceSchema,
    selectedFieldIds: z.array(fieldIdSchema).min(1).max(200),
    filter: conditionNodeSchema.optional(),
    groupByFieldIds: z.array(fieldIdSchema).max(10),
    aggregates: z.array(aggregateSchema).max(20),
    sort: z.array(sortSchema).min(1).max(20),
    pageSize: z.number().int().min(1).max(200),
    relationshipHops: z.number().int().min(0).max(2),
  })
  .strict();

type NavigationItemValue =
  | {
      id: typeof containedComponentIdSchema._output;
      type: "heading";
      label: string;
      children: NavigationItemValue[];
    }
  | {
      id: typeof containedComponentIdSchema._output;
      type: "page";
      label: string;
      pageId: typeof pageIdSchema._output;
      permissionKey: string;
    }
  | {
      id: typeof containedComponentIdSchema._output;
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

export const blockRegistrationSchema = z
  .object({
    blockId: platformIdSchema,
    releaseVersion: semanticVersionSchema,
    name: labelSchema,
    icon: builderKeySchema,
    paletteGroup: blockPaletteGroupSchema,
    settings: z
      .array(
        z
          .object({
            key: builderKeySchema,
            control: blockSettingControlSchema,
            required: z.boolean(),
          })
          .strict(),
      )
      .max(40),
    allowedChildBlockIds: z.array(platformIdSchema),
    phoneBehaviour: z.enum(["stack", "hide", "full_width"]),
    resizableHeight: z.boolean(),
    liveUpdate: z.boolean(),
    publicPage: z.boolean(),
  })
  .strict();

export const blockPlacementSchema = z
  .object({
    placementId: containedComponentIdSchema,
    blockId: platformIdSchema,
    blockReleaseVersion: semanticVersionSchema,
    settings: z.record(builderKeySchema, jsonValueSchema),
    desktop: z
      .object({
        startColumn: z.number().int().min(1).max(12),
        span: z.number().int().min(1).max(12),
        height: z.number().int().positive(),
      })
      .strict(),
    phone: z
      .object({
        order: z.number().int().min(0),
        behaviour: z.enum(["stack", "hide", "full_width"]),
      })
      .strict(),
    visibilityCondition: conditionNodeSchema.optional(),
    viewPermissionKey: namespacedKeySchema,
    usePermissionKey: namespacedKeySchema.optional(),
    queryId: platformIdSchema.optional(),
  })
  .strict()
  .refine((value) => value.desktop.startColumn + value.desktop.span <= 13, {
    path: ["desktop", "span"],
    message: "Block exceeds the twelve-column grid",
  });

export const responsivePageLayoutSchema = z
  .object({
    desktop: z
      .object({
        columns: z.literal(12),
        componentOrder: z.array(containedComponentIdSchema).max(200),
      })
      .strict(),
    phone: z.object({ componentOrder: z.array(containedComponentIdSchema).max(200) }).strict(),
  })
  .strict();
export const standardPageReplacementSchema = z
  .object({
    standardPage: z.enum(["list", "detail", "create_form"]),
    recordType: recordTypeReferenceSchema,
  })
  .strict();

const pageBase = {
  pageId: pageIdSchema,
  key: builderKeySchema,
  name: labelSchema,
  accessPermissionKey: namespacedKeySchema,
  states: z.array(pageStateSchema).min(1),
  layout: responsivePageLayoutSchema,
  standardPageReplacement: standardPageReplacementSchema.optional(),
};
const listPageSchema = z
  .object({
    ...pageBase,
    type: z.literal("list"),
    recordType: recordTypeReferenceSchema,
    queryId: platformIdSchema,
    arrangements: z.array(listArrangementSchema).min(1),
    calendarMapping: calendarMappingSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const usesCalendar = value.arrangements.includes("calendar");
    if (usesCalendar !== (value.calendarMapping !== undefined))
      context.addIssue({
        code: "custom",
        path: ["calendarMapping"],
        message: "Calendar mapping is required exactly when the calendar arrangement is enabled",
      });
  });
const detailPageSchema = z
  .object({
    ...pageBase,
    type: z.literal("detail"),
    recordType: recordTypeReferenceSchema,
    blocks: z.array(blockPlacementSchema).min(1).max(200),
  })
  .strict();
const dashboardPageSchema = z
  .object({
    ...pageBase,
    type: z.literal("dashboard"),
    blocks: z.array(blockPlacementSchema).min(1).max(200),
  })
  .strict();
const formPageSchema = z
  .object({
    ...pageBase,
    type: z.literal("form"),
    recordType: recordTypeReferenceSchema,
    commitActionKey: namespacedKeySchema,
    blocks: z.array(blockPlacementSchema).min(1).max(200),
  })
  .strict();
const guidedFormPageSchema = z
  .object({
    ...pageBase,
    type: z.literal("guided_form"),
    recordType: recordTypeReferenceSchema,
    commitActionKey: namespacedKeySchema,
    steps: z
      .array(
        z
          .object({
            id: containedComponentIdSchema,
            name: labelSchema,
            summary: z.boolean(),
            blocks: z.array(blockPlacementSchema).min(1).max(40),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict()
  .refine((value) => value.steps.filter((step) => step.summary).length === 1, {
    path: ["steps"],
    message: "A guided form has exactly one summary step",
  });
const publicPageSchema = z
  .object({
    ...pageBase,
    type: z.literal("public"),
    recordType: recordTypeReferenceSchema.optional(),
    publicFieldIds: z.array(fieldIdSchema),
    publicActionKey: namespacedKeySchema.optional(),
    blocks: z.array(blockPlacementSchema).min(1).max(40),
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
  });
export const pageDefinitionSchema = z.discriminatedUnion("type", [
  listPageSchema,
  detailPageSchema,
  dashboardPageSchema,
  formPageSchema,
  guidedFormPageSchema,
  publicPageSchema,
]);

export const applicationRoleSchema = z
  .object({
    roleId: roleIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    homePageId: pageIdSchema,
    permissionKeys: z.array(namespacedKeySchema).min(1),
  })
  .strict();
export const themeSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("platform"),
      catalogueThemeId: platformIdSchema,
      version: semanticVersionSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("application"),
      lightAndDark: z.boolean(),
      tokens: z
        .object({
          brand: builderKeySchema,
          density: z.enum(["compact", "comfortable"]),
          corners: z.enum(["square", "small", "medium", "large"]),
          focus: z.literal("high_contrast"),
        })
        .strict(),
    })
    .strict(),
]);
export const motionDefinitionSchema = z
  .object({
    library: z.literal("motion/react"),
    simpleFeedback: z.literal("css"),
    featureLoading: z.literal("lazy"),
    tokenSet: z.literal("platform_default"),
    semanticTokens: z.tuple([
      z.literal("feedback"),
      z.literal("enter_exit"),
      z.literal("refresh"),
      z.literal("panel"),
      z.literal("page"),
      z.literal("layout_spring"),
    ]),
    currentStateWins: z.literal(true),
    reducedMotion: z.literal("required"),
    experimentalViewTransitions: z.literal(false),
  })
  .strict();

export const applicationConnectionBindingSchema = z
  .object({
    bindingId: containedComponentIdSchema,
    key: builderKeySchema,
    connectionTypeId: connectionTypeIdSchema,
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
    pipelineId: platformIdSchema,
    key: builderKeySchema,
    name: labelSchema,
    recordType: recordTypeReferenceSchema,
    stageFieldId: fieldIdSchema,
    stages: z.array(z.object({ key: builderKeySchema, label: labelSchema }).strict()).min(1),
    transitions: z
      .array(
        z
          .object({
            from: builderKeySchema,
            to: builderKeySchema,
            permissionKey: namespacedKeySchema.optional(),
            actionKey: namespacedKeySchema.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const applicationContentSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    icon: builderKeySchema,
    moduleBindings: z.array(moduleBindingSchema).min(1),
    navigation: z.array(navigationItemSchema),
    pages: z.array(pageDefinitionSchema).min(1),
    roles: z.array(applicationRoleSchema).min(1),
    queries: z.array(queryDefinitionSchema),
    blockRegistrations: z.array(blockRegistrationSchema),
    pipelines: z.array(pipelineSchema),
    permissionKeys: z.array(namespacedKeySchema),
    actions: z.array(actionDefinitionSchema),
    rules: z.array(ruleDefinitionSchema),
    events: z.array(eventDefinitionSchema),
    workflows: z.array(workflowDefinitionSchema),
    connectionBindings: z.array(applicationConnectionBindingSchema),
    interfaces: z.array(interfaceDefinitionSchema),
    publicAddresses: z.array(publicAddressSchema),
    theme: themeSchema,
    motion: motionDefinitionSchema,
    homePageId: pageIdSchema,
  })
  .strict();
export const applicationDraftSchema = z
  .object({ envelope: applicationDefinitionEnvelopeSchema, content: applicationContentSchema })
  .strict();
export const publishedApplicationDefinitionSchema = z
  .object({
    publication: publishedApplicationReferenceSchema,
    content: applicationContentSchema,
    dependencyManifest: z.array(publishedDefinitionReferenceSchema),
    releaseNote: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) =>
    requireResolvedRecordTypeReferences(value.content, context, ["content"]),
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

export const sharedRecordProjectionSchema = z
  .object({
    sourceClusterId: platformIdSchema,
    sourceOrganizationId: platformIdSchema,
    grantId: platformIdSchema,
    recordTypeId: platformIdSchema,
    recordId: recordIdSchema,
    concurrencyNumber: z.number().int().positive(),
    fields: z.record(fieldIdSchema, jsonValueSchema),
    allowedActionKeys: z.array(namespacedKeySchema),
  })
  .strict();

export type QueryDefinition = z.infer<typeof queryDefinitionSchema>;
export type Sort = z.infer<typeof sortSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
export type ModuleBinding = z.infer<typeof moduleBindingSchema>;
export type NavigationItem = z.infer<typeof navigationItemSchema>;
export type CalendarMapping = z.infer<typeof calendarMappingSchema>;
export type PageDefinition = z.infer<typeof pageDefinitionSchema>;
export type ApplicationContent = z.infer<typeof applicationContentSchema>;
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;
export type PublishedApplicationDefinition = z.infer<typeof publishedApplicationDefinitionSchema>;
export type BlockRegistration = z.infer<typeof blockRegistrationSchema>;
export type BlockPlacement = z.infer<typeof blockPlacementSchema>;
export type ResponsivePageLayout = z.infer<typeof responsivePageLayoutSchema>;
export type StandardPageReplacement = z.infer<typeof standardPageReplacementSchema>;
export type ApplicationRole = z.infer<typeof applicationRoleSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type MotionDefinition = z.infer<typeof motionDefinitionSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;
export type ApplicationConnectionBinding = z.infer<typeof applicationConnectionBindingSchema>;
export type PublicAddress = z.infer<typeof publicAddressSchema>;
export type SharedRecordProjection = z.infer<typeof sharedRecordProjectionSchema>;
