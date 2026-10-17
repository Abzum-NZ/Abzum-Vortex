import type { ApplicationSourceDocument } from "./application-source-contracts";
import { standardPermissionKey } from "./module-field-shape";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];
type Relationship = RecordType["relationships"][number];

/**
 * The organisation's shared people directory: the platform's system directory Module, owned by the
 * organisation's administration application. A Person link is a link field whose target is its
 * person record type; a role that reads the linking record reads people's names through its
 * reference permission.
 */
export const peopleDirectory = Object.freeze({
  module: "vortex.system_directory",
  recordType: "vortex.system_directory:person",
  readPermission: "vortex.system_directory.person.reference_read",
});

/**
 * What the draft compile found of the people directory: the Application that owns it (a draft
 * that uses it names that owner) and the label of the field each person is shown by.
 */
export type PeopleDirectoryOwner = Readonly<{ application: string; titleLabel: string }>;

/** How many records of the linking record type may link to one linked record. */
export type LinkCardinality = "many_to_one" | "one_to_one";
export const linkCardinalities: readonly LinkCardinality[] = Object.freeze(["many_to_one", "one_to_one"]);

/** One link field of a record type and the relationship it declares. */
export type InlineRecordTypeLink = Readonly<{
  fieldKey: string;
  label: string;
  type: "link" | "link_to_one_of_several";
  /** The record types it links to, as `module:record`. */
  targets: readonly string[];
  /** The relationship's own cardinality; a link field holds one record. */
  cardinality: Relationship["cardinality"];
  /** The name of the link back, from each linked record. */
  reverseKey: string | undefined;
  onParentDelete: Relationship["on_parent_delete"];
}>;

/** A link of another owned record type that points at this record type. */
export type InlineRecordTypeIncomingLink = InlineRecordTypeLink & Readonly<{
  moduleKey: string; recordKey: string; recordName: string; recordPluralName: string;
}>;

const linksOf = (record: RecordType): InlineRecordTypeLink[] => record.fields.flatMap((field) => {
  if (field.type !== "link" && field.type !== "link_to_one_of_several") return [];
  const relationship = record.relationships.find((candidate) => candidate.from_field === field.key);
  if (relationship === undefined) return [];
  const settings = field.settings as { target?: string; targets?: string[]; reverse_key?: string };
  return [{
    fieldKey: field.key, label: field.label, type: field.type,
    targets: field.type === "link" ? [String(settings.target)] : [...(settings.targets ?? [])],
    cardinality: relationship.cardinality, reverseKey: settings.reverse_key, onParentDelete: relationship.on_parent_delete,
  }];
});

/**
 * The relationships of one record type of an owned inline Module, as a person reads them: the
 * links its own fields make, and the links other record types of the application's own Modules
 * make to it. Each relationship belongs to the link field that declares it.
 */
export const inlineRecordTypeLinks = (
  source: ApplicationSourceDocument, moduleKey: string, recordKey: string,
): Readonly<{ outgoing: readonly InlineRecordTypeLink[]; incoming: readonly InlineRecordTypeIncomingLink[] }> => {
  const record = source.body.modules.find((module) => module.key === moduleKey)?.record_types
    .find((candidate) => candidate.key === recordKey);
  const qualified = `${moduleKey}:${recordKey}`;
  // A record type that links to itself lists that link once, among its own.
  const incoming = source.body.modules.flatMap((module) => module.record_types.flatMap((other) =>
    module.key === moduleKey && other.key === recordKey ? [] : linksOf(other).filter((link) => link.targets.some((target) => target === qualified ||
      (module.key === moduleKey && target === recordKey)))
      .map((link) => ({ ...link, moduleKey: module.key, recordKey: other.key, recordName: other.name,
        recordPluralName: other.plural_name }))));
  return { outgoing: record === undefined ? [] : linksOf(record), incoming };
};

/** The module a qualified record type reference (`module:record`) names. */
export const linkTargetModule = (target: string): string | undefined => {
  const separator = target.lastIndexOf(":");
  return separator > 0 ? target.slice(0, separator) : undefined;
};

/** A link target as `module:record`; a bare record key names a record type of the linking module. */
export const qualifiedLinkTarget = (moduleKey: string, target: string): string =>
  linkTargetModule(target) === undefined ? `${moduleKey}:${target}` : target;

/** Whether a field is a Person link: a link field that may point at the people directory's person. */
export const isPersonLink = (field: Readonly<{ type: string; settings: unknown }>): boolean => {
  const settings = field.settings as { target?: unknown; targets?: unknown };
  return (field.type === "link" && settings.target === peopleDirectory.recordType) ||
    (field.type === "link_to_one_of_several" && Array.isArray(settings.targets) && settings.targets.includes(peopleDirectory.recordType));
};

/**
 * Makes a draft that links to the people directory able to: the application uses the directory
 * Module (named by its owner), and every role that reads the linking record type reads people's
 * names too. Returns why it cannot, or undefined.
 */
export const enablePeopleDirectoryLinks = (
  source: ApplicationSourceDocument, module: InlineModule, record: RecordType, owner: PeopleDirectoryOwner | null,
): string | undefined => {
  const uses = source.body.uses as { application: string; module: string }[];
  if (!uses.some((use) => use.module === peopleDirectory.module)) {
    if (owner === null)
      return "The organisation's people directory could not be read, so a link to a person can't be added now. " +
        "Save the draft and try again; if it keeps happening, ask your administrator to check the directory is installed.";
    uses.push({ application: owner.application, module: peopleDirectory.module });
  }
  // Readability follows the record's roles: who reads the record reads the people it links to.
  const read = standardPermissionKey(module.key, record.key, "read");
  for (const role of source.body.roles) {
    const permissions = role.permissions as string[];
    if (permissions.includes("*") || !permissions.includes(read) || permissions.includes(peopleDirectory.readPermission)) continue;
    permissions.push(peopleDirectory.readPermission);
  }
  return undefined;
};

/**
 * Undoes what the Person links added once the last of them is gone: the use of the directory
 * Module and the roles' permission to read people's names. Both stay while anything else in the
 * draft still names the directory, so nothing the author set up for another reason is removed.
 */
export const retirePeopleDirectoryLinks = (source: ApplicationSourceDocument): void => {
  const fields = source.body.modules.flatMap((module) => module.record_types.flatMap((record) => record.fields));
  if (fields.some((field) => isPersonLink(field))) return;
  const { uses, roles, ...rest } = source.body;
  const otherGrants = roles.map((role) => ({ ...role,
    permissions: (role.permissions as string[]).filter((permission) => permission !== peopleDirectory.readPermission) }));
  if (JSON.stringify([rest, otherGrants]).includes(peopleDirectory.module)) return;
  (source.body as { uses: typeof uses }).uses = uses.filter((use) => use.module !== peopleDirectory.module);
  for (const role of roles) {
    const permissions = role.permissions as string[];
    const at = permissions.indexOf(peopleDirectory.readPermission);
    if (at >= 0) permissions.splice(at, 1);
  }
};
