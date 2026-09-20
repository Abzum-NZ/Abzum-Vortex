import { describe, expect, it, vi } from "vitest";
import {
  createProtectedParentDeleteService,
  type ProtectedParentDeleteServiceDependencies,
} from "../src/delete-record";

vi.mock("server-only", () => ({}));

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const dependencies = (): ProtectedParentDeleteServiceDependencies => ({
  identityAuthorityId: id(1),
  clock: () => new Date("2026-09-21T00:00:00.000Z"),
  correlationId: () => id(2),
  resolvedRequestTransaction: vi.fn(),
});

describe("protected parent delete service", () => {
  it("rejects a command with caller-supplied extra fields before opening a request transaction", async () => {
    const values = dependencies();
    const service = createProtectedParentDeleteService(values);

    await expect(
      service.delete(
        { identityId: id(3), sessionId: id(4) } as never,
        { organizationId: id(5), applicationRootId: id(6) } as never,
        {
          commandId: id(7),
          recordTypeId: id(8),
          recordId: id(9),
          expectedConcurrencyNumber: 1,
          deletedRecordIds: [id(10)],
        },
      ),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(values.resolvedRequestTransaction).not.toHaveBeenCalled();
  });

  it("rejects a command that omits an exact deletion identity", async () => {
    const values = dependencies();
    const service = createProtectedParentDeleteService(values);

    await expect(
      service.delete(
        { identityId: id(3), sessionId: id(4) } as never,
        { organizationId: id(5), applicationRootId: id(6) } as never,
        { commandId: id(7), recordTypeId: id(8), expectedConcurrencyNumber: 1 },
      ),
    ).resolves.toEqual({ kind: "unavailable" });

    expect(values.resolvedRequestTransaction).not.toHaveBeenCalled();
  });
});
