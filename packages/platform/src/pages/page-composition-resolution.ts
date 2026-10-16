import {
  type AnyPageComposition,
  type ApplicationShell,
  type CompiledItem,
  type CompiledLayout,
  type PageComposition,
  compiledItemSlots,
  compiledItemTree,
  compiledPageRootSlots,
} from "../definition/application-composition/page-composition";
import type { PageDefinition } from "../definition/application-contracts";

export type ResolvedPageComposition = Readonly<{
  page: PageDefinition;
  roots:
    | Readonly<{ kind: "page"; main: CompiledLayout }>
    | Readonly<{ kind: "guided"; stepContent: Readonly<Record<string, CompiledLayout>> }>;
}>;

const requireUniquePlacementOwnership = (items: readonly CompiledItem[]): void => {
  const ids = new Set<string>();
  for (const item of compiledItemTree(items)) {
    if (ids.has(item.props.id)) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    ids.add(item.props.id);
  }
};

/** A copy of an item list with one shell placement's reserved slot filled by page content. */
const fill = (
  items: readonly CompiledItem[],
  fills: ReadonlyMap<
    string,
    ReadonlyMap<
      string,
      Readonly<{ items: CompiledItem[]; order: { tablet: string[]; phone: string[] } }>
    >
  >,
  used: Set<string>,
): CompiledItem[] =>
  items.map((item) => {
    const own = fills.get(item.props.id);
    const props: CompiledItem["props"] = {
      ...item.props,
      vortex: { ...item.props.vortex, slotOrders: { ...item.props.vortex.slotOrders } },
    };
    for (const [key, children] of compiledItemSlots(item)) {
      const supplied = own?.get(key);
      if (supplied === undefined) {
        props[key] = fill(children, fills, used);
        continue;
      }
      if (children.length > 0) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
      used.add(`${item.props.id}:${key}`);
      props[key] = supplied.items;
      props.vortex.slotOrders[key] = supplied.order;
    }
    return { type: item.type, props };
  });

/**
 * One page's data inside its application shell: the shell's layout with every content slot the
 * page fills placed into its reserved target. A required content slot must be filled.
 */
export const resolveShellLayout = (
  shell: ApplicationShell,
  data: PageComposition,
): CompiledLayout => {
  const supplied = new Map(compiledPageRootSlots(data));
  const allowed = new Set(shell.contentSlots.map((slot) => String(slot.slotId)));
  if ([...supplied.keys()].some((slotId) => !allowed.has(slotId)))
    throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
  const fills = new Map<
    string,
    Map<string, { items: CompiledItem[]; order: { tablet: string[]; phone: string[] } }>
  >();
  for (const binding of shell.contentSlots) {
    const items = supplied.get(String(binding.slotId)) ?? [];
    if (binding.required && items.length === 0) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    const order = data.root.props.vortex.slotOrders[String(binding.slotId)] ?? {
      tablet: [],
      phone: [],
    };
    const own = fills.get(String(binding.parentPlacementId)) ?? new Map();
    own.set(binding.parentSlotKey, { items, order });
    fills.set(String(binding.parentPlacementId), own);
  }
  const used = new Set<string>();
  const content = fill(shell.layout.content, fills, used);
  if (used.size !== shell.contentSlots.length) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
  return {
    root: { props: { vortex: { slotOrders: shell.layout.root.props.vortex.slotOrders } } },
    content,
  };
};

/** One page's (or step's) resolved layout: its own content, or its content inside its shell. */
const resolveData = (
  data: PageComposition,
  shell: ApplicationShell | undefined,
): CompiledLayout => {
  if (shell === undefined) {
    const order = data.root.props.vortex.slotOrders.content;
    if (order === undefined) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    return {
      root: { props: { vortex: { slotOrders: { content: order } } } },
      content: data.content,
    };
  }
  return resolveShellLayout(shell, data);
};

/**
 * The resolved layouts of one compiled composition: its one layout, or one layout per guided step in
 * declared step order. The step identities are the declared guided steps, absent for any other
 * page.
 */
export const resolveCompositionRoots = (
  composition: AnyPageComposition,
  stepIds: readonly string[] | undefined,
  shells: readonly ApplicationShell[] = [],
): ResolvedPageComposition["roots"] => {
  const steps = "stepContent" in composition ? composition.stepContent : undefined;
  const first = steps === undefined ? composition : Object.values(steps)[0];
  const shellId = (first as PageComposition | undefined)?.root.props.vortex.shellId ?? null;
  let shell: ApplicationShell | undefined;
  if (shellId !== null) {
    const matches = shells.filter((candidate) => candidate.shellId === shellId);
    if (matches.length !== 1 || matches[0] === undefined)
      throw new Error("PAGE_COMPOSITION_SHELL_UNAVAILABLE");
    shell = matches[0];
  }
  if (steps === undefined) {
    if (stepIds !== undefined) throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
    const main = resolveData(composition as PageComposition, shell);
    requireUniquePlacementOwnership(main.content);
    return { kind: "page", main };
  }
  const expectedSteps = stepIds ?? [];
  if (
    Object.keys(steps).length !== expectedSteps.length ||
    expectedSteps.some((stepId) => steps[stepId] === undefined)
  )
    throw new Error("PAGE_COMPOSITION_BINDING_INVALID");
  const stepContent = Object.fromEntries(
    expectedSteps.map((stepId) => [stepId, resolveData(steps[stepId]!, shell)]),
  );
  // A shell placement repeats in every step; within one step every placement is unique, and no
  // page placement repeats across steps.
  for (const layout of Object.values(stepContent)) requireUniquePlacementOwnership(layout.content);
  requireUniquePlacementOwnership(
    Object.values(steps).flatMap((data) =>
      compiledPageRootSlots(data)
        .flatMap(([, items]) => items)
        .concat(data.content),
    ),
  );
  return { kind: "guided", stepContent };
};

export const resolvePageComposition = (
  page: PageDefinition,
  shells: readonly ApplicationShell[] = [],
): ResolvedPageComposition => ({
  page,
  roots: resolveCompositionRoots(
    page.composition,
    page.type === "guided_form" ? page.steps.map((step) => String(step.id)) : undefined,
    shells,
  ),
});
