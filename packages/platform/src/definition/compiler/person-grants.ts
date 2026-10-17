import type { DefinitionCompilationOutput } from "../definition-compilation-contracts";
import { peopleDirectory } from "../module-links";

type ModuleOutput = Extract<DefinitionCompilationOutput, { kind: "module" }>;

const lower = (value: unknown): string => String(value).toLowerCase();

/**
 * The people-name grant each role derives at compile: a role that can read a record type with a
 * Person link (a link field that may point at the people directory's person) holds the directory's
 * name-only `reference_read` too, and nothing more of the directory. The grant is never written
 * into the draft; it follows the roles and links of every compile, so a role added later gets it
 * and a role whose last Person link is gone loses it.
 *
 * `moduleKeys` are the Modules this Application owns or uses: only their record types and
 * permissions are considered, and the grant is derived only while the Application uses the
 * directory Module.
 */
export const derivePersonGrants = (
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  moduleKeys: readonly string[],
): ((permissionKeys: readonly string[]) => readonly string[]) => {
  const unchanged = (permissionKeys: readonly string[]) => permissionKeys;
  const modules = dependencyOutputs.filter(
    (output): output is ModuleOutput =>
      output.kind === "module" && moduleKeys.includes(String(output.artifact.definitionKey)),
  );
  const directory = modules.find(
    (output) => output.artifact.definitionKey === peopleDirectory.module,
  );
  if (directory === undefined) return unchanged;
  const personKey = peopleDirectory.recordType.slice(
    peopleDirectory.recordType.lastIndexOf(":") + 1,
  );
  const person = directory.canonical.content.recordTypes.find((record) => record.key === personKey);
  if (person === undefined) return unchanged;
  const personId = lower(person.recordTypeId);
  const pointsAtPerson = (target: unknown): boolean =>
    typeof target === "object" &&
    target !== null &&
    (target as { state?: unknown }).state === "resolved" &&
    lower((target as { recordTypeId?: unknown }).recordTypeId) === personId;

  const linking = new Set<string>();
  for (const module of modules)
    for (const record of module.canonical.content.recordTypes)
      if (
        record.fields.some((field) =>
          field.type === "link"
            ? pointsAtPerson(field.settings.target)
            : field.type === "link_to_one_of_several" &&
              field.settings.targets.some(pointsAtPerson),
        )
      )
        linking.add(lower(record.recordTypeId));
  if (linking.size === 0) return unchanged;

  // The read permissions of those record types, by key, across the same Modules.
  const readsPersonLinks = new Set(
    modules.flatMap((module) =>
      module.canonical.content.permissions
        .filter(
          (permission) =>
            permission.actionKind === "read" &&
            permission.recordTypeId !== undefined &&
            linking.has(lower(permission.recordTypeId)),
        )
        .map((permission) => permission.key),
    ),
  );
  return (permissionKeys) =>
    permissionKeys.includes(peopleDirectory.readPermission) ||
    !permissionKeys.some((key) => readsPersonLinks.has(key))
      ? permissionKeys
      : [...permissionKeys, peopleDirectory.readPermission];
};
