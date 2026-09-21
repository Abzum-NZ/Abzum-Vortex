import {
  moduleFieldV2Schema,
  recordTypeDefinitionV2Schema,
  type ModuleFieldV2,
  type RecordTypeDefinitionV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { deriveEarliestPendingDeadlineTransitionV2 } from "../src";

const id = (value: number) => `73000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

const ids = {
  title: id(1),
  date: id(2),
  instant: id(3),
  status: id(4),
  calculatedInstant: id(5),
  dateDeadline: id(6),
  instantDeadline: id(7),
  calculatedDeadline: id(8),
} as const;

const field = (
  fieldId: string,
  key: string,
  type: ModuleFieldV2["type"],
  settings: unknown,
): ModuleFieldV2 =>
  moduleFieldV2Schema.parse({
    fieldId,
    key,
    label: key,
    required: false,
    unique: false,
    filterable: true,
    sortable: true,
    personalData: "none",
    publicDisplay: "refused",
    type,
    settings,
  });

const deadline = (
  fieldId: string,
  dueFieldId: string,
  terminalStatusValues: readonly unknown[] = [],
): ModuleFieldV2 =>
  field(fieldId, `deadline_${fieldId.slice(-2)}`, "calculation", {
    resultType: "yes_no",
    expression: {
      kind: "deadline_passed",
      dueFieldId,
      ...(terminalStatusValues.length === 0 ? {} : { statusFieldId: ids.status }),
      terminalStatusValues,
    },
    dependencyFieldIds: terminalStatusValues.length === 0 ? [dueFieldId] : [dueFieldId, ids.status],
  });

const recordType = (fields: readonly ModuleFieldV2[]): RecordTypeDefinitionV2 =>
  recordTypeDefinitionV2Schema.parse({
    recordTypeId: id(100),
    key: "deadlines",
    singularLabel: "Deadline",
    pluralLabel: "Deadlines",
    titleFieldId: ids.title,
    storageContractId: id(101),
    storageScope: "organization_shared",
    ownershipMode: "none",
    fields: [
      field(ids.title, "title", "text", { maxLength: 100 }),
      field(ids.date, "due_date", "date", {}),
      field(ids.instant, "due_at", "date_time", { displayTimeZone: "organization" }),
      field(ids.status, "status", "choice", {
        options: [
          { value: "open", label: "Open" },
          { value: "closed", label: "Closed" },
        ],
      }),
      field(ids.calculatedInstant, "calculated_due_at", "calculation", {
        resultType: "date_time",
        expression: {
          kind: "date_offset",
          dateFieldId: ids.instant,
          amount: { source: "literal", value: "0" },
          unit: "days",
        },
        dependencyFieldIds: [ids.instant],
      }),
      ...fields,
    ],
    relationships: [],
    standardActions: ["create", "read", "update"],
    customActionIds: [],
  });

const derive = (
  fields: readonly ModuleFieldV2[],
  finalAuthoritativeFieldValues: Readonly<Record<string, unknown>>,
  organizationTimeZone = "Pacific/Auckland",
) =>
  deriveEarliestPendingDeadlineTransitionV2({
    recordType: recordType(fields),
    finalAuthoritativeFieldValues,
    organizationTimeZone,
  });

describe("earliest pending deadline transition", () => {
  it("keeps an instant deadline's exact timestamp and selects the earliest candidate", () => {
    const dateDeadline = deadline(ids.dateDeadline, ids.date);
    const instantDeadline = deadline(ids.instantDeadline, ids.instant);
    expect(
      derive([dateDeadline, instantDeadline], {
        [ids.date]: "2026-04-04",
        [ids.instant]: "2026-04-04T10:59:59.1234567Z",
        [ids.dateDeadline]: false,
        [ids.instantDeadline]: false,
      }),
    ).toEqual({
      calculationFieldId: ids.instantDeadline,
      transitionAt: "2026-04-04T10:59:59.1234567Z",
    });
  });

  it("uses the IANA local-day boundary across Auckland DST changes", () => {
    const dateDeadline = deadline(ids.dateDeadline, ids.date);
    expect(
      derive([dateDeadline], {
        [ids.date]: "2026-04-04",
        [ids.dateDeadline]: false,
      }),
    ).toEqual({
      calculationFieldId: ids.dateDeadline,
      transitionAt: "2026-04-04T11:00:00.000Z",
    });
    expect(
      derive([dateDeadline], {
        [ids.date]: "2026-09-26",
        [ids.dateDeadline]: false,
      }),
    ).toEqual({
      calculationFieldId: ids.dateDeadline,
      transitionAt: "2026-09-26T12:00:00.000Z",
    });
  });

  it("uses final calculated due inputs without evaluating another calculation engine", () => {
    const calculatedDeadline = deadline(ids.calculatedDeadline, ids.calculatedInstant);
    expect(
      derive([calculatedDeadline], {
        [ids.calculatedInstant]: "2026-07-01T08:30:00+12:00",
        [ids.calculatedDeadline]: false,
      }),
    ).toEqual({
      calculationFieldId: ids.calculatedDeadline,
      transitionAt: "2026-07-01T08:30:00+12:00",
    });
  });

  it("omits cleared, terminal, passed, invalid and non-pending deadline values", () => {
    const dateDeadline = deadline(ids.dateDeadline, ids.date, ["closed"]);
    const instantDeadline = deadline(ids.instantDeadline, ids.instant);
    expect(
      derive([dateDeadline, instantDeadline], {
        [ids.date]: "2026-04-04",
        [ids.instant]: "not-a-timestamp",
        [ids.status]: "closed",
        [ids.dateDeadline]: false,
        [ids.instantDeadline]: true,
      }),
    ).toBeUndefined();
    expect(
      derive([instantDeadline], {
        [ids.instant]: "2026-04-04T10:00:00Z",
        [ids.instantDeadline]: null,
      }),
    ).toBeUndefined();
    expect(
      derive([instantDeadline], {
        [ids.instant]: "not-a-timestamp",
        [ids.instantDeadline]: false,
      }),
    ).toBeUndefined();
    expect(derive([instantDeadline], { [ids.instantDeadline]: false })).toBeUndefined();
  });
});
