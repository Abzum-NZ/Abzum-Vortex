import { describe, expect, test } from "vitest";
import { activityActorKindSchema, activityEntrySchema } from "../src";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

const entry = {
  organizationId: id(1),
  activityId: id(2),
  occurredAt: "2026-09-06T10:00:00.123456+12:00",
  actorKind: "organization_account",
  actorId: id(3),
  action: "record_updated",
  subjectIds: [id(4), id(5)],
  changedFieldIds: [id(6), id(7)],
  source: "web",
  correlationId: id(8),
  outcome: "completed",
} as const;

describe("Activity entry contract", () => {
  test("accepts the closed content-free evidence shape", () => {
    expect(activityEntrySchema.parse(entry)).toEqual(entry);
    expect(activityEntrySchema.parse({ ...entry, changedFieldIds: [] })).toEqual({
      ...entry,
      changedFieldIds: [],
    });
  });

  test.each(["identity", "organization_account", "system", "public_session"])(
    "accepts the %s actor kind",
    (actorKind) => {
      expect(activityActorKindSchema.parse(actorKind)).toBe(actorKind);
    },
  );

  test("rejects unknown and nil actors", () => {
    expect(activityEntrySchema.safeParse({ ...entry, actorKind: "federation" }).success).toBe(
      false,
    );
    expect(
      activityEntrySchema.safeParse({
        ...entry,
        actorId: "00000000-0000-0000-0000-000000000000",
      }).success,
    ).toBe(false);
  });

  test("requires canonical unique subject and changed-field lists", () => {
    expect(activityEntrySchema.safeParse({ ...entry, subjectIds: [] }).success).toBe(false);
    expect(activityEntrySchema.safeParse({ ...entry, subjectIds: [id(5), id(4)] }).success).toBe(
      false,
    );
    expect(activityEntrySchema.safeParse({ ...entry, subjectIds: [id(4), id(4)] }).success).toBe(
      false,
    );
    expect(
      activityEntrySchema.safeParse({ ...entry, changedFieldIds: [id(7), id(6)] }).success,
    ).toBe(false);
    expect(
      activityEntrySchema.safeParse({ ...entry, changedFieldIds: [id(6), id(6)] }).success,
    ).toBe(false);
  });

  test("compares UUID list ordering and duplicates canonically", () => {
    const alpha = "00000000-0000-4000-8000-00000000000a";
    const upperAlpha = alpha.toUpperCase();
    expect(
      activityEntrySchema.safeParse({ ...entry, subjectIds: [alpha, upperAlpha] }).success,
    ).toBe(false);
    expect(
      activityEntrySchema.safeParse({ ...entry, changedFieldIds: [upperAlpha, id(9)] }).success,
    ).toBe(false);
  });

  test("does not accept retained content or error details", () => {
    expect(
      activityEntrySchema.safeParse({ ...entry, retainedDetailReference: "secret://detail" })
        .success,
    ).toBe(false);
    expect(
      activityEntrySchema.safeParse({ ...entry, errorMessage: "private detail" }).success,
    ).toBe(false);
    expect(activityEntrySchema.safeParse({ ...entry, values: { before: "secret" } }).success).toBe(
      false,
    );
  });
});
