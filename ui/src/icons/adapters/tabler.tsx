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
} from "@tabler/icons-react";

import type { VortexIconAdapter } from "../icon-names";

/** The semantic icon set drawn with Tabler Icons, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": IconArrowDown,
  "arrow-up": IconArrowUp,
  calendar: IconCalendar,
  check: IconCheck,
  "chevron-down": IconChevronDown,
  "chevron-left": IconChevronLeft,
  "chevron-right": IconChevronRight,
  "chevron-up": IconChevronUp,
  circle: IconCircle,
  close: IconX,
  loader: IconLoader2,
  menu: IconMenu2,
  minus: IconMinus,
  "more-horizontal": IconDots,
  "more-vertical": IconDotsVertical,
  "panel-left": IconLayoutSidebar,
  plus: IconPlus,
  search: IconSearch,
};
