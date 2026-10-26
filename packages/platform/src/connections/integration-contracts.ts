import { z } from "zod";
import { secretReferenceSchema } from "../catalogue/common";
import {
  activityIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  connectionInstanceIdSchema,
  connectionTypeIdSchema,
  fieldIdSchema,
  fingerprintSchema,
  interfaceIdSchema,
  namespacedKeySchema,
  organizationIdSchema,
  platformIdSchema,
  revisionSchema,
  ruleIdSchema,
  semanticVersionSchema,
  timestampSchema,
  workflowRunIdSchema,
} from "../catalogue/identifiers";

export const connectionAuthenticationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("oauth2"),
      secretFieldKeys: z.array(builderKeySchema).min(1),
      scopes: z.array(z.string().min(1).max(200)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("signed_secret"),
      secretFieldKeys: z.array(builderKeySchema).min(1),
      algorithm: z.enum(["hmac_sha256", "ed25519"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("api_key"),
      secretFieldKeys: z.array(builderKeySchema).min(1),
      placement: z.enum(["header", "query"]),
    })
    .strict(),
]);
export const connectionShapeFieldSchema = z
  .object({
    key: builderKeySchema,
    type: z.enum([
      "text",
      "whole_number",
      "decimal_number",
      "yes_no",
      "date",
      "date_time",
      "record_reference",
      "json",
    ]),
    required: z.boolean(),
  })
  .strict();
export const connectionShapeSchema = z
  .object({
    key: builderKeySchema,
    fields: z.array(connectionShapeFieldSchema).max(100),
  })
  .strict();
export const connectionOperationSchema = z
  .object({
    key: builderKeySchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    pathTemplate: z.string().startsWith("/").max(500),
    inputShapeKey: builderKeySchema,
    outputShapeKey: builderKeySchema,
    timeoutSeconds: z.number().int().min(1).max(120),
    maximumAttempts: z.number().int().min(1).max(10),
    maximumResponseBytes: z.number().int().min(1).max(100_000_000),
  })
  .strict();
export const incomingMessageTypeSchema = z
  .object({
    key: builderKeySchema,
    signature: z.enum(["hmac_sha256", "ed25519"]),
    replayWindowSeconds: z.number().int().min(1).max(86_400),
    inputShapeKey: builderKeySchema,
    workflowTriggerKey: builderKeySchema,
  })
  .strict();
export const connectionTypeSchema = z
  .object({
    connectionTypeId: connectionTypeIdSchema,
    key: namespacedKeySchema,
    version: semanticVersionSchema,
    name: z.string().min(1).max(120),
    purpose: z.string().min(1).max(1_000),
    provider: z.string().min(1).max(120),
    authentication: connectionAuthenticationSchema,
    allowedHosts: z
      .array(
        z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9.-]+$/),
      )
      .min(1),
    allowRedirects: z.boolean(),
    shapes: z.array(connectionShapeSchema).min(1),
    operations: z.array(connectionOperationSchema).min(1),
    incomingMessages: z.array(incomingMessageTypeSchema),
    healthOperationKey: builderKeySchema.optional(),
    revocationOperationKey: builderKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const shapeKeys = new Set(value.shapes.map((shape) => shape.key));
    const operationKeys = new Set(value.operations.map((operation) => operation.key));
    if (shapeKeys.size !== value.shapes.length)
      context.addIssue({
        code: "custom",
        path: ["shapes"],
        message: "Connection shape keys must be unique",
      });
    for (const [index, shape] of value.shapes.entries())
      if (new Set(shape.fields.map((field) => field.key)).size !== shape.fields.length)
        context.addIssue({
          code: "custom",
          path: ["shapes", index, "fields"],
          message: "Connection shape field keys must be unique",
        });
    if (operationKeys.size !== value.operations.length)
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Connection operation keys must be unique",
      });
    for (const [index, operation] of value.operations.entries()) {
      if (!shapeKeys.has(operation.inputShapeKey))
        context.addIssue({
          code: "custom",
          path: ["operations", index, "inputShapeKey"],
          message: "Input shape must resolve inside this connection type",
        });
      if (!shapeKeys.has(operation.outputShapeKey))
        context.addIssue({
          code: "custom",
          path: ["operations", index, "outputShapeKey"],
          message: "Output shape must resolve inside this connection type",
        });
    }
    for (const [index, message] of value.incomingMessages.entries())
      if (!shapeKeys.has(message.inputShapeKey))
        context.addIssue({
          code: "custom",
          path: ["incomingMessages", index, "inputShapeKey"],
          message: "Incoming-message shape must resolve inside this connection type",
        });
    for (const [property, key] of [
      ["healthOperationKey", value.healthOperationKey],
      ["revocationOperationKey", value.revocationOperationKey],
    ] as const)
      if (key !== undefined && !operationKeys.has(key))
        context.addIssue({
          code: "custom",
          path: [property],
          message: "Named lifecycle operation must resolve inside this connection type",
        });
  });
