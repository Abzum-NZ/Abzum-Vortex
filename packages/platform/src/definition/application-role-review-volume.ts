import type { ApplicationContent } from "./application-contracts";
import type { ModuleContent } from "./module-contracts";
import type { JsonValue } from "../catalogue/common";

/**
 * A continuation holds 2 MiB. Reserve 256 KiB for the flow, release identities, bindings and
 * release note, leaving 896 KiB for each side of an upgrade. Installation also retains the role
 * snapshot, so the allowance charges both its permission objects and their displayed labels.
 */
export const maximumApplicationRoleReviewBytes = 896 * 1024;
export const maximumInstallationReviewBytes = 2 * maximumApplicationRoleReviewBytes;
export const applicationRoleReviewVolumeMessage =
  "This application's roles contain too much permission detail for one installation review. Use fewer roles, permissions or field-level grants before publishing.";

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
 * releases. Charging both versions covers removed permissions/fields as well as added ones.
 */
export const applicationRoleReviewBytes = (
  application: ApplicationContent,
  modules: readonly ModuleContent[],
): number => {
  const permissions = new Map(
    [...application.permissions, ...modules.flatMap((module) => module.permissions)].map(
      (permission) => [permission.key, permission],
    ),
  );
  return application.roles.reduce((total, role) => {
    let size = total + 512 + bytes(role.name) + bytes(role.key);
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
  }, 0);
};
