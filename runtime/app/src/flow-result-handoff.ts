import "server-only";

import { z } from "zod";
import {
  actorIdSchema,
  applicationRootIdSchema,
  builderKeySchema,
  containedComponentIdSchema,
  correlationIdSchema,
  fieldIdSchema,
  fileIdSchema,
  jsonValueSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  protectedOperationReferenceSchema,
  recordIdSchema,
  recordTypeIdSchema,
  revisionSchema,
  ruleIdSchema,
  safeFlowResultDescriptorSchema,
  safeFlowResultDescriptors,
  safeFlowResultKindSchema,
  timestampSchema,
  typedFlowResultMappingSchema,
  workflowNodeIdSchema,
  workflowValueTypeSchema,
} from "@vortex/contracts";
import {
  flowEffectiveActorResolutionSchema,
  type FlowEffectiveActorEffectiveResolution,
} from "@vortex/access";

/**
 * #687 projects one protected operation's result onto the original initiating viewer's current
 * authority. #686 resolves which actor may run the node; this module never changes that decision
 * and never re-runs it. It exists because execution access is not display access: an operation
 * that ran with a broader effective actor may hold values, counts, branch outcomes, errors and
 * derived data the watching viewer still cannot see.
 *
 * The published declaration is the only description of what a node's outputs disclose. It maps
 * each declared result output to its mapping kind and to the exact protected value references the
 * mapping is allowed to use. A concrete result may only project an output that declaration names,
 * and only when every reference it discloses is either currently readable by the viewer or covered
 * by an explicitly authorised disclosure operation. Privileged intermediates stay server-side;
 * the returned shape can carry only the viewer-safe descriptor, a declared result projection, a
 * safe message code, a declared branch outcome and a resolved navigation target.
 *
 * Refusal, partial, uncertain and background-pending results keep their own fixed descriptor, so a
 * permission refusal is never rendered as empty data and a partial or pending outcome is never
 * reported as success. Authored safe-result and typed mapping contracts are reused rather than
 * redefined; row, field, file and component policy is consumed as already-resolved viewer
 * authority and never recomputed here.
 */

export const flowResultHandoffContractVersion = "1.0.0" as const;

export const flowResultOutputMappingKindSchema = z.enum(["return", "transform", "later_write"]);
export type FlowResultOutputMappingKind = z.infer<typeof flowResultOutputMappingKindSchema>;

/**
 * One protected value the viewer may or may not see: a record identity, a single record field, a
 * record-type count, a file, a component, an application-scoped value, or a value derived from a
 * bounded set of those leaves. A derived value carries its flat leaf sources, so nested derivation
 * cannot hide a protected origin.
 */
export const flowResultProtectedValueLeafSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("record"),
      recordTypeId: recordTypeIdSchema,
      recordId: recordIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record_field"),
      recordId: recordIdSchema,
      fieldId: fieldIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("record_count"), recordTypeId: recordTypeIdSchema }).strict(),
  z.object({ kind: z.literal("file"), fileId: fileIdSchema }).strict(),
  z.object({ kind: z.literal("component"), componentId: containedComponentIdSchema }).strict(),
  z.object({ kind: z.literal("application") }).strict(),
]);
export type FlowResultProtectedValueLeaf = z.infer<typeof flowResultProtectedValueLeafSchema>;

export const flowResultProtectedValueReferenceSchema = z.union([
  flowResultProtectedValueLeafSchema,
  z
    .object({
      kind: z.literal("derived"),
      sources: z.array(flowResultProtectedValueLeafSchema).min(1).max(200),
    })
    .strict(),
]);
export type FlowResultProtectedValueReference = z.infer<
  typeof flowResultProtectedValueReferenceSchema
>;

/** The original initiating viewer. A system-started flow has a system actor instead of a person. */
export const flowResultViewerViewerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("organization_account"),
      organizationId: organizationIdSchema,
      organizationAccountId: organizationAccountIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      organizationId: organizationIdSchema,
      systemActorId: actorIdSchema,
    })
    .strict(),
]);
export type FlowResultViewerViewer = z.infer<typeof flowResultViewerViewerSchema>;

