import {
  sourcePageDataOf,
  sourcePageShell,
  sourceSlotBreakpointOrders,
  type SourceItem,
  type SourcePageData,
  type SourceSlotOrders,
  type PageSlotAddress,
} from "@vortex/platform/schema";
import {
  judged,
  quoted,
  refuse,
  type Source,
  type Page,
  type StudioStructureContext,
  type StudioStructureResult,
} from "./application-structure-common";

export type StudioPageLayoutCommand = Readonly<{
  kind: "move_page";
  pageAlias: string;
  shellAlias: string | null;
  /** Source area ID to destination area ID, chosen before any draft change. */
  areaMapping: Readonly<Record<string, string>>;
}>;

/** Business names for the same stable page-slot addresses the canvas and palette edit. */
export const studioPageAreaLabel = (
  source: Source,
  page: Page,
  address: PageSlotAddress,
): string => {
  const composition = page.composition;
  const data =
    "step_content" in composition
      ? address.step === undefined
        ? undefined
        : composition.step_content[address.step]
      : composition;
  if (data === undefined) throw new TypeError("The page content area's step is missing.");
  const step =
    address.step === undefined
      ? undefined
      : page.type === "guided_form"
        ? page.steps.find((entry) => entry.id === address.step)?.name
        : undefined;
  if (address.step !== undefined && step === undefined)
    throw new TypeError("The page content area names an undeclared step.");
  if (address.slot === undefined) return step ?? "Page content";
  const outlet = source.body.shells
    .find((shell) => shell.id === data.root.props.vortex.shell)
    ?.content_slots.find((slot) => slot.id === address.slot);
  if (outlet === undefined)
    throw new TypeError("The page content area names an undeclared outlet.");
  return step === undefined ? outlet.label : `${step} / ${outlet.label}`;
};

type Area = Readonly<{
  id: string;
  key: string;
  label: string;
  allowed: readonly string[] | undefined;
}>;
const areasOf = (source: Source, shellAlias: string | null): readonly Area[] => {
  if (shellAlias === null)
    return [{ id: "content", key: "content", label: "Content", allowed: undefined }];
  const shell = source.body.shells.find((entry) => entry.id === shellAlias);
  if (shell === undefined)
    return refuse("That layout is no longer in this application. Choose another.");
  return shell.content_slots.map((slot) => ({
    id: slot.id,
    key: slot.key,
    label: slot.label,
    allowed: slot.allowed_child_categories,
  }));
};

const blocksIn = (data: SourcePageData, area: Area): SourceItem[] =>
  data.root.props.vortex.shell === null
    ? data.content
    : ((data.root.props[area.id] as SourceItem[] | undefined) ?? []);

const blockProblem = (
  context: StudioStructureContext,
  items: readonly SourceItem[],
  target: Area,
): string | undefined => {
  if (target.allowed === undefined) return undefined;
  const blocked = items.filter((item) => {
    const release = context.catalogue.releases.find(
      (entry) =>
        String(entry.blockId) === item.props.vortex.block.block_id &&
        String(entry.releaseVersion) === item.props.vortex.block.release_version,
    );
    return release === undefined || !target.allowed!.includes(release.paletteGroup);
  });
  if (blocked.length === 0) return undefined;
  const names = [
    ...new Set(
      blocked.map((item) => {
        const settings = Object.fromEntries(
          Object.entries(item.props).filter(
            ([key, value]) => key !== "id" && key !== "vortex" && !Array.isArray(value),
          ),
        );
        return quoted(
          context.describePlacement({ block: item.props.vortex.block, settings }) ??
            "Unnamed block",
        );
      }),
    ),
  ];
  return `${names.join(", ")} cannot move to ${quoted(target.label)}. This area does not allow that kind of block.`;
};

export type StudioPageLayoutPlan = Readonly<{
  areas: readonly Readonly<{
    id: string;
    label: string;
    blockCount: number;
    suggestedTarget: string | null;
    destinations: readonly Readonly<{ id: string; label: string; problem: string | undefined }>[];
  }>[];
}>;

