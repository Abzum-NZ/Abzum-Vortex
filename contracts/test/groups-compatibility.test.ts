import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  moduleRecordOwnershipModeV1Schema,
  moduleSourceDocumentSchema,
  moduleSourceRecordOwnershipModeV1Schema,
  readModuleSourceRecordOwnershipModeV1,
  recordOwnershipModeSchema,
  sourceConditionSchema,
  writeModuleRecordOwnershipModeV1,
} from "../src";

const fixtureDirectory = path.resolve(import.meta.dirname, "../../testing/fixtures/modules");

describe("Groups compatibility", () => {
  it("keeps immutable Definition V1 ownership bytes behind an explicit current semantic boundary", () => {
    expect(readModuleSourceRecordOwnershipModeV1("team")).toBe("group");
    expect(writeModuleRecordOwnershipModeV1("group")).toBe("team");
    expect(readModuleSourceRecordOwnershipModeV1("organisation_account")).toBe(
      "organization_account",
    );
    expect(writeModuleRecordOwnershipModeV1("organization_account")).toBe("organization_account");

    expect(recordOwnershipModeSchema.safeParse("group").success).toBe(true);
    expect(recordOwnershipModeSchema.safeParse("team").success).toBe(false);
    expect(moduleSourceRecordOwnershipModeV1Schema.safeParse("team").success).toBe(true);
    expect(moduleSourceRecordOwnershipModeV1Schema.safeParse("group").success).toBe(false);
    expect(moduleRecordOwnershipModeV1Schema.safeParse("team").success).toBe(true);
    expect(moduleRecordOwnershipModeV1Schema.safeParse("group").success).toBe(false);
  });

  it("reads every historical module fixture exactly without rewriting its V1 ownership token", () => {
    const sources = fs
      .readdirSync(fixtureDirectory)
      .filter((name) => name.endsWith(".json"))
      .map(
        (name) => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8")) as unknown,
      );
    const parsed = sources.map((source) => moduleSourceDocumentSchema.parse(source));
    expect(parsed).toEqual(sources);

    const ownershipModes = parsed.flatMap((source) =>
      source.body.record_types.map((recordType) => recordType.ownership_mode),
    );
    expect(ownershipModes).toContain("team");
    expect(ownershipModes).not.toContain("group");
  });

  it("keeps access principals out of generic authored condition operands", () => {
    expect(
      sourceConditionSchema.safeParse({
        operator: "equals",
        left: { source: "team", team: "support" },
        right: { source: "value", value: true },
      }).success,
    ).toBe(false);
    expect(
      sourceConditionSchema.safeParse({
        operator: "equals",
        left: { source: "group", group: "support" },
        right: { source: "value", value: true },
      }).success,
    ).toBe(false);
  });
});
