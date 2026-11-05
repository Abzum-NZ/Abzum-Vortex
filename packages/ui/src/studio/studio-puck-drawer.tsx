"use client";

import { Drawer, createUsePuck, useGetPuck } from "@puckeditor/core";
import {
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BlockPaletteGroup } from "@vortex/platform/schema";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { Alert, AlertDescription } from "../components/alert";
import { Button } from "../components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../components/item";
import { Label } from "../components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Icon, resolveVortexIconName, type VortexIconName } from "../icons";
import { cn } from "../lib/utils";
import {
  definitionLimitMessage,
  definitionLimitReached,
  PALETTE_GROUP_TITLES,
  PUBLISHED_PAGE_ADD_REASON,
  type StudioCompositionAddTarget,
  studioPaletteComponentLists,
  type StudioPaletteChoice,
} from "@vortex/platform/schema";
import { StudioLimitNote, Reasoned } from "./studio-limit";
import { zoneOfDestination } from "./studio-canvas-data";
import { studioScreens, useStudioScreen } from "./studio-canvas-screen";
import { useStudioCanvas, type StudioCanvasAddRequest } from "./studio-puck-provider";
import { studioPuckStyle } from "./studio-puck-style";

const usePuckSelector = createUsePuck();

/** The end of a slot, for the Add button: the add command adds a block past the end last. */
const END_OF_SLOT = Number.MAX_SAFE_INTEGER;

type DrawerContextValue = Readonly<{
  target: StudioCompositionAddTarget;
  choices: ReadonlyMap<string, StudioPaletteChoice>;
  /** Why no block can be added now; absent while the canvas takes edits. */
  blocked: string | undefined;
  /** Why the place takes no block at all (full application, deepest level), said once by the Alert. */
  limitReason: string | undefined;
  limitId: string;
  add: (choice: StudioPaletteChoice) => void;
  /** The blocks Puck does not let be dropped, read once for the list. */
  notDroppable: ReadonlySet<string>;
}>;

const DrawerContext = createContext<DrawerContextValue | null>(null);

/**
 * Puck 0.24 draws every drawer item twice (a visual copy under the draggable one) with the one
 * function it is given for the row. The two copies mount in the order Puck draws them, the visual
 * copy first, so of the two rows of one block the one that mounts first is the visual copy. It is
 * hidden from keyboard and assistive technology, so a block is listed once and its Add button
 * exists once. Puck's own draggable element around the live row keeps the keyboard attributes
 * Puck gives it (a tab stop and a "draggable" role): Studio's route is the Add button, and
 * the row is not changed in Puck's markup (accepted limit, recorded in the PR).
 */
const mountedRows = new Map<string, number>();
function useDrawerRow(name: string): boolean {
  const [underlay, setUnderlay] = useState(false);
  useLayoutEffect(() => {
    const count = (mountedRows.get(name) ?? 0) + 1;
    mountedRows.set(name, count);
    setUnderlay(count % 2 === 1);
    return () => {
      const left = (mountedRows.get(name) ?? 1) - 1;
      if (left <= 0) mountedRows.delete(name);
      else mountedRows.set(name, left);
    };
  }, [name]);
  return underlay;
}

/** The Vortex icon of a release's icon name: the catalogue's own, or the nearest the icon set has. */
const RELEASE_ICONS: Readonly<Record<string, VortexIconName>> = {
  type: "pencil",
  "edit-3": "pencil",
  file: "file-text",
  hash: "filter",
  list: "list-tree",
  "alert-circle": "triangle-alert",
  folder: "archive",
  "message-square": "info",
  sidebar: "panel-left",
  user: "user-round",
  link: "app-window",
  zap: "activity",
  table: "table-columns",
  layout: "layout-dashboard",
  "chart-bar": "activity",
  heading: "file-text",
  paperclip: "package-plus",
};
export const studioReleaseIcon = (name: string): VortexIconName =>
  resolveVortexIconName(name) ?? RELEASE_ICONS[name] ?? "blocks";

