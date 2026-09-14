import {
  actionDefinitionV2Schema,
  moduleFieldV2Schema,
  type ModuleFieldV2,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { composeNamedAction, type PreparedNamedAction } from "../src/named-action-composition";

const id = (value: number) => `50000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const moduleRootId = id(1);
const recordTypeId = id(2);
const recordId = id(3);
const actorId = id(4);

const field = (fieldId: string, key: string, type: string, settings: unknown): ModuleFieldV2 =>
  moduleFieldV2Schema.parse({
    fieldId,
    key,
    label: key,
    required: false,
    unique: false,
    filterable: true,
    sortable: true,
    personalData: "none",
    publicDisplay: "allowed",
    type,
    settings,
  });

const fields = {
  title: field(id(10), "title", "text", { maxLength: 100 }),
  copied: field(id(11), "copied", "text", { maxLength: 100 }),
  money: field(id(12), "money", "money", {
    currencyMode: "fixed",
    currency: "NZD",
    minimum: "0",
  }),
  person: field(id(13), "person", "link_to_person", {
    audience: "organization_accounts",
    applicationRootIdRequired: false,
    onPersonDeactivation: "retain_reference",
  }),
  at: field(id(14), "at", "date_time", { displayTimeZone: "organization" }),
  self: field(id(15), "self", "link", {
    target: { state: "resolved", moduleRootId, recordTypeId },
    reverseKey: "self_links",
    onParentDelete: "refuse",
  }),
} as const;

const prepared = (effects: unknown[]): PreparedNamedAction => ({
  validationContractVersion: "2.0.0",
  action: actionDefinitionV2Schema.parse({
    actionId: id(20),
    key: "example.record.approve",
    label: "Approve",
    subjectRecordTypeId: recordTypeId,
    permissionKey: "example.record.approve",
    sharing: "refused",
    inputs: [
      {
        key: "amount",
        label: "Amount",
        required: true,
        type: "money",
        validation: { minimum: "1", maximum: "100" },
      },
    ],
    precondition: {
      kind: "comparison",
      operator: "equals",
      left: { source: "field", fieldId: fields.title.fieldId },
      right: { source: "value", value: "ready" },
    },
    effects,
  }),
  recordType: { recordTypeId, fields: Object.values(fields) },
  recordId,
  existingValues: { [fields.title.fieldId]: "ready" },
  actorOrganizationAccountId: actorId,
});

describe("named action composition", () => {
  it("normalizes typed inputs and resolves every supported value source in effect order", () => {
    const result = composeNamedAction(
      prepared([
        {
          kind: "set_field",
          fieldId: fields.money.fieldId,
          value: { source: "input", inputKey: "amount" },
        },
        {
          kind: "set_field",
          fieldId: fields.copied.fieldId,
          value: { source: "subject_field", fieldId: fields.title.fieldId },
        },
        {
          kind: "set_field",
          fieldId: fields.person.fieldId,
          value: { source: "current_actor" },
        },
        {
          kind: "set_field",
          fieldId: fields.at.fieldId,
          value: { source: "current_time" },
        },
        {
          kind: "set_field",
          fieldId: fields.self.fieldId,
          value: { source: "subject_record" },
        },
        { kind: "announce_event", eventKey: "example.record.approved" },
      ]),
      { amount: { amount: "10", currency: "NZD" } },
      "2026-09-14T12:00:00.000Z",
    );

    expect(result).toEqual({
      normalizedInputs: { amount: { amount: "10", currency: "NZD" } },
      preconditionSatisfied: true,
      announcedEventKeys: ["example.record.approved"],
      submittedValues: {
        [fields.money.fieldId]: { amount: "10", currency: "NZD" },
        [fields.copied.fieldId]: "ready",
        [fields.person.fieldId]: { organizationAccountId: actorId },
        [fields.at.fieldId]: "2026-09-14T12:00:00.000Z",
        [fields.self.fieldId]: { recordTypeId, recordId },
      },
    });
  });

  it("keeps event-only actions free of fabricated field changes", () => {
    expect(
      composeNamedAction(
        prepared([{ kind: "announce_event", eventKey: "example.record.approved" }]),
        { amount: { amount: "1", currency: "NZD" } },
        "2026-09-14T12:00:00.000Z",
      ),
    ).toMatchObject({ submittedValues: {}, announcedEventKeys: ["example.record.approved"] });
  });

  it("refuses invalid inputs, failed preconditions and unsupported effects without effects", () => {
    expect(
      composeNamedAction(
        prepared([{ kind: "announce_event", eventKey: "example.record.approved" }]),
        { amount: { amount: "101", currency: "NZD" } },
        "2026-09-14T12:00:00.000Z",
      ),
    ).toBeUndefined();
    expect(
      composeNamedAction(
        prepared([
          {
            kind: "create_record",
            recordType: { state: "resolved", moduleRootId, recordTypeId },
            values: {},
          },
        ]),
        { amount: { amount: "1", currency: "NZD" } },
        "2026-09-14T12:00:00.000Z",
      ),
    ).toBeUndefined();
    expect(
      composeNamedAction(
        {
          ...prepared([{ kind: "announce_event", eventKey: "example.record.approved" }]),
          existingValues: { [fields.title.fieldId]: "blocked" },
        },
        { amount: { amount: "1", currency: "NZD" } },
        "2026-09-14T12:00:00.000Z",
      )?.preconditionSatisfied,
    ).toBe(false);
  });
});
