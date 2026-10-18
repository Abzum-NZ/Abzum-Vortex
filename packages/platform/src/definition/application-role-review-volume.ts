import { maximumApplicationRoles, type ApplicationContent } from "./application-contracts";
import type { ModuleContent } from "./module-contracts";
import type { JsonValue } from "../catalogue/common";

/** A complete review reserves one bounded release and independently retained historical roles. */
export const maximumApplicationRoleReviewBytes = 896 * 1024;
// Every one of the 500 roles may retain a different previously published permission set.
export const maximumAcceptedRoleHistoryBytes =
  96 * 1024 * 1024 - 256 * 1024 - maximumApplicationRoleReviewBytes;
export const applicationRoleReviewVolumeMessage =
  "This application's roles contain too much permission detail for one installation review. Use fewer roles, or give each role fewer permissions or field-level grants before publishing.";

const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Upper bound for freshly parsed JSONB, including entry headers, alignment and numeric storage. */
export const reviewJsonbBytes = (value: JsonValue): number => {
  if (typeof value === "string") return bytes(value) + 8;
  if (typeof value === "number") return 32;
  if (typeof value === "boolean" || value === null) return 8;
  if (Array.isArray(value))
    return 8 + value.reduce<number>((total, entry) => total + 8 + reviewJsonbBytes(entry), 0);
  return (
    8 +
    Object.entries(value).reduce(
      (total, [key, entry]) => total + 16 + bytes(key) + reviewJsonbBytes(entry),
      0,
    )
  );
};

/**
 * Per-version review allowance, after permission references and wildcards have been resolved.
 * 512 bytes per role covers its snapshot identity/flags, local label (up to 180 UTF-8 bytes),
 * holder count, explanatory words, separators and submitted template ID. Each grant pays for
 * its saved key/label plus its displayed label and change marker. Each field grant reserves
 * 384 bytes: two 60-character labels at up to 3 UTF-8 bytes per UTF-16 unit, change marker,
 * edit suffix and separators. This also covers UUID fallbacks and names changed in later
 * releases. The largest role is charged 500 times because independently accepted roles can
 * retain permission sets from 500 different releases.
 */
export const applicationRoleReviewBytes = (
  application: ApplicationContent,
  modules: readonly ModuleContent[],
): Readonly<{ releaseBytes: number; acceptedHistoryBytes: number }> => {
  const permissions = new Map(
    [...application.permissions, ...modules.flatMap((module) => module.permissions)].map(
      (permission) => [permission.key, permission],
    ),
  );
  const roleSizes = application.roles.map((role) => {
    let size = 512 + bytes(role.name) + bytes(role.key);
    for (const key of role.permissionKeys) {
      const permission = permissions.get(key);
      if (permission === undefined) throw new Error(`Role permission is unresolved: ${key}`);
      if (
        role.permissionSelection.kind === "application_wildcard" &&
        (!application.permissions.includes(permission) ||
          permission.administrative ||
          permission.actionKind === "export")
      )
        continue;
      size += reviewJsonbBytes({ key, label: permission.label }) + bytes(permission.label) + 16;
      size +=
        384 *
        ((permission.fieldPolicy?.readableFieldIds.length ?? 0) +
          (permission.fieldPolicy?.changeableFieldIds.length ?? 0));
    }
    return size;
  });
  return {
    releaseBytes: roleSizes.reduce((total, size) => total + size, 0),
    acceptedHistoryBytes: maximumApplicationRoles * Math.max(0, ...roleSizes),
  };
};
