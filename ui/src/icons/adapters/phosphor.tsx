import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckIcon,
  CircleIcon,
  DotsThreeIcon,
  DotsThreeVerticalIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  SidebarIcon,
  SpinnerIcon,
  XIcon,
} from "@phosphor-icons/react";

import type { VortexIconAdapter } from "../icon-names";

/** The semantic icon set drawn with Phosphor Icons, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": ArrowDownIcon,
  "arrow-up": ArrowUpIcon,
  calendar: CalendarBlankIcon,
  check: CheckIcon,
  "chevron-down": CaretDownIcon,
  "chevron-left": CaretLeftIcon,
  "chevron-right": CaretRightIcon,
  "chevron-up": CaretUpIcon,
  circle: CircleIcon,
  close: XIcon,
  loader: SpinnerIcon,
  menu: ListIcon,
  minus: MinusIcon,
  "more-horizontal": DotsThreeIcon,
  "more-vertical": DotsThreeVerticalIcon,
  "panel-left": SidebarIcon,
  plus: PlusIcon,
  search: MagnifyingGlassIcon,
};
