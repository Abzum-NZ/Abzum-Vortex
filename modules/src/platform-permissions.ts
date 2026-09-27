import {
  modulePlatformPermissionDeclarationSchema,
  permissionDeclarationSchema,
  platformIdSchema,
  type ModulePlatformPermissionDeclaration,
  type PermissionDeclaration,
} from "@vortex/contracts";
import { organisationAdministrationPlatformPermissions } from "./organisation-administration/module";
import { systemCorePlatformPermissions } from "./system-core/platform-permissions";

export const platformPermissionOwnerId = platformIdSchema.parse(
  "cabe121e-0baf-4084-9471-cce915d460a8",
);

export type PlatformPermissionDeclaration = PermissionDeclaration &
  Pick<ModulePlatformPermissionDeclaration, "meaningFingerprint" | "stewardMinimum">;

const sourceDeclarations: readonly ModulePlatformPermissionDeclaration[] = [
  ...organisationAdministrationPlatformPermissions,
  ...systemCorePlatformPermissions,
];

export const platformPermissionDeclarations: readonly PlatformPermissionDeclaration[] =
  Object.freeze(
    sourceDeclarations.map((sourceDeclaration) => {
      const declaration = modulePlatformPermissionDeclarationSchema.parse(sourceDeclaration);
      if (declaration.pinnedPermissionId === undefined)
        throw new TypeError("Platform permission declarations require a pinned permission id");
      const { pinnedPermissionId, meaningFingerprint, stewardMinimum, ...permissionFields } =
        declaration;
      const permission = permissionDeclarationSchema.parse({
        ...permissionFields,
        permissionId: pinnedPermissionId,
      });
      return Object.freeze({
        ...permission,
        ...(meaningFingerprint === undefined ? {} : { meaningFingerprint }),
        ...(stewardMinimum === undefined ? {} : { stewardMinimum }),
      });
    }),
  );

const platformPermissionIndex: ReadonlyMap<string, PlatformPermissionDeclaration> = new Map(
  platformPermissionDeclarations.map((permission) => [permission.key, permission] as const),
);

export const platformPermissionFor = (key: string): PlatformPermissionDeclaration | undefined =>
  platformPermissionIndex.get(key);

export const isPlatformPermissionKey = (key: string): boolean =>
  platformPermissionIndex.has(key);
