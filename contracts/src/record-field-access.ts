import { z } from "zod";
import { jsonValueSchema } from "./common";
import { fieldIdSchema, namespacedKeySchema } from "./identifiers";
import {
  organizationAccessDecisionEvidenceSchema,
  organizationAccessExactPermissionSchema,
  organizationRecordAccessDecisionSchema,
  type OrganizationAccessDecisionEvidence,
  type OrganizationRecordAccessDecision,
} from "./organization-access-decision";
import { businessRecordSchema, type BusinessRecord } from "./operation-contracts";
import { permissionDeclarationSchema, permissionFieldPolicySchema } from "./permissions";
import { permissionRegistryDefinitionReleaseSchema } from "./permission-registry";

const same = (left: string | undefined, right: string | undefined): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined && left.toLowerCase() === right.toLowerCase();

const canonicalFields = (values: Iterable<string>): string[] =>
  [...new Set([...values].map((value) => value.toLowerCase()))].sort();

export const recordFieldDeclarationSchema = z
  .object({
    permission: organizationAccessExactPermissionSchema,
    source: permissionRegistryDefinitionReleaseSchema,
    declaration: permissionDeclarationSchema,
  })
  .strict();

export const recordFieldAccessRefusalReasonSchema = z.enum([
  "record_access_refused",
  "declaration_mismatch",
  "evidence_mismatch",
]);

export const resolvedRecordFieldAccessSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("allowed"),
      decision: organizationRecordAccessDecisionSchema.refine(
        (decision) => decision.outcome === "allowed",
        "Resolved field access requires an allowed record decision",
      ),
      fieldPolicy: permissionFieldPolicySchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      decision: organizationRecordAccessDecisionSchema,
      reasonCode: recordFieldAccessRefusalReasonSchema,
    })
    .strict(),
]);

export type RecordFieldDeclaration = z.infer<typeof recordFieldDeclarationSchema>;
export type ResolvedRecordFieldAccess = z.infer<typeof resolvedRecordFieldAccessSchema>;

const exactPermissionKey = (value: z.infer<typeof organizationAccessExactPermissionSchema>) =>
  [
    value.applicationRootId?.toLowerCase() ?? "",
    value.ownerKind,
    value.ownerId.toLowerCase(),
    value.permissionId.toLowerCase(),
  ].join(":");

