import type {
  ApplicationShell,
  CompiledLayout,
} from "../definition/application-composition/page-composition";
import { itemPropSlots } from "./placement-walk";

type JsonObject = Record<string, unknown>;

/**
 * Where the page content sits inside the application frame. A shell with one content slot holds
 * the content in that slot. Several content slots are held by their nearest common placement, which
 * then belongs to the page. Without a common placement (or without a shell) the whole root is the
 * content. The frame renders one outlet at this location and the page fills it.
 */
export type ShellOutletLocation =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "slot"; placementId: string; slotKey: string }>
  | Readonly<{ kind: "placement"; placementId: string }>;

/** The viewer's application frame: the projected shell without the page content. */
export type ProjectedApplicationFrame = Readonly<{
  shellId?: string;
  composition: CompiledLayout;
  outlet: ShellOutletLocation;
}>;

/** One projected page split into the frame around it and the content it places in the outlet. */
export type SplitProjectedPage = Readonly<{
  frame: ProjectedApplicationFrame;
  content: Readonly<Record<string, unknown>>;
}>;

const object = (value: unknown): JsonObject => value as JsonObject;
const items = (value: unknown): JsonObject[] => value as JsonObject[];

const layoutOf = (content: JsonObject[], order: unknown): CompiledLayout =>
  ({
    root: { props: { vortex: { slotOrders: { content: order } } } },
    content,
  }) as unknown as CompiledLayout;

const emptyLayout = (): CompiledLayout => layoutOf([], { tablet: [], phone: [] });

/** Ancestor placement identities from the root down to and including the named placement. */
const pathTo = (list: unknown, placementId: string): readonly string[] | undefined => {
  for (const item of items(list)) {
    const props = object(item.props);
    const id = String(props.id);
    if (id === placementId) return [id];
    for (const [, child] of itemPropSlots(props)) {
      const nested = pathTo(child, placementId);
      if (nested !== undefined) return [id, ...nested];
    }
  }
  return undefined;
};

/** The outlet location a shell declares through its content slots. */
export const shellOutletLocation = (shell: ApplicationShell | undefined): ShellOutletLocation => {
  if (shell === undefined || shell.contentSlots.length === 0) return { kind: "root" };
  const [first, ...rest] = shell.contentSlots;
  if (first !== undefined && rest.length === 0)
    return {
      kind: "slot",
      placementId: String(first.parentPlacementId),
      slotKey: first.parentSlotKey,
    };
  const paths = shell.contentSlots.map((binding) =>
    pathTo(shell.layout.content, String(binding.parentPlacementId)),
  );
  if (paths.some((path) => path === undefined)) return { kind: "root" };
  const [head, ...others] = paths as readonly (readonly string[])[];
  let common = 0;
  while (
    head !== undefined &&
    common < head.length &&
    others.every((path) => path[common] === head[common])
  )
    common += 1;
  const placementId = head?.[common - 1];
  return placementId === undefined ? { kind: "root" } : { kind: "placement", placementId };
};

/** Locates an item, and the props and slot key of the item holding it, in a projected list. */
const locate = (
  list: unknown,
  placementId: string,
  parent?: Readonly<{ props: JsonObject; slotKey: string }>,
):
  | Readonly<{
      item: JsonObject;
      parent: Readonly<{ props: JsonObject; slotKey: string }> | undefined;
    }>
  | undefined => {
  for (const item of items(list)) {
    const props = object(item.props);
    if (String(props.id) === placementId) return { item, parent };
    for (const [slotKey, child] of itemPropSlots(props)) {
      const found = locate(child, placementId, { props, slotKey });
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

/** Empties one item's slot in place, with its breakpoint order. */
const emptySlot = (props: JsonObject, slotKey: string): void => {
  props[slotKey] = [];
  const vortex = object(props.vortex);
  props.vortex = {
    ...vortex,
    slotOrders: { ...object(vortex.slotOrders), [slotKey]: { tablet: [], phone: [] } },
  };
};

/** Replaces one item, copying only its ancestors; every unchanged placement keeps its identity. */
const replaceItem = (
  list: JsonObject[],
  placementId: string,
  replacement: JsonObject,
): JsonObject[] => {
  let changed = false;
  const next = list.map((item) => {
    const props = object(item.props);
    if (String(props.id) === placementId) {
      changed = true;
      return replacement;
    }
    let nextProps = props;
    for (const [slotKey, child] of itemPropSlots(props)) {
      const nextChild = replaceItem(items(child), placementId, replacement);
      if (nextChild !== child) nextProps = { ...nextProps, [slotKey]: nextChild };
    }
    if (nextProps === props) return item;
    changed = true;
    return { ...item, props: nextProps };
  });
  return changed ? next : list;
};

const splitRoot = (
  root: unknown,
  outlet: ShellOutletLocation,
): Readonly<{ frame: CompiledLayout; content: CompiledLayout }> => {
  if (outlet.kind === "root") return { frame: emptyLayout(), content: root as CompiledLayout };
  const original = object(root);
  const found = locate(original.content, outlet.placementId);
  if (found === undefined)
    // The viewer may not see the placement that holds the content, so no content is shown, exactly
    // as when the content is composed into that placement.
    return { frame: root as CompiledLayout, content: emptyLayout() };
  const props = { ...object(found.item.props) };
  const frame = (): CompiledLayout =>
    ({
      ...original,
      content: replaceItem(items(original.content), outlet.placementId, { ...found.item, props }),
    }) as unknown as CompiledLayout;
  if (outlet.kind === "slot") {
    const content = items(props[outlet.slotKey] ?? []);
    const order = object(object(props.vortex).slotOrders)[outlet.slotKey] ?? {
      tablet: [],
      phone: [],
    };
    emptySlot(props, outlet.slotKey);
    return { frame: frame(), content: layoutOf(content, order) };
  }
  const content = layoutOf([found.item], {
    tablet: [outlet.placementId],
    phone: [outlet.placementId],
  });
  // The frame keeps the holding placement's position, emptied, so the outlet takes its place.
  for (const [slotKey] of itemPropSlots(props)) emptySlot(props, slotKey);
  return { frame: frame(), content };
};

/**
 * Splits one permission-projected page into its application frame and its content. Both parts come
 * from the same projection, so the frame carries exactly the shell placements the viewer was
 * allowed on this page and the content carries exactly the page's own placements; nothing is
 * decided again.
 */
export const splitProjectedPage = (
  projected: Readonly<Record<string, unknown>>,
  shell: ApplicationShell | undefined,
): SplitProjectedPage => {
  const outlet = shellOutletLocation(shell);
  const composition = object(projected.composition);
  // The content renders inside the frame's outlet, so it names no shell of its own.
  const page = Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "shellId"));
  const frameOf = (frame: CompiledLayout): ProjectedApplicationFrame => ({
    ...(shell === undefined ? {} : { shellId: String(shell.shellId) }),
    composition: frame,
    outlet,
  });
  if (composition.stepContent === undefined) {
    const { frame, content } = splitRoot(composition, outlet);
    return { frame: frameOf(frame), content: { ...page, composition: content } };
  }
  const stepContent = object(composition.stepContent);
  const steps = Object.entries(stepContent).map(
    ([stepId, root]) => [stepId, splitRoot(root, outlet)] as const,
  );
  return {
    frame: frameOf(steps[0]?.[1].frame ?? emptyLayout()),
    content: {
      ...page,
      composition: {
        stepContent: Object.fromEntries(steps.map(([stepId, split]) => [stepId, split.content])),
      },
    },
  };
};
