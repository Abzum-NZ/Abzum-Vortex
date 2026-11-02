"use client";

import { Puck, createUsePuck, useGetPuck } from "@puckeditor/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
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
import { Icon, resolveVortexIconName } from "../icons";
import { cn } from "../lib/utils";
import type { StudioCompositionAddTarget } from "./application-composition-commands";
import { studioPaletteComponentLists, type StudioPaletteChoice } from "./contextual-palette";
import { zoneOfDestination } from "./studio-canvas-data";
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
  add: (choice: StudioPaletteChoice) => void;
}>;

const DrawerContext = createContext<DrawerContextValue | null>(null);

/**
 * Whether a drawer row is the copy Puck keeps under the draggable one (it draws every item twice
 * and gives only the top copy a drag reference and a test id). The copy is hidden from keyboard
 * and assistive technology so each block is offered once.
 */
function useUnderlayRow(): Readonly<{
  underlay: boolean;
  mark: (element: HTMLElement | null) => void;
}> {
  const [underlay, setUnderlay] = useState(false);
  const mark = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    setUnderlay(element.closest("[data-puck-drawer-item]")?.getAttribute("data-testid") === "");
  }, []);
  return { underlay, mark };
}

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
  const reasonId = useId();
  const { underlay, mark } = useUnderlayRow();
  const draggable = usePuckSelector((state) => state.getPermissions({ type: name }).insert);
  const choice = drawer?.choices.get(name);
  if (drawer === null || choice === undefined) return <>{children}</>;
  const reason = drawer.blocked ?? choice.unavailable;
  const label = `Add ${choice.name} to ${drawer.target.label}`;
  return (
    <Item
      ref={mark}
      size="sm"
      variant="outline"
      className={cn("flex-nowrap", draggable ? "cursor-grab active:cursor-grabbing" : "opacity-70")}
      {...(underlay ? { inert: true, "aria-hidden": true } : {})}
    >
      <ItemMedia variant="icon">
        <Icon name={resolveVortexIconName(choice.icon) ?? "blocks"} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{choice.name}</ItemTitle>
        <ItemDescription className="line-clamp-1">{choice.description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                aria-disabled={reason === undefined ? undefined : true}
                aria-describedby={reason === undefined ? undefined : reasonId}
                onClick={(event) => {
                  if (reason !== undefined) {
                    event.preventDefault();
                    return;
                  }
                  drawer.add(choice);
                }}
              />
            }
          >
            <Icon name="plus" />
          </TooltipTrigger>
          <TooltipContent>{reason ?? `Add ${choice.name}`}</TooltipContent>
        </Tooltip>
        {reason === undefined ? null : (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
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

/** Why the canvas takes no new block now, in the words the Add button says it with. */
const blockedReason = (
  editable: boolean,
  readOnlyCause: string | undefined,
  breakpoint: "desktop" | "tablet" | "phone",
): string | undefined => {
  if (editable) return undefined;
  if (breakpoint !== "desktop") return "Blocks are added on the Desktop screen size.";
  if (readOnlyCause !== undefined) return "This page is shown read-only, so blocks can't be added.";
  return "Studio is busy; try again in a moment.";
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
      blocked={blockedReason(model.editable, model.readOnlyCause, input.breakpoint)}
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
  onAdd: (request: StudioCanvasAddRequest) => boolean;
}>) {
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState("");
  const targetSelectId = useId();
  const getPuck = useGetPuck();
  const listed = usePuckSelector((state) => state.appState.ui.componentList);
  const target = targets.find((candidate) => candidate.id === targetId) ?? targets[0];
  const lists = useMemo(
    () => studioPaletteComponentLists(target?.choices ?? [], search),
    [target, search],
  );
  const choices = useMemo(
    () => new Map((target?.choices ?? []).map((choice) => [choice.rendererKey, choice])),
    [target],
  );
  const shown = Object.values(lists).reduce((total, names) => total + names.length, 0);
  const applied = sameLists(listed, lists);
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
        onAdd(request);
        return;
      }
      // A page's block is inserted at the end of the place like a drop is, so both reach the add
      // command through Puck's `insert` action.
      getPuck().dispatch({
        type: "insert",
        componentType: choice.rendererKey,
        destinationZone: zoneOfDestination(target.destination),
        destinationIndex: request.index,
        id: `${choice.rendererKey}-${crypto.randomUUID()}`,
      });
    },
    [target, owner, onAdd, getPuck],
  );
  const context = useMemo(
    (): DrawerContextValue | null =>
      target === undefined ? null : { target, choices, blocked, add },
    [target, choices, blocked, add],
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
          items={targets.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
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
                <span style={{ paddingInlineStart: `${candidate.depth * 0.75}rem` }}>
                  {candidate.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <InputGroup data-vortex-focus-group="">
        <InputGroupAddon>
          <Icon name="search" />
        </InputGroupAddon>
        <InputGroupInput
          data-vortex-focus-primary=""
          type="search"
          value={search}
          aria-label="Search blocks"
          placeholder="Search blocks"
          onChange={(event) => setSearch(event.target.value)}
        />
      </InputGroup>
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
          {applied ? <Puck.Components /> : null}
        </DrawerContext.Provider>
      )}
    </div>
  );
}
