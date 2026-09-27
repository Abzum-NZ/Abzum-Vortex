import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleIcon,
  Loader2Icon,
  MenuIcon,
  MinusIcon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";

import type { VortexIconAdapter } from "../icon-names";

/** The semantic icon set drawn with Lucide, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": ArrowDownIcon,
  "arrow-up": ArrowUpIcon,
  calendar: CalendarIcon,
  check: CheckIcon,
  "chevron-down": ChevronDownIcon,
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-up": ChevronUpIcon,
  circle: CircleIcon,
  close: XIcon,
  loader: Loader2Icon,
  menu: MenuIcon,
  minus: MinusIcon,
  "more-horizontal": MoreHorizontalIcon,
  "more-vertical": MoreVerticalIcon,
  "panel-left": PanelLeftIcon,
  plus: PlusIcon,
  search: SearchIcon,
};
