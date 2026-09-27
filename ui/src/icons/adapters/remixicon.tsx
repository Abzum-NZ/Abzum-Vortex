import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiArrowUpSLine,
  RiCalendarLine,
  RiCheckLine,
  RiCircleLine,
  RiCloseLine,
  RiLoader4Line,
  RiMenuLine,
  RiMore2Line,
  RiMoreLine,
  RiSearchLine,
  RiSideBarLine,
  RiSubtractLine,
} from "@remixicon/react";

import type { VortexIconAdapter } from "../icon-names";

/** The semantic icon set drawn with Remix Icon, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": RiArrowDownLine,
  "arrow-up": RiArrowUpLine,
  calendar: RiCalendarLine,
  check: RiCheckLine,
  "chevron-down": RiArrowDownSLine,
  "chevron-left": RiArrowLeftSLine,
  "chevron-right": RiArrowRightSLine,
  "chevron-up": RiArrowUpSLine,
  circle: RiCircleLine,
  close: RiCloseLine,
  loader: RiLoader4Line,
  menu: RiMenuLine,
  minus: RiSubtractLine,
  "more-horizontal": RiMoreLine,
  "more-vertical": RiMore2Line,
  "panel-left": RiSideBarLine,
  plus: RiAddLine,
  search: RiSearchLine,
};
