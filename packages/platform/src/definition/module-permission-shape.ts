import type { ApplicationSourceDocument } from "./application-source-contracts";
import {
  changeableByPeople,
  standardPermissionKey,
  standardRecordActions,
  type StandardRecordAction,
} from "./module-field-shape";

type InlineModule = ApplicationSourceDocument["body"]["modules"][number];
type RecordType = InlineModule["record_types"][number];

export const standardPermissionLabel = (verb: string, name: string): string =>
  `${verb} ${name.toLowerCase()}`.slice(0, 60);
export const standardPermissionDescription = (action: string, plural: string): string =>
  `Allows the standard ${action.replaceAll("_", " ")} operation for ${plural.toLowerCase()}.`;

/** The one declaration used both at creation and when an operation is enabled later. */
export const standardRecordPermission = (
  moduleKey: string,
  record: RecordType,
  action: StandardRecordAction,
  id: string,
): InlineModule["permissions"][number] => {
  const entry = standardRecordActions.find((item) => item.action === action)!;
  return {
    id,
    key: standardPermissionKey(moduleKey, record.key, action),
    label: standardPermissionLabel(entry.verb, record.name),
    description: standardPermissionDescription(action, record.plural_name),
    record_type: record.key,
    action_kind: entry.kind,
    administrative: false,
    record_scope: { routes: [{ kind: "all_records" }] },
    field_policy: {
      readable_fields: record.fields.map((field) => field.key),
      changeable_fields:
        entry.kind === "create" || entry.kind === "update"
          ? record.fields.filter(changeableByPeople).map((field) => field.key)
          : [],
    },
  } as InlineModule["permissions"][number];
};

/** Roles holding every existing record permission across the Application's owned Modules. */
export const fullRecordAccessRoleKeys = (
  source: ApplicationSourceDocument,
): ReadonlySet<string> => {
  const ownedRecordTypes = new Set(
    source.body.modules.flatMap((owned) =>
      owned.record_types.map((record) => `${owned.key}:${record.key}`),
    ),
  );
  const existingRecordPermissions = [
    ...source.body.modules.flatMap((owned) =>
      owned.permissions
        .filter((permission) => permission.record_type !== undefined)
        .map((permission) => permission.key),
    ),
    ...source.body.permissions
      .filter(
        (permission) =>
          permission.record_type !== undefined && ownedRecordTypes.has(permission.record_type),
      )
      .map((permission) => permission.key),
  ];
  return new Set(
    source.body.roles
      .filter(
        (role) =>
          role.permissions.includes("*") ||
          existingRecordPermissions.every((permission) => role.permissions.includes(permission)),
      )
      .map((role) => role.key),
  );
};
