import { z } from "zod";
import {
  boundedPageSchema,
  correlationIdSchema,
  duplicateProtectionKeySchema,
  jsonValueSchema,
  safeHttpsUrlSchema,
  secretReferenceSchema,
} from "./common";
import { accessGrantSchema, grantConsentDecisionSchema } from "./identity-access";
import { conditionNodeSchema } from "./module-contracts";
import { recordScopeSchema } from "./records";
import {
  activityIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  clusterIdSchema,
  connectionInstanceIdSchema,
  connectionTypeIdSchema,
  fieldIdSchema,
  fileIdSchema,
  fingerprintSchema,
  grantIdSchema,
  grantConsentDecisionIdSchema,
  identityIdSchema,
  interfaceIdSchema,
  moduleRootIdSchema,
  namespacedKeySchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  platformIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  roleIdSchema,
  semanticVersionSchema,
  timestampSchema,
  workflowRunIdSchema,
} from "./identifiers";

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
    type: z.enum(["text", "number", "boolean", "date", "date_time", "record_reference", "json"]),
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

export const interfaceOperationSchema = z
  .object({
    operationId: platformIdSchema,
    key: builderKeySchema,
    description: z.string().min(1).max(1_000),
    inputShape: z.record(
      builderKeySchema,
      z.enum(["text", "number", "boolean", "date", "date_time", "record_reference"]),
    ),
    outputShape: z.record(
      builderKeySchema,
      z.enum(["text", "number", "boolean", "date", "date_time", "record_reference"]),
    ),
    authentication: z.enum(["organization_token", "partner_token", "public"]),
    permissionKey: namespacedKeySchema.optional(),
    visibility: z.enum(["organization_private", "partner", "public"]),
    rateLimitPerMinute: z.number().int().min(1).max(100_000),
    maximumRequestBytes: z.number().int().min(1).max(100_000_000),
    duplicateProtection: z.enum(["not_required", "required"]),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("action"), key: namespacedKeySchema }).strict(),
      z.object({ kind: z.literal("query"), key: builderKeySchema }).strict(),
      z.object({ kind: z.literal("workflow"), key: builderKeySchema }).strict(),
    ]),
    errorCodes: z.array(builderKeySchema),
  })
  .strict();
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

