import {
  applicationRootIdSchema,
  fileIdSchema,
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

/** Exact identity for one record or file considered for permanent removal. */
export type LifecycleRemovalCandidateIdentity =
  | Readonly<{
      kind: "record";
      tenantId: string;
      organizationId: string;
      applicationRootId?: string | null;
      recordTypeId: string;
      recordId: string;
    }>
  | Readonly<{
      kind: "file";
      tenantId: string;
      organizationId: string;
      applicationRootId?: string | null;
      fileId: string;
      /** `null` means the file is known to have no record owner. */
      owner?: Readonly<{ recordTypeId: string; recordId: string }> | null;
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
  kind: "record" | "file";
  tenantId: string;
  organizationId: string;
  applicationRootId: string | null | undefined;
  recordTypeId: string | undefined;
  recordId: string | undefined;
  fileId: string | undefined;
  ownerState: "present" | "absent" | "unknown";
}>;

const parseCandidateFacts = (candidate: unknown): CandidateFacts | undefined => {
  if (!isRecord(candidate) || (candidate.kind !== "record" && candidate.kind !== "file"))
    return undefined;

  const tenantId = parseIdentifier(tenantIdSchema, candidate.tenantId);
  const organizationId = parseIdentifier(organizationIdSchema, candidate.organizationId);
  if (tenantId === undefined || organizationId === undefined) return undefined;

  const applicationRootId =
    candidate.applicationRootId === null
      ? null
      : parseIdentifier(applicationRootIdSchema, candidate.applicationRootId);
  if (candidate.applicationRootId !== undefined && applicationRootId === undefined) return undefined;

  if (candidate.kind === "record") {
    const recordTypeId = parseIdentifier(recordTypeIdSchema, candidate.recordTypeId);
    const recordId = parseIdentifier(recordIdSchema, candidate.recordId);
    if (recordTypeId === undefined || recordId === undefined) return undefined;

    return {
      kind: "record",
      tenantId,
      organizationId,
      applicationRootId,
      recordTypeId,
      recordId,
      fileId: undefined,
      ownerState: "present",
    };
  }

  const fileId = parseIdentifier(fileIdSchema, candidate.fileId);
  if (fileId === undefined) return undefined;

  const owner = candidate.owner;
  if (owner === null) {
    return {
      kind: "file",
      tenantId,
      organizationId,
      applicationRootId,
      recordTypeId: undefined,
      recordId: undefined,
      fileId,
      ownerState: "absent",
    };
  }

  if (isRecord(owner)) {
    const recordTypeId = parseIdentifier(recordTypeIdSchema, owner.recordTypeId);
    const recordId = parseIdentifier(recordIdSchema, owner.recordId);
    if (recordTypeId === undefined || recordId === undefined) return undefined;

    return {
      kind: "file",
      tenantId,
      organizationId,
      applicationRootId,
      recordTypeId,
      recordId,
      fileId,
      ownerState: "present",
    };
  }

  if (owner !== undefined) return undefined;

  return {
    kind: "file",
    tenantId,
    organizationId,
    applicationRootId,
    recordTypeId: undefined,
    recordId: undefined,
    fileId,
    ownerState: "unknown",
  };
};

/**
 * Compares one authoritative, versioned hold reference with one removal
 * candidate. The result never grants read access or authorises deletion.
 */
export const matchProtectedLegalHoldToCandidate = (
  hold: ProtectedLegalHoldReference,
  candidate: LifecycleRemovalCandidateIdentity,
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
      if (facts.ownerState === "unknown") return INDETERMINATE;
      if (facts.ownerState === "absent") return NO_MATCH;
      if (facts.recordTypeId === undefined) return INDETERMINATE;
      return sameId(hold.scope.recordTypeId, facts.recordTypeId) ? MATCH : NO_MATCH;
    case "record":
      if (facts.ownerState === "unknown") return INDETERMINATE;
      if (facts.ownerState === "absent") return NO_MATCH;
      if (facts.recordTypeId === undefined || facts.recordId === undefined) return INDETERMINATE;
      return sameId(hold.scope.recordTypeId, facts.recordTypeId) &&
        sameId(hold.scope.recordId, facts.recordId)
        ? MATCH
        : NO_MATCH;
    case "file":
      if (facts.kind !== "file") return NO_MATCH;
      if (facts.fileId === undefined) return INDETERMINATE;
      return sameId(hold.scope.fileId, facts.fileId) ? MATCH : NO_MATCH;
    default: {
      const exhaustive: never = hold.scope;
      return exhaustive;
    }
  }
};
