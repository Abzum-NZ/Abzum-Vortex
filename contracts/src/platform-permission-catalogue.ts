import { type PermissionId, type PlatformId } from "./identifiers";
import { type PermissionDeclaration } from "./permissions";

/** A shipped declaration whose permanent identity is still a plain UUID literal before it is branded. */
type ShippedPermission = Omit<PermissionDeclaration, "permissionId"> & {
  readonly permissionId: string;
};

const brandPermission = (permission: ShippedPermission): PermissionDeclaration => ({
  ...permission,
  permissionId: permission.permissionId as PermissionId,
});

/**
 * The immutable shipped platform permission catalogue: the one source of the platform
 * administration permissions a page, navigation item or other requirement may reference by key.
 *
 * This data lives in Contracts, the lowest shared layer, so both Definition (validation and
 * compilation) and Access (runtime decisions) can consume the same keys and identities without
 * either importing the other. Access derives each release's fingerprint from this data. Every key
 * is a permanent internal identifier that never changes between catalogue versions, and no release
 * is ever removed.
 */
export const platformPermissionCatalogueOwnerId =
  "cabe121e-0baf-4084-9471-cce915d460a8" as PlatformId;
export const platformPermissionCatalogueVersionV1 = "1.0.0";
export const platformPermissionCatalogueVersionV1_0_1 = "1.0.1";
export const platformPermissionCatalogueVersion = "1.4.0";

const historicalPermissionsV1: readonly ShippedPermission[] = [
  {
    permissionId: "687d5649-62ee-43dd-b684-b8af3a5394c1",
    key: "platform.organization.permissions.read",
    label: "View available permissions",
    description:
      "View the selected organisation's registered permission catalogue without receiving use or assignment authority.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "ca5f56d4-5382-4bf8-9a91-fbfdc77642b2",
    key: "platform.organization.roles.read",
    label: "View roles",
    description:
      "View the selected organisation's live roles and registered application role templates.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "87c96495-c806-4692-9bc2-250ddb10613c",
    key: "platform.organization.roles.manage",
    label: "Manage roles",
    description: "Create, change or retire roles only within the actor's explicit delegated scope.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "290ae49f-4cab-4159-9c20-6e664f07d50b",
    key: "platform.organization.groups.read",
    label: "View teams",
    description: "View the selected organisation's Teams and membership administration data.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "6185dc64-464b-4776-97dc-c64a6f299550",
    key: "platform.organization.groups.manage",
    label: "Manage teams",
    description:
      "Manage Teams and memberships subject to delegated scope and permanent-steward safeguards.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "9901c0dc-8bac-45c7-be0b-3642cb839bb1",
    key: "platform.organization.assignments.read",
    label: "View access assignments",
    description:
      "View the selected organisation's role and delegation assignments and their effective scope.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "156d01f3-8f80-45fb-8fc8-b31c47dbb1df",
    key: "platform.organization.assignments.manage",
    label: "Manage access assignments",
    description:
      "Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "02c772e5-2921-4300-ad90-4f5772a7fa46",
    key: "platform.organization.accounts.read",
    label: "View organisation accounts",
    description: "View the selected organisation's safe account-administration information.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "630a980c-0ff5-40b1-a329-7326a2122395",
    key: "platform.organization.accounts.manage",
    label: "Manage organisation accounts",
    description:
      "Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "9300e501-6d56-41b1-b203-3361dbace9bc",
    key: "platform.organization.invitations.read",
    label: "View invitations",
    description:
      "View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb",
    key: "platform.organization.invitations.manage",
    label: "Manage invitations",
    description:
      "Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5",
    key: "platform.organization.runtime_settings.read",
    label: "View organisation display settings",
    description:
      "View the organisation's default language, time zone, currency, date and number display settings.",
    actionKind: "read",
    administrative: true,
  },
  {
    permissionId: "c658c254-2884-414a-9012-512c0cfe4b34",
    key: "platform.organization.runtime_settings.manage",
    label: "Manage organisation display settings",
    description:
      "Change the organisation's validated default display settings through the protected revision-checked operation.",
    actionKind: "manage",
    administrative: true,
  },
];