/**
 * Puck's `drawerItem` override: one block of the drawer as a shadcn `Item` with its icon, name and
 * description. Its Add button adds the block to the chosen place, so a block never needs a drag;
 * when the block cannot be added the button stays focusable, says why in a tooltip and does nothing.
 */
export function StudioDrawerItem({
  children,
  name,
}: Readonly<{ children: ReactNode; name: string }>) {
  const drawer = useContext(DrawerContext);
  const underlay = useDrawerRow(name);
  const descriptionId = useId();
  const choice = drawer?.choices.get(name);
  const draggable = drawer?.notDroppable.has(name) === false;
  if (drawer === null || choice === undefined) return <>{children}</>;
  const reason = drawer.blocked ?? choice.unavailable;
  const addButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Add ${choice.name} to ${drawer.target.label}`}
      aria-describedby={descriptionId}
      onClick={() => drawer.add(choice)}
    >
      <Icon name="plus" />
    </Button>
  );
  return (
    <Item
      size="sm"
      variant="outline"
      className={cn(
        "flex-nowrap",
        reason !== undefined && "opacity-70",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
      {...(underlay ? { inert: true, "aria-hidden": true } : {})}
    >
      <ItemMedia variant="icon">
        <Icon name={studioReleaseIcon(choice.icon)} />
      </ItemMedia>
      <Tooltip>
        <TooltipTrigger render={<ItemContent className="min-w-0" />}>
          <ItemTitle>{choice.name}</ItemTitle>
          <ItemDescription id={descriptionId} className="line-clamp-2">
            {choice.description}
          </ItemDescription>
        </TooltipTrigger>
        <TooltipContent className="max-w-prose">{choice.description}</TooltipContent>
      </Tooltip>
      <ItemActions>
        {reason === undefined ? (
          <Tooltip>
            <TooltipTrigger render={addButton} />
            <TooltipContent className="max-w-prose">
              Add {choice.name}: {choice.description}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Reasoned
            reason={reason}
            describedBy={reason === drawer.limitReason ? drawer.limitId : undefined}
          >
            {addButton}
          </Reasoned>
        )}
      </ItemActions>
    </Item>
  );
}

function BlocksEmpty({
  title,
  description,
  icon = "blocks",
}: Readonly<{ title: string; description: string; icon?: "blocks" | "search" }>) {
  return (
    <Empty role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name={icon} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A place as the list names it: deeper places say their level. */
const placeLabel = (target: StudioCompositionAddTarget, top: number): string =>
  target.depth === top ? target.label : `${target.label} (level ${target.depth - top + 1})`;

/** The screen blocks are added on. */
const desktop = studioScreens[0]!;

/** Why the canvas takes no new block now, in the words the Add button says it with. */
const blockedReason = (
  editable: boolean,
  readOnlyCause: string | undefined,
  screen: Readonly<{ breakpoint: string }>,
  disabledReason: string | undefined,
): string | undefined => {
  if (editable) return undefined;
  if (screen.breakpoint !== desktop.breakpoint)
    return `Blocks are added on the ${desktop.label} screen size.`;
  if (readOnlyCause !== undefined) return "This page is shown read-only, so blocks can't be added.";
  return disabledReason ?? "Studio is busy; try again in a moment.";
};

/** One block of the list: Puck's draggable `Drawer.Item`, drawn by `StudioDrawerItem`. */
function StudioBlockRow({ name }: Readonly<{ name: string }>) {
  const drawer = useContext(DrawerContext);
  return (
    <Drawer.Item name={name} isDragDisabled={drawer?.notDroppable.has(name) === true}>
      {StudioDrawerItem}
    </Drawer.Item>
  );
}

/**
 * The blocks of a place and a search, one collapsible group per palette group in Studio's own
 * headings (sentence case, from the palette group titles); a group with no match is not listed.
 */
function StudioBlockList({
  lists,
}: Readonly<{ lists: Readonly<Record<string, readonly string[]>> }>) {
  return (
    <Drawer>
      <div className="flex flex-col gap-2" aria-label="Blocks" role="group">
        {Object.entries(lists).map(([group, names]) =>
          names.length === 0 ? null : (
            <Collapsible key={group} defaultOpen className="flex flex-col gap-1">
              <CollapsibleTrigger className="group/trigger flex items-center justify-between gap-2 rounded-md px-1 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                {PALETTE_GROUP_TITLES[group as BlockPaletteGroup] ?? group}
                <Icon
                  name="chevron-down"
                  className="size-4 transition-transform group-data-[panel-open]/trigger:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col gap-1">
                {names.map((name) => (
                  <StudioBlockRow key={name} name={name} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          ),
        )}
      </div>
    </Drawer>
  );
}

/**
 * Studio's Blocks panel: where the new block goes and a search above the list of blocks. The
 * place and the search decide which blocks are listed, grouped by palette group; the rows are
 * drawn by `StudioDrawerItem`. Each block drags with Puck's own drag and drop (`Drawer.Item`),
 * or is added with its Add button.
 */
export function StudioBlocksPanel() {
  const { input, model } = useStudioCanvas();
  const screen = useStudioScreen();
  const palette = input.palette;
  // No page is open: the panel says so itself.
  if (palette === undefined || !model.open) return null;
  if (model.shown === undefined)
    return (
      <BlocksEmpty
        title="Blocks unavailable"
        description={`Blocks can be added once this ${palette.owner} has a compiled version, which follows shortly after your latest change is saved.`}
      />
    );
  // The places are worked out when the panel is drawn, not on every edit of the draft.
  const places = palette.targets();
  if (places.kind !== "available")
    return (
      <BlocksEmpty
        title="Blocks unavailable"
        description={
          places.kind === "unsupported"
            ? places.reason === "published"
              ? PUBLISHED_PAGE_ADD_REASON
              : "Blocks can't be added to this kind of page in Studio yet."
            : `This ${palette.owner} is not in the current draft.`
        }
      />
    );
  return (
    <StudioBlocksDrawer
      targets={places.targets.filter((target) => model.zoneKeys.has(target.area))}
      blocked={blockedReason(model.editable, model.readOnlyCause, screen, input.disabledReason)}
      owner={palette.owner}
      message={palette.message}
      slotOfArea={model.slotOfZoneKey}
      preferredArea={model.defaultZoneKey}
    />
  );
}

function StudioBlocksDrawer({
  targets,
  blocked,
  owner,
  message,
  slotOfArea,
  preferredArea,
}: Readonly<{
  /** The places of the page (or step) the canvas shows. */
  targets: readonly StudioCompositionAddTarget[];
  blocked: string | undefined;
  /** Whose blocks the panel adds to, which it says when there is no place for one. */
  owner: "page" | "layout";
  message: string;
  /** Puck's root slot of a content slot's key; `undefined` for the page's default zone. */
  slotOfArea: (area: string) => string | undefined;
  /** The content slot the panel adds to until another is chosen. */
  preferredArea: string | undefined;
}>) {
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const targetSelectId = useId();
  // An insert only needs an id that is unique while it is in flight.
  const instance = useId();
  const inserts = useRef(0);
  const getPuck = useGetPuck();
  const target =
    targets.find((candidate) => candidate.id === targetId) ??
    targets.find((candidate) => candidate.area === preferredArea) ??
    targets[0];
  // The page's own top level is level 1: the levels the layout around it holds are not the page's.
  const top = Math.min(...targets.map((candidate) => candidate.depth));
  // Typing stays responsive on a big page: the list follows the search one render behind.
  const searched = useDeferredValue(search);
  const lists = useMemo(
    () => studioPaletteComponentLists(target?.choices ?? [], searched),
    [target, searched],
  );
  const choices = useMemo(
    () => new Map((target?.choices ?? []).map((choice) => [choice.rendererKey, choice])),
    [target],
  );
  const shown = Object.values(lists).reduce((total, names) => total + names.length, 0);
  const add = useCallback(
    (choice: StudioPaletteChoice) => {
      if (target === undefined) return;
      const request: StudioCanvasAddRequest = {
        area: target.area,
        destination: target.destination,
        index: END_OF_SLOT,
        rendererKey: choice.rendererKey,
      };
      // A block is inserted at the end of the place like a drop is, so both reach the add command
      // through Puck's `insert` action.
      getPuck().dispatch({
        type: "insert",
        componentType: choice.rendererKey,
        destinationZone: zoneOfDestination(target.destination, slotOfArea(target.area)),
        destinationIndex: request.index,
        id: `${choice.rendererKey}-${instance}-${(inserts.current += 1)}`,
      });
    },
    [target, getPuck, instance, slotOfArea],
  );
  const limitId = useId();
  // The place is full when the application holds every block it may, or the place nests as deep as
  // a block may: said once by the Alert, not on every row.
  const limitReason =
    target === undefined
      ? undefined
      : definitionLimitReached("compositionPlacements", target.placed)
        ? definitionLimitMessage("compositionPlacements")
        : definitionLimitReached("compositionDepth", target.depth)
          ? definitionLimitMessage("compositionDepth")
          : undefined;
  // Whether a block may be dropped is read once for every block of the list, not once per row.
  const blockedKey = usePuckSelector((state) =>
    [...choices.keys()].filter((name) => !state.getPermissions({ type: name }).insert).join(","),
  );
  const notDroppable = useMemo(
    (): ReadonlySet<string> => new Set(blockedKey === "" ? [] : blockedKey.split(",")),
    [blockedKey],
  );
  const context = useMemo(
    (): DrawerContextValue | null =>
      target === undefined
        ? null
        : { target, choices, blocked, limitReason, limitId, add, notDroppable },
    [target, choices, blocked, limitReason, limitId, add, notDroppable],
  );
  if (target === undefined || context === null)
    return (
      <BlocksEmpty
        title="No block targets"
        description={
          owner === "layout"
            ? "This layout has no place for new blocks."
            : "This page has no place for new blocks."
        }
      />
    );
  return (
    <div className="flex flex-col gap-3" data-vortex-studio-palette="" style={studioPuckStyle}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={targetSelectId}>Add to</Label>
        <Select
          items={targets.map((candidate) => ({
            value: candidate.id,
            label: placeLabel(candidate, top),
          }))}
          value={target.id}
          onValueChange={(next) => {
            if (typeof next === "string") setTargetId(next);
          }}
        >
          <SelectTrigger id={targetSelectId}>
            <SelectValue />
          </SelectTrigger>
          {/* The list is as wide as its longest place name (up to the space there is), not the trigger. */}
          <SelectContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
            {targets.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {placeLabel(candidate, top)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <InputGroup>
        <InputGroupAddon>
          <Icon name="search" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={search}
          aria-label="Search blocks"
          placeholder="Search blocks"
          onChange={(event) => setSearch(event.target.value)}
        />
      </InputGroup>
      {limitReason === undefined ? (
        <>
          <StudioLimitNote
            limit="compositionPlacements"
            used={target.placed}
            label="Blocks in the application"
          />
          <StudioLimitNote limit="compositionDepth" used={target.depth} label="Levels above here" />
        </>
      ) : (
        <Alert role="status" id={limitId}>
          <AlertDescription>{limitReason}</AlertDescription>
        </Alert>
      )}
      {/* The answer to an Add is announced, not drawn: a line that comes and goes would move the list. */}
      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>
      {shown === 0 ? (
        <BlocksEmpty
          icon="search"
          title="No blocks found"
          description={
            search.trim().length > 0
              ? "Try another name or group."
              : "This place takes no new blocks."
          }
        />
      ) : (
        <DrawerContext.Provider value={context}>
          <StudioBlockList lists={lists} />
        </DrawerContext.Provider>
      )}
    </div>
  );
}
