import type {
  OrganizationRecordAccessDecision,
  OrganizationRecordAccessDeclaration,
  SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import {
  runOrganizationRecordAccessOperation,
  type FixedOrganizationRecordAccessAdapter,
} from "../src/organization-record-access-operation";

const id = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const applicationRootId = id(1);
const organizationId = id(2);
const organizationAccountId = id(3);
const moduleRootId = id(4);
const recordTypeId = id(5);
const storageContractId = id(6);
const recordId = id(7);
const permissionId = id(8);
const correlationId = id(9);
const declaration: OrganizationRecordAccessDeclaration = {
  operationKey: "neutral.records.read",
  action: { actionKind: "read" },
  target: { kind: "application", applicationRootId },
  requiredPermissions: [
    {
      applicationRootId,
      ownerKind: "module",
      ownerId: moduleRootId,
      permissionId,
    },
  ],
  recordBinding: {
    moduleRootId,
    recordTypeId,
    storageContractId,
    storageScope: "application_contained",
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
};
const scope: SelectedOrganizationScope = {
  tenantId: id(10),
  organizationId,
  organizationAccountId,
  applicationRootId,
  accessVersion: 11,
};
const allowed: OrganizationRecordAccessDecision = {
  outcome: "allowed",
  operationKey: declaration.operationKey,
  target: declaration.target,
  organizationId,
  organizationAccountId,
  accessVersion: 11,
  checkedAt: "2026-09-08T01:00:00.000Z",
  recordBinding: declaration.recordBinding,
  recordId,
  action: declaration.action,
  matchedContributions: [
    {
      permission: declaration.requiredPermissions[0]!,
      recordScope: { routes: [{ kind: "all_records" }] },
      source: {
        kind: "module",
        definitionKey: "neutral.records",
        rootId: moduleRootId,
        releaseRevision: 1,
        releaseVersion: "1.0.0",
        validationContractVersion: "2.20.0",
        contentFingerprint: `sha256:${"1".repeat(64)}`,
        resolutionFingerprint: `sha256:${"2".repeat(64)}`,
      },
      route: { kind: "all_records" },
      validUntil: "2026-09-08T01:05:00.000Z",
    },
  ],
  validUntil: "2026-09-08T01:05:00.000Z",
  correlationId,
};

const currentEvidence = {
  organization_id: organizationId,
  organization_account_id: organizationAccountId,
  application_root_id: applicationRootId,
  access_version: "11",
  correlation_id: correlationId,
  expires_at: "2026-09-08T02:00:00.000Z",
  observed_at: new Date("2026-09-08T01:01:00.000Z"),
};
const transactionFor = (
  evidence: Readonly<Record<string, unknown>> = currentEvidence,
): RequestDatabaseTransaction => ({
  query: async <Row extends DatabaseRow>() => [evidence] as readonly Row[],
});
const transaction = transactionFor();
type Command = Readonly<{ recordId: string }>;
const adapterFor = (
  decision: OrganizationRecordAccessDecision,
): FixedOrganizationRecordAccessAdapter<Command> => ({
  declaration,
  recordId: (command) => command.recordId,
  evaluate: vi.fn(async () => decision),
});

describe("fixed organization record-access orchestration", () => {
  it("invokes an operation only with an exact adapter-bound allowed decision", async () => {
    const adapter = adapterFor(allowed);
    const operation = vi.fn(
      async (decision: OrganizationRecordAccessDecision) => decision.recordId,
    );

    await expect(
      runOrganizationRecordAccessOperation(transaction, scope, adapter, { recordId }, operation),
    ).resolves.toEqual({ outcome: "completed", value: recordId });
    expect(adapter.evaluate).toHaveBeenCalledWith(transaction, { recordId });
    expect(operation).toHaveBeenCalledWith(allowed);
  });

  it("returns only a safe refusal and never invokes the operation", async () => {
    const refusal: OrganizationRecordAccessDecision = {
      outcome: "refused",
      operationKey: allowed.operationKey,
      target: allowed.target,
      organizationId: allowed.organizationId,
      organizationAccountId: allowed.organizationAccountId,
      accessVersion: allowed.accessVersion,
      checkedAt: allowed.checkedAt,
      recordBinding: allowed.recordBinding,
      recordId: allowed.recordId,
      action: allowed.action,
      reasonCode: "record_scope_refused",
      correlationId: allowed.correlationId,
    };
    const operation = vi.fn(async () => undefined);

    await expect(
      runOrganizationRecordAccessOperation(
        transaction,
        scope,
        adapterFor(refusal),
        { recordId },
        operation,
      ),
    ).resolves.toEqual({ outcome: "refused", reasonCode: "access_refused", correlationId });
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ["record", { ...allowed, recordId: id(20) }],
    ["organization", { ...allowed, organizationId: id(20) }],
    [
      "application",
      { ...allowed, target: { kind: "application" as const, applicationRootId: id(20) } },
    ],
    ["Access version", { ...allowed, accessVersion: 12 }],
    ["action", { ...allowed, action: { actionKind: "update" as const } }],
    [
      "record binding",
      { ...allowed, recordBinding: { ...allowed.recordBinding, recordTypeId: id(20) } },
    ],
  ] as const)("refuses a decision rebound to another %s", async (_label, changed) => {
    await expect(
      runOrganizationRecordAccessOperation(
        transaction,
        scope,
        adapterFor(changed),
        { recordId },
        async () => undefined,
      ),
    ).rejects.toThrow("ORGANIZATION_RECORD_ACCESS_DECISION_UNAVAILABLE");
  });

  it("requires the selected protected request application to match the fixed adapter", async () => {
    await expect(
      runOrganizationRecordAccessOperation(
        transaction,
        { ...scope, applicationRootId: id(20) },
        adapterFor(allowed),
        { recordId },
        async () => undefined,
      ),
    ).rejects.toThrow("ORGANIZATION_RECORD_ACCESS_DECISION_UNAVAILABLE");
  });

  it("rejects cached evidence that does not match current correlation or validity", async () => {
    await expect(
      runOrganizationRecordAccessOperation(
        transactionFor({ ...currentEvidence, correlation_id: id(20) }),
        scope,
        adapterFor(allowed),
        { recordId },
        async () => undefined,
      ),
    ).rejects.toThrow("ORGANIZATION_RECORD_ACCESS_DECISION_UNAVAILABLE");

    await expect(
      runOrganizationRecordAccessOperation(
        transaction,
        scope,
        adapterFor({
          ...allowed,
          matchedContributions: [
            { ...allowed.matchedContributions[0]!, validUntil: "2026-09-08T01:00:30.000Z" },
          ],
          validUntil: "2026-09-08T01:00:30.000Z",
        }),
        { recordId },
        async () => undefined,
      ),
    ).rejects.toThrow("ORGANIZATION_RECORD_ACCESS_DECISION_UNAVAILABLE");
  });

  it("rejects a contribution outside the fixed declaration alternatives", async () => {
    const contribution = allowed.matchedContributions[0]!;
    await expect(
      runOrganizationRecordAccessOperation(
        transaction,
        scope,
        adapterFor({
          ...allowed,
          matchedContributions: [
            {
              ...contribution,
              permission: { ...contribution.permission, permissionId: id(20) },
            },
          ],
        }),
        { recordId },
        async () => undefined,
      ),
    ).rejects.toThrow("ORGANIZATION_RECORD_ACCESS_DECISION_UNAVAILABLE");
  });

  it("preserves errors raised by the operation after an allowed decision", async () => {
    const businessError = new Error("RECORD_UPDATE_CONFLICT");
    await expect(
      runOrganizationRecordAccessOperation(
        transaction,
        scope,
        adapterFor(allowed),
        { recordId },
        async () => {
          throw businessError;
        },
      ),
    ).rejects.toBe(businessError);
  });
});
