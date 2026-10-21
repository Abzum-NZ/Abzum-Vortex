import { maximumApplicationRoles, type ApplicationContent } from "./application-contracts";
import type { ModuleContent } from "./module-contracts";
import type { JsonValue } from "../catalogue/common";

/** A complete review reserves one bounded release and independently retained historical roles. */
export const maximumApplicationRoleReviewBytes = 896 * 1024;
// Every one of the 500 roles may retain a different previously published permission set.
export const maximumAcceptedRoleHistoryBytes =
  96 * 1024 * 1024 - 256 * 1024 - maximumApplicationRoleReviewBytes;
const fieldGrantBytes = 384;

export type ApplicationRoleReviewRole = Readonly<{
  name: string;
  permissionCount: number;
  fieldGrants: number;
  bytes: number;
}>;

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
 * releases. The review names a field once per record type, sign and edit suffix however many of
 * the role's permissions list it, so a role pays for the distinct fields it can read and the
 * distinct fields it can change on each record type; a permission whose record type is not
 * declared in the given modules pays for each listed field. The largest role is charged 500
 * times because independently accepted roles can retain permission sets from 500 different
 * releases.
 */
export const applicationRoleReviewBytes = (
  application: ApplicationContent,
  modules: readonly ModuleContent[],
): Readonly<{
  releaseBytes: number;
  acceptedHistoryBytes: number;
  roles: ApplicationRoleReviewRole[];
}> => {
  const permissions = new Map(
    [...application.permissions, ...modules.flatMap((module) => module.permissions)].map(
      (permission) => [permission.key, permission],
    ),
  );
  const declaredRecordTypes = new Set(
    modules.flatMap((module) =>
      module.recordTypes.map((recordType) => String(recordType.recordTypeId).toLowerCase()),
    ),
  );
  const roles = application.roles.map((role): ApplicationRoleReviewRole => {
    let size = 512 + bytes(role.name) + bytes(role.key);
    let permissionCount = 0;
    // Distinct field ids per record type (or per permission when its record type is unknown).
    const readable = new Map<string, Set<string>>();
    const changeable = new Map<string, Set<string>>();
    const add = (into: Map<string, Set<string>>, subject: string, ids: readonly unknown[]) => {
      const fields = into.get(subject) ?? new Set<string>();
      for (const id of ids) fields.add(String(id).toLowerCase());
      into.set(subject, fields);
    };
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
      permissionCount += 1;
      const policy = permission.fieldPolicy;
      if (policy !== undefined) {
        const recordTypeId = String(permission.recordTypeId).toLowerCase();
        const subject = declaredRecordTypes.has(recordTypeId)
          ? `record:${recordTypeId}`
          : `permission:${key}`;
        add(readable, subject, policy.readableFieldIds);
        add(changeable, subject, policy.changeableFieldIds);
      }
    }
    let fieldGrants = 0;
    for (const fields of [...readable.values(), ...changeable.values()]) fieldGrants += fields.size;
    return {
      name: role.name,
      permissionCount,
      fieldGrants,
      bytes: size + fieldGrantBytes * fieldGrants,
    };
  });
  const roleSizes = roles.map((role) => role.bytes);
  return {
    releaseBytes: roleSizes.reduce((total, size) => total + size, 0),
    acceptedHistoryBytes: maximumApplicationRoles * Math.max(0, ...roleSizes),
    roles,
  };
};

/**
 * The refusal sentence of a review over its budget, naming the largest role with its permissions,
 * its field grants and the most field grants it could hold; undefined when the review fits.
 */
export const applicationRoleReviewRefusal = (
  review: ReturnType<typeof applicationRoleReviewBytes>,
): string | undefined => {
  if (
    review.releaseBytes <= maximumApplicationRoleReviewBytes &&
    review.acceptedHistoryBytes <= maximumAcceptedRoleHistoryBytes
  )
    return undefined;
  const largest = review.roles.reduce((best, role) => (role.bytes > best.bytes ? role : best));
  const budget = Math.min(
    maximumApplicationRoleReviewBytes - (review.releaseBytes - largest.bytes),
    Math.floor(maximumAcceptedRoleHistoryBytes / maximumApplicationRoles),
  );
  const limit = Math.max(
    0,
    Math.floor(
      (budget - (largest.bytes - fieldGrantBytes * largest.fieldGrants)) / fieldGrantBytes,
    ),
  );
  return `The role ${largest.name} holds ${largest.permissionCount} permissions with ${largest.fieldGrants} field grants; one role can hold at most ${limit} field grants for an installation review. Give it fewer permissions or field-level grants, or split it into two roles.`;
};
