import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { permissionDeclarationSchema, permissionRecordScopeSchema } from "../src";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;

describe("permission record scope", () => {
  const relationshipRoute = {
    kind: "relationship" as const,
    relationshipId: id(2),
    sourcePermissionId: id(3),
  };
  const scope = {
    routes: [{ kind: "ownership" as const }, { kind: "direct_share" as const }, relationshipRoute],
    savedCondition: {
      conditionId: id(4),
      publishedRevision: 2,
      contractFingerprint: fingerprint,
      parameterBindings: [
        { key: "account", source: "current_organization_account_id" as const },
        { key: "region", source: "literal" as const, value: "north" },
      ],
    },
  };

  test("accepts one canonical set of base routes and one exact condition restriction", () => {
    expect(permissionRecordScopeSchema.safeParse(scope).success).toBe(true);
    expect(
      permissionDeclarationSchema.safeParse({
        permissionId: id(1),
        key: "sample.records.read",
        label: "Read records",
        description: "Read the records admitted by this permission's published scope.",
        recordTypeId: id(5),
        actionKind: "read",
        administrative: false,
        recordScope: scope,
      }).success,
    ).toBe(true);
  });

  test("refuses duplicate, non-canonical, broad-combined and unknown scope routes", () => {
    expect(
      permissionRecordScopeSchema.safeParse({
        routes: [{ kind: "ownership" }, { kind: "ownership" }],
      }).success,
    ).toBe(false);
    expect(
      permissionRecordScopeSchema.safeParse({
        routes: [relationshipRoute, { kind: "direct_share" }],
      }).success,
    ).toBe(false);
    expect(
      permissionRecordScopeSchema.safeParse({
        routes: [{ kind: "all_records" }, { kind: "ownership" }],
      }).success,
    ).toBe(false);
    expect(
      permissionRecordScopeSchema.safeParse({ routes: [{ kind: "group_ownership" }] }).success,
    ).toBe(false);
    const alphaRelationshipId = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(alphaRelationshipId.toUpperCase()).not.toBe(alphaRelationshipId);
    expect(
      permissionRecordScopeSchema.safeParse({
        routes: [
          {
            kind: "relationship",
            relationshipId: alphaRelationshipId,
            sourcePermissionId: id(3),
          },
          {
            kind: "relationship",
            relationshipId: alphaRelationshipId.toUpperCase(),
            sourcePermissionId: id(3),
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("agrees with the shared PostgreSQL parity corpus on every record-scope vector", () => {
    const sql = readFileSync(
      new URL("../../supabase/tests/470_permission_record_scope_parity.test.sql", import.meta.url),
      "utf8",
    );
    const matches = [
      ...sql.matchAll(/\$record_scope_vectors\$([\s\S]*?)\$record_scope_vectors\$/g),
    ];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[1]).toBeDefined();

    type RecordScopeVector = Readonly<{
      name: string;
      scope: unknown;
      valid: boolean;
    }>;
    const corpus = JSON.parse(matches[0]![1]!) as { vectors: RecordScopeVector[] };
    expect(corpus.vectors).toHaveLength(36);

    for (const vector of corpus.vectors)
      expect(permissionRecordScopeSchema.safeParse(vector.scope).success, vector.name).toBe(
        vector.valid,
      );
  });

  test("requires exact canonical saved-condition bindings", () => {
    expect(
      permissionRecordScopeSchema.safeParse({
        ...scope,
        savedCondition: {
          ...scope.savedCondition,
          parameterBindings: [
            { key: "region", source: "literal", value: "north" },
            { key: "account", source: "current_organization_account_id" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      permissionRecordScopeSchema.safeParse({
        ...scope,
        savedCondition: {
          ...scope.savedCondition,
          parameterBindings: [
            { key: "account", source: "current_organization_account_id" },
            { key: "account", source: "literal", value: "duplicate" },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
