import type { ApplicationSourceDocument } from "./application-source-contracts";

/** Roles holding every existing record permission across the Application's owned Modules. */
export const fullRecordAccessRoleKeys = (source: ApplicationSourceDocument): ReadonlySet<string> => {
  const ownedRecordTypes = new Set(source.body.modules.flatMap((owned) =>
    owned.record_types.map((record) => `${owned.key}:${record.key}`)));
  const existingRecordPermissions = [
    ...source.body.modules.flatMap((owned) => owned.permissions
      .filter((permission) => permission.record_type !== undefined)
      .map((permission) => permission.key)),
    ...source.body.permissions
      .filter((permission) => permission.record_type !== undefined && ownedRecordTypes.has(permission.record_type))
      .map((permission) => permission.key),
  ];
  return new Set(source.body.roles.filter((role) => role.permissions.includes("*") ||
    existingRecordPermissions.every((permission) => role.permissions.includes(permission)))
    .map((role) => role.key));
};
