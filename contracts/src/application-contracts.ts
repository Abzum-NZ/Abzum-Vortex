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
import { listArrangementSchema, pageStateSchema } from "./catalogues";
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
import {
  componentFlowBindingSchema,
  currentUserFlowSchema,
  flowTargetDependencySchema,
  platformManagedFlowDependencySchema,
} from "./application-flow-bindings";

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

export const standardPageReplacementSchema = z
  .object({
    standardPage: z.enum(["list", "detail", "create_form"]),
    recordType: recordTypeReferenceSchema,
  })
  .strict();

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
    roles: z.array(applicationRoleSchema).min(1),
    queries: z.array(queryDefinitionSchema),
    pipelines: z.array(pipelineSchema),
    permissions: z.array(permissionDeclarationSchema),
    actions: z.array(actionDefinitionSchema),
    rules: z.array(ruleDefinitionSchema),
    events: z.array(eventDefinitionSchema),
    workflows: z.array(workflowDefinitionSchema),
    connectionBindings: z.array(applicationConnectionBindingSchema),
    interfaces: z.array(interfaceDefinitionSchema),
    publicAddresses: z.array(publicAddressSchema),
    homePageId: pageIdSchema,
    flows: z.array(currentUserFlowSchema),
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

    const flowIds = value.flows.map((flow) => String(flow.flowId));
    const flowKeys = value.flows.map((flow) => flow.key);
    if (new Set(flowIds).size !== flowIds.length)
      context.addIssue({ code: "custom", path: ["flows"], message: "Flow identities must be unique" });
    if (new Set(flowKeys).size !== flowKeys.length)
      context.addIssue({ code: "custom", path: ["flows"], message: "Flow keys must be unique" });

    const flowsById = new Map(value.flows.map((flow) => [String(flow.flowId), flow]));
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
      if (binding.flow.kind === "application_owned") {
        const flow = flowsById.get(String(binding.flow.flowId));
        if (flow === undefined) {
          context.addIssue({
            code: "custom",
            path: ["flowBindings", bindingIndex, "flow"],
            message: "A flow binding must resolve inside the same application",
          });
        }
      }
      if (!placementIdSet.has(String(binding.controlId))) {
        context.addIssue({
          code: "custom",
          path: ["flowBindings", bindingIndex, "controlId"],
          message: "A flow binding control must resolve to a placement inside the application",
        });
      }
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
    dependencyManifest: z.array(
      z.union([
        publishedDefinitionReferenceSchema,
        flowTargetDependencySchema,
        platformManagedFlowDependencySchema,
      ]),
    ),
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
export type PageDefinitionV2 = z.infer<typeof pageDefinitionV2Schema>;
export type ApplicationContentV2 = z.infer<typeof applicationContentV2Schema>;
export type ApplicationDraftV2 = z.infer<typeof applicationDraftV2Schema>;
export type ApplicationCanonicalDocumentV2 = z.infer<typeof applicationCanonicalDocumentV2Schema>;
export type PublishedApplicationDefinitionV2 = z.infer<
  typeof publishedApplicationDefinitionV2Schema
>;
export type PublishedApplicationDefinition = z.infer<typeof publishedApplicationDefinitionSchema>;
export type StandardPageReplacement = z.infer<typeof standardPageReplacementSchema>;
export type ApplicationRole = z.infer<typeof applicationRoleSchema>;
export type Pipeline = z.infer<typeof pipelineSchema>;
export type ApplicationConnectionBinding = z.infer<typeof applicationConnectionBindingSchema>;
export type PublicAddress = z.infer<typeof publicAddressSchema>;
export type SharedRecordProjection = z.infer<typeof sharedRecordProjectionSchema>;