/**
 * The viewer's current, already-resolved authority, re-read after execution. It is evidence
 * produced by the owning Access boundary, never policy derived in this module: the module only
 * consults it before disclosing a value. `validUntil` is the earliest relevant session, account,
 * membership, assignment, sharing or Access-version transition.
 */
export const flowResultViewerAuthoritySchema = z
  .object({
    viewer: flowResultViewerViewerSchema,
    applicationRootId: applicationRootIdSchema.optional(),
    accessVersion: revisionSchema,
    checkedAt: timestampSchema,
    validUntil: timestampSchema,
    applicationReadAllowed: z.boolean(),
    readableRecords: z
      .array(
        z.object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema }).strict(),
      )
      .max(5000)
      .default([]),
    readableRecordFields: z
      .array(z.object({ recordId: recordIdSchema, fieldId: fieldIdSchema }).strict())
      .max(20_000)
      .default([]),
    readableRecordCounts: z.array(recordTypeIdSchema).max(1000).default([]),
    readableFiles: z.array(fileIdSchema).max(10_000).default([]),
    readableComponents: z.array(containedComponentIdSchema).max(5000).default([]),
    authorisedDisclosureOperations: z
      .array(protectedOperationReferenceSchema)
      .max(500)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.validUntil) <= Date.parse(value.checkedAt))
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "Viewer authority must expire after it was checked",
      });
  });
export type FlowResultViewerAuthority = z.infer<typeof flowResultViewerAuthoritySchema>;

/**
 * The published mapping for one declared result output. `discloses` names every protected value
 * the mapping is allowed to use; `disclosureOperation`, when present, is the existing explicitly
 * authorised operation that permits a transformation or later write to disclose those values to
 * this viewer.
 */
export const flowResultDeclaredMappingSchema = z
  .object({
    mappingKind: flowResultOutputMappingKindSchema,
    discloses: z.array(flowResultProtectedValueReferenceSchema).max(200).default([]),
    disclosureOperation: protectedOperationReferenceSchema.optional(),
  })
  .strict();
export type FlowResultDeclaredMapping = z.infer<typeof flowResultDeclaredMappingSchema>;

/**
 * The published declared safe result mapping. `results` reuses the shared typed result mapping;
 * `mappings` may only name an output that `results` already declares.
 */
export const flowResultDeclarationSchema = z
  .object({
    contractVersion: z.literal(flowResultHandoffContractVersion),
    flowId: ruleIdSchema,
    nodeId: workflowNodeIdSchema,
    results: z.record(builderKeySchema, typedFlowResultMappingSchema),
    mappings: z.record(builderKeySchema, flowResultDeclaredMappingSchema).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    for (const output of Object.keys(value.mappings))
      if (!Object.hasOwn(value.results, output))
        context.addIssue({
          code: "custom",
          path: ["mappings", output],
          message: "A declared mapping must correspond to a published result output",
        });
  });
export type FlowResultDeclaration = z.input<typeof flowResultDeclarationSchema>;

/** A concrete output the effective actor produced; only its declared mapping may project it. */
export const flowResultOperationOutputSchema = z
  .object({
    output: builderKeySchema,
    value: jsonValueSchema,
  })
  .strict();
export type FlowResultOperationOutput = z.infer<typeof flowResultOperationOutputSchema>;

const flowResultRuntimeDisclosureSchema = {
  discloses: z.array(flowResultProtectedValueReferenceSchema).max(200).default([]),
  disclosureOperation: protectedOperationReferenceSchema.optional(),
} as const;

export const flowResultBranchOutcomeSchema = z
  .object({
    outcome: builderKeySchema,
    ...flowResultRuntimeDisclosureSchema,
  })
  .strict();
export type FlowResultBranchOutcome = z.infer<typeof flowResultBranchOutcomeSchema>;

export const flowResultSafeErrorSchema = z
  .object({
    code: builderKeySchema,
    ...flowResultRuntimeDisclosureSchema,
  })
  .strict();
export type FlowResultSafeError = z.infer<typeof flowResultSafeErrorSchema>;

/** A structured safe message: a declared code the interface localises; never raw failure detail. */
export const flowResultSafeMessageSchema = z.object({ code: builderKeySchema }).strict();
export type FlowResultSafeMessage = z.infer<typeof flowResultSafeMessageSchema>;

