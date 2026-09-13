import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionResolutionSnapshotSchema,
  definitionSourceDocumentSchema,
} from "@vortex/contracts";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";
import { validateDefinitionSet } from "../src/validation";

// #37: the two field-policy rules that are owned at publication, tested at that
// layer rather than restated in the database resolver. Field bounds are
// resolved only in SQL (the Access schema's resolve_record_field_bounds_internal),
// which contributes exactly the field identities a stored policy names. It has
// no notion of record-type membership or of sensitivity. Registration's store
// check (permission_field_policy_is_valid) validates shape only -- canonical
// unique UUIDs, changeable within readable -- and registration requires the
// candidate to equal the published release's permissions exactly. So whether
// a policy may name a field at all is decided here:
//   * field/record-type mismatch: an authored alias resolves only within the
//     permission's exact record type (compiler), and a compiled policy must
//     name only that record type's fields (publication validation);
//   * sensitive explicit access: a sensitive field reaches a policy only when
//     that policy names it. The compiler resolves each named alias and adds
//     nothing else; a compiled policy field with no authored alias fails the
//     compiler's own provenance check and publication's provenance rule; and
//     there is no wildcard alias.

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../testing/fixtures/historical/module-v1",
);
const sources = ["modules", "applications", "connection-types"].flatMap((directory) =>
  fs
    .readdirSync(path.join(fixtureRoot, directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) =>
      definitionSourceDocumentSchema.parse(
        JSON.parse(fs.readFileSync(path.join(fixtureRoot, directory, name), "utf8")),
      ),
    ),
);
const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);
const draftMetadata = {
  organizationId: "10000000-0000-4000-a000-000000000001",
  draftRevision: 1,
  createdAt: "2026-09-01T00:00:00+00:00",
  createdBy: "10000000-0000-4000-a000-000000000002",
  updatedAt: "2026-09-01T00:00:00+00:00",
  updatedBy: "10000000-0000-4000-a000-000000000002",
} as const;
const savedConditionRevisions = [
  { conditionId: "a4b5546d-8a54-4003-adc4-ddb8b0d7257d", revision: 1 },
] as const;
const requestFor = (source: (typeof sources)[number]) => ({
  source,
  resolution,
  ...(source.kind === "connection_type" ? {} : { draftMetadata }),
  ...(source.kind === "module" ? { savedConditionRevisions } : {}),
});

const peopleSource = () => {
  const source = sources.find(
    (candidate) => candidate.kind === "module" && candidate.key === "vortex.crm.people",
  );
  if (!source || source.kind !== "module") throw new Error("People module fixture required");
  return structuredClone(source);
};
const compilePeople = (source = peopleSource()) => {
  const output = compileDefinition(requestFor(source));
  if (output.kind !== "module") throw new Error("Compiled module required");
  return output;
};
const recordType = (output: ReturnType<typeof compilePeople>, key: string) => {
  const record = output.canonical.content.recordTypes.find((entry) => entry.key === key);
  if (!record) throw new Error(`Record type ${key} required`);
  return record;
};
const fieldId = (record: ReturnType<typeof recordType>, key: string) => {
  const field = record.fields.find((entry) => entry.key === key);
  if (!field) throw new Error(`Field ${key} required`);
  return field.fieldId;
};