export const clusterManifestSchema = z
  .object({
    clusterId: clusterIdSchema,
    environment: z.enum(["local", "testing", "production"]),
    federationBaseAddress: safeHttpsUrlSchema,
    serviceRegion: z.string().min(2).max(100),
    routedOrganizationIds: z.array(organizationIdSchema),
    status: z.enum(["active", "draining", "disabled", "retired"]),
    protocolVersions: z.array(semanticVersionSchema).min(1),
    sharedContractVersions: z.array(semanticVersionSchema).min(1),
    signingKeys: z
      .array(
        z
          .object({
            keyId: z.string().min(1).max(120),
            algorithm: z.enum(["ed25519", "rsa_pss_sha256"]),
            publicKey: z.string().min(32).max(10_000),
            activatesAt: timestampSchema,
            retiresAt: timestampSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    manifestSignature: z.string().min(32).max(10_000),
  })
  .strict();
export const recipientDiscoveryEntrySchema = z
  .object({
    sharingCodeFingerprint: fingerprintSchema,
    organizationId: organizationIdSchema,
    clusterId: clusterIdSchema,
    approvedDisplayName: z.string().min(1).max(120),
    serviceRegion: z.string().min(2).max(100),
    state: z.enum(["active", "rotated", "disabled"]),
    issuedAt: timestampSchema,
    rotatedAt: timestampSchema.optional(),
    directorySignature: z.string().min(32).max(10_000),
  })
  .strict();
export const recipientAssertionSchema = z
  .object({
    assertionId: platformIdSchema,
    recipientClusterId: clusterIdSchema,
    recipientClusterRegion: z.string().min(2).max(100),
    recipientOrganizationId: organizationIdSchema,
    recipientOrganizationAccountId: organizationAccountIdSchema,
    identityId: identityIdSchema,
    recipientApplicationId: applicationRootIdSchema,
    recipientRoleIds: z.array(roleIdSchema).min(1),
    recipientAccessVersion: revisionSchema,
    grantId: grantIdSchema,
    intendedSourceClusterId: clusterIdSchema,
    authenticationStrength: z.enum(["single_factor", "multi_factor", "recent_multi_factor"]),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    nonce: z.string().min(16).max(500),
    correlationId: correlationIdSchema,
  })
  .strict();
const recipientGrantMirrorBase = {
  grantId: grantIdSchema,
  sourceClusterId: clusterIdSchema,
  sourceOrganizationId: organizationIdSchema,
  sourceApplicationId: applicationRootIdSchema.optional(),
  recipientClusterId: clusterIdSchema,
  recipientOrganizationId: organizationIdSchema,
  recipientApplicationId: applicationRootIdSchema,
  approvedRecipientRegion: z.string().min(2).max(100),
  recipientRoleIds: z.array(roleIdSchema).min(1),
  contractVersion: semanticVersionSchema,
  contractFingerprint: fingerprintSchema,
  definitionMappingFingerprint: fingerprintSchema,
  sourceRoute: safeHttpsUrlSchema,
  sourceProposalFingerprint: fingerprintSchema,
  localAccessVersionContribution: revisionSchema,
  lastReconciledAt: timestampSchema,
  lastSafeOutcome: builderKeySchema,
};
const activationEvidence = {
  recipientConsentDecisionId: grantConsentDecisionIdSchema,
  signedActivationReceipt: z.string().min(32).max(10_000),
};
const pendingRecipientGrantMirrorSchema = z
  .object({
    ...recipientGrantMirrorBase,
    state: z.literal("pending"),
    recipientConsentDecisionId: grantConsentDecisionIdSchema.optional(),
  })
  .strict();
const activeRecipientGrantMirrorSchema = z
  .object({ ...recipientGrantMirrorBase, ...activationEvidence, state: z.literal("active") })
  .strict();
const suspendedRecipientGrantMirrorSchema = z
  .object({
    ...recipientGrantMirrorBase,
    ...activationEvidence,
    state: z.literal("suspended"),
    signedSuspensionEvidence: z.string().min(32).max(10_000),
  })
  .strict();
const revokedRecipientGrantMirrorSchema = z
  .object({
    ...recipientGrantMirrorBase,
    state: z.literal("revoked"),
    recipientConsentDecisionId: grantConsentDecisionIdSchema.optional(),
    signedActivationReceipt: z.string().min(32).max(10_000).optional(),
    revokedAt: timestampSchema,
    signedRevocationEvidence: z.string().min(32).max(10_000),
  })
  .strict()
  .refine(
    (value) =>
      (value.recipientConsentDecisionId === undefined) ===
      (value.signedActivationReceipt === undefined),
    {
      path: ["signedActivationReceipt"],
      message: "A revoked mirror carries either both activation fields or neither",
    },
  );
const expiredRecipientGrantMirrorSchema = z
  .object({
    ...recipientGrantMirrorBase,
    state: z.literal("expired"),
    recipientConsentDecisionId: grantConsentDecisionIdSchema.optional(),
    signedActivationReceipt: z.string().min(32).max(10_000).optional(),
    expiredAt: timestampSchema,
    signedExpiryEvidence: z.string().min(32).max(10_000),
  })
  .strict()
  .refine(
    (value) =>
      (value.recipientConsentDecisionId === undefined) ===
      (value.signedActivationReceipt === undefined),
    {
      path: ["signedActivationReceipt"],
      message: "An expired mirror carries either both activation fields or neither",
    },
  );
export const recipientGrantMirrorSchema = z.discriminatedUnion("state", [
  pendingRecipientGrantMirrorSchema,
  activeRecipientGrantMirrorSchema,
  suspendedRecipientGrantMirrorSchema,
  revokedRecipientGrantMirrorSchema,
  expiredRecipientGrantMirrorSchema,
]);

export const federatedQuerySchema = z
  .object({
    kind: z.enum(["list", "record", "search", "report"]),
    grantId: grantIdSchema,
    sourceOrganizationId: organizationIdSchema,
    moduleRootId: moduleRootIdSchema,
    recordTypeId: recordTypeIdSchema,
    publishedModuleRevision: revisionSchema,
    readableFieldIds: z.array(fieldIdSchema).min(1),
    recordId: recordIdSchema.optional(),
    filter: conditionNodeSchema.optional(),
    searchTerm: z.string().max(500).optional(),
    grouping: z.array(fieldIdSchema).max(10),
    totals: z.array(
      z
        .object({
          operation: z.enum(["count", "sum", "minimum", "maximum", "average"]),
          fieldId: fieldIdSchema.optional(),
        })
        .strict(),
    ),
    sort: z
      .array(
        z
          .object({ fieldId: fieldIdSchema, direction: z.enum(["ascending", "descending"]) })
          .strict(),
      )
      .min(1),
    page: boundedPageSchema,
    countRequested: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === "record") !== (value.recordId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["recordId"],
        message: "Only a record query carries one record identifier",
      });
    if ((value.kind === "search") !== (value.searchTerm !== undefined))
      context.addIssue({
        code: "custom",
        path: ["searchTerm"],
        message: "Only a search query carries a search term, and it is required there",
      });
    for (const [index, total] of value.totals.entries())
      if ((total.operation === "count") === (total.fieldId !== undefined))
        context.addIssue({
          code: "custom",
          path: ["totals", index, "fieldId"],
          message: "Count has no field; every other total requires one field",
        });
  });
export const federatedActionSchema = z
  .object({
    grantId: grantIdSchema,
    sourceRecord: recordScopeSchema,
    actionKey: namespacedKeySchema,
    input: z.record(builderKeySchema, jsonValueSchema),
    expectedConcurrencyNumber: z.number().int().positive(),
    duplicateProtectionKey: duplicateProtectionKeySchema,
  })
  .strict();
export const federatedExportSchema = z
  .object({
    grantId: grantIdSchema,
    sourceQueryFingerprint: fingerprintSchema,
    format: z.enum(["csv", "json", "xlsx"]),
    readableFieldIds: z.array(fieldIdSchema).min(1),
    maximumRows: z.number().int().min(1).max(1_000_000),
    duplicateProtectionKey: duplicateProtectionKeySchema,
    downloadExpiresAt: timestampSchema,
  })
  .strict();
export const federatedFileOperationSchema = z
  .object({
    grantId: grantIdSchema,
    sourceRecord: recordScopeSchema,
    attachmentFieldId: fieldIdSchema,
    operation: z.enum(["upload_admit", "upload_complete", "preview", "download"]),
    expectedConcurrencyNumber: z.number().int().positive().optional(),
    fileId: fileIdSchema.optional(),
    duplicateProtectionKey: duplicateProtectionKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const changesState =
      value.operation === "upload_admit" || value.operation === "upload_complete";
    if (changesState && value.duplicateProtectionKey === undefined)
      context.addIssue({
        code: "custom",
        path: ["duplicateProtectionKey"],
        message: "A changing file operation requires duplicate protection",
      });
    if (value.operation === "upload_complete" && value.expectedConcurrencyNumber === undefined)
      context.addIssue({
        code: "custom",
        path: ["expectedConcurrencyNumber"],
        message: "Completing an upload requires the expected record version",
      });
  });

const federatedRequestBase = {
  protocolVersion: semanticVersionSchema,
  senderClusterId: clusterIdSchema,
  receiverClusterId: clusterIdSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  nonce: z.string().min(16).max(500),
  correlationId: correlationIdSchema,
  sharedContractVersion: semanticVersionSchema,
  sharedContractFingerprint: fingerprintSchema,
};
const federatedQueryRequestSchema = z
  .object({
    ...federatedRequestBase,
    operation: z.literal("query"),
    recipientAssertion: recipientAssertionSchema,
    payload: federatedQuerySchema,
  })
  .strict();
const federatedActionRequestSchema = z
  .object({
    ...federatedRequestBase,
    operation: z.literal("action"),
    duplicateProtectionKey: duplicateProtectionKeySchema,
    recipientAssertion: recipientAssertionSchema,
    payload: federatedActionSchema,
  })
  .strict();
const federatedExportRequestSchema = z
  .object({
    ...federatedRequestBase,
    operation: z.literal("export"),
    duplicateProtectionKey: duplicateProtectionKeySchema,
    recipientAssertion: recipientAssertionSchema,
    payload: federatedExportSchema,
  })
  .strict();
const federatedFileRequestSchema = z
  .object({
    ...federatedRequestBase,
    operation: z.literal("file"),
    duplicateProtectionKey: duplicateProtectionKeySchema.optional(),
    recipientAssertion: recipientAssertionSchema,
    payload: federatedFileOperationSchema,
  })
  .strict();
const grantControlEvidenceBase = {
  grantId: grantIdSchema,
  sourceClusterId: clusterIdSchema,
  recipientClusterId: clusterIdSchema,
  evidenceFingerprint: fingerprintSchema,
  evidenceSignature: z.string().min(32).max(10_000),
  issuedAt: timestampSchema,
};
const grantProposalSchema = z
  .object({
    ...grantControlEvidenceBase,
    kind: z.literal("proposal"),
    proposedGrant: accessGrantSchema,
  })
  .strict()
  .refine((value) => value.grantId === value.proposedGrant.grantId, {
    path: ["grantId"],
    message: "Proposal evidence must name its proposed grant",
  })
  .refine((value) => value.evidenceFingerprint === value.proposedGrant.contractFingerprint, {
    path: ["evidenceFingerprint"],
    message: "Proposal evidence must bind the proposed grant fingerprint",
  })
  .refine(
    (value) =>
      value.sourceClusterId === value.proposedGrant.sourceClusterId &&
      value.recipientClusterId === value.proposedGrant.recipientClusterId,
    {
      path: ["sourceClusterId"],
      message: "Proposal evidence must bind the grant cluster pair",
    },
  )
  .refine((value) => value.proposedGrant.status === "pending_consent", {
    path: ["proposedGrant", "status"],
    message: "A cross-cluster proposal is pending consent",
  });
const grantDecisionSchema = z
  .object({
    ...grantControlEvidenceBase,
    kind: z.literal("decision"),
    decision: grantConsentDecisionSchema,
  })
  .strict()
  .refine((value) => value.evidenceFingerprint === value.decision.proposedGrantFingerprint, {
    path: ["evidenceFingerprint"],
    message: "Decision evidence must bind the proposed grant fingerprint",
  });
const grantActivationReceiptSchema = z
  .object({
    ...grantControlEvidenceBase,
    kind: z.literal("activation_receipt"),
    activeGrant: accessGrantSchema,
    recipientConsentDecisionId: grantConsentDecisionIdSchema,
    signedActivationReceipt: z.string().min(32).max(10_000),
  })
  .strict()
  .refine(
    (value) => value.grantId === value.activeGrant.grantId && value.activeGrant.status === "active",
    {
      path: ["activeGrant"],
      message: "Activation evidence must contain the matching active grant",
    },
  )
  .refine((value) => value.evidenceFingerprint === value.activeGrant.contractFingerprint, {
    path: ["evidenceFingerprint"],
    message: "Activation evidence must bind the active grant fingerprint",
  })
  .refine(
    (value) =>
      value.sourceClusterId === value.activeGrant.sourceClusterId &&
      value.recipientClusterId === value.activeGrant.recipientClusterId,
    {
      path: ["sourceClusterId"],
      message: "Activation evidence must bind the grant cluster pair",
    },
  );
const grantRevocationEvidenceSchema = z
  .object({
    ...grantControlEvidenceBase,
    kind: z.literal("revocation_evidence"),
    revokedGrant: accessGrantSchema,
    sourceAccessVersion: revisionSchema,
    signedRevocationEvidence: z.string().min(32).max(10_000),
  })
  .strict()
  .refine(
    (value) =>
      value.grantId === value.revokedGrant.grantId && value.revokedGrant.status === "revoked",
    {
      path: ["revokedGrant"],
      message: "Revocation evidence must contain the matching revoked grant",
    },
  )
  .refine((value) => value.evidenceFingerprint === value.revokedGrant.contractFingerprint, {
    path: ["evidenceFingerprint"],
    message: "Revocation evidence must bind the revoked grant fingerprint",
  })
  .refine(
    (value) =>
      value.sourceClusterId === value.revokedGrant.sourceClusterId &&
      value.recipientClusterId === value.revokedGrant.recipientClusterId,
    {
      path: ["sourceClusterId"],
      message: "Revocation evidence must bind the grant cluster pair",
    },
  );
export const federatedGrantControlSchema = z.discriminatedUnion("kind", [
  grantProposalSchema,
  grantDecisionSchema,
  grantActivationReceiptSchema,
  grantRevocationEvidenceSchema,
]);
const federatedGrantControlRequestSchema = z
  .object({
    ...federatedRequestBase,
    operation: z.literal("grant_control"),
    duplicateProtectionKey: duplicateProtectionKeySchema,
    payload: federatedGrantControlSchema,
  })
  .strict();
export const federatedRequestSchema = z
  .discriminatedUnion("operation", [
    federatedQueryRequestSchema,
    federatedActionRequestSchema,
    federatedExportRequestSchema,
    federatedFileRequestSchema,
    federatedGrantControlRequestSchema,
  ])
  .refine((value) => value.senderClusterId !== value.receiverClusterId, {
    path: ["receiverClusterId"],
    message: "Federation is between different clusters",
  })
  .superRefine((value, context) => {
    if (
      value.operation === "file" &&
      (value.payload.operation === "upload_admit" ||
        value.payload.operation === "upload_complete") &&
      value.duplicateProtectionKey === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["duplicateProtectionKey"],
        message: "A changing file request requires envelope duplicate protection",
      });
    if (
      "duplicateProtectionKey" in value &&
      "duplicateProtectionKey" in value.payload &&
      value.duplicateProtectionKey !== value.payload.duplicateProtectionKey
    )
      context.addIssue({
        code: "custom",
        path: ["duplicateProtectionKey"],
        message: "Envelope and operation duplicate-protection keys must match",
      });
    if (
      value.operation !== "grant_control" &&
      value.recipientAssertion.grantId !== value.payload.grantId
    )
      context.addIssue({
        code: "custom",
        path: ["recipientAssertion", "grantId"],
        message: "The recipient assertion must name the requested grant",
      });
    if (value.operation !== "grant_control") {
      if (value.recipientAssertion.recipientClusterId !== value.senderClusterId)
        context.addIssue({
          code: "custom",
          path: ["recipientAssertion", "recipientClusterId"],
          message: "The recipient assertion must identify the sending cluster",
        });
      if (value.recipientAssertion.intendedSourceClusterId !== value.receiverClusterId)
        context.addIssue({
          code: "custom",
          path: ["recipientAssertion", "intendedSourceClusterId"],
          message: "The recipient assertion must identify the receiving source cluster",
        });
      if (value.recipientAssertion.correlationId !== value.correlationId)
        context.addIssue({
          code: "custom",
          path: ["recipientAssertion", "correlationId"],
          message: "The recipient assertion and envelope correlation identifiers must match",
        });
    } else {
      const sentBySource =
        value.payload.kind !== "decision" || value.payload.decision.side === "source_authorization";
      const expectedSender = sentBySource
        ? value.payload.sourceClusterId
        : value.payload.recipientClusterId;
      const expectedReceiver = sentBySource
        ? value.payload.recipientClusterId
        : value.payload.sourceClusterId;
      if (value.senderClusterId !== expectedSender)
        context.addIssue({
          code: "custom",
          path: ["senderClusterId"],
          message: "Grant-control sender must match the evidence direction",
        });
      if (value.receiverClusterId !== expectedReceiver)
        context.addIssue({
          code: "custom",
          path: ["receiverClusterId"],
          message: "Grant-control receiver must match the evidence direction",
        });
    }
  });