export const flowResultNavigationTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application"),
      applicationRootId: applicationRootIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("page"),
      applicationRootId: applicationRootIdSchema,
      pageId: containedComponentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("record"),
      recordTypeId: recordTypeIdSchema,
      recordId: recordIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("external"), address: z.url().max(2000) }).strict(),
]);
export type FlowResultNavigationTarget = z.infer<typeof flowResultNavigationTargetSchema>;

/**
 * The exact #686 effective-actor operation result plus the viewer authority and published mapping.
 * The operation result is produced server-side under the resolution's effective actor; it is a
 * trusted input, not a browser payload.
 */
export const flowResultOperationResultSchema = z
  .object({
    outcome: safeFlowResultKindSchema,
    outputs: z.array(flowResultOperationOutputSchema).max(500).default([]),
    branchOutcome: flowResultBranchOutcomeSchema.optional(),
    safeError: flowResultSafeErrorSchema.optional(),
    safeMessage: flowResultSafeMessageSchema.optional(),
    navigation: flowResultNavigationTargetSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, output] of value.outputs.entries()) {
      const key = output.output.toLowerCase();
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["outputs", index, "output"],
          message: "A result output may appear only once",
        });
      seen.add(key);
    }
  });
export type FlowResultOperationResult = z.input<typeof flowResultOperationResultSchema>;

export const flowResultHandoffRequestSchema = z
  .object({
    authority: flowResultViewerAuthoritySchema,
    resolution: flowEffectiveActorResolutionSchema,
    declaration: flowResultDeclarationSchema,
    result: flowResultOperationResultSchema,
  })
  .strict();
export type FlowResultHandoffRequest = z.input<typeof flowResultHandoffRequestSchema>;

export const flowResultHandoffRefusalReasonSchema = z.enum([
  "malformed_request",
  "authority_unavailable",
  "resolution_refused",
  "viewer_scope_mismatch",
  "undeclared_output",
  "unsafe_disclosure_mapping",
  "disclosure_operation_not_authorised",
]);
export type FlowResultHandoffRefusalReason = z.infer<
  typeof flowResultHandoffRefusalReasonSchema
>;

/** One viewer-permitted output value. Unreadable values are omitted, never blanked or hidden. */
export const flowResultProjectedValueSchema = z
  .object({
    output: builderKeySchema,
    type: workflowValueTypeSchema,
    value: jsonValueSchema,
  })
  .strict();
export type FlowResultProjectedValue = z.infer<typeof flowResultProjectedValueSchema>;

export const flowResultPresentationSchema = z.enum([
  "data",
  "empty",
  "refusal",
  "partial",
  "pending",
]);
export type FlowResultPresentation = z.infer<typeof flowResultPresentationSchema>;

export const flowResultHandoffPermittedSchema = z
  .object({
    outcome: z.literal("permitted"),
    correlationId: correlationIdSchema,
    descriptor: safeFlowResultDescriptorSchema,
    presentation: flowResultPresentationSchema,
    data: z.array(flowResultProjectedValueSchema).max(500),
    branchOutcome: builderKeySchema.optional(),
    message: flowResultSafeMessageSchema.optional(),
    navigation: flowResultNavigationTargetSchema.optional(),
  })
  .strict();
export type FlowResultHandoffPermitted = z.infer<typeof flowResultHandoffPermittedSchema>;

