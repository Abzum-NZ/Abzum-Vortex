import {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  CONTAINER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
} from "../definition/application-composition-catalogue";
import { applicationShellSchema } from "../definition/application-composition/page-composition";
import type { PlatformBlockRelease } from "../definition/application-composition/platform-block-release";
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
const sameOrder = (ids: readonly string[]) => ({ tablet: [...ids], phone: [...ids] });

/** One platform-owned compiled item: settings, empty child slots and the full Vortex metadata. */
export const platformPageItem = (
  release: PlatformBlockRelease,
  id: string,
  settings: Record<string, unknown>,
  emptySlots: readonly string[] = [],
) => ({
  type: release.rendererKey,
  props: {
    id,
    ...settings,
    ...Object.fromEntries(emptySlots.map((key) => [key, []])),
    vortex: {
      block: { blockId: release.blockId, releaseVersion: release.releaseVersion },
      responsive,
      slotOrders: Object.fromEntries(emptySlots.map((key) => [key, sameOrder([])])),
    },
  },
});

/** Compiled page data in an application shell whose one content slot holds `items`. */
export const platformShellPageData = (
  shellId: string,
  contentSlotId: string,
  items: readonly ReturnType<typeof platformPageItem>[],
) => ({
  root: {
    props: {
      vortex: {
        shellId,
        slotOrders: { [contentSlotId]: sameOrder(items.map((item) => item.props.id)) },
      },
      [contentSlotId]: items,
    },
  },
  content: [],
});

const launcherContainerId = "5163e6b1-3034-44d6-9f5b-a5e7e461c001";

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
      appearanceToggle: true,
    },
  },
  layout: {
    root: { props: { vortex: { slotOrders: { content: sameOrder([launcherContainerId]) } } } },
    content: [
      platformPageItem(
        CONTAINER_BLOCK_RELEASE,
        launcherContainerId,
        {
          direction: "column",
          gap: "medium",
          menu_width: 16,
          menu_placement: "flow",
          tablet_direction: "inherit",
          tablet_menu_width: 14,
          tablet_menu_placement: "inherit",
          phone_direction: "inherit",
          phone_menu_width: 14,
          phone_menu_placement: "inherit",
          content_landmark: true,
          padding: "medium",
          content_width: "fill",
        },
        ["content"],
      ),
    ],
  },
  contentSlots: [
    {
      slotId: launcherContentSlotId,
      key: "content",
      label: "Content",
      required: true,
      allowedChildCategories: ["layout", "content"],
      parentPlacementId: launcherContainerId,
      parentSlotKey: "content",
    },
  ],
});

export const organizationLauncherPlacementId = "8f31d589-1897-4d31-b27c-e79ebda3f001";
export const organizationLauncherStudioPlacementId = "ec7f435c-e468-4690-b3e3-a74ee077f001";

const launcherItems = [
  platformPageItem(HEADING_BLOCK_RELEASE, "f0299e44-84f3-4ab1-a822-90b28584f001", {
    text: "Choose an application you can open",
    level: "one",
  }),
  platformPageItem(
    APPLICATION_LAUNCHER_BLOCK_RELEASE,
    organizationLauncherPlacementId,
    { title: "Available applications" },
    ["side_panel"],
  ),
];

const launcherPage = (items: readonly ReturnType<typeof platformPageItem>[]) =>
  pageDefinitionSchema.parse({
    type: "dashboard",
    pageId: "49837db7-4c96-427b-9908-844cbf130001",
    key: "organization_launcher",
    name: "Applications",
    accessPermissionKey: "platform.organization.launcher.open",
    composition: platformShellPageData(
      organizationLauncherShell.shellId,
      launcherContentSlotId,
      items,
    ),
  });

export const organizationLauncherPage = launcherPage(launcherItems);

/** The Studio tile is part of the page definition only for an authorized creator. */
export const organizationLauncherStudioPage = launcherPage([
  ...launcherItems,
  platformPageItem(
    LINK_TILES_BLOCK_RELEASE,
    organizationLauncherStudioPlacementId,
    {
      title: "Studio",
      label_key: "label",
      address_key: "address",
      description_key: "description",
    },
    ["actions"],
  ),
]);
