"use client";

import { Puck, createUsePuck, useGetPuck } from "@puckeditor/core";
import "./studio-puck-drawer.css";
import {
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { toast } from "../components/sonner";
import { definitionLimitMessage, definitionLimitReached } from "@vortex/platform/schema";
import { StudioLimitNote, Reasoned } from "./studio-limit";
import type { StudioCompositionAddTarget } from "./application-composition-commands";
import { studioPaletteComponentLists, type StudioPaletteChoice } from "./contextual-palette";
import { zoneOfDestination } from "./studio-canvas-data";
import { studioScreens, useStudioScreen } from "./studio-canvas-screen";
import { useStudioCanvas, type StudioCanvasAddRequest } from "./studio-puck-provider";

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
}>;

const DrawerContext = createContext<DrawerContextValue | null>(null);

/**
 * Puck 0.24 draws every drawer item twice (`DrawerItemDraggable`: a visual copy under the
 * draggable one, in two sibling wrappers) and puts dnd-kit's Accessibility plugin on the draggable
 * copy: `tabindex=0`, `role=button`, "draggable" and instructions for a keyboard drag Puck does not
 * support (it registers the pointer sensor only). Studio's keyboard route is the Add button, so the
 * row is one list item with no tab stop of its own, and the visual copy is hidden from keyboard and
 * assistive technology. Puck gives the override no way to tell the copies apart, so the copy is the
 * item whose wrapper has a following sibling. Re-check this after a Puck upgrade.
 */
const ROW_ATTRIBUTES: Readonly<Record<string, string | null>> = {
  tabindex: "-1",
  role: "listitem",
  "aria-roledescription": null,
  "aria-describedby": null,
  "aria-disabled": null,
};