export function resolveRecordFieldAccess(input: {
  decision: unknown;
  declarations: readonly unknown[];
  currentEvidence: unknown;
  observedAt: unknown;
}): ResolvedRecordFieldAccess {
  const decision = organizationRecordAccessDecisionSchema.parse(input.decision);
  if (decision.outcome === "refused")
    return { outcome: "refused", decision, reasonCode: "record_access_refused" };
  if (!evidenceIsCurrent(decision, input.currentEvidence, input.observedAt))
    return { outcome: "refused", decision, reasonCode: "evidence_mismatch" };
  const declarations = input.declarations.map((entry) => recordFieldDeclarationSchema.parse(entry));

  const byPermission = new Map<string, RecordFieldDeclaration>();
  for (const entry of declarations) {
    const key = exactPermissionKey(entry.permission);
    if (byPermission.has(key))
      return { outcome: "refused", decision, reasonCode: "declaration_mismatch" };
    byPermission.set(key, entry);
  }

  const readable = new Set<string>();
  const changeable = new Set<string>();
  for (const contribution of decision.matchedContributions) {
    const entry = byPermission.get(exactPermissionKey(contribution.permission));
    if (!entry) return { outcome: "refused", decision, reasonCode: "declaration_mismatch" };
    const { declaration } = entry;
    const sourceMatches =
      entry.source.kind === contribution.source.kind &&
      entry.source.definitionKey === contribution.source.definitionKey &&
      same(entry.source.rootId, contribution.source.rootId) &&
      entry.source.releaseVersion === contribution.source.releaseVersion &&
      entry.source.releaseRevision === contribution.source.releaseRevision &&
      entry.source.validationContractVersion === contribution.source.validationContractVersion &&
      entry.source.contentFingerprint === contribution.source.contentFingerprint &&
      entry.source.resolutionFingerprint === contribution.source.resolutionFingerprint;
    const ownerMatches =
      entry.permission.ownerKind === entry.source.kind &&
      same(entry.permission.ownerId, entry.source.rootId) &&
      same(entry.permission.applicationRootId, decision.target.applicationRootId) &&
      (entry.source.kind === "module"
        ? same(entry.source.rootId, decision.recordBinding.moduleRootId)
        : same(entry.source.rootId, decision.target.applicationRootId));
    const declarationMatches =
      same(entry.permission.permissionId, declaration.permissionId) &&
      same(declaration.recordTypeId, decision.recordBinding.recordTypeId) &&
      declaration.actionKind === decision.action.actionKind &&
      declaration.namedAction === decision.action.namedAction &&
      JSON.stringify(declaration.recordScope) === JSON.stringify(contribution.recordScope);
    if (!sourceMatches || !ownerMatches || !declarationMatches)
      return { outcome: "refused", decision, reasonCode: "declaration_mismatch" };

    const policy = declaration.fieldPolicy;
    if (!policy) continue;
    const shareReadable =
      contribution.route.kind === "direct_share"
        ? new Set(contribution.route.readableFieldIds.map((fieldId) => fieldId.toLowerCase()))
        : undefined;
    const shareChangeable =
      contribution.route.kind === "direct_share"
        ? new Set(contribution.route.changeableFieldIds.map((fieldId) => fieldId.toLowerCase()))
        : undefined;
    for (const fieldId of policy.readableFieldIds)
      if (!shareReadable || shareReadable.has(fieldId.toLowerCase())) readable.add(fieldId);
    for (const fieldId of policy.changeableFieldIds)
      if (!shareChangeable || shareChangeable.has(fieldId.toLowerCase())) changeable.add(fieldId);
  }
  return resolvedRecordFieldAccessSchema.parse({
    outcome: "allowed",
    decision,
    fieldPolicy: {
      readableFieldIds: canonicalFields(readable),
      changeableFieldIds: canonicalFields(changeable),
    },
  });
}

const derivedProjectionSchema = z
  .object({
    key: namespacedKeySchema,
    dependencyFieldIds: z.array(fieldIdSchema).min(1),
    value: jsonValueSchema,
  })
  .strict();

export const protectedRecordProjectionSchema = z
  .object({
    record: businessRecordSchema,
    derived: z.array(derivedProjectionSchema),
  })
  .strict();

/**
 * Projects server-owned record values and immutable semantic resources. The
 * `derived` dependency declarations are trusted Definition metadata, never
 * request-authored labels for values supplied by a caller.
 */
export function projectReadableRecord(
  access: unknown,
  record: unknown,
  derived: readonly unknown[] = [],
  currentEvidence?: unknown,
  observedAt?: unknown,
): z.infer<typeof protectedRecordProjectionSchema> | undefined {
  const parsed = resolvedRecordFieldAccessSchema.parse(access);
  const candidate = businessRecordSchema.parse(record);
  if (parsed.outcome === "refused" || parsed.decision.outcome !== "allowed") return undefined;
  if (!evidenceIsCurrent(parsed.decision, currentEvidence, observedAt)) return undefined;
  if (!recordMatches(parsed.decision, candidate)) return undefined;
  const readable = new Set(
    parsed.fieldPolicy.readableFieldIds.map((fieldId) => fieldId.toLowerCase()),
  );
  const values = Object.fromEntries(
    Object.entries(candidate.values).filter(([fieldId]) => readable.has(fieldId.toLowerCase())),
  );
  return protectedRecordProjectionSchema.parse({
    record: { ...candidate, values },
    derived: derived
      .map((entry) => derivedProjectionSchema.parse(entry))
      .filter((entry) =>
        entry.dependencyFieldIds.every((fieldId) => readable.has(fieldId.toLowerCase())),
      ),
  });
}