export const connectionInstanceSchema = z
  .object({
    connectionInstanceId: connectionInstanceIdSchema,
    organizationId: organizationIdSchema,
    connectionTypeId: connectionTypeIdSchema,
    connectionTypeVersion: semanticVersionSchema,
    secretReference: secretReferenceSchema,
    authorizedApplicationIds: z.array(applicationRootIdSchema).min(1),
    state: z.enum(["pending", "active", "unhealthy", "revoked"]),
    grantedScopes: z.array(z.string().min(1).max(200)),
    tokenExpiresAt: timestampSchema.optional(),
    lastHealthOutcome: z.enum(["healthy", "unhealthy", "unknown"]),
    administratorActivityId: activityIdSchema,
  })
  .strict();
/**
 * The page read model of one connection instance, deliberately separate from
 * `connectionInstanceSchema`. It carries only what an administration page may render: the state, the
 * last health outcome, the credential expiry, the authority revision the revision-checking
 * administration commands must send unchanged, and both scope lists. It never carries a secret
 * reference, an organisation identity or an administrator activity identity, and it permits an
 * instance with no authorised application and no granted scope, so a grant-less instance is shown as
 * such instead of being refused. A reader that returns a value outside this closed shape fails
 * closed before the page projects it.
 */
export const connectionInstanceStatusSchema = z
  .object({
    connectionInstanceId: connectionInstanceIdSchema,
    connectionTypeId: connectionTypeIdSchema,
    connectionTypeVersion: semanticVersionSchema,
    state: z.enum(["pending", "active", "unhealthy", "revoked"]),
    lastHealthOutcome: z.enum(["healthy", "unhealthy", "unknown"]),
    revision: revisionSchema,
    tokenExpiresAt: timestampSchema.optional(),
    authorizedApplicationIds: z.array(applicationRootIdSchema),
    grantedScopes: z.array(z.string().min(1).max(200)),
  })
  .strict();
export const incomingMessageSchema = z
  .object({
    organizationId: organizationIdSchema,
    connectionInstanceId: connectionInstanceIdSchema,
    messageTypeKey: builderKeySchema,
    providerMessageId: z.string().min(1).max(500).optional(),
    payloadFingerprint: fingerprintSchema,
    verifiedAt: timestampSchema,
    safePayloadReference: secretReferenceSchema,
    duplicateState: z.enum(["new", "duplicate"]),
    workflowRunId: workflowRunIdSchema.optional(),
    retentionDueAt: timestampSchema,
  })
  .strict();

export const interfaceValueTypeSchema = z.enum([
  "text",
  "whole_number",
  "decimal_number",
  "money",
  "yes_no",
  "date",
  "date_time",
  "record_reference",
]);
export const interfaceInputFieldSchema = z
  .object({
    type: z.union([interfaceValueTypeSchema, z.literal("formatted_text")]),
    required: z.boolean(),
    targetBinding: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("action_subject") }).strict(),
      z.object({ kind: z.literal("action_input"), key: builderKeySchema }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetBinding.kind === "action_subject" && value.type !== "record_reference")
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "An action subject input is a record reference",
      });
  });
export const interfaceOutputFieldSchema = z
  .object({
    type: interfaceValueTypeSchema,
    required: z.boolean(),
    targetBinding: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("query_field"), fieldId: fieldIdSchema }).strict(),
      z
        .object({
          kind: z.literal("query_page_information"),
          value: z.enum(["continuation_token", "has_more", "result_count"]),
        })
        .strict(),
      z.object({ kind: z.literal("workflow_run_id") }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetBinding.kind === "workflow_run_id" && value.type !== "text")
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "A workflow run identifier is text",
      });
    if (
      value.targetBinding.kind === "query_page_information" &&
      ((value.targetBinding.value === "continuation_token" && value.type !== "text") ||
        (value.targetBinding.value === "has_more" && value.type !== "yes_no") ||
        (value.targetBinding.value === "result_count" && value.type !== "whole_number"))
    )
      context.addIssue({
        code: "custom",
        path: ["type"],
        message: "Query page information has a fixed value type",
      });
  });