describe("field/record-type mismatch is refused at publication", () => {
  it("refuses an authored alias that names a field of another record type in the same module", () => {
    // Contact and Lead are both record types of vortex.crm.people; score exists
    // on Lead only.
    const control = peopleSource();
    const contactRead = control.body.permissions.find(
      (entry) => entry.key === "vortex.crm.people.contact.read",
    );
    if (!contactRead?.field_policy) throw new Error("Contact read policy required");
    expect(contactRead.field_policy.readable_fields).not.toContain("score");
    expect(() => compilePeople(control)).not.toThrow();

    const mismatched = peopleSource();
    const policy = mismatched.body.permissions.find(
      (entry) => entry.key === "vortex.crm.people.contact.read",
    )?.field_policy;
    if (!policy) throw new Error("Contact read policy required");
    policy.readable_fields = [...policy.readable_fields, "score"];
    expect(() => compilePeople(mismatched)).toThrowError("vortex.definition.missing_identity");
  });

  it("refuses a compiled policy that names a field of another record type", () => {
    const people = peopleSource();
    const request = requestFor(people);
    const dependencyOutputs = sources
      .filter((source) => source.kind === "module" && source.key !== people.key)
      .map((source) => compileDefinition(requestFor(source)));
    const validate = (candidate: ReturnType<typeof compilePeople>) =>
      validateDefinitionSet({
        requests: [request],
        outputs: [candidate],
        dependencyOutputs,
        publishedHistories: [{ kind: "module", definitionKey: people.key, history: [] }],
      }).failures.map((entry) => entry.ruleCode);

    const output = compilePeople(people);
    expect(validate(output)).toEqual([]);

    // The same output with Contact read's authored "phone" alias resolved to
    // Lead's score field instead -- a field that exists, but not on that
    // permission's record type -- and its content fingerprint recomputed. This
    // is what a compiler resolving an alias outside the record type would
    // emit: every source and canonical position is still traced, so
    // provenance is complete and only the record-type rule can refuse it.
    const mismatched = structuredClone(output);
    const phoneId = fieldId(recordType(mismatched, "contact"), "phone");
    const scoreId = fieldId(recordType(mismatched, "lead"), "score");
    const contactRead = mismatched.canonical.content.permissions.find(
      (entry) => entry.key === "vortex.crm.people.contact.read",
    );
    if (!contactRead?.fieldPolicy) throw new Error("Compiled contact read policy required");
    expect(contactRead.fieldPolicy.readableFieldIds).toContain(phoneId);
    contactRead.fieldPolicy = {
      ...contactRead.fieldPolicy,
      readableFieldIds: contactRead.fieldPolicy.readableFieldIds
        .map((id) => (id === phoneId ? scoreId : id))
        .sort(),
    };
    mismatched.artifact.contentFingerprint = fingerprintCanonicalValue(
      mismatched.canonical.content,
    );
    expect(validate(mismatched)).toEqual(["vortex.definition.module_record_references"]);
  });
});

describe("a sensitive field requires explicit access", () => {
  it("reaches only the compiled policies that name it", () => {
    const people = peopleSource();
    const output = compilePeople(people);
    const contact = recordType(output, "contact");
    const notes = contact.fields.find((field) => field.key === "notes");
    expect(notes?.personalData).toBe("sensitive");
    if (!notes) throw new Error("Contact notes field required");

    const authored = new Map(people.body.permissions.map((entry) => [entry.key, entry]));
    const contactPermissions = output.canonical.content.permissions.filter(
      (entry) => entry.recordTypeId === contact.recordTypeId,
    );
    expect(contactPermissions.length).toBeGreaterThan(1);
    for (const permission of contactPermissions) {
      const authoredPolicy = authored.get(permission.key)?.field_policy;
      const compiledPolicy = permission.fieldPolicy;
      expect(compiledPolicy?.readableFieldIds.includes(notes.fieldId), permission.key).toBe(
        authoredPolicy?.readable_fields.includes("notes") ?? false,
      );
      expect(compiledPolicy?.changeableFieldIds.includes(notes.fieldId), permission.key).toBe(
        authoredPolicy?.changeable_fields.includes("notes") ?? false,
      );
    }
    expect(
      output.canonical.content.permissions.find(
        (entry) => entry.key === "vortex.crm.people.contact.view_sensitive_notes",
      )?.fieldPolicy,
    ).toEqual({ readableFieldIds: [notes.fieldId], changeableFieldIds: [] });
    for (const key of ["read", "update", "export"])
      expect(
        output.canonical.content.permissions
          .find((entry) => entry.key === `vortex.crm.people.contact.${key}`)
          ?.fieldPolicy?.readableFieldIds.includes(notes.fieldId),
        key,
      ).toBe(false);
  });

  it("grants it once a policy names it explicitly, and has no alias that could include it implicitly", () => {
    const people = peopleSource();
    const policy = people.body.permissions.find(
      (entry) => entry.key === "vortex.crm.people.contact.read",
    )?.field_policy;
    if (!policy) throw new Error("Contact read policy required");
    policy.readable_fields = [...policy.readable_fields, "notes"];
    const output = compilePeople(people);
    const notesId = fieldId(recordType(output, "contact"), "notes");
    expect(
      output.canonical.content.permissions
        .find((entry) => entry.key === "vortex.crm.people.contact.read")
        ?.fieldPolicy?.readableFieldIds.includes(notesId),
    ).toBe(true);

    const wildcard = peopleSource();
    const wildcardPolicy = wildcard.body.permissions.find(
      (entry) => entry.key === "vortex.crm.people.contact.read",
    )?.field_policy;
    if (!wildcardPolicy) throw new Error("Contact read policy required");
    wildcardPolicy.readable_fields = ["*"];
    expect(definitionSourceDocumentSchema.safeParse(wildcard).success).toBe(false);
  });
});
