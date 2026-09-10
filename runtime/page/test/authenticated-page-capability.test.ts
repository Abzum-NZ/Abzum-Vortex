import type { OrganizationAccessDeclaration } from "@vortex/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthenticatedPageCapabilityService } from "../src/authenticated-page-capability";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const applicationRootId = id(1);
const correlationId = id(2);
const scope = {
  tenantId: id(3),
  organizationId: id(4),
  organizationAccountId: id(5),
  applicationRootId,
  accessVersion: 7,
};
const outcomes = new Map<string, "allowed" | "refused">();

vi.mock("@vortex/access", () => ({
  createHumanOrganizationRequestService: () => ({
    run: async (
      _session: unknown,
      _candidate: unknown,
      operation: (...args: unknown[]) => unknown,
    ) => ({
      kind: "available",
      value: await operation({ query: async () => [] }, scope),
    }),
  }),
  runOrganizationAccessOperation: async (
    _transaction: unknown,
    _scope: unknown,
    declaration: OrganizationAccessDeclaration,
    operation: (decision: { correlationId: string }) => unknown,
  ) =>
    outcomes.get(declaration.operationKey) === "refused"
      ? { outcome: "refused", reasonCode: "access_refused", correlationId }
      : { outcome: "completed", value: await operation({ correlationId }) },
}));

const declaration = (operationKey: string): OrganizationAccessDeclaration => ({
  operationKey,
  action: { actionKind: "read" },
  target: { kind: "application", applicationRootId },
  requiredPermission: {
    applicationRootId,
    ownerKind: "application",
    ownerId: applicationRootId,
    permissionId: id(8),
  },
  recentAuthentication: { kind: "none" },
  authority: { kind: "permission" },
});
const placementId = id(9);
const page = {
  pageId: id(10),
  key: "overview",
  name: "Overview",
  type: "dashboard" as const,
  accessPermissionKey: "example.page.view",
  states: ["normal" as const],
  layout: {
    desktop: { columns: 12 as const, componentOrder: [placementId] },
    phone: { componentOrder: [placementId] },
  },
  blocks: [
    {
      placementId,
      blockId: id(11),
      blockReleaseVersion: "1.0.0",
      settings: {},
      desktop: { startColumn: 1, span: 12, height: 1 },
      phone: { order: 0, behaviour: "stack" as const },
      viewPermissionKey: "example.block.view",
      usePermissionKey: "example.block.use",
    },
  ],
};

describe("authenticated page capability adapter", () => {
  beforeEach(() => outcomes.clear());

  const service = (
    permissionKey = "example.page.view",
    pageCandidate = page,
    visibilityConditionAllowed?: boolean,
  ) =>
    createAuthenticatedPageCapabilityService({
      identityAuthorityId: id(20),
      adapter: {
        load: async () => ({
          page: pageCandidate,
          pagePermission: { permissionKey, declaration: declaration("page.read") },
          placements: {
            [placementId]: {
              viewPermission: {
                permissionKey: "example.block.view",
                declaration: declaration("block.view"),
              },
              usePermission: {
                permissionKey: "example.block.use",
                declaration: declaration("block.use"),
              },
              operationBound: true,
              ...(visibilityConditionAllowed === undefined ? {} : { visibilityConditionAllowed }),
            },
          },
        }),
      },
    });

  it("omits a page refused by the current Access decision", async () => {
    outcomes.set("page.read", "refused");
    await expect(service().project({} as never, {} as never, {})).resolves.toEqual({
      kind: "available",
      value: undefined,
    });
  });

  it("keeps visible presentation but removes invocation on use refusal", async () => {
    outcomes.set("block.use", "refused");
    const result = await service().project({} as never, {} as never, {});
    expect(result).toMatchObject({
      kind: "available",
      value: {
        blocks: [{ availability: "unavailable", unavailableReason: "operation_unavailable" }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("PermissionKey");
  });

  it("keeps a bound control unavailable when only page, view and use gates are admitted", async () => {
    const result = await service().project({} as never, {} as never, {});
    expect(result).toMatchObject({
      kind: "available",
      value: {
        blocks: [{ availability: "unavailable", unavailableReason: "operation_unavailable" }],
      },
    });
  });

  it("removes a V1 placement refused by its ordinary view permission and prunes layout order", async () => {
    outcomes.set("block.view", "refused");
    const result = await service().project({} as never, {} as never, {});
    expect(result).toMatchObject({
      kind: "available",
      value: {
        blocks: [],
        layout: { desktop: { componentOrder: [] }, phone: { componentOrder: [] } },
      },
    });
  });

  it("removes a conditioned V1 placement unless its trusted condition evaluation admits it", async () => {
    const conditionedPage = structuredClone(page);
    conditionedPage.blocks[0]!.visibilityCondition = {
      kind: "comparison",
      operator: "equals",
      left: { source: "value", value: true },
      right: { source: "value", value: true },
    };
    const refused = await service("example.page.view", conditionedPage, false).project(
      {} as never,
      {} as never,
      {},
    );
    expect(refused).toMatchObject({ kind: "available", value: { blocks: [] } });
    const admitted = await service("example.page.view", conditionedPage, true).project(
      {} as never,
      {} as never,
      {},
    );
    expect(admitted).toMatchObject({ kind: "available", value: { blocks: [{}] } });
    expect(JSON.stringify(admitted)).not.toContain("visibilityCondition");
  });

  it("refuses a trusted adapter whose page permission binding does not match", async () => {
    await expect(service("example.other").project({} as never, {} as never, {})).rejects.toThrow(
      "PAGE_CAPABILITY_BINDING_UNAVAILABLE",
    );
  });
});
