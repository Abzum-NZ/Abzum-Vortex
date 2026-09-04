import { identitySessionSchema, type IdentitySession } from "@vortex/contracts";
import type { DatabaseRow, DatabaseValue, RuntimeDatabaseTransaction } from "@vortex/db";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationLauncherService } from "../src/organization-launcher";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const session = (): IdentitySession =>
  identitySessionSchema.parse({
    identityId: id(1),
    sessionId: id(2),
    authenticationStrength: "single_factor",
    accessTokenIssuedAt: "2026-09-05T00:00:00.000Z",
    accessTokenExpiresAt: "2026-09-05T01:00:00.000Z",
  });

describe("organisation launcher", () => {
  it("returns only the safe launcher projection from the Identity owner", async () => {
    const calls: Array<{ text: string; values: readonly DatabaseValue[] }> = [];
    const service = createOrganizationLauncherService({
      runtimeTransaction: async <Result>(
        operation: (transaction: RuntimeDatabaseTransaction) => Promise<Result>,
      ) =>
        operation({
          query: async <Row extends DatabaseRow>(
            strings: TemplateStringsArray,
            ...values: readonly DatabaseValue[]
          ) => {
            calls.push({ text: strings.join("$value"), values });
            return [
              {
                organization_id: id(4),
                tenant_display_name: "Example tenant",
                organization_display_name: "North office",
                account_display_name: "Person",
                private_state: "must not escape",
              },
            ] as readonly Row[];
          },
        }),
    });

    await expect(service.list(session())).resolves.toEqual({
      kind: "available",
      entries: [
        {
          organizationId: id(4),
          tenantDisplayName: "Example tenant",
          organizationDisplayName: "North office",
          accountDisplayName: "Person",
        },
      ],
    });
    expect(calls[0]?.text).toContain("vortex_identity.list_organization_launcher");
    expect(calls[0]?.values).toEqual([id(1)]);
  });

  it("distinguishes a safe empty launcher from temporary storage failure", async () => {
    const empty = createOrganizationLauncherService({
      runtimeTransaction: async (operation) => operation({ query: async () => [] }),
    });
    await expect(empty.list(session())).resolves.toEqual({ kind: "available", entries: [] });

    const failed = createOrganizationLauncherService({
      runtimeTransaction: async () => {
        throw new Error("private storage detail");
      },
    });
    await expect(failed.list(session())).resolves.toEqual({ kind: "temporarily_unavailable" });
  });

  it("refuses malformed identity sessions before storage", async () => {
    const runtimeTransaction = vi.fn();
    const service = createOrganizationLauncherService({ runtimeTransaction });
    await expect(
      service.list({ ...session(), identityId: "browser-value" } as IdentitySession),
    ).resolves.toEqual({ kind: "invalid_session_state" });
    expect(runtimeTransaction).not.toHaveBeenCalled();
  });
});
