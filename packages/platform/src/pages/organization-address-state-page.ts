import {
  BUTTON_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
} from "../definition/application-composition-catalogue";
import { pageDefinitionSchema, type PageDefinition } from "../definition/application-contracts";
import {
  organizationLauncherShell,
  platformPageItem,
  platformShellPageData,
} from "./organization-launcher-page";

const launcherContentSlot = organizationLauncherShell.contentSlots[0];
if (launcherContentSlot === undefined)
  throw new Error("Platform organisation launcher shell has no content slot");

/** The one button of an address state: it leads to the state's way forward. */
export const organizationAddressStateActionPlacementId = "6a0f3c1e-52d4-4b8e-9f27-3c8d41a6e0b1";

/**
 * What an address that shows no page of an application tells the signed-in person, and the one way
 * forward it offers. Each state renders inside the organisation shell, so the header, the
 * organisation switcher and the account menu (with sign out) stay available.
 */
export type OrganizationAddressState = Readonly<{
  key:
    | "unavailable"
    | "page_not_open"
    | "temporarily_unavailable"
    | "suspended"
    | "preview_not_runnable";
  title: string;
  detail: string;
  actionLabel: string;
}>;

const statePageIds: Readonly<Record<OrganizationAddressState["key"], string>> = {
  unavailable: "0d6f2b8a-7c41-4e9a-b3d5-8e2a6c4f1b07",
  page_not_open: "5b9e3d61-a2f7-4c08-9e4b-7f1c2d8a6e35",
  temporarily_unavailable: "e2c84a1f-6d39-4b7e-8a05-3f9d1b6c7e48",
  suspended: "9a7d2e5c-1f48-4b63-b9e0-6c3a8d4f2b19",
  preview_not_runnable: "4f1b8c3e-7a26-4d9f-85e1-2b6d9a3c0f57",
};

/** The platform page of one address state, in the organisation shell. */
export const organizationAddressStatePage = (state: OrganizationAddressState): PageDefinition =>
  pageDefinitionSchema.parse({
    type: "dashboard",
    pageId: statePageIds[state.key],
    key: `address_${state.key}`,
    name: state.title,
    // Shown to any signed-in person; the state itself discloses nothing about the address.
    accessPermissionKey: "platform.organization.launcher.open",
    composition: platformShellPageData(
      organizationLauncherShell.shellId,
      launcherContentSlot.slotId,
      [
        // The page header shows the title; the content explains it under it.
        platformPageItem(HEADING_BLOCK_RELEASE, "c47a1e93-2b6d-4f85-a0e8-5d9b3c7f2a64", {
          text: state.detail,
          level: "two",
        }),
        platformPageItem(BUTTON_BLOCK_RELEASE, organizationAddressStateActionPlacementId, {
          label: state.actionLabel,
          action_kind: "action",
          variant: "secondary",
        }),
      ],
    ),
  });
