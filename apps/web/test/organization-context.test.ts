import { identitySessionSchema } from "@vortex/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listOrganizationLauncher = vi.hoisted(() => vi.fn());
const resolve = vi.hoisted(() => vi.fn());
const createHumanOrganizationRequestService = vi.hoisted(() => vi.fn(() => ({ resolve })));
const getIdentityAuthorityConfiguration = vi.hoisted(() =>
  vi.fn(() => ({ authorityId: "80000000-0000-4000-8000-000000000001" })),
);

vi.mock("server-only", () => ({}));
vi.mock("@vortex/identity", () => ({ listOrganizationLauncher }));
vi.mock("@vortex/access", () => ({ createHumanOrganizationRequestService }));
vi.mock("../app/auth/_lib/authority-configuration", () => ({
  getIdentityAuthorityConfiguration,
}));

import { loadSelectedOrganization } from "../app/_lib/organization-context";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const session = identitySessionSchema.parse({
  identityId: id(1),
  sessionId: id(2),
  authenticationStrength: "single_factor",
  accessTokenIssuedAt: "2026-09-05T00:00:00.000Z",
  accessTokenExpiresAt: "2026-09-05T01:00:00.000Z",
});
const entry = {
  organizationId: id(3),
  tenantDisplayName: "Example tenant",
  organizationDisplayName: "Example organisation",
};

describe("web organisation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      kind: "available",
      value: {
        tenantId: id(10),
        organizationId: id(3),
        organizationAccountId: id(11),
        accessVersion: 1,
      },
    });
    listOrganizationLauncher.mockResolvedValue({ kind: "available", entries: [entry] });
  });

  it("passes only the route organisation candidate into configured Access composition", async () => {
    await expect(loadSelectedOrganization(session, id(3))).resolves.toEqual({
      kind: "available",
      entry,
    });
    expect(createHumanOrganizationRequestService).toHaveBeenCalledWith({
      identityAuthorityId: "80000000-0000-4000-8000-000000000001",
    });
    expect(resolve).toHaveBeenCalledWith(session, { organizationId: id(3) });
  });

  it("coarsens malformed, unknown and no-longer-listed selections", async () => {
    await expect(loadSelectedOrganization(session, "bad")).resolves.toEqual({
      kind: "unavailable",
    });
    expect(resolve).not.toHaveBeenCalled();

    resolve.mockResolvedValueOnce({ kind: "unavailable" });
    await expect(loadSelectedOrganization(session, id(4))).resolves.toEqual({
      kind: "unavailable",
    });

    listOrganizationLauncher.mockResolvedValueOnce({ kind: "available", entries: [] });
    await expect(loadSelectedOrganization(session, id(3))).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("keeps configuration and dependency failures retryable", async () => {
    getIdentityAuthorityConfiguration.mockImplementationOnce(() => {
      throw new Error("configuration detail");
    });
    await expect(loadSelectedOrganization(session, id(3))).resolves.toEqual({
      kind: "temporarily_unavailable",
    });

    resolve.mockResolvedValueOnce({ kind: "temporarily_unavailable" });
    await expect(loadSelectedOrganization(session, id(3))).resolves.toEqual({
      kind: "temporarily_unavailable",
    });
  });
});
