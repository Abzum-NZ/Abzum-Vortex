import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE_1_3_0,
  HEADING_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
} from "../definition/application-composition-catalogue";
import { applicationShellSchema } from "../definition/application-composition/page-composition";
import { pageDefinitionSchema } from "../definition/application-contracts";
import { containedComponentIdSchema } from "../catalogue/identifiers";

const launcherContentSlotId = containedComponentIdSchema.parse(
  "e2ad4e2a-f499-40dc-9522-51ee34eaf001",
);

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

/** The platform-owned organisation launcher uses the same page and shell contracts as an app. */
export const organizationLauncherShell = applicationShellSchema.parse({
  shellId: "5e9e1e29-cbc4-4c4a-ac30-47a955c9f201",
  key: "organization_launcher_shell",
  name: "Applications",
  presentation: {
    sidebar: { collapsible: "none", defaultCollapsed: false },
    topBar: {
      breadcrumbs: false,
      organizationSwitcher: true,
      applicationSwitcher: false,
      accountMenu: true,
    },
  },
  layout: {
    placements: {
      "5163e6b1-3034-44d6-9f5b-a5e7e461c001": {
        block: {
          blockId: CONTAINER_BLOCK_RELEASE_1_3_0.blockId,
          releaseVersion: CONTAINER_BLOCK_RELEASE_1_3_0.releaseVersion,
        },
        settings: {
          direction: { kind: "choice", value: "column" },
          gap: { kind: "choice", value: "medium" },
          menu_width: { kind: "number", value: 16 },
          menu_placement: { kind: "choice", value: "flow" },
          tablet_direction: { kind: "choice", value: "inherit" },
          tablet_menu_width: { kind: "number", value: 14 },
          tablet_menu_placement: { kind: "choice", value: "inherit" },
          phone_direction: { kind: "choice", value: "inherit" },
          phone_menu_width: { kind: "number", value: 14 },
          phone_menu_placement: { kind: "choice", value: "inherit" },
          content_landmark: { kind: "boolean", value: true },
          padding: { kind: "choice", value: "medium" },
          content_width: { kind: "choice", value: "fill" },
        },
        themeOverrides: {},
        responsive,
        slots: { content: emptySlot() },
      },
    },
    order: {
      desktop: ["5163e6b1-3034-44d6-9f5b-a5e7e461c001"],
      tablet: ["5163e6b1-3034-44d6-9f5b-a5e7e461c001"],
      phone: ["5163e6b1-3034-44d6-9f5b-a5e7e461c001"],
    },
  },
  contentSlots: [
    {
      slotId: launcherContentSlotId,
      key: "content",
      label: "Content",
      required: true,
      allowedChildCategories: ["layout", "content"],
      parentPlacementId: "5163e6b1-3034-44d6-9f5b-a5e7e461c001",
      parentSlotKey: "content",
    },
  ],
});

export const organizationLauncherPlacementId = "8f31d589-1897-4d31-b27c-e79ebda3f001";
export const organizationLauncherStudioPlacementId = "ec7f435c-e468-4690-b3e3-a74ee077f001";

export const organizationLauncherPage = pageDefinitionSchema.parse({
  type: "dashboard",
  pageId: "49837db7-4c96-427b-9908-844cbf130001",
  key: "organization_launcher",
  name: "Applications",
  accessPermissionKey: "platform.organization.launcher.open",
  composition: {
    shellKind: "application",
    shellId: organizationLauncherShell.shellId,
    content: {
      [launcherContentSlotId]: {
        placements: {
          "f0299e44-84f3-4ab1-a822-90b28584f001": {
            block: {
              blockId: HEADING_BLOCK_RELEASE.blockId,
              releaseVersion: HEADING_BLOCK_RELEASE.releaseVersion,
            },
            settings: {
              text: { kind: "text", value: "Choose an application you can open" },
              level: { kind: "choice", value: "one" },
            },
            themeOverrides: {},
            responsive,
            slots: {},
          },
          [organizationLauncherPlacementId]: {
            block: {
              blockId: APPLICATION_LAUNCHER_BLOCK_RELEASE.blockId,
              releaseVersion: APPLICATION_LAUNCHER_BLOCK_RELEASE.releaseVersion,
            },
            settings: { title: { kind: "text", value: "Available applications" } },
            themeOverrides: {},
            responsive,
            slots: { side_panel: emptySlot() },
          },
        },
        order: {
          desktop: ["f0299e44-84f3-4ab1-a822-90b28584f001", organizationLauncherPlacementId],
          tablet: ["f0299e44-84f3-4ab1-a822-90b28584f001", organizationLauncherPlacementId],
          phone: ["f0299e44-84f3-4ab1-a822-90b28584f001", organizationLauncherPlacementId],
        },
      },
    },
  },
});

const launcherComposition = organizationLauncherPage.composition;
if (launcherComposition.shellKind !== "application" || !("content" in launcherComposition))
  throw new Error("Invalid platform organisation launcher composition");
const launcherContent = launcherComposition.content[launcherContentSlotId];
if (launcherContent === undefined)
  throw new Error("Missing platform organisation launcher content slot");

/** The Studio tile is part of the page definition only for an authorized creator. */
export const organizationLauncherStudioPage = pageDefinitionSchema.parse({
  ...organizationLauncherPage,
  composition: {
    ...launcherComposition,
    content: {
      ...launcherComposition.content,
      [launcherContentSlotId]: {
        ...launcherContent,
        placements: {
          ...launcherContent.placements,
          [organizationLauncherStudioPlacementId]: {
            block: {
              blockId: LINK_TILES_BLOCK_RELEASE.blockId,
              releaseVersion: LINK_TILES_BLOCK_RELEASE.releaseVersion,
            },
            settings: {
              title: { kind: "text", value: "Studio" },
              label_key: { kind: "text", value: "label" },
              address_key: { kind: "text", value: "address" },
              description_key: { kind: "text", value: "description" },
            },
            themeOverrides: {},
            responsive,
            slots: { actions: emptySlot() },
          },
        },
        order: {
          desktop: [...launcherContent.order.desktop, organizationLauncherStudioPlacementId],
          tablet: [...launcherContent.order.tablet, organizationLauncherStudioPlacementId],
          phone: [...launcherContent.order.phone, organizationLauncherStudioPlacementId],
        },
      },
    },
  },
});
