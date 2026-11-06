import type { Content, Data } from "@puckeditor/core";
import type {
  ApplicationShell,
  CompiledLayout,
  ProjectedApplicationFrame,
  ProjectedNavigation,
} from "@vortex/platform/schema";
import type { Breakpoint } from "../definition-error";
import type { ApplicationTheme } from "../theme";

/**
 * The application frame the page being edited is drawn inside: the shell the page uses, the
 * application theme and the menu as the builder designed it, all from the compiled draft.
 */
export type StudioCanvasFrame = Readonly<{
  applicationName: string;
  shells: readonly ApplicationShell[];
  theme: ApplicationTheme;
  navigation: ProjectedNavigation;
  pageId: string;
  pageName: string;
  frame: ProjectedApplicationFrame;
  /** Only for a shell with several content slots: its own placements around them (the holding placement, or the whole layout), those slots empty. */
  outletContent?: CompiledLayout;
}>;

/** A slot's items; a plain list setting is an array too, but of values, not items. */
const isContent = (value: unknown): value is Content =>
  Array.isArray(value) &&
  value.every(
    (entry) => entry !== null && typeof entry === "object" && "type" in entry && "props" in entry,
  );

type PageVortex = Readonly<{ slot_orders: Readonly<Record<string, SlotOrder>> }>;

type SlotOrder = Readonly<{
  tablet?: readonly string[] | undefined;
  phone?: readonly string[] | undefined;
}>;

/**
 * The page's root slots in the order of the layout's content slots, so the Outline lists them as
 * the layout does, never in the order they happen to be stored.
 */
export const puckDataInSlotOrder = (data: Data, slotKeys: readonly string[]): Data => {
  const root = data.root as { props: Record<string, unknown> };
  const rank = (key: string) => {
    const index = slotKeys.indexOf(key);
    return index === -1 ? slotKeys.length : index;
  };
  return {
    ...data,
    root: {
      ...root,
      props: Object.fromEntries(
        Object.entries(root.props).sort(([left], [right]) => rank(left) - rank(right)),
      ),
    } as Data["root"],
  };
};

/**
 * The canvas shows a smaller screen in that screen's own order: each page zone's stored order and
 * each block's stored slot orders. The arrays are reordered for display only: the data a smaller
 * screen reports is never stored whole. A drag inside one slot there is read as that screen's
 * order (`classifyCanvasChange`), and nothing else is taken.
 */
export const puckDataForBreakpoint = (data: Data, breakpoint: Breakpoint): Data => {
  if (breakpoint === "desktop") return data;
  const reorder = (content: Content, order: SlotOrder | undefined): Content => {
    const sequence = breakpoint === "phone" ? (order?.phone ?? order?.tablet) : order?.tablet;
    const position = new Map(sequence?.map((id, index) => [id, index]) ?? []);
    const sorted =
      sequence === undefined
        ? [...content]
        : [...content].sort(
            (left, right) =>
              (position.get(String(left.props.id)) ?? 0) -
              (position.get(String(right.props.id)) ?? 0),
          );
    return sorted.map((item) => {
      const orders = (item.props as { vortex?: { slot_orders?: Record<string, SlotOrder> } }).vortex
        ?.slot_orders;
      return {
        ...item,
        props: Object.fromEntries(
          Object.entries(item.props).map(([key, value]) => [
            key,
            key !== "id" && key !== "vortex" && isContent(value)
              ? reorder(value, orders?.[key])
              : value,
          ]),
        ),
      };
    }) as Content;
  };
  const root = data.root as { props: Record<string, unknown> & { vortex: PageVortex } };
  const orders = root.props.vortex.slot_orders;
  return {
    ...data,
    root: {
      ...root,
      props: Object.fromEntries(
        Object.entries(root.props).map(([key, value]) => [
          key,
          key !== "vortex" && isContent(value) ? reorder(value, orders[key]) : value,
        ]),
      ),
    } as Data["root"],
    content: reorder(data.content, orders.content),
  };
};
