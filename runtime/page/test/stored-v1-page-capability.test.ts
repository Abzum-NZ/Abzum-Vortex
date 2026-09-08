import type { OrganizationAccessDeclaration, SessionContext } from "@vortex/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStoredV1PageCapabilityService } from "../src/stored-v1-page-capability";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const applicationRootId = id(1);
const pageId = id(2);
const organizationId = id(3);
const correlationId = id(4);
const systemContext: SessionContext = {
  callerKind: "system",
  tenantId: id(5),
  organizationId,
  systemActorId: id(6),
  sessionId: id(7),
  authenticationStrength: "service",
  issuedAt: "2026-09-08T00:00:00.000Z",
  expiresAt: "2026-09-09T00:00:00.000Z",
  accessVersion: 7,
  correlationId,
};
const permission = (permissionId: string, key: string) => ({
  applicationRootId,
  ownerKind: "application" as const,
  ownerId: applicationRootId,
  permission: {
    permissionId,
    key,
    label: key,
    description: key,
    actionKind: "read" as const,
    administrative: false,
  },
  sourceRelease: {},
  meaningFingerprint: "sha256:" + "a".repeat(64),
});
const pagePermission = permission(id(10), "example.page.view");
const blockPermission = permission(id(11), "example.block.view");
const page = {
  pageId,
  key: "overview",
  name: "Overview",
  type: "dashboard" as const,
  accessPermissionKey: pagePermission.permission.key,
  states: ["normal" as const],
  layout: {
    desktop: { columns: 12 as const, componentOrder: [id(20)] },
    phone: { componentOrder: [id(20)] },
  },
  blocks: [
    {
      placementId: id(20),
      blockId: id(21),
      blockReleaseVersion: "1.0.0",
      settings: { heading: { kind: "literal" as const, value: "Safe heading" } },
      desktop: { startColumn: 1, span: 12, height: 1 },
      phone: { order: 0, behaviour: "stack" as const },
      viewPermissionKey: blockPermission.permission.key,
    },
  ],
};
const readExact = vi.fn();
const accessDeclarations: OrganizationAccessDeclaration[] = [];
let accessCorrelationId = correlationId;

vi.mock("@vortex/access", () => ({
  createStoredApplicationPermissionSource: () => ({ readExact }),
  createHumanOrganizationRequestService: () => ({
    run: async (
      _session: unknown,
      _candidate: unknown,
      operation: (...args: unknown[]) => unknown,
    ) => ({
      kind: "available",
      value: await operation(
        { query: async () => [] },
        {
          tenantId: id(5),
          organizationId,
          organizationAccountId: id(30),
          applicationRootId,
          accessVersion: 7,
        },
      ),
    }),
  }),
  runOrganizationAccessOperation: async (
    _transaction: unknown,
    _scope: unknown,
    declaration: OrganizationAccessDeclaration,
    operation: (decision: { correlationId: string }) => unknown,
  ) => {
    accessDeclarations.push(declaration);
    return { outcome: "completed", value: await operation({ correlationId: accessCorrelationId }) };
  },
}));

const release = {
  kind: "application" as const,
  organizationId,
  definitionKey: "example.application",
  rootId: applicationRootId,
  releaseRevision: 5,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: "sha256:" + "b".repeat(64),
  resolutionFingerprint: "sha256:" + "c".repeat(64),
  dependencyManifest: [],
  correlationId,
  content: { pages: [page] },
};

describe("stored V1 page capability adapter", () => {
  beforeEach(() => {
    readExact.mockReset().mockResolvedValue({
      applicationRelease: release,
      permissionRegistration: {
        organizationId,
        applicationRootId,
        applicationRelease: {
          definitionKey: release.definitionKey,
          releaseRevision: release.releaseRevision,
          releaseVersion: release.releaseVersion,
          validationContractVersion: release.validationContractVersion,
          contentFingerprint: release.contentFingerprint,
          resolutionFingerprint: release.resolutionFingerprint,
        },
        entries: [pagePermission, blockPermission],
      },
    });
    accessDeclarations.length = 0;
    accessCorrelationId = correlationId;
  });

  const service = (selectedPageId = pageId) => ({
    service: createStoredV1PageCapabilityService({
      identityAuthorityId: id(40),
      systemContext,
      selection: { applicationRootId, releaseRevision: 5, pageId: selectedPageId },
      definitionCatalogue: { connectionTypeReleases: [], platformThemeReleases: [] },
    }),
  });

  it("reads one fixed exact release in system context before projecting the selected page", async () => {
    const candidate = service();
    await expect(
      candidate.service.project({} as never, { organizationId, applicationRootId }),
    ).resolves.toMatchObject({
      kind: "available",
      value: { pageId, name: "Overview", blocks: [{ settings: page.blocks[0]!.settings }] },
    });
    expect(readExact).toHaveBeenCalledOnce();
    expect(accessDeclarations.map((entry) => entry.requiredPermission.permissionId)).toEqual([
      pagePermission.permission.permissionId,
      blockPermission.permission.permissionId,
    ]);
  });

  it("refuses an unselected application before reading Definition", async () => {
    const candidate = service();
    await expect(
      candidate.service.project({} as never, {
        organizationId,
        applicationRootId: id(99),
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(readExact).not.toHaveBeenCalled();
    await expect(
      candidate.service.project({} as never, {
        organizationId: id(97),
        applicationRootId,
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(readExact).not.toHaveBeenCalled();
  });

  it("refuses an absent page selection", async () => {
    await expect(
      service(id(98)).service.project({} as never, { organizationId, applicationRootId }),
    ).rejects.toThrow("STORED_PAGE_DEFINITION_EVIDENCE_UNAVAILABLE");
  });

  it("refuses human Access evidence from a different server correlation", async () => {
    accessCorrelationId = id(96);
    await expect(
      service().service.project({} as never, { organizationId, applicationRootId }),
    ).rejects.toThrow("PAGE_CAPABILITY_EVIDENCE_UNAVAILABLE");
  });
});
