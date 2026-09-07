import { describe, expect, it } from "vitest";
import {
  projectReadableRecord,
  resolveRecordFieldAccess,
  validateRecordFieldWrite,
} from "../src/record-field-access";

const id = (prefix: string, suffix: number): string =>
  `${prefix}4000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const fieldA = id("1", 1);
const fieldB = id("2", 2);
const fieldC = id("3", 3);

const permission = (permissionId: string) => ({
  applicationRootId: id("a", 1),
  ownerKind: "module" as const,
  ownerId: id("b", 2),
  permissionId,
});
const source = {
  kind: "module" as const,
  definitionKey: "module.records",
  rootId: id("b", 2),
  releaseVersion: "1.0.0",
  releaseRevision: 1,
  validationContractVersion: "1.0.0",
  contentFingerprint: `sha256:${"a".repeat(64)}`,
  resolutionFingerprint: `sha256:${"b".repeat(64)}`,
};
const contribution = (permissionId: string, route: Record<string, unknown>, deadline: string) => ({
  permission: permission(permissionId),
  recordScope: { routes: [{ kind: route.kind }] },
  source,
  route,
  validUntil: deadline,
});
const decision = (
  actionKind: "create" | "read" | "update" | "named" = "read",
  namedAction?: string,
) => ({
  operationKey: `module.records.${actionKind}`,
  target: { kind: "application" as const, applicationRootId: id("a", 1) },
  organizationId: id("c", 3),
  organizationAccountId: id("d", 4),
  accessVersion: 8,
  checkedAt: "2026-09-08T00:00:00.000Z",
  correlationId: id("e", 5),
  recordBinding: {
    moduleRootId: id("b", 2),
    recordTypeId: id("f", 6),
    storageContractId: id("9", 7),
    storageScope: "application_contained" as const,
  },
  recordId: id("8", 8),
  outcome: "allowed" as const,
  action: { actionKind, ...(namedAction === undefined ? {} : { namedAction }) },
  validUntil: "2026-09-08T00:04:00.000Z",
  matchedContributions: [
    contribution(id("4", 10), { kind: "ownership" }, "2026-09-08T00:05:00.000Z"),
    contribution(
      id("5", 11),
      {
        kind: "direct_share",
        directShareId: id("6", 12),
        directShareRevision: 2,
        readableFieldIds: [fieldB, fieldC],
        changeableFieldIds: [fieldB],
      },
      "2026-09-08T00:04:00.000Z",
    ),
  ],
});
const declaration = (
  permissionId: string,
  readableFieldIds: string[],
  changeableFieldIds: string[],
  route: "ownership" | "direct_share" = "ownership",
) => ({
  permission: permission(permissionId),
  source,
  declaration: {
    permissionId,
    key: `module.records.permission_${permissionId[0]}`,
    label: "Record permission",
    description: "Authorizes one exact record operation.",
    recordTypeId: id("f", 6),
    actionKind: "read" as const,
    administrative: false,
    recordScope: { routes: [{ kind: route }] },
    fieldPolicy: { readableFieldIds, changeableFieldIds },
  },
});
const declarations = () => [
  declaration(id("4", 10), [fieldA, fieldB], [fieldA]),
  declaration(id("5", 11), [fieldB, fieldC], [fieldB, fieldC], "direct_share"),
];
const record = () => ({
  storageScope: "application_contained" as const,
  applicationRootId: id("a", 1),
  organizationId: id("c", 3),
  moduleRootId: id("b", 2),
  recordTypeId: id("f", 6),
  storageContractId: id("9", 7),
  recordId: id("8", 8),
  definitionRevision: 1,
  lifecycleState: "active" as const,
  concurrencyNumber: 1,
  values: { [fieldA]: "A", [fieldB]: "B", [fieldC]: "C" },
  createdAt: "2026-09-01T00:00:00.000Z",
  createdBy: id("7", 20),
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: id("7", 20),
});
const observedAt = "2026-09-08T00:01:00.000Z";
const currentEvidence = (value: ReturnType<typeof decision>) => ({
  operationKey: value.operationKey,
  target: value.target,
  organizationId: value.organizationId,
  organizationAccountId: value.organizationAccountId,
  accessVersion: value.accessVersion,
  checkedAt: value.checkedAt,
  correlationId: value.correlationId,
});
const resolve = (value = decision(), exactDeclarations: readonly unknown[] = declarations()) =>
  resolveRecordFieldAccess({
    decision: value,
    declarations: exactDeclarations,
    currentEvidence: currentEvidence(value),
    observedAt,
  });

describe("record field access", () => {
  it("unions complete contributions after intersecting direct-share ceilings", () => {
    expect(resolve()).toMatchObject({
      outcome: "allowed",
      fieldPolicy: {
        readableFieldIds: [fieldA, fieldB, fieldC],
        changeableFieldIds: [fieldA, fieldB],
      },
    });
  });

  it("treats historical missing policy as zero authority without vetoing another contribution", () => {
    const inputs = declarations();
    delete (inputs[0]!.declaration as { fieldPolicy?: unknown }).fieldPolicy;
    expect(resolve(decision(), inputs)).toMatchObject({
      outcome: "allowed",
      fieldPolicy: { readableFieldIds: [fieldB, fieldC], changeableFieldIds: [fieldB] },
    });
  });

  it("refuses missing or mismatched exact declaration evidence", () => {
    expect(resolve(decision(), declarations().slice(1))).toMatchObject({
      outcome: "refused",
      reasonCode: "declaration_mismatch",
    });
    const mismatched = declarations();
    mismatched[0]!.source = { ...source, releaseRevision: 2 };
    expect(resolve(decision(), mismatched)).toMatchObject({
      outcome: "refused",
      reasonCode: "declaration_mismatch",
    });
    const wrongScope = declarations();
    wrongScope[1]!.declaration.recordScope = { routes: [{ kind: "ownership" }] };
    expect(resolve(decision(), wrongScope)).toMatchObject({
      outcome: "refused",
      reasonCode: "declaration_mismatch",
    });
    const currentDecision = decision();
    expect(
      resolveRecordFieldAccess({
        decision: currentDecision,
        declarations: declarations(),
        currentEvidence: { ...currentEvidence(currentDecision), accessVersion: 9 },
        observedAt,
      }),
    ).toMatchObject({ outcome: "refused", reasonCode: "evidence_mismatch" });
    expect(
      resolveRecordFieldAccess({
        decision: currentDecision,
        declarations: declarations(),
        currentEvidence: {
          ...currentEvidence(currentDecision),
          target: {
            kind: "application",
            applicationRootId: currentDecision.target.applicationRootId.toUpperCase(),
          },
        },
        observedAt,
      }),
    ).toMatchObject({ outcome: "allowed" });
  });

  it("projects only readable values and explicitly field-dependent resources", () => {
    const recordDecision = decision();
    const access = resolve(recordDecision);
    const restricted = {
      ...access,
      fieldPolicy: { readableFieldIds: [fieldA], changeableFieldIds: [] },
    };
    const projected = projectReadableRecord(
      restricted,
      record(),
      [
        { key: "module.records.visible_label", dependencyFieldIds: [fieldA], value: "visible" },
        { key: "module.records.protected_label", dependencyFieldIds: [fieldC], value: "hidden" },
      ],
      currentEvidence(recordDecision),
      observedAt,
    );
    expect(projected?.record.values).toEqual({ [fieldA]: "A" });
    expect(projected?.derived.map((entry) => entry.key)).toEqual(["module.records.visible_label"]);
  });

  it("refuses an unauthorized write as one operation and never upgrades read to write", () => {
    const readDecision = decision();
    const readAccess = resolve(readDecision);
    expect(
      validateRecordFieldWrite(
        readAccess,
        record(),
        { [fieldA]: "changed" },
        currentEvidence(readDecision),
        observedAt,
      ),
    ).toMatchObject({
      outcome: "refused",
      reasonCode: "action_refused",
    });
    const updateDeclarations = declarations().map((entry) => ({
      ...entry,
      declaration: { ...entry.declaration, actionKind: "update" as const },
    }));
    const updateDecision = decision("update");
    const updateAccess = resolve(updateDecision, updateDeclarations);
    expect(
      validateRecordFieldWrite(
        updateAccess,
        record(),
        { [fieldA]: "ok", [fieldC]: "no" },
        currentEvidence(updateDecision),
        observedAt,
      ),
    ).toEqual({
      outcome: "refused",
      reasonCode: "field_refused",
    });
    expect(
      validateRecordFieldWrite(
        updateAccess,
        record(),
        { [fieldA]: "ok" },
        currentEvidence(updateDecision),
        observedAt,
      ),
    ).toEqual({
      outcome: "accepted",
      changes: { [fieldA]: "ok" },
    });
  });

  it("honours exact create and named write authority without changing action meaning", () => {
    for (const [actionKind, namedAction] of [
      ["create", undefined],
      ["named", "complete"],
    ] as const) {
      const actionDecision = {
        ...decision(actionKind, namedAction),
        validUntil: "2026-09-08T00:05:00.000Z",
        matchedContributions: decision(actionKind, namedAction).matchedContributions.slice(0, 1),
      };
      const actionDeclarations = declarations()
        .slice(0, 1)
        .map((entry) => ({
          ...entry,
          declaration: {
            ...entry.declaration,
            actionKind,
            ...(namedAction === undefined ? {} : { namedAction }),
          },
        }));
      const access = resolve(actionDecision, actionDeclarations);
      expect(
        validateRecordFieldWrite(
          access,
          record(),
          { [fieldA]: "ok" },
          currentEvidence(actionDecision),
          observedAt,
        ),
      ).toMatchObject({ outcome: "accepted" });

      if (namedAction !== undefined) {
        const mismatched = structuredClone(actionDeclarations) as unknown as Array<{
          declaration: { namedAction: string };
        }>;
        mismatched[0]!.declaration.namedAction = "reopen";
        expect(resolve(actionDecision, mismatched)).toMatchObject({
          outcome: "refused",
          reasonCode: "declaration_mismatch",
        });
      }
    }
  });

  it("cannot reuse field evidence for another exact record", () => {
    const recordDecision = decision();
    const access = resolve(recordDecision);
    expect(
      projectReadableRecord(
        access,
        { ...record(), recordId: id("8", 99) },
        [],
        currentEvidence(recordDecision),
        observedAt,
      ),
    ).toBeUndefined();
    expect(
      projectReadableRecord(
        access,
        record(),
        [],
        currentEvidence(recordDecision),
        "2026-09-08T00:04:00.000Z",
      ),
    ).toBeUndefined();
  });
});
