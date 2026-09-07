import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  moduleSourceDocumentSchema,
  sourcePermissionFieldPolicySchema,
} from "../src/module-source-contracts";
import { applicationSourceDocumentSchema } from "../src/application-source-contracts";

const fixtureRoot = path.resolve(import.meta.dirname, "../../testing/fixtures");
const fixture = (relativePath: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), "utf8"));

describe("authored permission field policy", () => {
  test("accepts explicit empty and exact alias sets", () => {
    expect(
      sourcePermissionFieldPolicySchema.safeParse({
        readable_fields: [],
        changeable_fields: [],
      }).success,
    ).toBe(true);
    expect(
      sourcePermissionFieldPolicySchema.safeParse({
        readable_fields: ["subject", "status"],
        changeable_fields: ["status"],
      }).success,
    ).toBe(true);
  });

  test("refuses duplicates, non-subsets and unknown properties", () => {
    for (const candidate of [
      { readable_fields: ["subject", "subject"], changeable_fields: [] },
      { readable_fields: ["subject"], changeable_fields: ["status"] },
      { readable_fields: [], changeable_fields: [], all_fields: true },
      { readable_fields: ["not valid"], changeable_fields: [] },
    ])
      expect(sourcePermissionFieldPolicySchema.safeParse(candidate).success).toBe(false);
  });

  test("preserves historical omission and forbids policy on non-record permissions", () => {
    const module = moduleSourceDocumentSchema.parse(fixture("modules/service-desk.cases.json"));
    delete module.body.permissions[0]!.field_policy;
    expect(moduleSourceDocumentSchema.safeParse(module).success).toBe(true);

    const application = applicationSourceDocumentSchema.parse(
      fixture("applications/service-desk.json"),
    );
    application.body.permissions[0]!.field_policy = {
      readable_fields: [],
      changeable_fields: [],
    };
    expect(applicationSourceDocumentSchema.safeParse(application).success).toBe(false);
  });

  test("accepts an application-owned policy for an exact qualified record type", () => {
    const application = applicationSourceDocumentSchema.parse(fixture("applications/crm.json"));
    const permission = application.body.permissions[2]!;
    permission.record_type = "vortex.service_desk.cases:case";
    permission.field_policy = {
      readable_fields: ["case_number", "subject"],
      changeable_fields: [],
    };

    expect(applicationSourceDocumentSchema.safeParse(application).success).toBe(true);
  });
});
