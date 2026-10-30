import {
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  defaultOpenFlowSource,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import authoredSource from "./application.json";
import { loadApplicationSource } from "../application-source-loader";
import { landingZoneModules } from "./module";

/** The Landing Zone application composes the shared launcher, link-tile and filter blocks. */
export const landingZoneApplication: ApplicationSourceDocument = loadApplicationSource(
  authoredSource,
  DEFAULT_SOURCE_APPLICATION_THEME_SELECTION,
  landingZoneModules,
  [
    {
      ...defaultOpenFlowSource({
        id: "landing_zone_open_favourite_status",
        key: "landing_zone_open_favourite_status",
        description: "Opens the protected Favourite status form for one returned tile record.",
        page: "page_landing_favourite_status",
        recordType: "vortex.landing_zone:tile",
      }),
      labels: { name: "Edit favourite" },
    },
    {
      ...defaultOpenFlowSource({
        id: "landing_zone_open_remove_tile",
        key: "landing_zone_open_remove_tile",
        description: "Opens the protected removal form for one returned private tile record.",
        page: "page_landing_remove_tile",
        recordType: "vortex.landing_zone:tile",
      }),
      labels: { name: "Remove tile" },
    },
  ],
);
