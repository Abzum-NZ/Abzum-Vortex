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
  blockIdSchema,
  clusterIdSchema,
  connectionTypeIdSchema,
  containedComponentIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  grantIdSchema,
  lineageIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  pageIdSchema,
  pipelineIdSchema,
  platformIdSchema,
  queryIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  roleIdSchema,
  semanticVersionSchema,
  workflowIdSchema,
} from "./identifiers";
import { jsonValueSchema, labelSchema, safeHttpsUrlSchema } from "./common";
import { permissionDeclarationSchema } from "./permissions";
import {
  applicationShellV2Schema,
  applicationThemeV2Schema,
  canonicalPlacementEntriesV2,
  guidedFormPageCompositionV2Schema,
  pageCompositionV2Schema,
  platformBlockDependenciesV2Schema,
} from "./application-composition-v2";

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

/** A placed block setting is always explicitly literal or one typed platform reference. */
export const blockSettingValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: jsonValueSchema }).strict(),
  z.object({ kind: z.literal("field_reference"), fieldId: fieldIdSchema }).strict(),
  z
    .object({
      kind: z.literal("relationship_reference"),
      relationshipId: containedComponentIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("action_reference"), actionKey: namespacedKeySchema }).strict(),
  z.object({ kind: z.literal("page_reference"), pageId: pageIdSchema }).strict(),
  z.object({ kind: z.literal("query_reference"), queryId: queryIdSchema }).strict(),
  z.object({ kind: z.literal("pipeline_reference"), pipelineId: pipelineIdSchema }).strict(),
  z
    .object({ kind: z.literal("record_type_reference"), recordType: recordTypeReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("record_reference"),
      recordType: recordTypeReferenceSchema,
      recordId: recordIdSchema,
    })
    .strict(),
]);
export const blockSettingDeclarationSchema = z
  .object({
    key: builderKeySchema,
    control: blockSettingControlSchema,
    required: z.boolean(),
  })
  .strict();

/** Used by publication validation to match a registered control to its placed value kind. */
export const blockSettingReferenceKindByControl = Object.freeze({
  data_reading: "query_reference",
  record_type_picker: "record_type_reference",
  record_picker: "record_reference",
  field_picker: "field_reference",
  relationship_picker: "relationship_reference",
  action_picker: "action_reference",
  page_picker: "page_reference",
  process_pipeline_picker: "pipeline_reference",
} as const);

export const blockRegistrationSchema = z
  .object({
    blockId: blockIdSchema,
    releaseVersion: semanticVersionSchema,
    name: labelSchema,
    icon: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    paletteGroup: blockPaletteGroupSchema,
    settings: z.array(blockSettingDeclarationSchema).max(40),
    allowedChildBlockIds: z.array(blockIdSchema),
    phoneBehaviour: z.enum(["stack", "hide", "full_width"]),
    resizableHeight: z.boolean(),
    liveUpdate: z.boolean(),
    publicPage: z.boolean(),
  })
  .strict();

