import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  Calendar01Icon,
  Cancel01Icon,
  CircleIcon,
  Loading03Icon,
  Menu01Icon,
  MinusSignIcon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  PlusSignIcon,
  Search01Icon,
  SidebarLeftIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentType } from "react";

import type { VortexIconAdapter, VortexIconProps } from "../icon-names";

/**
 * HugeIcons ships each glyph as data drawn by one component. Each semantic icon binds its glyph to
 * that component with the stroke width the shadcn registry uses for HugeIcons.
 */
const hugeicon = (icon: IconSvgElement): ComponentType<VortexIconProps> => {
  function HugeiconsGlyph({ strokeWidth = 2, ...props }: VortexIconProps) {
    return <HugeiconsIcon icon={icon} strokeWidth={strokeWidth as number} {...props} />;
  }
  return HugeiconsGlyph;
};

/** The semantic icon set drawn with HugeIcons, the names the shadcn registry uses for it. */
export const icons: VortexIconAdapter = {
  "arrow-down": hugeicon(ArrowDown02Icon),
  "arrow-up": hugeicon(ArrowUp02Icon),
  calendar: hugeicon(Calendar01Icon),
  check: hugeicon(Tick02Icon),
  "chevron-down": hugeicon(ArrowDown01Icon),
  "chevron-left": hugeicon(ArrowLeft01Icon),
  "chevron-right": hugeicon(ArrowRight01Icon),
  "chevron-up": hugeicon(ArrowUp01Icon),
  circle: hugeicon(CircleIcon),
  close: hugeicon(Cancel01Icon),
  loader: hugeicon(Loading03Icon),
  menu: hugeicon(Menu01Icon),
  minus: hugeicon(MinusSignIcon),
  "more-horizontal": hugeicon(MoreHorizontalIcon),
  "more-vertical": hugeicon(MoreVerticalIcon),
  "panel-left": hugeicon(SidebarLeftIcon),
  plus: hugeicon(PlusSignIcon),
  search: hugeicon(Search01Icon),
};
