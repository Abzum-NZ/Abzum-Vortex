import { describe, expect, test } from "vitest";
import { permissionDeclarationSchema, permissionFieldPolicySchema } from "../src";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

const recordPermission = (fieldPolicy?: unknown) => ({
  permissionId: id(1),
  key: "sample.records.read",
  label: "Read records",
  description: "Read fields from records admitted by this permission.",
  recordTypeId: id(2),
  actionKind: "read" as const,
  administrative: false,
  ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
});

describe("permission field policy", () => {
  test("accepts empty and canonical readable/changeable field sets", () => {
    for (const fieldPolicy of [
      { readableFieldIds: [], changeableFieldIds: [] },
      { readableFieldIds: [id(10)], changeableFieldIds: [] },
      { readableFieldIds: [id(10), id(11)], changeableFieldIds: [id(11)] },
    ]) {
      expect(permissionFieldPolicySchema.safeParse(fieldPolicy).success).toBe(true);
      expect(permissionDeclarationSchema.safeParse(recordPermission(fieldPolicy)).success).toBe(
        true,
      );
    }
  });

  test("keeps absent policy readable for historical record permissions", () => {
    const result = permissionDeclarationSchema.safeParse(recordPermission());

    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("fieldPolicy");
  });

  test("refuses duplicate, non-canonical and non-subset field identities", () => {
    const upperCaseId = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(upperCaseId.toUpperCase()).not.toBe(upperCaseId);

    for (const fieldPolicy of [
      { readableFieldIds: [id(10), id(10)], changeableFieldIds: [] },
      {
        readableFieldIds: [upperCaseId, upperCaseId.toUpperCase()],
        changeableFieldIds: [],
      },
      { readableFieldIds: [id(11), id(10)], changeableFieldIds: [] },
      { readableFieldIds: [id(10)], changeableFieldIds: [id(11)] },
      { readableFieldIds: [id(10), id(11)], changeableFieldIds: [id(11), id(10)] },
    ])
      expect(permissionFieldPolicySchema.safeParse(fieldPolicy).success).toBe(false);
  });

  test("refuses incomplete, unknown and invalid field-policy values", () => {
    for (const fieldPolicy of [
      { readableFieldIds: [] },
      { changeableFieldIds: [] },
      { readableFieldIds: [], changeableFieldIds: [], wildcard: true },
      { readableFieldIds: ["not-a-field-id"], changeableFieldIds: [] },
    ])
      expect(permissionFieldPolicySchema.safeParse(fieldPolicy).success).toBe(false);
  });

  test("forbids field policy on a non-record permission", () => {
    const nonRecordPermission: Partial<ReturnType<typeof recordPermission>> = recordPermission({
      readableFieldIds: [],
      changeableFieldIds: [],
    });
    delete nonRecordPermission.recordTypeId;

    expect(permissionDeclarationSchema.safeParse(nonRecordPermission).success).toBe(false);
  });

  test("field policy does not change the permission action", () => {
    const result = permissionDeclarationSchema.safeParse(
      recordPermission({ readableFieldIds: [id(10)], changeableFieldIds: [id(10)] }),
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.actionKind).toBe("read");
  });
});