export const flowResultHandoffRefusedSchema = z
  .object({
    outcome: z.literal("refused"),
    reasonCode: flowResultHandoffRefusalReasonSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type FlowResultHandoffRefused = z.infer<typeof flowResultHandoffRefusedSchema>;

export const flowResultHandoffSchema = z.discriminatedUnion("outcome", [
  flowResultHandoffPermittedSchema,
  flowResultHandoffRefusedSchema,
]);
export type FlowResultHandoff = z.infer<typeof flowResultHandoffSchema>;

export type FlowResultHandoffDependencies = Readonly<{ clock?: () => Date }>;

/** A stable, non-nil correlation identifier for a request too malformed to carry its own. */
const FALLBACK_CORRELATION_ID = correlationIdSchema.parse(
  "00000000-0000-4000-8000-000000000001",
);

const sameId = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.toLowerCase() === right.toLowerCase();

const sameOperation = (
  left: z.infer<typeof protectedOperationReferenceSchema>,
  right: z.infer<typeof protectedOperationReferenceSchema>,
): boolean => {
  const ownerId = (owner: typeof left.owner): string =>
    owner.kind === "application"
      ? owner.applicationRootId
      : owner.kind === "module"
        ? owner.moduleRootId
        : owner.serviceId;
  return (
    left.owner.kind === right.owner.kind &&
    sameId(ownerId(left.owner), ownerId(right.owner)) &&
    sameId(left.operationId, right.operationId)
  );
};

const authorityCovers = (
  reference: FlowResultProtectedValueLeaf,
  authority: FlowResultViewerAuthority,
): boolean => {
  switch (reference.kind) {
    case "record":
      return authority.readableRecords.some(
        (record) =>
          sameId(record.recordId, reference.recordId) &&
          sameId(record.recordTypeId, reference.recordTypeId),
      );
    case "record_field":
      return authority.readableRecordFields.some(
        (field) =>
          sameId(field.recordId, reference.recordId) && sameId(field.fieldId, reference.fieldId),
      );
    case "record_count":
      return authority.readableRecordCounts.some((recordTypeId) =>
        sameId(recordTypeId, reference.recordTypeId),
      );
    case "file":
      return authority.readableFiles.some((fileId) => sameId(fileId, reference.fileId));
    case "component":
      return authority.readableComponents.some((componentId) =>
        sameId(componentId, reference.componentId),
      );
    case "application":
      return authority.applicationReadAllowed;
  }
};

const viewerCanSee = (
  reference: FlowResultProtectedValueReference,
  authority: FlowResultViewerAuthority,
): boolean =>
  reference.kind === "derived"
    ? reference.sources.every((source) => authorityCovers(source, authority))
    : authorityCovers(reference, authority);

const disclosureOperationAuthorised = (
  operation: z.infer<typeof protectedOperationReferenceSchema> | undefined,
  authority: FlowResultViewerAuthority,
): boolean =>
  operation !== undefined &&
  authority.authorisedDisclosureOperations.some((candidate) =>
    sameOperation(candidate, operation),
  );

const viewerMatchesInitiator = (
  viewer: FlowResultViewerViewer,
  initiator: FlowEffectiveActorEffectiveResolution["initiator"],
): boolean =>
  viewer.kind === "organization_account"
    ? initiator.kind === "organization_account" &&
      sameId(viewer.organizationAccountId, initiator.organizationAccountId)
    : initiator.kind === "system" && sameId(viewer.systemActorId, initiator.systemActorId);

const navigationAvailable = (
  navigation: FlowResultNavigationTarget,
  authority: FlowResultViewerAuthority,
): boolean => {
  switch (navigation.kind) {
    case "external":
      return true;
    case "application":
      return (
        authority.applicationReadAllowed &&
        sameId(authority.applicationRootId, navigation.applicationRootId)
      );
    case "page":
      return (
        authority.applicationReadAllowed &&
        sameId(authority.applicationRootId, navigation.applicationRootId)
      );
    case "record":
      return authority.readableRecords.some(
        (record) =>
          sameId(record.recordId, navigation.recordId) &&
          sameId(record.recordTypeId, navigation.recordTypeId),
      );
  }
};

const presentationFor = (
  outcome: z.infer<typeof safeFlowResultKindSchema>,
  hasData: boolean,
): FlowResultPresentation => {
  switch (outcome) {
    case "completed":
    case "committed":
      return hasData ? "data" : "empty";
    case "partial":
      return "partial";
    case "uncertain":
    case "background_pending":
      return "pending";
    default:
      return "refusal";
  }
};

/**
 * Projects one effective-actor operation result onto the initiating viewer's current authority.
 * Total and side-effect free: malformed input, stale or mismatched viewer authority, a refused
 * #686 resolution, an undeclared output, or a transformation/later write that would disclose a
 * protected value without an authorised disclosure operation all return a safe refusal. Only a
 * permitted projection is returned otherwise, and it never carries effective-actor intermediates.
 */
export const projectFlowResultHandoff = (
  requestCandidate: FlowResultHandoffRequest,
  dependencies: FlowResultHandoffDependencies = {},
): FlowResultHandoff => {
  const parsed = flowResultHandoffRequestSchema.safeParse(requestCandidate);
  if (!parsed.success)
    return {
      outcome: "refused",
      reasonCode: "malformed_request",
      correlationId: FALLBACK_CORRELATION_ID,
    };

  const { authority, resolution, declaration, result } = parsed.data;

  const refuse = (reasonCode: FlowResultHandoffRefusalReason): FlowResultHandoffRefused => ({
    outcome: "refused",
    reasonCode,
    correlationId: resolution.correlationId,
  });

  const now = (dependencies.clock ?? (() => new Date()))().valueOf();
  if (!Number.isFinite(now)) return refuse("malformed_request");
  if (Date.parse(authority.checkedAt) > now) return refuse("authority_unavailable");
  if (Date.parse(authority.validUntil) <= now) return refuse("authority_unavailable");

  if (resolution.outcome !== "effective") return refuse("resolution_refused");

  const viewer = authority.viewer;
  if (!sameId(viewer.organizationId, resolution.purpose.organizationId))
    return refuse("viewer_scope_mismatch");
  if (!sameId(authority.applicationRootId, resolution.purpose.applicationRootId))
    return refuse("viewer_scope_mismatch");
  if (!viewerMatchesInitiator(viewer, resolution.initiator))
    return refuse("viewer_scope_mismatch");

  const descriptor = safeFlowResultDescriptors[result.outcome];

  const data: FlowResultProjectedValue[] = [];
  // A partial, uncertain, refused or background-pending descriptor reports outputs unavailable;
  // its intermediates are withheld entirely rather than projected as partial success.
  if (descriptor.outputs === "available") {
    for (const output of result.outputs) {
      const declared = declaration.mappings[output.output];
      const published = declaration.results[output.output];
      if (declared === undefined || published === undefined) return refuse("undeclared_output");

      if (
        declared.disclosureOperation !== undefined &&
        !disclosureOperationAuthorised(declared.disclosureOperation, authority)
      )
        return refuse("disclosure_operation_not_authorised");

      const blocked = declared.discloses.some(
        (reference) => !viewerCanSee(reference, authority),
      );
      if (blocked) {
        // A plain return omits an unreadable value; a transformation or later write would launder
        // it into a viewer-readable output, so it needs its explicitly authorised disclosure.
        if (declared.mappingKind === "return") continue;
        if (!disclosureOperationAuthorised(declared.disclosureOperation, authority))
          return refuse("unsafe_disclosure_mapping");
      }

      data.push({ output: output.output, type: published.type, value: output.value });
    }
  }

  const branchOutcome = result.branchOutcome;
  if (branchOutcome !== undefined) {
    if (
      branchOutcome.disclosureOperation !== undefined &&
      !disclosureOperationAuthorised(branchOutcome.disclosureOperation, authority)
    )
      return refuse("disclosure_operation_not_authorised");
    const blocked = branchOutcome.discloses.some(
      (reference) => !viewerCanSee(reference, authority),
    );
    if (blocked && !disclosureOperationAuthorised(branchOutcome.disclosureOperation, authority))
      return refuse("unsafe_disclosure_mapping");
  }

  // Errors are only ever surfaced as a declared safe code; raw failure detail is never projected.
  const safeError = result.safeError;
  if (safeError !== undefined) {
    if (
      safeError.disclosureOperation !== undefined &&
      !disclosureOperationAuthorised(safeError.disclosureOperation, authority)
    )
      return refuse("disclosure_operation_not_authorised");
    const blocked = safeError.discloses.some((reference) => !viewerCanSee(reference, authority));
    if (blocked && !disclosureOperationAuthorised(safeError.disclosureOperation, authority))
      return refuse("unsafe_disclosure_mapping");
  }

  const message =
    result.safeMessage ?? (safeError === undefined ? undefined : { code: safeError.code });

  const navigation =
    result.navigation !== undefined && navigationAvailable(result.navigation, authority)
      ? result.navigation
      : undefined;

  return {
    outcome: "permitted",
    correlationId: resolution.correlationId,
    descriptor,
    presentation: presentationFor(result.outcome, data.length > 0),
    data,
    ...(branchOutcome === undefined ? {} : { branchOutcome: branchOutcome.outcome }),
    ...(message === undefined ? {} : { message }),
    ...(navigation === undefined ? {} : { navigation }),
  };
};
