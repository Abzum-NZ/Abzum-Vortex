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
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";

import type { VortexIconAdapter, VortexIconProps } from "../icon-names";

const phosphorIcon = (Glyph: PhosphorIcon): ComponentType<VortexIconProps> => {
  function PhosphorGlyph({ color, ...props }: VortexIconProps) {
    return <Glyph {...props} {...(color === undefined ? {} : { color })} />;
  }
  return PhosphorGlyph;
};

/** The semantic icon set drawn with Phosphor Icons, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": phosphorIcon(ArrowDownIcon),
  "arrow-up": phosphorIcon(ArrowUpIcon),
  calendar: phosphorIcon(CalendarBlankIcon),
  check: phosphorIcon(CheckIcon),
  "chevron-down": phosphorIcon(CaretDownIcon),
  "chevron-left": phosphorIcon(CaretLeftIcon),
  "chevron-right": phosphorIcon(CaretRightIcon),
  "chevron-up": phosphorIcon(CaretUpIcon),
  circle: phosphorIcon(CircleIcon),
  close: phosphorIcon(XIcon),
  loader: phosphorIcon(SpinnerIcon),
  menu: phosphorIcon(ListIcon),
  minus: phosphorIcon(MinusIcon),
  "more-horizontal": phosphorIcon(DotsThreeIcon),
  "more-vertical": phosphorIcon(DotsThreeVerticalIcon),
  "panel-left": phosphorIcon(SidebarIcon),
  plus: phosphorIcon(PlusIcon),
  search: phosphorIcon(MagnifyingGlassIcon),
};