export const interfaceOperationSchema = z
  .object({
    operationId: platformIdSchema,
    key: builderKeySchema,
    description: z.string().min(1).max(1_000),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/").max(500),
    inputShape: z.record(builderKeySchema, interfaceInputFieldSchema),
    outputShape: z.record(builderKeySchema, interfaceOutputFieldSchema),
    authentication: z.enum(["organization_token", "partner_token", "public"]),
    permissionKey: namespacedKeySchema,
    visibility: z.enum(["organization_private", "partner", "public"]),
    rateLimitPerMinute: z.number().int().min(1).max(100_000),
    maximumRequestBytes: z.number().int().min(1).max(100_000_000),
    duplicateProtection: z.enum(["not_required", "required"]),
    /**
     * What the operation calls. A change or background start names an application-owned flow entry
     * point (a one-task flow by default) and never a lower-level action or workflow, so a published
     * interface and the web and agent surfaces that start the same flow share one start path. A
     * read names a declared query, which the Query engine runs directly under the caller's access.
     * Definition validation resolves the flow and checks the shape against the work it commits.
     */
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("flow"), flowId: ruleIdSchema }).strict(),
      z.object({ kind: z.literal("query"), key: builderKeySchema }).strict(),
    ]),
    errorCodes: z.array(builderKeySchema),
  })
  .strict()
  .superRefine((value, context) => {
    // A flow entry point takes a named-action subject and inputs or returns its run identifier; a
    // query takes nothing and returns its fields. Validation decides which flow entry point it is.
    const inputKinds = new Set(
      Object.values(value.inputShape).map((field) => field.targetBinding.kind),
    );
    const outputKinds = new Set(
      Object.values(value.outputShape).map((field) => field.targetBinding.kind),
    );
    const allowedInputKinds = {
      flow: new Set(["action_subject", "action_input"]),
      query: new Set(),
    }[value.target.kind];
    const allowedOutputKinds = {
      flow: new Set(["workflow_run_id"]),
      query: new Set(["query_field", "query_page_information"]),
    }[value.target.kind];
    for (const kind of inputKinds)
      if (!allowedInputKinds.has(kind))
        context.addIssue({
          code: "custom",
          path: ["inputShape"],
          message: `A ${value.target.kind} interface accepts only ${value.target.kind} input bindings`,
        });
    for (const kind of outputKinds)
      if (!allowedOutputKinds.has(kind))
        context.addIssue({
          code: "custom",
          path: ["outputShape"],
          message: `A ${value.target.kind} interface accepts only ${value.target.kind} output bindings`,
        });
  });
export const interfaceDefinitionSchema = z
  .object({
    interfaceId: interfaceIdSchema,
    key: namespacedKeySchema,
    version: semanticVersionSchema,
    state: z.enum(["supported", "deprecated", "removal_scheduled", "removed"]),
    operations: z.array(interfaceOperationSchema).min(1),
  })
  .strict();
export const interfaceDependencySchema = z
  .object({
    interfaceId: interfaceIdSchema,
    minimumVersion: semanticVersionSchema,
    maximumVersion: semanticVersionSchema.optional(),
  })
  .strict();

export const federatedRefusalCodeSchema = z.enum([
  "access_refused",
  "grant_inactive",
  "request_invalid",
]);

export type ConnectionType = z.infer<typeof connectionTypeSchema>;
export type ConnectionAuthentication = z.infer<typeof connectionAuthenticationSchema>;
export type ConnectionOperation = z.infer<typeof connectionOperationSchema>;
export type IncomingMessageType = z.infer<typeof incomingMessageTypeSchema>;
export type ConnectionInstance = z.infer<typeof connectionInstanceSchema>;
export type ConnectionInstanceStatus = z.infer<typeof connectionInstanceStatusSchema>;
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type InterfaceValueType = z.infer<typeof interfaceValueTypeSchema>;
export type InterfaceInputField = z.infer<typeof interfaceInputFieldSchema>;
export type InterfaceOutputField = z.infer<typeof interfaceOutputFieldSchema>;
export type InterfaceOperation = z.infer<typeof interfaceOperationSchema>;
export type InterfaceDefinition = z.infer<typeof interfaceDefinitionSchema>;
export type InterfaceDependency = z.infer<typeof interfaceDependencySchema>;
