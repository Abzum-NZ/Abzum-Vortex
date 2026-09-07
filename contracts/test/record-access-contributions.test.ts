import { organizationRecordAccessDecisionSchema } from "../src/organization-access-decision";
import { describe, expect, it } from "vitest";

const id = (prefix: string, suffix: number): string =>
  `${prefix}4000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const applicationPermission = () => ({
  applicationRootId: id("a", 1),
  ownerKind: "application" as const,
  ownerId: id("a", 1),
  permissionId: id("b", 2),
});

const modulePermission = () => ({
  applicationRootId: id("a", 1),
  ownerKind: "module" as const,
  ownerId: id("c", 3),
  permissionId: id("d", 4),
});

const source = (kind: "application" | "module", rootId: string, definitionKey: string) => ({
  kind,
  definitionKey,
  rootId,
  releaseVersion: "1.2.3",
  releaseRevision: 7,
  validationContractVersion: "1.0.0",
  contentFingerprint: `sha256:${"a".repeat(64)}`,
  resolutionFingerprint: `sha256:${"b".repeat(64)}`,
});

const evidence = () => ({
  operationKey: "module.records.read",
  target: { kind: "application" as const, applicationRootId: id("a", 1) },
  organizationId: id("e", 5),
  organizationAccountId: id("f", 6),
  accessVersion: 8,
  checkedAt: "2026-09-06T06:00:00.000Z",
  correlationId: id("a", 7),
  recordBinding: {
    moduleRootId: id("c", 3),
    recordTypeId: id("b", 8),
    storageContractId: id("d", 9),
    storageScope: "application_contained" as const,
  },
});

const finalRecordEvidence = () => ({ ...evidence(), recordId: id("e", 10) });

const ownershipContribution = () => ({
  permission: modulePermission(),
  recordScope: { routes: [{ kind: "ownership" as const }] },
  source: source("module", id("c", 3), "module.records"),
  route: { kind: "ownership" as const },
  validUntil: "2026-09-06T06:04:00.000Z",
});

const allRecordsContribution = () => ({
  permission: applicationPermission(),
  recordScope: { routes: [{ kind: "all_records" as const }] },
  source: source("application", id("a", 1), "application.records"),
  route: { kind: "all_records" as const },
  validUntil: "2026-09-06T06:05:00.000Z",
});

const allowedDecision = () => ({
  ...finalRecordEvidence(),
  outcome: "allowed" as const,
  action: { actionKind: "read" as const },
  validUntil: "2026-09-06T06:04:00.000Z",
  matchedContributions: [ownershipContribution(), allRecordsContribution()],
});

describe("organization record access contributions", () => {
  it("requires a valid row identity on final allowed and refused decisions", () => {
    const allowedWithoutRecordId: Partial<ReturnType<typeof allowedDecision>> = {
      ...allowedDecision(),
    };
    delete allowedWithoutRecordId.recordId;
    const refused = {
      ...finalRecordEvidence(),
      outcome: "refused" as const,
      action: { actionKind: "read" as const },
      reasonCode: "record_scope_refused" as const,
    };
    const refusedWithoutRecordId: Partial<typeof refused> = { ...refused };
    delete refusedWithoutRecordId.recordId;

    expect(organizationRecordAccessDecisionSchema.safeParse(allowedDecision()).success).toBe(true);
    expect(organizationRecordAccessDecisionSchema.safeParse(refused).success).toBe(true);
    for (const candidate of [
      allowedWithoutRecordId,
      { ...allowedDecision(), recordId: "not-a-record-id" },
      refusedWithoutRecordId,
      { ...refused, recordId: "not-a-record-id" },
    ])
      expect(organizationRecordAccessDecisionSchema.safeParse(candidate).success).toBe(false);
  });

  it("parses complete contributions and uses their earliest deadline as the envelope", () => {
    const result = organizationRecordAccessDecisionSchema.safeParse(allowedDecision());

    expect(result.success).toBe(true);
    if (result.success && result.data.outcome === "allowed") {
      expect(result.data.outcome).toBe("allowed");
      expect(result.data.matchedContributions).toHaveLength(2);
      expect(result.data.validUntil).toBe("2026-09-06T06:04:00.000Z");
    }

    expect(
      organizationRecordAccessDecisionSchema.safeParse({
        ...allowedDecision(),
        validUntil: "2026-09-06T06:05:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires a complete contribution whose route belongs to its own permission scope", () => {
    const decision = allowedDecision();
    const missingSource: Partial<ReturnType<typeof ownershipContribution>> = {
      ...ownershipContribution(),
    };
    delete missingSource.source;

    for (const matchedContributions of [
      [],
      [missingSource],
      [
        {
          ...ownershipContribution(),
          source: { ...ownershipContribution().source, rootId: id("e", 10) },
        },
      ],
      [
        {
          ...ownershipContribution(),
          source: { ...ownershipContribution().source, kind: "application" },
        },
      ],
      [
        {
          ...ownershipContribution(),
          route: { kind: "all_records" },
        },
      ],
    ])
      expect(
        organizationRecordAccessDecisionSchema.safeParse({
          ...decision,
          matchedContributions,
        }).success,
      ).toBe(false);
  });

  it("rejects expired contributions even when the envelope also uses that deadline", () => {
    const expired = {
      ...allowedDecision(),
      validUntil: "2026-09-06T06:00:00.000Z",
      matchedContributions: [
        { ...ownershipContribution(), validUntil: "2026-09-06T06:00:00.000Z" },
      ],
    };

    expect(organizationRecordAccessDecisionSchema.safeParse(expired).success).toBe(false);
  });

  it("permits direct-share contributions only for read or update with canonical field subsets", () => {
    const readableFieldIds = [id("a", 20), id("b", 21)];
    const directShare = {
      permission: applicationPermission(),
      recordScope: { routes: [{ kind: "direct_share" as const }] },
      source: source("application", id("a", 1), "application.records"),
      route: {
        kind: "direct_share" as const,
        directShareId: id("c", 22),
        directShareRevision: 3,
        readableFieldIds,
        changeableFieldIds: [id("b", 21)],
      },
      validUntil: "2026-09-06T06:04:00.000Z",
    };
    const decision = {
      ...finalRecordEvidence(),
      outcome: "allowed" as const,
      action: { actionKind: "read" as const },
      validUntil: directShare.validUntil,
      matchedContributions: [directShare],
    };

    for (const actionKind of ["read", "update"] as const)
      expect(
        organizationRecordAccessDecisionSchema.safeParse({
          ...decision,
          action: { actionKind },
        }).success,
      ).toBe(true);

    for (const candidate of [
      { ...decision, action: { actionKind: "delete" } },
      {
        ...decision,
        matchedContributions: [
          {
            ...directShare,
            route: { ...directShare.route, readableFieldIds: [...readableFieldIds].reverse() },
          },
        ],
      },
      {
        ...decision,
        matchedContributions: [
          {
            ...directShare,
            route: { ...directShare.route, changeableFieldIds: [id("d", 23)] },
          },
        ],
      },
      {
        ...decision,
        matchedContributions: [
          {
            ...directShare,
            route: {
              ...directShare.route,
              changeableFieldIds: [id("b", 21), id("b", 21)],
            },
          },
        ],
      },
      {
        ...decision,
        matchedContributions: [
          {
            ...directShare,
            route: {
              ...directShare.route,
              changeableFieldIds: [id("b", 21), id("a", 20)],
            },
          },
        ],
      },
    ])
      expect(organizationRecordAccessDecisionSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires relationship contributions to match their scoped identity and source permission", () => {
    const relationshipId = id("a", 30);
    const sourcePermissionId = id("b", 31);
    const relationshipContribution = {
      permission: modulePermission(),
      recordScope: {
        routes: [{ kind: "relationship" as const, relationshipId, sourcePermissionId }],
      },
      source: source("module", id("c", 3), "module.records"),
      route: {
        kind: "relationship" as const,
        relationshipId,
        sourcePermissionId,
        sourceRecordId: id("d", 32),
      },
      validUntil: "2026-09-06T06:04:00.000Z",
    };
    const decision = {
      ...finalRecordEvidence(),
      outcome: "allowed" as const,
      action: { actionKind: "read" as const },
      validUntil: relationshipContribution.validUntil,
      matchedContributions: [relationshipContribution],
    };

    expect(organizationRecordAccessDecisionSchema.safeParse(decision).success).toBe(true);
    for (const route of [
      { ...relationshipContribution.route, relationshipId: id("e", 33) },
      { ...relationshipContribution.route, sourcePermissionId: id("f", 34) },
    ])
      expect(
        organizationRecordAccessDecisionSchema.safeParse({
          ...decision,
          matchedContributions: [{ ...relationshipContribution, route }],
        }).success,
      ).toBe(false);
  });
});
