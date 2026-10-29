import { modulePlatformPermissionDeclarationSchema } from "@vortex/platform/schema";

/** Platform permissions protected by Organisation Administration's system records and operations. */
export const organisationAdministrationPlatformPermissions = [
  {
    pinnedPermissionId: "687d5649-62ee-43dd-b684-b8af3a5394c1",
    key: "platform.organization.permissions.read",
    label: "View available permissions",
    description:
      "View the selected organisation's registered permission catalogue without receiving use or assignment authority.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "ca5f56d4-5382-4bf8-9a91-fbfdc77642b2",
    key: "platform.organization.roles.read",
    label: "View roles",
    description:
      "View the selected organisation's live roles and registered application role templates.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "87c96495-c806-4692-9bc2-250ddb10613c",
    key: "platform.organization.roles.manage",
    label: "Manage roles",
    description: "Create, change or retire roles only within the actor's explicit delegated scope.",
    actionKind: "manage",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "290ae49f-4cab-4159-9c20-6e664f07d50b",
    key: "platform.organization.groups.read",
    label: "View groups",
    description: "View the selected organisation's Groups and membership administration data.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "6185dc64-464b-4776-97dc-c64a6f299550",
    key: "platform.organization.groups.manage",
    label: "Manage groups",
    description:
      "Manage Groups and memberships subject to delegated scope and permanent-steward safeguards.",
    actionKind: "manage",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "9901c0dc-8bac-45c7-be0b-3642cb839bb1",
    key: "platform.organization.assignments.read",
    label: "View access assignments",
    description:
      "View the selected organisation's role and delegation assignments and their effective scope.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "156d01f3-8f80-45fb-8fc8-b31c47dbb1df",
    key: "platform.organization.assignments.manage",
    label: "Manage access assignments",
    description:
      "Grant, change or revoke use and delegation assignments only within the actor's explicit delegated scope.",
    actionKind: "manage",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "02c772e5-2921-4300-ad90-4f5772a7fa46",
    key: "platform.organization.accounts.read",
    label: "View organisation accounts",
    description: "View the selected organisation's safe account-administration information.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "630a980c-0ff5-40b1-a329-7326a2122395",
    key: "platform.organization.accounts.manage",
    label: "Manage organisation accounts",
    description:
      "Change organisation-account lifecycle through the protected operation without changing global identity or removing the final permanent steward.",
    actionKind: "manage",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "9300e501-6d56-41b1-b203-3361dbace9bc",
    key: "platform.organization.invitations.read",
    label: "View invitations",
    description:
      "View safe invitation administration metadata without the raw invitation secret or its stored fingerprint.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "c2e03f58-debe-478e-b1e0-a4a8b8f1b9cb",
    key: "platform.organization.invitations.manage",
    label: "Manage invitations",
    description:
      "Create or revoke invitations through the protected operation; role assignment additionally requires the actor's assignment authority.",
    actionKind: "manage",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "6dffcb0b-ded8-4cd5-acc8-c50f7d4269a5",
    key: "platform.organization.runtime_settings.read",
    label: "View organisation display settings",
    description:
      "View the organisation's default language, time zone, currency, date and number display settings.",
    actionKind: "read",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "c658c254-2884-414a-9012-512c0cfe4b34",
    key: "platform.organization.runtime_settings.manage",
    label: "Manage organisation display settings",
    description:
      "Change the organisation's validated default display settings through the protected revision-checked operation.",
    actionKind: "manage",
    administrative: true,
    stewardMinimum: true,
  },
  {
    pinnedPermissionId: "7ecd3304-f16c-47d4-94db-0964980091ba",
    key: "platform.organization.applications.manage",
    label: "Manage applications",
    description:
      "Install, upgrade or detach exact application bindings in the selected organisation without receiving business-record use or role-assignment authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "ca1fb1ae-056c-4596-9c70-36a42c0de87b",
    key: "platform.records.views.share",
    label: "Share table views",
    description: "Share saved table views and change views shared with you in the organisation.",
    actionKind: "manage",
    administrative: true,
  },
].map((declaration) => modulePlatformPermissionDeclarationSchema.parse(declaration));
