import {
  eventEnvelopeSchema,
  eventOccurrenceEnvelopeV2Schema,
  installedEventDescriptorSchema,
  standardInstalledEventKindSchema,
} from "../src";
import { describe, expect, it } from "vitest";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const fingerprint = `sha256:${"a".repeat(64)}`;

const declaredDescriptor = {
  kind: "declared",
  owner: { kind: "module", moduleRootId: id(1) },
  declarationId: id(2),
  key: "example.item.reviewed",
  recordTypeId: id(3),
  carriedFieldIds: [id(4)],
} as const;

const occurrence = {
  contractVersion: "2.0.0",
  occurrenceId: id(5),
  organizationId: id(6),
  installation: {
    applicationRootId: id(7),
    applicationReleaseRevision: 3,
    moduleBinding: { moduleRootId: id(1), moduleReleaseRevision: 4, bindingRevision: 9 },
  },
  descriptor: declaredDescriptor,
  definitionRelease: {
    kind: "module",
    rootId: id(1),
    releaseRevision: 4,
    releaseVersion: "2.1.0",
    contentFingerprint: fingerprint,
    resolutionFingerprint: fingerprint,
  },
  recordId: id(8),
  occurredAt: "2026-09-09T01:02:03.000Z",
  actorId: id(9),
  correlationId: id(10),
  recordSequence: 12,
  payload: { kind: "declared", carriedValues: { [id(4)]: "reviewed" } },
} as const;

describe("installed event contracts", () => {
  it("closes standard descriptors to the seven specification kinds", () => {
    expect(standardInstalledEventKindSchema.options).toEqual([
      "created",
      "changed",
      "deleted",
      "linked",
      "unlinked",
      "reassigned",
      "state_changed",
    ]);
    for (const eventKind of standardInstalledEventKindSchema.options)
      expect(
        installedEventDescriptorSchema.safeParse({
          kind: "standard",
          eventKind,
          recordTypeId: id(3),
        }).success,
      ).toBe(true);
    expect(
      installedEventDescriptorSchema.safeParse({
        kind: "standard",
        eventKind: "restored",
        recordTypeId: id(3),
      }).success,
    ).toBe(false);
  });

  it("requires a permanent declaration identity, namespaced key, owner and canonical fields", () => {
    expect(installedEventDescriptorSchema.safeParse(declaredDescriptor).success).toBe(true);
    expect(
      installedEventDescriptorSchema.safeParse({ ...declaredDescriptor, key: "reviewed" }).success,
    ).toBe(false);
    expect(
      installedEventDescriptorSchema.safeParse({
        ...declaredDescriptor,
        carriedFieldIds: [id(5), id(4)],
      }).success,
    ).toBe(false);
  });

  it("uses an explicit V2 occurrence identity and retains the full descriptor identity", () => {
    expect(eventOccurrenceEnvelopeV2Schema.parse(occurrence)).toEqual(occurrence);
    expect(
      eventOccurrenceEnvelopeV2Schema.safeParse({
        ...occurrence,
        payload: { kind: "created" },
      }).success,
    ).toBe(false);
    expect(
      eventOccurrenceEnvelopeV2Schema.safeParse({
        ...occurrence,
        definitionRelease: { ...occurrence.definitionRelease, rootId: id(11) },
      }).success,
    ).toBe(false);
  });

  it("leaves the historical envelope shape and builder eventName semantics unchanged", () => {
    const historical = {
      eventId: id(12),
      organizationId: id(6),
      moduleRootId: id(1),
      recordTypeId: id(3),
      recordId: id(8),
      eventName: "reviewed",
      occurredAt: occurrence.occurredAt,
      actorId: id(9),
      correlationId: id(10),
      definitionRevisions: { module: 4 },
      recordSequence: 12,
      carriedValues: {},
    };
    expect(eventEnvelopeSchema.parse(historical)).toEqual(historical);
    expect(eventEnvelopeSchema.safeParse({ ...historical, occurrenceId: id(5) }).success).toBe(
      false,
    );
  });
});
