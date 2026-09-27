import {
  modulePlatformPermissionDeclarationSchema,
  type ModulePlatformPermissionDeclaration,
} from "@vortex/contracts";

/** Platform permissions without a corresponding Organisation Administration system record type. */
export const systemCorePlatformPermissions: readonly ModulePlatformPermissionDeclaration[] = [
  {
    pinnedPermissionId: "ec2908a1-f3cd-4c4a-8bf7-91bffbf4cb3d",
    key: "platform.organization.connections.manage",
    label: "Manage connections",
    description:
      "Register, grant, check, revoke and reauthorise connection instances in the selected organisation without application-installation or access-assignment authority.",
    actionKind: "manage",
    administrative: true,
    meaningFingerprint: "sha256:809b4b3ad29ff61ab5ea73c06504909540b8111a2b3c2e1310559a7e9dc2e31e",
  },
  {
    pinnedPermissionId: "e85c2232-2ed7-4ce8-b1e5-7e2ad8e2b847",
    key: "platform.security.identities.disable",
    label: "Disable identities",
    description:
      "Disable an identity and revoke its active sessions through the identity owner's protected operation without receiving general identity-administration or business-record authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "014d2898-1969-4434-805c-eeb0f0e6f797",
    key: "platform.support.access.request",
    label: "Request support access",
    description:
      "Request time-bounded support access to another organisation for a named operator and exact scope without receiving standing access to that organisation.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "07e4653c-d358-489f-8067-46e085d99478",
    key: "platform.organization.support.approve",
    label: "Approve support access",
    description:
      "Approve or refuse a time-bounded support-access request for one's own organisation without granting the requester standing authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "0548c061-b1a9-48e5-a04a-eb1d0dae0644",
    key: "platform.organization.definition_drafts.manage",
    label: "Manage definition drafts",
    description:
      "Create and change module and application drafts, including flows, placements and role templates, without publication or installation authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "dfdd5aba-2b85-4169-b570-92be284e7b5c",
    key: "platform.organization.definition_releases.manage",
    label: "Manage definition releases",
    description:
      "Publish module and application drafts as immutable releases without receiving installation or business-record authority.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "d1be247f-094d-47c1-a38d-762290868c91",
    key: "platform.organization.custom_code.manage",
    label: "Manage custom code",
    description:
      "Required in addition to the application-management permission to install, upgrade or uninstall packages that bundle custom components or scripts.",
    actionKind: "manage",
    administrative: true,
  },
  {
    pinnedPermissionId: "eaade6fd-7390-44d2-a7ef-343324c7384a",
    key: "platform.organization.system_applications.manage",
    label: "Manage system applications",
    description:
      "Change system application definitions, including extension fields, theme, navigation and dependent applications, without uninstallation authority.",
    actionKind: "manage",
    administrative: true,
  },
].map((declaration) => modulePlatformPermissionDeclarationSchema.parse(declaration));