/** The same category check powers the mapping choices and the atomic command. Steps share an area mapping. */
export const studioPageLayoutPlan = (
  context: StudioStructureContext,
  pageAlias: string,
  target: string | null,
): StudioPageLayoutPlan => {
  const page = context.source.body.pages.find((entry) => entry.id === pageAlias);
  if (page === undefined) return refuse("That page is no longer in the draft.");
  const from = areasOf(context.source, sourcePageShell(page.composition));
  const to = areasOf(context.source, target);
  return {
    areas: from.flatMap((area) => {
      const items = sourcePageDataOf(page.composition).flatMap((data) => blocksIn(data, area));
      if (items.length === 0) return [];
      return [
        {
          id: area.id,
          label: area.label,
          blockCount: items.length,
          suggestedTarget:
            to.find((entry) => entry.key === area.key)?.id ?? (to.length === 1 ? to[0]!.id : null),
          destinations: to.map((entry) => ({
            id: entry.id,
            label: entry.label,
            problem: blockProblem(context, items, entry),
          })),
        },
      ];
    }),
  };
};

/** Join areas without dropping blocks or their effective tablet/phone order. */
const movedData = (
  context: StudioStructureContext,
  data: SourcePageData,
  command: StudioPageLayoutCommand,
): SourcePageData => {
  const from = areasOf(context.source, data.root.props.vortex.shell);
  const to = areasOf(context.source, command.shellAlias);
  const placed = new Map<string, { items: SourceItem[]; tablet: string[]; phone: string[] }>();
  for (const area of from) {
    const items = blocksIn(data, area);
    if (items.length === 0) continue;
    const match = to.find((entry) => entry.id === command.areaMapping[area.id]);
    if (match === undefined)
      return refuse(`Choose where the blocks in ${quoted(area.label)} should go.`);
    const problem = blockProblem(context, items, match);
    if (problem !== undefined) return refuse(problem);
    const order = sourceSlotBreakpointOrders(items, data.root.props.vortex.slot_orders[area.id]);
    const previous = placed.get(match.id);
    placed.set(match.id, {
      items: [...(previous?.items ?? []), ...items],
      tablet: [...(previous?.tablet ?? []), ...order.tablet],
      phone: [...(previous?.phone ?? []), ...order.phone],
    });
  }
  const slotOrders: SourceSlotOrders = Object.fromEntries(
    [...placed].map(([id, entry]) => [id, { tablet: entry.tablet, phone: entry.phone }]),
  );
  return {
    root: {
      props: {
        vortex: { shell: command.shellAlias, slot_orders: slotOrders },
        ...(command.shellAlias === null
          ? {}
          : Object.fromEntries(to.map((area) => [area.id, placed.get(area.id)?.items ?? []]))),
      },
    },
    content: command.shellAlias === null ? (placed.get("content")?.items ?? []) : [],
  };
};

export const movePage = (
  context: StudioStructureContext,
  candidate: Source,
  command: StudioPageLayoutCommand,
): StudioStructureResult => {
  const page = candidate.body.pages.find((entry) => entry.id === command.pageAlias);
  if (page === undefined) return refuse("That page is no longer in the draft.");
  if (sourcePageShell(page.composition) === command.shellAlias)
    return refuse(`${quoted(page.name)} already uses that layout.`);
  // Validate the layout even when the page is empty.
  areasOf(context.source, command.shellAlias);
  page.composition =
    "step_content" in page.composition
      ? {
          step_content: Object.fromEntries(
            Object.entries(page.composition.step_content).map(([step, data]) => [
              step,
              movedData(context, data, command),
            ]),
          ),
        }
      : movedData(context, page.composition, command);
  const target = candidate.body.shells.find((entry) => entry.id === command.shellAlias);
  return {
    kind: "applied",
    source: judged(candidate),
    select: { kind: "page", pageAlias: page.id },
    details: [],
    message: `${quoted(page.name)} now uses ${target === undefined ? "the platform default frame" : `the layout ${quoted(target.name)}`}.`,
  };
};