const federatedResponseCommon = {
  correlationId: correlationIdSchema,
  sourceClusterId: clusterIdSchema,
  sharedContractVersion: semanticVersionSchema,
  issuedAt: timestampSchema,
};
export const federatedRefusalCodeSchema = z.enum([
  "access_refused",
  "grant_inactive",
  "request_invalid",
]);
export const federatedResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...federatedResponseCommon,
      outcome: z.literal("completed"),
      continuationToken: z.string().min(1).max(2_000).optional(),
      result: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...federatedResponseCommon,
      outcome: z.literal("refused"),
      safeErrorCode: federatedRefusalCodeSchema,
    })
    .strict(),
  z
    .object({
      ...federatedResponseCommon,
      outcome: z.literal("unavailable"),
      safeErrorCode: z.literal("source_unavailable"),
    })
    .strict(),
  z
    .object({
      ...federatedResponseCommon,
      outcome: z.literal("retryable_failure"),
      safeErrorCode: z.literal("retry_later"),
    })
    .strict(),
]);

export type ConnectionType = z.infer<typeof connectionTypeSchema>;
export type ConnectionAuthentication = z.infer<typeof connectionAuthenticationSchema>;
export type ConnectionOperation = z.infer<typeof connectionOperationSchema>;
export type IncomingMessageType = z.infer<typeof incomingMessageTypeSchema>;
export type ConnectionInstance = z.infer<typeof connectionInstanceSchema>;
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
export type InterfaceOperation = z.infer<typeof interfaceOperationSchema>;
export type InterfaceDefinition = z.infer<typeof interfaceDefinitionSchema>;
export type InterfaceDependency = z.infer<typeof interfaceDependencySchema>;
export type ClusterManifest = z.infer<typeof clusterManifestSchema>;
export type RecipientDiscoveryEntry = z.infer<typeof recipientDiscoveryEntrySchema>;
export type RecipientAssertion = z.infer<typeof recipientAssertionSchema>;
export type RecipientGrantMirror = z.infer<typeof recipientGrantMirrorSchema>;
export type FederatedQuery = z.infer<typeof federatedQuerySchema>;
export type FederatedAction = z.infer<typeof federatedActionSchema>;
export type FederatedExport = z.infer<typeof federatedExportSchema>;
export type FederatedFileOperation = z.infer<typeof federatedFileOperationSchema>;
export type FederatedGrantControl = z.infer<typeof federatedGrantControlSchema>;
export type FederatedRequest = z.infer<typeof federatedRequestSchema>;
export type FederatedResponse = z.infer<typeof federatedResponseSchema>;
