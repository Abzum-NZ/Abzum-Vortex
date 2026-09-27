import {
  IconArrowDown,
  IconArrowUp,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconDots,
  IconDotsVertical,
  IconLayoutSidebar,
  IconLoader2,
  IconMenu2,
  IconMinus,
  IconPlus,
  IconSearch,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

import type { VortexIconAdapter, VortexIconProps } from "../icon-names";

const tablerIcon = (Glyph: TablerIcon): ComponentType<VortexIconProps> => {
  function TablerGlyph({ stroke, ...props }: VortexIconProps) {
    return <Glyph {...props} {...(stroke === undefined ? {} : { stroke })} />;
  }
  return TablerGlyph;
};

/** The semantic icon set drawn with Tabler Icons, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": tablerIcon(IconArrowDown),
  "arrow-up": tablerIcon(IconArrowUp),
  calendar: tablerIcon(IconCalendar),
  check: tablerIcon(IconCheck),
  "chevron-down": tablerIcon(IconChevronDown),
  "chevron-left": tablerIcon(IconChevronLeft),
  "chevron-right": tablerIcon(IconChevronRight),
  "chevron-up": tablerIcon(IconChevronUp),
  circle: tablerIcon(IconCircle),
  close: tablerIcon(IconX),
  loader: tablerIcon(IconLoader2),
  menu: tablerIcon(IconMenu2),
  minus: tablerIcon(IconMinus),
  "more-horizontal": tablerIcon(IconDots),
  "more-vertical": tablerIcon(IconDotsVertical),
  "panel-left": tablerIcon(IconLayoutSidebar),
  plus: tablerIcon(IconPlus),
  search: tablerIcon(IconSearch),
};