export const blockPlacementSchema = z
  .object({
    placementId: containedComponentIdSchema,
    blockId: blockIdSchema,
    blockReleaseVersion: semanticVersionSchema,
    settings: z.record(builderKeySchema, blockSettingValueSchema),
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
    queryId: queryIdSchema.optional(),
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
    queryId: queryIdSchema,
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

const pageV2Common = {
  pageId: pageIdSchema,
  key: builderKeySchema,
  name: labelSchema,
  accessPermissionKey: namespacedKeySchema,
  states: z.array(pageStateSchema).min(1),
  standardPageReplacement: standardPageReplacementSchema.optional(),
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
      commitActionKey: namespacedKeySchema,
    })
    .strict(),
  z
    .object({
      ...pageV2Common,
      type: z.literal("guided_form"),
      recordType: recordTypeReferenceSchema,
      commitActionKey: namespacedKeySchema,
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
            entryWorkflowIds: z.array(workflowIdSchema).max(10),
            exitWorkflowIds: z.array(workflowIdSchema).max(10),
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

export const applicationContentV1Schema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    icon: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    moduleBindings: z.array(moduleBindingSchema).min(1),
    navigation: z.array(navigationItemSchema),
    pages: z.array(pageDefinitionSchema).min(1),
    roles: z.array(applicationRoleSchema).min(1),
    queries: z.array(queryDefinitionSchema),
    blockRegistrations: z.array(blockRegistrationSchema),
    pipelines: z.array(pipelineSchema),
    permissions: z.array(permissionDeclarationSchema),
    actions: z.array(actionDefinitionSchema),
    rules: z.array(ruleDefinitionSchema),
    events: z.array(eventDefinitionSchema),
    workflows: z.array(workflowDefinitionSchema),
    connectionBindings: z.array(applicationConnectionBindingSchema),
    interfaces: z.array(interfaceDefinitionSchema),
    publicAddresses: z.array(publicAddressSchema),
    theme: themeSchema,
    homePageId: pageIdSchema,
  })
  .strict();

export const applicationContentV2Schema = applicationContentV1Schema
  .omit({ pages: true, blockRegistrations: true, theme: true })
  .extend({
    platformBlockDependencies: platformBlockDependenciesV2Schema,
    shells: z.array(applicationShellV2Schema),
    pages: z.array(pageDefinitionV2Schema).min(1),
    theme: applicationThemeV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
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

    const manifest = new Map(
      value.platformBlockDependencies.map((dependency) => [
        String(dependency.blockId),
        dependency.releaseVersion,
      ]),
    );
    const used = new Set<string>();
    for (const [, placement] of placementEntries) {
      const blockId = String(placement.block.blockId);
      used.add(blockId);
      if (manifest.get(blockId) !== placement.block.releaseVersion)
        context.addIssue({
          code: "custom",
          path: ["platformBlockDependencies"],
          message: "Every placement must match one exact platform-block dependency",
        });
    }
    if ([...manifest.keys()].some((blockId) => !used.has(blockId)))
      context.addIssue({
        code: "custom",
        path: ["platformBlockDependencies"],
        message: "The platform-block dependency list cannot contain unused releases",
      });
  });

/** Backward-compatible name for the currently implemented canonical Application content. */
export const applicationContentSchema = applicationContentV1Schema;

export const applicationDraftV1Schema = z
  .object({ envelope: applicationDefinitionEnvelopeSchema, content: applicationContentV1Schema })
  .strict();
/** Backward-compatible name for the currently implemented canonical Application draft. */
export const applicationDraftSchema = applicationDraftV1Schema;

export const publishedApplicationDefinitionV1Schema = z
  .object({
    publication: publishedApplicationReferenceSchema,
    content: applicationContentV1Schema,
    dependencyManifest: z.array(publishedDefinitionReferenceSchema),
    releaseNote: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) =>
    requireResolvedRecordTypeReferences(applicationContentV1Schema, value.content, context, [
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

/** Backward-compatible name for the currently implemented published Application contract. */
export const publishedApplicationDefinitionSchema = publishedApplicationDefinitionV1Schema;

export const sharedRecordProjectionSchema = z
  .object({
    sourceClusterId: clusterIdSchema,
    sourceOrganizationId: organizationIdSchema,
    grantId: grantIdSchema,
    recordTypeId: recordTypeIdSchema,
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
export type PageDefinitionV2 = z.infer<typeof pageDefinitionV2Schema>;
export type ApplicationContent = z.infer<typeof applicationContentSchema>;
export type ApplicationContentV2 = z.infer<typeof applicationContentV2Schema>;
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;
export type PublishedApplicationDefinition = z.infer<typeof publishedApplicationDefinitionSchema>;
export type BlockSettingValue = z.infer<typeof blockSettingValueSchema>;
export type BlockSettingDeclaration = z.infer<typeof blockSettingDeclarationSchema>;
export type BlockRegistration = z.infer<typeof blockRegistrationSchema>;
export type BlockPlacement = z.infer<typeof blockPlacementSchema>;
export type ResponsivePageLayout = z.infer<typeof responsivePageLayoutSchema>;
export type StandardPageReplacement = z.infer<typeof standardPageReplacementSchema>;
export type ApplicationRole = z.infer<typeof applicationRoleSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;
export type ApplicationConnectionBinding = z.infer<typeof applicationConnectionBindingSchema>;
export type PublicAddress = z.infer<typeof publicAddressSchema>;
export type SharedRecordProjection = z.infer<typeof sharedRecordProjectionSchema>;
