import {
  organizationAccessDeclarationSchema,
  selectedOrganizationScopeSchema,
  type OrganizationAccessDeclaration,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RequestDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { runOrganizationAccessOperation } from "../src/organization-access-decision";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const checkedAt = "2026-09-06T01:00:00.000Z";
const validUntil = "2026-09-06T01:05:00.000Z";

const declaration = (
  overrides: Partial<OrganizationAccessDeclaration> = {},
): OrganizationAccessDeclaration =>
  organizationAccessDeclarationSchema.parse({
    operationKey: "platform.organization.groups.read",
    action: { actionKind: "read" },
    target: { kind: "organization" },
    requiredPermission: {
      ownerKind: "platform",
      ownerId: id(90),
      permissionId: id(91),
    },
    recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
    ...overrides,
  });

const scope = (overrides: Partial<SelectedOrganizationScope> = {}): SelectedOrganizationScope =>
  selectedOrganizationScopeSchema.parse({
    tenantId: id(1),
    organizationId: id(2),
    organizationAccountId: id(3),
    accessVersion: 4,
    ...overrides,
  });

const row = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  outcome: "eligible",
  operation_key: "platform.organization.groups.read",
  target_kind: "organization",
  target_application_root_id: null,
  organization_id: id(2),
  organization_account_id: id(3),
  access_version: "4",
  checked_at: new Date(checkedAt),
  valid_until: new Date(validUntil),
  correlation_id: id(4),
  reason_code: null,
  ...overrides,
});

const transaction = (
  rows: readonly DatabaseRow[] | Error,
  calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [],
): RequestDatabaseTransaction => ({
  query: async <ResultRow extends DatabaseRow>(
    strings: TemplateStringsArray,
    ...values: readonly DatabaseValue[]
  ): Promise<readonly ResultRow[]> => {
    calls.push({ text: strings.join("$value"), values });
    if (rows instanceof Error) throw rows;
    return rows as readonly ResultRow[];
  },
});

describe("organization access decision adapter", () => {
  it("runs one exact evaluator call and keeps allowed evidence inside the callback", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const operation = vi.fn(async (decision) => ({
      operationKey: decision.operationKey,
      validUntil: decision.validUntil,
    }));

    await expect(
      runOrganizationAccessOperation(
        transaction([row()], calls),
        scope(),
        declaration(),
        operation,
      ),
    ).resolves.toEqual({
      outcome: "completed",
      value: {
        operationKey: "platform.organization.groups.read",
        validUntil,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("vortex_access.evaluate_organization_permission_eligibility");
    expect(JSON.parse(String(calls[0]?.values[0]))).toEqual(declaration());
    expect(operation).toHaveBeenCalledWith({
      outcome: "allowed",
      operationKey: "platform.organization.groups.read",
      target: { kind: "organization" },
      organizationId: id(2),
      organizationAccountId: id(3),
      accessVersion: 4,
      checkedAt,
      validUntil,
      correlationId: id(4),
    });
  });

  it.each([
    ["permission_unavailable", "access_refused"],
    ["permission_not_effective", "access_refused"],
    ["delegation_insufficient", "access_refused"],
    ["authentication_unsatisfied", "authentication_required"],
    ["target_policy_unavailable", "target_policy_unavailable"],
  ] as const)("coarsens %s without invoking the operation", async (privateReason, safeReason) => {
    const operation = vi.fn();
    await expect(
      runOrganizationAccessOperation(
        transaction([row({ outcome: "refused", valid_until: null, reason_code: privateReason })]),
        scope(),
        declaration(),
        operation,
      ),
    ).resolves.toEqual({ outcome: "refused", reasonCode: safeReason, correlationId: id(4) });
    expect(operation).not.toHaveBeenCalled();
  });

  it("requires exact application context but permits organization operations inside it", async () => {
    const applicationRootId = id(5);
    const applicationDeclaration = declaration({
      operationKey: "application.records.read",
      target: { kind: "application", applicationRootId },
      requiredPermission: {
        applicationRootId,
        ownerKind: "application",
        ownerId: applicationRootId,
        permissionId: id(92),
      },
    });
    const applicationRow = row({
      operation_key: "application.records.read",
      target_kind: "application",
      target_application_root_id: applicationRootId.toUpperCase(),
    });

    await expect(
      runOrganizationAccessOperation(
        transaction([applicationRow]),
        scope({ applicationRootId: applicationRootId.toUpperCase() }),
        applicationDeclaration,
        async () => "application",
      ),
    ).resolves.toEqual({ outcome: "completed", value: "application" });

    await expect(
      runOrganizationAccessOperation(
        transaction([row()]),
        scope({ applicationRootId }),
        declaration(),
        async () => "organization",
      ),
    ).resolves.toEqual({ outcome: "completed", value: "organization" });

    const operation = vi.fn();
    await expect(
      runOrganizationAccessOperation(
        transaction([applicationRow]),
        scope({ applicationRootId: id(6) }),
        applicationDeclaration,
        operation,
      ),
    ).rejects.toThrow("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");
    expect(operation).not.toHaveBeenCalled();

    await expect(
      runOrganizationAccessOperation(
        transaction([
          {
            ...applicationRow,
            outcome: "refused",
            valid_until: null,
            reason_code: "permission_unavailable",
          },
        ]),
        scope(),
        applicationDeclaration,
        operation,
      ),
    ).rejects.toThrow("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ["missing row", []],
    ["multiple rows", [row(), row()]],
    ["foreign organization", [row({ organization_id: id(99) })]],
    ["foreign account", [row({ organization_account_id: id(99) })]],
    ["wrong Access version", [row({ access_version: 5n })]],
    ["wrong operation", [row({ operation_key: "platform.organization.groups.update" })]],
    ["malformed result", [row({ reason_code: "private_detail" })]],
  ] as const)("refuses a %s result without invoking the operation", async (_description, rows) => {
    const operation = vi.fn();
    await expect(
      runOrganizationAccessOperation(
        transaction(rows as readonly DatabaseRow[]),
        scope(),
        declaration(),
        operation,
      ),
    ).rejects.toThrow("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not query for invalid declarations or expose database failures", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const operation = vi.fn();
    await expect(
      runOrganizationAccessOperation(
        transaction([], calls),
        scope(),
        { ...declaration(), operationKey: "bad" } as OrganizationAccessDeclaration,
        operation,
      ),
    ).rejects.toThrow("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");
    expect(calls).toHaveLength(0);

    const privateFailure = Object.assign(new Error("raw SQL and private role detail"), {
      code: "XX000",
    });
    await expect(
      runOrganizationAccessOperation(
        transaction(privateFailure),
        scope(),
        declaration(),
        operation,
      ),
    ).rejects.toThrow("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not expose a protected operation failure", async () => {
    const privateFailure = new Error("raw protected-writer detail");
    await expect(
      runOrganizationAccessOperation(transaction([row()]), scope(), declaration(), async () => {
        throw privateFailure;
      }),
    ).rejects.toThrow("ORGANIZATION_ACCESS_DECISION_UNAVAILABLE");
  });
});
