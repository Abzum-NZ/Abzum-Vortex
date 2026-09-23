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
  safeHttpsUrlSchema,
  stableDefinitionReleaseVersionSchema,
  timestampSchema,
  typedFlowResultMappingSchema,
  workflowNodeIdSchema,
  workflowValueTypeSchema,
  type CorrelationId,
  type ProtectedOperationReference,
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
 * The operation result is produced server-side under the effective actor and names the protected
 * provenance of every value it carries. The published declaration is bound to the exact resolved
 * release, flow, node and operation; it reuses the shared typed result mapping (result key to node
 * output) and states how each result is handed off. Only a declared result is ever projected, so
 * every other operation output stays server-side. A result, branch outcome, message, error or
 * navigation is disclosed only when every protected value it derives from is currently readable
 * by the viewer, or when its published mapping names an existing disclosure operation the viewer
 * is explicitly authorised for. Anything else is withheld and reported as withheld.
 *
 * The shared safe-result descriptor is always returned, so refusal, partial, uncertain and
 * background-pending outcomes keep their own commit and recovery semantics, and a withheld result
 * is never presented as empty data or as success. Row, field, derived-value, file, component and
 * application policy is consumed as already-resolved viewer authority and never recomputed here.
 */

export const flowResultHandoffContractVersion = "1.0.0" as const;

/**
 * How a declared result reaches the viewer: returned as it is, transformed into another value, or
 * carried into a later write. Every kind is disclosure to the viewer and gets the same check; the
 * kind tells a withheld transformation or later write apart from an unreadable plain return.
 */
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

/**
 * Every protected value an operation-produced item derives from. It is required rather than
 * defaulted, so a producer must state it; an empty list means no protected source at all.
 */
export const flowResultProvenanceSchema = z.array(flowResultProtectedValueReferenceSchema).max(200);
export type FlowResultProvenance = z.infer<typeof flowResultProvenanceSchema>;

/** The original initiating viewer. A system-started flow has a system actor instead of a person. */
export const flowResultViewerSchema = z.discriminatedUnion("kind", [
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
export type FlowResultViewer = z.infer<typeof flowResultViewerSchema>;

/**
 * The viewer's current, already-resolved authority, re-read after execution. It is evidence
 * produced by the owning Access boundary, never policy derived in this module: the module only
 * consults it before disclosing a value. `validUntil` is the earliest relevant session, account,
 * membership, assignment, sharing or Access-version transition.
 */
export const flowResultViewerAuthoritySchema = z
  .object({
    viewer: flowResultViewerSchema,
    applicationRootId: applicationRootIdSchema,
    accessVersion: revisionSchema,
    checkedAt: timestampSchema,
    validUntil: timestampSchema,
    applicationReadAllowed: z.boolean(),
    readableRecords: z
      .array(z.object({ recordTypeId: recordTypeIdSchema, recordId: recordIdSchema }).strict())
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
 * How one declared result is handed off. `disclosureOperation`, when present, is the existing
 * explicitly authorised operation that permits this result to disclose protected values the
 * viewer could not otherwise read; it has effect only when the viewer is authorised for it.
 */
export const flowResultDeclaredMappingSchema = z
  .object({
    mappingKind: flowResultOutputMappingKindSchema,
    disclosureOperation: protectedOperationReferenceSchema.optional(),
  })
  .strict();
export type FlowResultDeclaredMapping = z.infer<typeof flowResultDeclaredMappingSchema>;

/**
 * The published declared safe result mapping for one exact node. `results` is the shared typed
 * result mapping from result key to node output; `mappings` states the handoff of every result
 * key and of nothing else.
 */
export const flowResultDeclarationSchema = z
  .object({
    contractVersion: z.literal(flowResultHandoffContractVersion),
    releaseVersion: stableDefinitionReleaseVersionSchema,
    flowId: ruleIdSchema,
    nodeId: workflowNodeIdSchema,
    operation: protectedOperationReferenceSchema,
    results: z.record(builderKeySchema, typedFlowResultMappingSchema).default({}),
    mappings: z.record(builderKeySchema, flowResultDeclaredMappingSchema).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    for (const result of Object.keys(value.mappings))
      if (!Object.hasOwn(value.results, result))
        context.addIssue({
          code: "custom",
          path: ["mappings", result],
          message: "A handoff mapping must correspond to a declared result",
        });
    const mappedOutputs = new Set<string>();
    for (const [result, mapping] of Object.entries(value.results)) {
      if (!Object.hasOwn(value.mappings, result))
        context.addIssue({
          code: "custom",
          path: ["mappings", result],
          message: "Every declared result needs a handoff mapping",
        });
      if (mappedOutputs.has(mapping.output))
        context.addIssue({
          code: "custom",
          path: ["results", result, "output"],
          message: "A node output can be mapped only once",
        });
      mappedOutputs.add(mapping.output);
    }
  });
export type FlowResultDeclaration = z.input<typeof flowResultDeclarationSchema>;

/** A concrete node output the effective actor produced, with its protected provenance. */
export const flowResultOperationOutputSchema = z
  .object({
    output: builderKeySchema,
    value: jsonValueSchema,
    provenance: flowResultProvenanceSchema,
  })
  .strict();
export type FlowResultOperationOutput = z.infer<typeof flowResultOperationOutputSchema>;

/** A structured safe code the interface localises; never raw failure detail. */
const flowResultCodedItemSchema = z
  .object({ code: builderKeySchema, provenance: flowResultProvenanceSchema })
  .strict();

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
  z.object({ kind: z.literal("external"), address: safeHttpsUrlSchema.max(2000) }).strict(),
]);
export type FlowResultNavigationTarget = z.infer<typeof flowResultNavigationTargetSchema>;

/**
 * The exact #686 effective-actor operation result. It is produced server-side under the
 * resolution's effective actor; it is a trusted input, never a browser payload.
 */
export const flowResultOperationResultSchema = z
  .object({
    outcome: safeFlowResultKindSchema,
    outputs: z.array(flowResultOperationOutputSchema).max(500).default([]),
    branchOutcome: z
      .object({ outcome: builderKeySchema, provenance: flowResultProvenanceSchema })
      .strict()
      .optional(),
    message: flowResultCodedItemSchema.optional(),
    error: flowResultCodedItemSchema.optional(),
    navigation: z
      .object({ target: flowResultNavigationTargetSchema, provenance: flowResultProvenanceSchema })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, output] of value.outputs.entries()) {
      if (seen.has(output.output))
        context.addIssue({
          code: "custom",
          path: ["outputs", index, "output"],
          message: "A node output may appear only once",
        });
      seen.add(output.output);
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
  "declaration_mismatch",
]);
export type FlowResultHandoffRefusalReason = z.infer<
  typeof flowResultHandoffRefusalReasonSchema
>;

/** One viewer-permitted result value, keyed by its declared result key. */
export const flowResultProjectedValueSchema = z
  .object({
    result: builderKeySchema,
    type: workflowValueTypeSchema,
    value: jsonValueSchema,
  })
  .strict();
export type FlowResultProjectedValue = z.infer<typeof flowResultProjectedValueSchema>;

/**
 * Something the operation produced that this viewer may not see. A withheld result is named by
 * its declared result key only; `unsafe_disclosure_mapping` marks a transformation or later write
 * that would launder a protected value without an authorised disclosure operation.
 */
export const flowResultWithheldSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("result"),
      result: builderKeySchema,
      reason: z.enum(["not_viewer_readable", "unsafe_disclosure_mapping"]),
    })
    .strict(),
  z.object({ kind: z.literal("branch_outcome") }).strict(),
  z.object({ kind: z.literal("message") }).strict(),
  z.object({ kind: z.literal("error") }).strict(),
  z.object({ kind: z.literal("navigation") }).strict(),
]);
export type FlowResultWithheld = z.infer<typeof flowResultWithheldSchema>;