export const recordFieldWriteResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({ outcome: z.literal("accepted"), changes: z.record(fieldIdSchema, jsonValueSchema) })
    .strict(),
  z
    .object({
      outcome: z.literal("refused"),
      reasonCode: z.enum([
        "record_access_refused",
        "evidence_mismatch",
        "field_refused",
        "action_refused",
      ]),
    })
    .strict(),
]);

export function validateRecordFieldWrite(
  access: unknown,
  record: unknown,
  changes: unknown,
  currentEvidence?: unknown,
  observedAt?: unknown,
): z.infer<typeof recordFieldWriteResultSchema> {
  const parsed = resolvedRecordFieldAccessSchema.parse(access);
  const candidate = businessRecordSchema.parse(record);
  if (parsed.outcome === "refused" || parsed.decision.outcome !== "allowed")
    return { outcome: "refused", reasonCode: "record_access_refused" };
  if (!evidenceIsCurrent(parsed.decision, currentEvidence, observedAt))
    return { outcome: "refused", reasonCode: "evidence_mismatch" };
  if (!recordMatches(parsed.decision, candidate))
    return { outcome: "refused", reasonCode: "evidence_mismatch" };
  if (!["create", "update", "named"].includes(parsed.decision.action.actionKind))
    return { outcome: "refused", reasonCode: "action_refused" };
  const allowed = new Set(
    parsed.fieldPolicy.changeableFieldIds.map((fieldId) => fieldId.toLowerCase()),
  );
  const parsedChanges = z.record(fieldIdSchema, jsonValueSchema).parse(changes);
  if (Object.keys(parsedChanges).some((fieldId) => !allowed.has(fieldId.toLowerCase())))
    return { outcome: "refused", reasonCode: "field_refused" };
  return recordFieldWriteResultSchema.parse({ outcome: "accepted", changes: parsedChanges });
}

function evidenceIsCurrent(
  decision: Extract<OrganizationRecordAccessDecision, { outcome: "allowed" }>,
  candidate: unknown,
  observedAt: unknown,
): boolean {
  const parsed = organizationAccessDecisionEvidenceSchema.safeParse(candidate);
  const observed = z.string().datetime({ offset: true }).safeParse(observedAt);
  if (!parsed.success || !observed.success) return false;
  const evidence: OrganizationAccessDecisionEvidence = parsed.data;
  return (
    evidence.operationKey === decision.operationKey &&
    evidence.target.kind === "application" &&
    same(evidence.target.applicationRootId, decision.target.applicationRootId) &&
    same(evidence.organizationId, decision.organizationId) &&
    same(evidence.organizationAccountId, decision.organizationAccountId) &&
    evidence.accessVersion === decision.accessVersion &&
    Date.parse(decision.checkedAt) >= Date.parse(evidence.checkedAt) &&
    same(evidence.correlationId, decision.correlationId) &&
    Date.parse(observed.data) >= Date.parse(decision.checkedAt) &&
    Date.parse(observed.data) < Date.parse(decision.validUntil)
  );
}

function recordMatches(
  decision: Extract<OrganizationRecordAccessDecision, { outcome: "allowed" }>,
  record: BusinessRecord,
): boolean {
  return (
    same(decision.organizationId, record.organizationId) &&
    (record.storageScope === "application_contained"
      ? same(decision.target.applicationRootId, record.applicationRootId)
      : true) &&
    same(decision.recordBinding.moduleRootId, record.moduleRootId) &&
    same(decision.recordBinding.recordTypeId, record.recordTypeId) &&
    same(decision.recordBinding.storageContractId, record.storageContractId) &&
    decision.recordBinding.storageScope === record.storageScope &&
    same(decision.recordId, record.recordId)
  );
}
