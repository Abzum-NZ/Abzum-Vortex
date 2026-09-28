import {
  applicationRootIdSchema,
  isRecord,
  organizationIdSchema,
  recordIdSchema,
  recordTypeIdSchema,
  sameId,
  tenantIdSchema,
  type ProtectedLegalHoldReference,
} from "@vortex/contracts";

type IdentifierSchema = Readonly<{
  safeParse: (value: unknown) =>
    | Readonly<{ success: true; data: string }>
    | Readonly<{ success: false }>;
}>;

const parseIdentifier = (schema: IdentifierSchema, value: unknown): string | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** Exact identity for one record considered for permanent removal. */
export type RecordRemovalCandidateIdentity = Readonly<{
  kind: "record";
  tenantId: string;
  organizationId: string;
  /** `null` means the record is known not to belong to an application. */
  applicationRootId?: string | null;
  recordTypeId: string;
  recordId: string;
}>;

/**
 * A scope match is advisory input to a protected removal operation. Callers
 * must refuse removal for both `match` and `indeterminate` outcomes.
 */
export type LifecycleHoldScopeMatch =
  | Readonly<{ outcome: "match" }>
  | Readonly<{ outcome: "no_match" }>
  | Readonly<{ outcome: "indeterminate" }>;

const MATCH: LifecycleHoldScopeMatch = Object.freeze({ outcome: "match" });
const NO_MATCH: LifecycleHoldScopeMatch = Object.freeze({ outcome: "no_match" });
const INDETERMINATE: LifecycleHoldScopeMatch = Object.freeze({ outcome: "indeterminate" });

type CandidateFacts = Readonly<{
  tenantId: string;
  organizationId: string;
  applicationRootId: string | null | undefined;
  recordTypeId: string | undefined;
  recordId: string | undefined;
}>;

const parseCandidateFacts = (candidate: unknown): CandidateFacts | undefined => {
  if (!isRecord(candidate) || candidate.kind !== "record") return undefined;

  const tenantId = parseIdentifier(tenantIdSchema, candidate.tenantId);
  const organizationId = parseIdentifier(organizationIdSchema, candidate.organizationId);
  if (tenantId === undefined || organizationId === undefined) return undefined;

  return {
    tenantId,
    organizationId,
    applicationRootId:
      candidate.applicationRootId === null
        ? null
        : parseIdentifier(applicationRootIdSchema, candidate.applicationRootId),
    recordTypeId: parseIdentifier(recordTypeIdSchema, candidate.recordTypeId),
    recordId: parseIdentifier(recordIdSchema, candidate.recordId),
  };
};

/**
 * Compares one authoritative, versioned hold reference with one record removal
 * candidate. File-scoped holds belong to the File matcher. This result never
 * grants read access or authorises deletion.
 */
export const matchProtectedLegalHoldToRecord = (
  hold: ProtectedLegalHoldReference,
  candidate: RecordRemovalCandidateIdentity,
): LifecycleHoldScopeMatch => {
  if (hold.status === "released") return NO_MATCH;

  const facts = parseCandidateFacts(candidate);
  if (facts === undefined) return INDETERMINATE;
  if (!sameId(hold.tenantId, facts.tenantId) || !sameId(hold.organizationId, facts.organizationId))
    return NO_MATCH;

  switch (hold.scope.kind) {
    case "all_organization_data":
      return MATCH;
    case "application":
      return facts.applicationRootId === undefined
        ? INDETERMINATE
        : facts.applicationRootId === null
          ? NO_MATCH
          : sameId(hold.scope.applicationRootId, facts.applicationRootId)
            ? MATCH
            : NO_MATCH;
    case "record_type":
      if (facts.recordTypeId === undefined) return INDETERMINATE;
      return sameId(hold.scope.recordTypeId, facts.recordTypeId) ? MATCH : NO_MATCH;
    case "record":
      if (facts.recordTypeId === undefined || facts.recordId === undefined) return INDETERMINATE;
      return sameId(hold.scope.recordTypeId, facts.recordTypeId) &&
        sameId(hold.scope.recordId, facts.recordId)
        ? MATCH
        : NO_MATCH;
    case "file":
      return NO_MATCH;
    default: {
      const exhaustive: never = hold.scope;
      return exhaustive;
    }
  }
};