/**
 * What happened to the declared results: projected, genuinely empty, restricted because at least
 * one was withheld from this viewer, or unavailable because the outcome makes no results
 * available. The descriptor carries the commit and recovery semantics independently.
 */
export const flowResultPresentationSchema = z.enum(["data", "empty", "restricted", "unavailable"]);
export type FlowResultPresentation = z.infer<typeof flowResultPresentationSchema>;

const flowResultSafeCodeSchema = z.object({ code: builderKeySchema }).strict();

export const flowResultHandoffPermittedSchema = z
  .object({
    outcome: z.literal("permitted"),
    correlationId: correlationIdSchema,
    descriptor: safeFlowResultDescriptorSchema,
    presentation: flowResultPresentationSchema,
    data: z.array(flowResultProjectedValueSchema).max(500),
    withheld: z.array(flowResultWithheldSchema).max(504),
    branchOutcome: builderKeySchema.optional(),
    message: flowResultSafeCodeSchema.optional(),
    error: flowResultSafeCodeSchema.optional(),
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
const FALLBACK_CORRELATION_ID: CorrelationId = correlationIdSchema.parse(
  "00000000-0000-4000-8000-000000000001",
);

const correlationIdFrom = (candidate: unknown): CorrelationId => {
  const extracted = z
    .object({ resolution: z.object({ correlationId: correlationIdSchema }) })
    .safeParse(candidate);
  return extracted.success ? extracted.data.resolution.correlationId : FALLBACK_CORRELATION_ID;
};

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const sameOperation = (
  left: ProtectedOperationReference,
  right: ProtectedOperationReference,
): boolean => {
  const ownerId = (owner: ProtectedOperationReference["owner"]): string =>
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

const viewerCanRead = (
  provenance: FlowResultProvenance,
  authority: FlowResultViewerAuthority,
): boolean =>
  provenance.every((reference) =>
    reference.kind === "derived"
      ? reference.sources.every((source) => authorityCovers(source, authority))
      : authorityCovers(reference, authority),
  );

const disclosureOperationAuthorised = (
  operation: ProtectedOperationReference | undefined,
  authority: FlowResultViewerAuthority,
): boolean =>
  operation !== undefined &&
  authority.authorisedDisclosureOperations.some((candidate) =>
    sameOperation(candidate, operation),
  );

const viewerMatchesInitiator = (
  viewer: FlowResultViewer,
  initiator: FlowEffectiveActorEffectiveResolution["initiator"],
): boolean =>
  viewer.kind === "organization_account"
    ? initiator.kind === "organization_account" &&
      sameId(viewer.organizationAccountId, initiator.organizationAccountId)
    : initiator.kind === "system" && sameId(viewer.systemActorId, initiator.systemActorId);

const navigationTargetReadable = (
  target: FlowResultNavigationTarget,
  authority: FlowResultViewerAuthority,
): boolean => {
  switch (target.kind) {
    case "external":
      return true;
    case "application":
      return (
        authority.applicationReadAllowed &&
        sameId(authority.applicationRootId, target.applicationRootId)
      );
    case "page":
      return (
        authority.applicationReadAllowed &&
        sameId(authority.applicationRootId, target.applicationRootId) &&
        authorityCovers({ kind: "component", componentId: target.pageId }, authority)
      );
    case "record":
      return authorityCovers(
        { kind: "record", recordTypeId: target.recordTypeId, recordId: target.recordId },
        authority,
      );
  }
};

/**
 * Projects one effective-actor operation result onto the initiating viewer's current authority.
 * Total and side-effect free. Malformed input, stale or mismatched viewer authority, a refused
 * #686 resolution, or a declaration for a different release, flow, node or operation returns a
 * safe refusal. Otherwise the shared safe-result descriptor is always returned with only the
 * viewer-permitted results, branch outcome, message, error and navigation; everything else is
 * withheld, reported as withheld, and never carries effective-actor intermediates.
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
      correlationId: correlationIdFrom(requestCandidate),
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

  const { purpose } = resolution;
  if (
    !sameId(authority.viewer.organizationId, purpose.organizationId) ||
    !sameId(authority.applicationRootId, purpose.applicationRootId) ||
    !viewerMatchesInitiator(authority.viewer, resolution.initiator)
  )
    return refuse("viewer_scope_mismatch");

  if (
    declaration.releaseVersion !== purpose.releaseVersion ||
    !sameId(declaration.flowId, purpose.flowId) ||
    !sameId(declaration.nodeId, purpose.nodeId) ||
    !sameOperation(declaration.operation, purpose.operation)
  )
    return refuse("declaration_mismatch");

  const descriptor = safeFlowResultDescriptors[result.outcome];
  const data: FlowResultProjectedValue[] = [];
  const withheld: FlowResultWithheld[] = [];

  // Only declared results are projected, so every other output stays server-side. An outcome that
  // makes no outputs available (refused, partial, uncertain, background-pending and the rest)
  // projects none of them rather than presenting intermediates as partial success.
  if (descriptor.outputs === "available") {
    const outputs = new Map(result.outputs.map((output) => [output.output, output] as const));
    for (const [resultKey, published] of Object.entries(declaration.results)) {
      const mapping = declaration.mappings[resultKey];
      const produced = outputs.get(published.output);
      if (mapping === undefined || produced === undefined) continue;
      if (
        viewerCanRead(produced.provenance, authority) ||
        disclosureOperationAuthorised(mapping.disclosureOperation, authority)
      )
        data.push({ result: resultKey, type: published.type, value: produced.value });
      else
        withheld.push({
          kind: "result",
          result: resultKey,
          reason:
            mapping.mappingKind === "return"
              ? "not_viewer_readable"
              : "unsafe_disclosure_mapping",
        });
    }
  }

  // Branch outcomes, messages, errors and navigation have no declared disclosure operation, so
  // they reach the viewer only when everything they derive from is currently readable.
  const disclose = <Item extends { provenance: FlowResultProvenance }>(
    item: Item | undefined,
    kind: Exclude<FlowResultWithheld["kind"], "result">,
    readable: (candidate: Item) => boolean = () => true,
  ): Item | undefined => {
    if (item === undefined) return undefined;
    if (viewerCanRead(item.provenance, authority) && readable(item)) return item;
    withheld.push({ kind });
    return undefined;
  };
  const branchOutcome = disclose(result.branchOutcome, "branch_outcome");
  const message = disclose(result.message, "message");
  const error = disclose(result.error, "error");
  const navigation = disclose(result.navigation, "navigation", (candidate) =>
    navigationTargetReadable(candidate.target, authority),
  );

  const presentation: FlowResultPresentation =
    descriptor.outputs !== "available"
      ? "unavailable"
      : withheld.some((item) => item.kind === "result")
        ? "restricted"
        : data.length > 0
          ? "data"
          : "empty";

  return {
    outcome: "permitted",
    correlationId: resolution.correlationId,
    descriptor,
    presentation,
    data,
    withheld,
    ...(branchOutcome === undefined ? {} : { branchOutcome: branchOutcome.outcome }),
    ...(message === undefined ? {} : { message: { code: message.code } }),
    ...(error === undefined ? {} : { error: { code: error.code } }),
    ...(navigation === undefined ? {} : { navigation: navigation.target }),
  };
};
