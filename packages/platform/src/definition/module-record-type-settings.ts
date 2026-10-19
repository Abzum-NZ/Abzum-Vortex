import type { ApplicationSourceDocument } from "./application-source-contracts";
import type { ModuleFieldPublication } from "./module-field-edit";
import type { InlineRecordTypeResult } from "./module-record-type-shape";
import { applicationSourceDocumentSchema } from "./application-source-contracts";
import type { RecordOwnershipMode } from "../records/record-ownership-mode";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];

/** Where a record type's records are kept: shared by the organisation, or only for this application. */
export type RecordStorageScope = "organization_shared" | "application_contained";

/** Who owns each record: nobody, the person who created it, a group, or the record it links to. */
export type RecordOwnershipChoice =
  | Readonly<{ mode: "none" | "organization_account" | "group" }>
  | Readonly<{ mode: "inherited"; relationship: string }>;

/**
 * What a record type's storage and ownership are checked against besides the draft: what is
 * published, whose storage is then fixed, and the ownership of the record types of the modules the
 * application uses, by qualified key (`module:record`); undefined when the application cannot read it.
 */
export type RecordSettingsContext = Readonly<{
  publication: ModuleFieldPublication;
  usedOwnership: (qualifiedRecordType: string) => RecordOwnershipMode | undefined;
}>;

/** One relationship a record type could take its owner from, and why it cannot, if it cannot. */
export type RecordOwnershipSource = Readonly<{
  key: string;
  label: string;
  /** The record types it links to, qualified (`module:record`); more than one for a polymorphic link. */
  targets: readonly string[];
  problem?: string;
}>;

const qualify = (moduleKey: string, reference: string): string =>
  reference.includes(":") ? reference : `${moduleKey}:${reference}`;

const findRecord = (
  source: ApplicationSourceDocument,
  qualified: string,
): Readonly<{ module: InlineModule; record: RecordType }> | undefined => {
  const separator = qualified.lastIndexOf(":");
  const module = source.body.modules.find((item) => item.key === qualified.slice(0, separator));
  const record = module?.record_types.find((item) => item.key === qualified.slice(separator + 1));
  return module === undefined || record === undefined ? undefined : { module, record };
};

const relationshipTargets = (
  moduleKey: string,
  relationship: RecordType["relationships"][number],
): string[] =>
  relationship.to_record_type !== undefined
    ? [qualify(moduleKey, relationship.to_record_type)]
    : (relationship.to_record_types ?? []).map((target) => qualify(moduleKey, target));

/**
 * Why records of the target cannot hand an owner down, or undefined when they can. An owner is
 * found by following inherited ownership until a record owned by a person or a group; a record
 * type without an owner, one the application cannot read, or a loop back to a record type already
 * on the way has none. `visiting` holds the record types already on the way.
 */