function useDrawerRow(): Readonly<{
  underlay: boolean;
  mark: (element: HTMLElement | null) => void;
}> {
  const [underlay, setUnderlay] = useState(false);
  const observer = useRef<MutationObserver | null>(null);
  const mark = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    const host = element?.closest<HTMLElement>("[data-puck-drawer-item]");
    if (host === null || host === undefined) return;
    const copy = host.parentElement?.nextElementSibling != null;
    setUnderlay(copy);
    if (copy) return;
    const apply = () => {
      for (const [name, value] of Object.entries(ROW_ATTRIBUTES)) {
        if (value === null) host.toggleAttribute(name, false);
        else if (host.getAttribute(name) !== value) host.setAttribute(name, value);
      }
    };
    apply();
    // dnd-kit sets its attributes from an effect, after this ref: they are put back as they change.
    observer.current = new MutationObserver(apply);
    observer.current.observe(host, {
      attributes: true,
      attributeFilter: Object.keys(ROW_ATTRIBUTES),
    });
  }, []);
  return { underlay, mark };
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
const releaseIcon = (name: string): VortexIconName =>
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
  const { underlay, mark } = useDrawerRow();
  const draggable = usePuckSelector((state) => state.getPermissions({ type: name }).insert);
  const choice = drawer?.choices.get(name);
  if (drawer === null || choice === undefined) return <>{children}</>;
  const reason = drawer.blocked ?? choice.unavailable;
  const addButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Add ${choice.name} to ${drawer.target.label}`}
      onClick={() => drawer.add(choice)}
    >
      <Icon name="plus" />
    </Button>
  );
  return (
    <Item
      ref={mark}
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
        <Icon name={releaseIcon(choice.icon)} />
      </ItemMedia>
      <Tooltip>
        <TooltipTrigger render={<ItemContent className="min-w-0" />}>
          <ItemTitle>{choice.name}</ItemTitle>
          <ItemDescription className="line-clamp-2">{choice.description}</ItemDescription>
        </TooltipTrigger>
        <TooltipContent>{reason ?? choice.description}</TooltipContent>
      </Tooltip>
      <ItemActions>
        {reason === undefined ? (
          <Tooltip>
            <TooltipTrigger render={addButton} />
            <TooltipContent>Add {choice.name}</TooltipContent>
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

/** Whether Puck's category lists already hold exactly these blocks. */
const sameLists = (
  current: Readonly<Record<string, Readonly<{ components?: string[]; visible?: boolean }>>>,
  wanted: Readonly<Record<string, readonly string[]>>,
): boolean =>
  current.other?.visible === false &&
  Object.entries(wanted).every(
    ([group, names]) =>
      (current[group]?.components ?? []).join("\n") === names.join("\n") &&
      (current[group]?.visible !== false) === names.length > 0,
  );

/**
 * Studio's Blocks panel: where the new block goes and a search above Puck's own component list.
 * The place and the search decide which blocks Puck lists, written to its `ui.componentList`
 * (its category lists, titled from the palette groups); the rows are drawn by `StudioDrawerItem`.
 * Each block drags with Puck's own drag and drop, or is added with its Add button.
 */
export function StudioBlocksPanel() {
  const { input, model } = useStudioCanvas();
  const screen = useStudioScreen();
  const palette = input.palette;
  // No page is open: the panel says so itself.
  if (palette === undefined || model.at === undefined || model.slot === undefined) return null;
  if (model.shown === undefined)
    return (
      <BlocksEmpty
        title="Blocks unavailable"
        description="Blocks can be added once this page has a compiled version, which follows shortly after your latest change is saved."
      />
    );
  if (palette.targets.kind !== "available")
    return (
      <BlocksEmpty
        title="Blocks unavailable"
        description={
          palette.targets.kind === "unsupported"
            ? "Blocks can't be added to this kind of page in Studio yet."
            : "This page is not in the current draft."
        }
      />
    );
  const at = model.at;
  return (
    <StudioBlocksDrawer
      targets={palette.targets.targets.filter(
        (target) => palette.owner === "layout" || target.area === at.key,
      )}
      blocked={blockedReason(model.editable, model.readOnlyCause, screen, input.disabledReason)}
      owner={palette.owner}
      message={palette.message}
      onAdd={palette.onAdd}
    />
  );
}

function StudioBlocksDrawer({
  targets,
  blocked,
  owner,
  message,
  onAdd,
}: Readonly<{
  /** The places of the content area the canvas shows. */
  targets: readonly StudioCompositionAddTarget[];
  blocked: string | undefined;
  /** A page's blocks also drag onto the canvas; a layout's blocks are added with Add. */
  owner: "page" | "layout";
  message: string;
  onAdd: (request: StudioCanvasAddRequest) => true | false | string;
}>) {
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const targetSelectId = useId();
  // An insert only needs an id that is unique while it is in flight.
  const instance = useId();
  const inserts = useRef(0);
  const getPuck = useGetPuck();
  const listed = usePuckSelector((state) => state.appState.ui.componentList);
  const target = targets.find((candidate) => candidate.id === targetId) ?? targets[0];
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
  const applied = sameLists(listed, lists);
  // Puck's list is drawn once its categories have been set the first time, and stays mounted
  // after, so a search or a place only changes what it lists (no remount, no lost scroll).
  const [listReady, setListReady] = useState(false);
  useEffect(() => {
    if (applied) setListReady(true);
  }, [applied]);
  // The place and the search choose the blocks Puck lists, one category per palette group; a
  // group with none is hidden, and no block is left over for Puck's own "Other" category.
  useEffect(() => {
    if (applied) return;
    const { appState, dispatch } = getPuck();
    const current = appState.ui.componentList;
    dispatch({
      type: "setUi",
      ui: {
        componentList: {
          ...Object.fromEntries(
            Object.entries(lists).map(([group, names]) => [
              group,
              { ...current[group], components: [...names], visible: names.length > 0 },
            ]),
          ),
          other: { ...current.other, visible: false },
        },
      },
      recordHistory: false,
    });
  }, [applied, lists, getPuck]);
  const add = useCallback(
    (choice: StudioPaletteChoice) => {
      if (target === undefined) return;
      const request: StudioCanvasAddRequest = {
        area: target.area,
        destination: target.destination,
        index: END_OF_SLOT,
        rendererKey: choice.rendererKey,
      };
      // A layout's blocks are not on the canvas, so Studio's add command takes the request itself.
      if (owner === "layout") {
        const outcome = onAdd(request);
        if (typeof outcome === "string") toast.error(outcome);
        return;
      }
      // A page's block is inserted at the end of the place like a drop is, so both reach the add
      // command through Puck's `insert` action.
      getPuck().dispatch({
        type: "insert",
        componentType: choice.rendererKey,
        destinationZone: zoneOfDestination(target.destination),
        destinationIndex: request.index,
        id: `${choice.rendererKey}-${instance}-${(inserts.current += 1)}`,
      });
    },
    [target, owner, onAdd, getPuck, instance],
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
  const context = useMemo(
    (): DrawerContextValue | null =>
      target === undefined ? null : { target, choices, blocked, limitReason, limitId, add },
    [target, choices, blocked, limitReason, limitId, add],
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
    <div className="flex flex-col gap-3" data-vortex-studio-palette="">
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
          {listReady ? (
            <div role="list" aria-label="Blocks">
              <Puck.Components />
            </div>
          ) : null}
        </DrawerContext.Provider>
      )}
    </div>
  );
}
