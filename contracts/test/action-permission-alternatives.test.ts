import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionDefinitionSchema,
  applicationSourceDocumentSchema,
  moduleSourceDocumentSchema,
} from "../src/index.js";

const fixture = (relativePath: string): unknown =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../testing/fixtures", relativePath),
      "utf8",
    ),
  );

type MutableSource = Record<string, unknown> & {
  body: Record<string, unknown> & { actions: Record<string, unknown>[] };
};

const replaceActionPermission = (
  source: MutableSource,
  alternatives: readonly string[],
): MutableSource => {
  const changed = structuredClone(source);
  const action = changed.body.actions[0]!;
  delete action.permission;
  action.permission_alternatives = alternatives;
  return changed;
};

describe("record action permission alternatives", () => {
  it("preserves singular authored actions and accepts canonical alternatives", () => {
    const moduleSource = fixture("modules/service-desk.cases.json") as MutableSource;
    const applicationSource = fixture("applications/service-desk.json") as MutableSource;
    expect(moduleSourceDocumentSchema.parse(moduleSource)).toEqual(moduleSource);
    expect(applicationSourceDocumentSchema.parse(applicationSource)).toEqual(applicationSource);

    const moduleKeys = [
      String(moduleSource.body.actions[0]!.permission),
      `${String(moduleSource.body.actions[0]!.permission)}_alternative`,
    ].sort();
    expect(
      moduleSourceDocumentSchema.safeParse(replaceActionPermission(moduleSource, moduleKeys))
        .success,
    ).toBe(true);

    const applicationAction = {
      id: "act_alternative",
      key: "vortex.service_desk.case.update",
      label: "Update case",
      record_type: "vortex.service_desk.cases:case",
      permission_alternatives: [
        "vortex.service_desk.cases.case.update_all",
        "vortex.service_desk.cases.case.update_own",
      ],
      sharing: "refused",
      inputs: [],
      effects: [{ kind: "announce_event", event: "vortex.service_desk.case.updated" }],
    };
    applicationSource.body.actions.push(applicationAction);
    expect(applicationSourceDocumentSchema.safeParse(applicationSource).success).toBe(true);
  });

  it("refuses missing, mixed, singleton, duplicate and noncanonical bindings", () => {
    const source = fixture("modules/service-desk.cases.json") as MutableSource;
    const first = source.body.actions[0]!;
    const keys = [String(first.permission), `${String(first.permission)}_alternative`].sort();
    for (const candidate of [
      (() => {
        const changed = structuredClone(source);
        delete changed.body.actions[0]!.permission;
        return changed;
      })(),
      (() => {
        const changed = structuredClone(source);
        changed.body.actions[0]!.permission_alternatives = keys;
        return changed;
      })(),
      replaceActionPermission(source, [keys[0]!]),
      replaceActionPermission(source, [keys[0]!, keys[0]!]),
      replaceActionPermission(source, [...keys].reverse()),
    ])
      expect(moduleSourceDocumentSchema.safeParse(candidate).success).toBe(false);
  });

  it("keeps compiled singular bytes and makes plural alternatives exclusive", () => {
    const singular = {
      actionId: "90000000-0000-4000-a000-000000000001",
      key: "sample.record.update",
      label: "Update",
      subjectRecordTypeId: "90000000-0000-4000-a000-000000000002",
      permissionKey: "sample.record.update",
      sharing: "refused",
      inputs: [],
      effects: [{ kind: "announce_event", eventKey: "sample.record.updated" }],
    };
    expect(actionDefinitionSchema.parse(singular)).toEqual(singular);
    expect(
      actionDefinitionSchema.safeParse({
        ...singular,
        permissionKey: undefined,
        permissionKeys: ["sample.record.update_all", "sample.record.update_own"],
      }).success,
    ).toBe(true);
    expect(
      actionDefinitionSchema.safeParse({
        ...singular,
        permissionKeys: ["sample.record.update_all", "sample.record.update_own"],
      }).success,
    ).toBe(false);
  });
});
