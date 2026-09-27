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
  type RemixiconComponentType,
} from "@remixicon/react";
import type { ComponentType } from "react";

import type { VortexIconAdapter, VortexIconProps } from "../icon-names";

const remixIcon = (Glyph: RemixiconComponentType): ComponentType<VortexIconProps> => {
  function RemixGlyph({ color, ...props }: VortexIconProps) {
    return <Glyph {...props} {...(color === undefined ? {} : { color })} />;
  }
  return RemixGlyph;
};

/** The semantic icon set drawn with Remix Icon, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": remixIcon(RiArrowDownLine),
  "arrow-up": remixIcon(RiArrowUpLine),
  calendar: remixIcon(RiCalendarLine),
  check: remixIcon(RiCheckLine),
  "chevron-down": remixIcon(RiArrowDownSLine),
  "chevron-left": remixIcon(RiArrowLeftSLine),
  "chevron-right": remixIcon(RiArrowRightSLine),
  "chevron-up": remixIcon(RiArrowUpSLine),
  circle: remixIcon(RiCircleLine),
  close: remixIcon(RiCloseLine),
  loader: remixIcon(RiLoader4Line),
  menu: remixIcon(RiMenuLine),
  minus: remixIcon(RiSubtractLine),
  "more-horizontal": remixIcon(RiMoreLine),
  "more-vertical": remixIcon(RiMore2Line),
  "panel-left": remixIcon(RiSideBarLine),
  plus: remixIcon(RiAddLine),
  search: remixIcon(RiSearchLine),
};