const ownerProblem = (
  source: ApplicationSourceDocument,
  target: string,
  context: RecordSettingsContext,
  visiting: ReadonlySet<string>,
  name: (qualified: string) => string,
): string | undefined => {
  if (visiting.has(target))
    return `${name(target)} takes its owner from this record type, so the owners would go round in a loop.`;
  const owned = findRecord(source, target);
  if (owned === undefined) {
    const mode = context.usedOwnership(target);
    if (mode === undefined)
      return `${name(target)} is not in a module this application owns or uses.`;
    return mode === "none" ? `${name(target)} records have no owner to hand down.` : undefined;
  }
  const { module, record } = owned;
  if (record.ownership_mode === "organization_account" || record.ownership_mode === "group")
    return undefined;
  if (record.ownership_mode !== "inherited")
    return `${name(target)} records have no owner to hand down.`;
  const relationship = record.relationships.find(
    (item) => item.key === record.ownership_relationship,
  );
  if (relationship === undefined)
    return `${name(target)} takes its owner from a relationship it no longer has.`;
  const next = new Set([...visiting, target]);
  for (const further of relationshipTargets(module.key, relationship)) {
    const problem = ownerProblem(source, further, context, next, name);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

/**
 * Every relationship of a record type that could give each record its owner: a single-record link
 * (one target, or several for a polymorphic link) whose every target hands an owner down. Those
 * that cannot are listed too, with why, so a builder sees what to change.
 */
export const recordOwnershipSources = (
  source: ApplicationSourceDocument,
  moduleKey: string,
  recordKey: string,
  context: RecordSettingsContext,
  name: (qualified: string) => string,
): readonly RecordOwnershipSource[] => {
  const qualified = `${moduleKey}:${recordKey}`;
  const found = findRecord(source, qualified);
  if (found === undefined) return [];
  const { record } = found;
  return record.relationships.map((relationship) => {
    const field = record.fields.find((item) => item.key === relationship.from_field);
    const targets = relationshipTargets(moduleKey, relationship);
    const label = field?.label ?? relationship.key;
    const problem =
      field === undefined ||
      (field.type !== "link" && field.type !== "link_to_one_of_several") ||
      field.key !== relationship.key
        ? "Only a link field can give records their owner."
        : relationship.cardinality === "many_to_many"
          ? "It links to several records, so it cannot name one owner."
          : !field.required
            ? `Make ${label} required first: every record needs the record it takes its owner from.`
            : targets
                .map((target) => ownerProblem(source, target, context, new Set([qualified]), name))
                .find((item) => item !== undefined);
    return { key: relationship.key, label, targets, ...(problem === undefined ? {} : { problem }) };
  });
};

/**
 * Sets where a record type's records are kept and who owns them, as one change. It is allowed only
 * before the record type's first publication: afterwards its storage is fixed and an upgrade
 * refuses a change. Inherited ownership is set together with the relationship it follows, and
 * leaving it clears that relationship. The storage identity never changes.
 */
export const setInlineRecordStorageOwnership = (
  current: ApplicationSourceDocument,
  change: Readonly<{
    moduleKey: string;
    recordKey: string;
    storageScope: RecordStorageScope;
    ownership: RecordOwnershipChoice;
  }>,
  context: RecordSettingsContext,
  name: (qualified: string) => string,
): InlineRecordTypeResult => {
  const qualified = `${change.moduleKey}:${change.recordKey}`;
  if (findRecord(current, qualified) === undefined)
    return {
      kind: "invalid",
      issues: ["The record type is not in this application's modules any more."],
    };
  if (context.publication.recordTypes.has(qualified))
    return {
      kind: "invalid",
      issues: [
        "Storage and ownership are fixed once the record type is published: its records are already kept that way.",
      ],
    };
  if (change.ownership.mode === "inherited") {
    const relationship = change.ownership.relationship;
    const choice = recordOwnershipSources(
      current,
      change.moduleKey,
      change.recordKey,
      context,
      name,
    ).find((item) => item.key === relationship);
    if (choice === undefined)
      return {
        kind: "invalid",
        issues: ["Choose the linked record each record takes its owner from."],
      };
    if (choice.problem !== undefined) return { kind: "invalid", issues: [choice.problem] };
  }
  const source = structuredClone(current);
  const record = findRecord(source, qualified)!.record as {
    storage_scope: RecordStorageScope;
    ownership_mode: RecordOwnershipMode;
    ownership_relationship?: string;
  };
  record.storage_scope = change.storageScope;
  record.ownership_mode = change.ownership.mode;
  if (change.ownership.mode === "inherited")
    record.ownership_relationship = change.ownership.relationship;
  else delete record.ownership_relationship;
  // A record type that takes its owner from this one must still find an owner.
  for (const module of source.body.modules)
    for (const dependent of module.record_types) {
      const dependentKey = `${module.key}:${dependent.key}`;
      if (dependentKey === qualified || dependent.ownership_mode !== "inherited") continue;
      const before = recordOwnershipSources(current, module.key, dependent.key, context, name).find(
        (item) => item.key === dependent.ownership_relationship,
      );
      const after = recordOwnershipSources(source, module.key, dependent.key, context, name).find(
        (item) => item.key === dependent.ownership_relationship,
      );
      if (before?.problem === undefined && after?.problem !== undefined)
        return {
          kind: "invalid",
          issues: [
            `${name(dependentKey)} takes its owner from its ${after.label} link, which would then give none. ${after.problem}`,
          ],
        };
    }
  const parsed = applicationSourceDocumentSchema.safeParse(source);
  if (!parsed.success)
    return {
      kind: "invalid",
      issues: parsed.error.issues.map((issue) => `${issue.message} (${issue.path.join(" / ")})`),
    };
  return {
    kind: "changed",
    source: parsed.data,
    moduleKey: change.moduleKey,
    recordKey: change.recordKey,
  };
};
