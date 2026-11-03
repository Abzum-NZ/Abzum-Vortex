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
  /** Only for a shell with several content slots: its own placements around them, those slots empty. */
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
 * The canvas shows a smaller screen in that screen's own order: each page zone's stored order and
 * each block's stored slot orders. The arrays are reordered for display only; a canvas showing
 * another size than desktop never sends its data back as an edit.
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