/**
 * Group-facing display metadata. Only labels and descriptions change. A permission's
 * permanent key is part of its authority-bearing meaning fingerprint, so a key never
 * changes between catalogue versions: every version below uses the same Group keys and
 * the same meaning fingerprints, and no organisation can experience a continuity break
 * from this terminology change.
 */
const historicalPermissionsV1_0_1: readonly ShippedPermission[] = historicalPermissionsV1.map(
  (permission) => {
    if (permission.key === "platform.organization.groups.read")
      return {
        ...permission,
        label: "View groups",
        description: "View the selected organisation's Groups and membership administration data.",
      };
    if (permission.key === "platform.organization.groups.manage")
      return {
        ...permission,
        label: "Manage groups",
        description:
          "Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.",
      };
    return permission;
  },
);

const currentPermissions: readonly ShippedPermission[] = [
  ...historicalPermissionsV1_0_1,
  {
    permissionId: "7ecd3304-f16c-47d4-94db-0964980091ba",
    key: "platform.organization.applications.manage",
    label: "Manage applications",
    description:
      "Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d",
    key: "platform.organization.connections.manage",
    label: "Manage connections",
    description:
      "Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847",
    key: "platform.security.identities.disable",
    label: "Disable identities",
    description:
      "Disable an identity and revoke its active sessions through the identity owner's protected operation without receiving general identity-administration or business-record authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "014d2898-1969-4434-805c-eeb0f0e6f797",
    key: "platform.support.access.request",
    label: "Request support access",
    description:
      "Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "07e4653c-d358-489f-8067-46e085d99478",
    key: "platform.organization.support.approve",
    label: "Approve support access",
    description:
      "Approve or refuse a time-bounded support-access request for one's own organisation without granting the requester standing authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "0548c061-b1a9-48e5-a04a-eb1d0dae0644",
    key: "platform.organization.definition_drafts.manage",
    label: "Manage definition drafts",
    description:
      "Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "dfdd5aba-2b85-4169-b570-92be284e7b5c",
    key: "platform.organization.definition_releases.manage",
    label: "Manage definition releases",
    description:
      "Publish module and application drafts as immutable releases without receiving installation or business-record authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "d1be247f-094d-47c1-a38d-762290868c91",
    key: "platform.organization.custom_code.manage",
    label: "Manage custom code",
    description:
      "Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.",
    actionKind: "manage",
    administrative: true,
  },
  {
    permissionId: "eaade6fd-7390-44d2-a7ef-343324c7384a",
    key: "platform.organization.system_applications.manage",
    label: "Manage system applications",
    description:
      "Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.",
    actionKind: "manage",
    administrative: true,
  },
];

/** The immutable `1.0.0` metadata: the initial platform catalogue release. */
export const historicalPlatformPermissionsV1: readonly PermissionDeclaration[] =
  historicalPermissionsV1.map(brandPermission);

/** The immutable `1.0.1` Group-facing metadata revision; identities and meanings are unchanged. */
export const historicalPlatformPermissionsV1_0_1: readonly PermissionDeclaration[] =
  historicalPermissionsV1_0_1.map(brandPermission);

/** The current additive catalogue, mirroring platform registration revision 6 (`1.4.0`). */
export const currentPlatformPermissions: readonly PermissionDeclaration[] =
  currentPermissions.map(brandPermission);

const platformPermissionIndex: ReadonlyMap<string, PermissionDeclaration> = new Map(
  currentPlatformPermissions.map((permission) => [permission.key, permission] as const),
);

/**
 * The exact currently shipped platform permission declaration for a permanent key, or `undefined`
 * when the key is not a platform permission. The current catalogue is additive over every earlier
 * release, so its keys are the full set any application may reference.
 */
export const platformPermissionFor = (key: string): PermissionDeclaration | undefined =>
  platformPermissionIndex.get(key);

/** Whether a key names an exact permission in the currently shipped platform catalogue. */
export const isPlatformPermissionKey = (key: string): boolean => platformPermissionIndex.has(key);
