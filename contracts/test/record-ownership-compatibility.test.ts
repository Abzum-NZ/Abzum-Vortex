import { describe, expect, it } from "vitest";
import { v5 as uuidV5 } from "uuid";
import {
  decideRecordOwnershipTransferTarget,
  offboardingTransferCommandId,
  offboardingTransferCommandNamespace,
  recordOwnershipModeSchema,
  recordOwnershipTransferTargetKindSchema,
  transferRecordOwnershipCommandV2Schema,
} from "../src";

const id = (value: number) => `40700000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("record ownership transfer target compatibility", () => {
  it("uses the exact target kinds the single-record transfer command accepts", () => {
    const commandKinds = ["organization_account", "group"].map(
      (targetKind) =>
        transferRecordOwnershipCommandV2Schema.safeParse({
          contractVersion: "2.0.0",
          commandId: id(1),
          recordTypeId: id(2),
          recordId: id(3),
          expectedConcurrencyNumber: 1,
          targetKind,
          targetOrganizationAccountId: id(4),
          targetGroupId: id(5),
        }).success,
    );
    expect(commandKinds).toEqual([false, false]);
    expect(recordOwnershipTransferTargetKindSchema.options).toEqual([
      "organization_account",
      "group",
    ]);
    for (const targetKind of recordOwnershipTransferTargetKindSchema.options) {
      const base = {
        contractVersion: "2.0.0",
        commandId: id(1),
        recordTypeId: id(2),
        recordId: id(3),
        expectedConcurrencyNumber: 1,
        targetKind,
      };
      const command =
        targetKind === "organization_account"
          ? { ...base, targetOrganizationAccountId: id(4) }
          : { ...base, targetGroupId: id(5) };
      expect(transferRecordOwnershipCommandV2Schema.safeParse(command).success).toBe(true);
    }
  });

  it("accepts an account target for an account-owned type and nothing else", () => {
    expect(
      decideRecordOwnershipTransferTarget("organization_account", "organization_account"),
    ).toEqual({ outcome: "compatible" });
    expect(decideRecordOwnershipTransferTarget("organization_account", "group")).toEqual({
      outcome: "refused_incompatible",
      reason: "target_kind_mismatch",
    });
  });

  it("refuses a Group target for an account-owned type instead of converting it", () => {
    const decision = decideRecordOwnershipTransferTarget("organization_account", "group");
    expect(decision).toStrictEqual({
      outcome: "refused_incompatible",
      reason: "target_kind_mismatch",
    });
    expect(decision).not.toHaveProperty("targetKind");
  });

  it("accepts a Group target for a Group-owned type and refuses an account target", () => {
    expect(decideRecordOwnershipTransferTarget("group", "group")).toEqual({
      outcome: "compatible",
    });
    expect(decideRecordOwnershipTransferTarget("group", "organization_account")).toEqual({
      outcome: "refused_incompatible",
      reason: "target_kind_mismatch",
    });
  });

  it("refuses every target for types that carry no direct owner", () => {
    for (const mode of ["none", "inherited"] as const)
      for (const targetKind of recordOwnershipTransferTargetKindSchema.options)
        expect(decideRecordOwnershipTransferTarget(mode, targetKind)).toEqual({
          outcome: "refused_incompatible",
          reason: "ownership_not_direct",
        });
  });

  it("decides exhaustively over every ownership mode and target kind", () => {
    const compatible = recordOwnershipModeSchema.options.flatMap((mode) =>
      recordOwnershipTransferTargetKindSchema.options
        .filter(
          (targetKind) =>
            decideRecordOwnershipTransferTarget(mode, targetKind).outcome === "compatible",
        )
        .map((targetKind) => `${mode}:${targetKind}`),
    );
    expect(compatible).toEqual(["organization_account:organization_account", "group:group"]);
  });

  it("rejects vocabulary that is not a runtime ownership mode or target kind", () => {
    expect(() =>
      decideRecordOwnershipTransferTarget("team" as never, "organization_account"),
    ).toThrow();
    expect(() =>
      decideRecordOwnershipTransferTarget("organization_account", "team" as never),
    ).toThrow();
    expect(recordOwnershipTransferTargetKindSchema.safeParse("team").success).toBe(false);
  });
});

describe("offboarding transfer command identity", () => {
  it("uses the RFC UUID-v5 DNS known vector", () => {
    expect(uuidV5("www.example.com", uuidV5.DNS)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("uses one fixed valid UUID namespace", () => {
    expect(offboardingTransferCommandNamespace).toBe("036eb24c-fed1-575f-b3b6-0a9a608e1942");
    expect(uuidV5("https://vortex.abzum.nz/record-offboarding-transfer", uuidV5.URL)).toBe(
      offboardingTransferCommandNamespace,
    );
    expect(() => uuidV5("probe", offboardingTransferCommandNamespace)).not.toThrow();
  });

  it("is deterministic and normalizes semantically equivalent UUID case", () => {
    const commandId = offboardingTransferCommandId(id(10), id(11), id(12));
    expect(offboardingTransferCommandId(id(10), id(11), id(12))).toBe(commandId);
    expect(
      offboardingTransferCommandId(
        id(10).toUpperCase(),
        id(11).toUpperCase(),
        id(12).toUpperCase(),
      ),
    ).toBe(commandId);
  });

  it("separates changes to every identity component", () => {
    const baseline = offboardingTransferCommandId(id(20), id(21), id(22));
    expect(
      new Set([
        baseline,
        offboardingTransferCommandId(id(23), id(21), id(22)),
        offboardingTransferCommandId(id(20), id(24), id(22)),
        offboardingTransferCommandId(id(20), id(21), id(25)),
      ]).size,
    ).toBe(4);
  });

  it("rejects invalid or nil identities", () => {
    const nilId = "00000000-0000-0000-0000-000000000000";
    expect(() => offboardingTransferCommandId("not-a-uuid", id(31), id(32))).toThrow();
    expect(() => offboardingTransferCommandId(id(30), nilId, id(32))).toThrow();
    expect(() => offboardingTransferCommandId(id(30), id(31), nilId)).toThrow();
  });
});
