import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
} from "../definition/application-composition-catalogue";
import { applicationShellSchema } from "../definition/application-composition/page-composition";
import { pageDefinitionSchema } from "../definition/application-contracts";
import { organizationLauncherShell } from "./organization-launcher-page";

const visible = {
  visible: true,
  width: { kind: "fill" as const },
  height: { kind: "content" as const },
};
const responsive = { desktop: visible, tablet: visible, phone: visible };
const emptySlot = () => ({
  placements: {},
  order: { desktop: [], tablet: [], phone: [] },
});

const launcherContentSlot = organizationLauncherShell.contentSlots[0];
if (launcherContentSlot === undefined)
  throw new Error("Platform organisation launcher shell has no content slot");

const headingId = "909f1d05-5596-47ec-b478-40c3dce43fae";
const detailId = "d050acf3-d3a2-4279-855d-6fcc90f7b355";

/**
 * The platform-owned shell shown before an organisation is chosen. It reuses the launcher shell's
 * layout; its name is the product wordmark shown in the top bar's breadcrumbs.
 */
export const organizationChooserShell = applicationShellSchema.parse({
  ...organizationLauncherShell,
  shellId: "87ca0909-4d6e-4155-bb26-df34d5dc7cd1",
  key: "organization_chooser_shell",
  name: "Vortex",
  presentation: {
    sidebar: { collapsible: "none", defaultCollapsed: false },
    topBar: {
      breadcrumbs: true,
      organizationSwitcher: false,
      applicationSwitcher: false,
      accountMenu: true,
    },
  },
});

export const organizationChooserPlacementId = "a9e6994c-ddd1-4398-8997-ccba4df76f43";

const headingPlacement = (placementId: string, text: string, level: "one" | "two") => ({
  [placementId]: {
    block: {
      blockId: HEADING_BLOCK_RELEASE.blockId,
      releaseVersion: HEADING_BLOCK_RELEASE.releaseVersion,
    },
    settings: {
      text: { kind: "text", value: text },
      level: { kind: "choice", value: level },
    },
    themeOverrides: {},
    responsive,
    slots: {},
  },
});

const chooserPage = (
  pageId: string,
  key: string,
  name: string,
  placements: Record<string, unknown>,
  order: readonly string[],
) =>
  pageDefinitionSchema.parse({
    type: "dashboard",
    pageId,
    key,
    name,
    // Shown to any signed-in person; which organisations appear is decided by the membership read.
    accessPermissionKey: "platform.organization.launcher.open",
    composition: {
      shellKind: "application",
      shellId: organizationChooserShell.shellId,
      content: {
        [launcherContentSlot.slotId]: {
          placements,
          order: { desktop: order, tablet: order, phone: order },
        },
      },
    },
  });

/** The chooser for a person with several organisations: one launcher tile per organisation. */
export const organizationChooserPage = chooserPage(
  "52cdff89-5ecd-45ff-9691-c4e2bf050a67",
  "organization_chooser",
  "Organisations",
  {
    ...headingPlacement(headingId, "Choose an organisation", "one"),
    ...headingPlacement(detailId, "Select an organisation to open its applications and workspace.", "two"),
    [organizationChooserPlacementId]: {
      block: {
        blockId: APPLICATION_LAUNCHER_BLOCK_RELEASE.blockId,
        releaseVersion: APPLICATION_LAUNCHER_BLOCK_RELEASE.releaseVersion,
      },
      settings: {
        title: { kind: "text", value: "Available organisations" },
        name_key: { kind: "text", value: "name" },
        icon_key: { kind: "text", value: "icon" },
      },
      themeOverrides: {},
      responsive,
      slots: { side_panel: emptySlot() },
    },
  },
  [headingId, detailId, organizationChooserPlacementId],
);

/** Shown instead of the chooser when the person has no active organisation account. */
export const organizationChooserEmptyPage = chooserPage(
  "a2449c68-63a6-47fe-81ac-21b4231520f8",
  "organization_chooser_empty",
  "Organisations",
  {
    ...headingPlacement(headingId, "No organisations available", "one"),
    ...headingPlacement(
      detailId,
      "You are signed in, but you do not currently have an active organisation account.",
      "two",
    ),
  },
  [headingId, detailId],
);
