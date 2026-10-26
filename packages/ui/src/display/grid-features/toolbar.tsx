"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { recordsTableDensities, type RecordsTableDensity } from "@vortex/platform/schema";
import { Button } from "../../components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Icon } from "../../icons/icon";
import type { GridLayoutControls } from "../table-layout";

const DENSITY_LABELS: Readonly<Record<RecordsTableDensity, string>> = Object.freeze({
  comfortable: "Comfortable",
  compact: "Compact",
});

/** The full screen shortcut, as the tooltip shows it and as `aria-keyshortcuts` names it. */
const FULL_SCREEN_ARIA_KEYS = "Control+Shift+F Meta+Shift+F";

/** The classes of a table expanded to fill the window, as an in-app layer over the page. */
export const FULL_SCREEN_CLASS =
  "fixed inset-0 z-50 flex flex-col overflow-hidden bg-background p-4";

/** Keys inside a cell's own control or a text box keep their meaning; Escape there is not "leave". */
const ownsEscape = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest("input,textarea,select,[contenteditable='true']") !== null) return true;
  const cell = target.closest("[data-grid-cell]");
  return cell !== null && cell !== target;
};

export type GridFullScreen = Readonly<{
  active: boolean;
  toggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}>;

/**
 * Full screen for one table. The table stays the same React tree and only changes its classes, so
 * scroll, selection and an open editor are kept on the way in and out. It fills the window as an
 * in-app layer and, where the browser allows it, also asks the browser for full screen on the
 * page: menus, tooltips and dialogs portal to the page, so they stay visible. Escape (the browser's
 * own, or in the layer) and the shortcut leave; focus returns to the Full screen button. Nothing is
 * read on the way in or out.
 */
export function useGridFullScreen(
  container: RefObject<HTMLElement | null>,
  allowed: boolean,
  announce: (message: string) => void,
): GridFullScreen {
  const [active, setActive] = useState(false);
  const browser = useRef(false);
  const restoreFocus = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const leave = useCallback(() => {
    if (!activeRef.current) return;
    setActive(false);
    restoreFocus.current = true;
    announce("Left full screen");
    if (browser.current) {
      browser.current = false;
      if (document.fullscreenElement === document.documentElement)
        document.exitFullscreen().catch((error: unknown) => {
          console.error("[display] the browser did not leave full screen", error);
        });
    }
  }, [announce]);
  const enter = useCallback(() => {
    if (activeRef.current) return;
    setActive(true);
    announce("Full screen. Press Escape to leave");
    const root = document.documentElement;
    if (document.fullscreenEnabled && document.fullscreenElement === null) {
      browser.current = true;
      // A refusal (a policy or a frame without permission) keeps the in-app layer.
      root.requestFullscreen().catch(() => {
        browser.current = false;
      });
    }
  }, [announce]);
  const toggle = useCallback(() => (activeRef.current ? leave() : enter()), [enter, leave]);

  // The browser's own Escape ends its full screen; the layer follows.
  useEffect(() => {
    const onChange = (): void => {
      if (browser.current && document.fullscreenElement === null) {
        browser.current = false;
        leave();
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [leave]);

  // The shortcut toggles from anywhere inside the table; Escape leaves the in-app layer. Menus are
  // portalled outside the table, so their own Escape never reaches this listener. It listens on the
  // document and reads the table's element on each key: a lazily loaded grid feature mounts that
  // element again after this effect has run, and a listener on the first one would never fire.
  useEffect(() => {
    if (!allowed) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const element = container.current;
      if (element === null || !(event.target instanceof Node) || !element.contains(event.target))
        return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        toggle();
        return;
      }
      if (event.key === "Escape" && activeRef.current && !ownsEscape(event.target)) {
        event.preventDefault();
        leave();
      }
    };
    // Capture keeps the order the table's own listener had: before the grid's React handlers.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [container, allowed, toggle, leave]);

  // A table that stops allowing full screen, or unmounts, leaves it.
  useEffect(() => {
    if (!allowed) leave();
  }, [allowed, leave]);
  useEffect(
    () => () => {
      if (browser.current && document.fullscreenElement === document.documentElement)
        void document.exitFullscreen().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (active || !restoreFocus.current) return;
    restoreFocus.current = false;
    buttonRef.current?.focus();
  }, [active]);

  return { active, toggle, buttonRef };
}

type ColumnChoicesProps = Readonly<{
  layout: GridLayoutControls;
  /** The columns the shown page carries values for, lower-cased. */
  loadedKeys: ReadonlySet<string>;
  /** Whether the host can read the page again, so a column it was read without can be shown. */
  canRead: boolean;
  announce: (message: string) => void;
}>;

/**
 * The declared columns to show or hide, and Reset layout. Every choice changes the grid at once
 * and is stored as the person's own layout; none reads records, except showing a column the page
 * was read without, which reads the same page again with it. A hidden column's values are never
 * sent: the next read leaves it out.
 */
function ColumnChoices({
  layout,
  loadedKeys,
  canRead,
  announce,
}: ColumnChoicesProps): ReactElement {
  const shownCount = layout.entries.filter((entry) => entry.visible).length;
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        {layout.entries.map((entry) => (
          <DropdownMenuCheckboxItem
            key={entry.key}
            checked={entry.visible}
            // One column always stays shown; a column the page was read without needs a read.
            disabled={
              (entry.visible && shownCount <= 1) ||
              (!entry.visible && !loadedKeys.has(entry.key) && !canRead)
            }
            onCheckedChange={(checked: boolean) => {
              layout.setVisible(entry.key, checked);
              announce(`${entry.label} ${checked ? "shown" : "hidden"}`);
            }}
          >
            {entry.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!layout.arranged}
        onClick={() => {
          layout.reset();
          announce("Layout reset");
        }}
      >
        Reset layout
      </DropdownMenuItem>
    </>
  );
}

const pickDensity = (value: unknown): RecordsTableDensity | undefined =>
  recordsTableDensities.find((candidate) => candidate === value);

export type GridToolbarProps = Readonly<{
  accessibleName: string;
  /** What the projected grid features draw first: search, filter chips, the view switcher. */
  featureItems: ReactNode;
  overflowItems: ReactNode;
  selectionActive: boolean;
  refresh: (() => void) | undefined;
  /**
   * The bulk actions over the selection and the selection band, when the projection offers them;
   * these replace the ordinary controls inside the same toolbar row.
   */
  selectionBanner: ReactNode;
  /** The layout controls (density, columns) show when the page has rows to arrange. */
  layoutControls: (ColumnChoicesProps & Readonly<{ layout: GridLayoutControls }>) | undefined;
  /** Full screen, when the block allows it. */
  fullScreen: GridFullScreen | undefined;
}>;

type ToolbarArea = "supplement";
type ToolbarSlots = Record<ToolbarArea, HTMLElement | null>;
const ToolbarContext = createContext<Readonly<{
  slots: ToolbarSlots;
  setSlot: (area: ToolbarArea, element: HTMLElement | null) => void;
  find: (() => void) | undefined;
  setFind: (action: (() => void) | undefined) => void;
}> | null>(null);

/** Interactions stay with the grid while their controls fill its one toolbar. */
export function GridToolbarScope({ children }: Readonly<{ children: ReactNode }>): ReactElement {
  const [slots, setSlots] = useState<ToolbarSlots>({ supplement: null });
  const [find, holdFind] = useState<(() => void) | undefined>(undefined);
  const setFind = useCallback((action: (() => void) | undefined): void => {
    holdFind(() => action);
  }, []);
  const setSlot = useCallback((area: ToolbarArea, element: HTMLElement | null): void => {
    setSlots((held) => (held[area] === element ? held : { ...held, [area]: element }));
  }, []);
  return <ToolbarContext value={{ slots, setSlot, find, setFind }}>{children}</ToolbarContext>;
}

/** Menu items render under their menu's context; the grid interaction supplies the command. */
export function useGridToolbarFind(action: () => void): void {
  const setFind = useContext(ToolbarContext)?.setFind;
  useEffect(() => {
    setFind?.(action);
    return () => setFind?.(undefined);
  }, [action, setFind]);
}

export function GridToolbarSlot({
  area,
  children,
}: Readonly<{ area: ToolbarArea; children: ReactNode }>): ReactNode {
  const toolbar = useContext(ToolbarContext);
  const target = toolbar?.slots[area];
  return target == null ? null : createPortal(children, target);
}

/**
 * The one toolbar of the Records table, in a fixed order: the projected features' items (search,
 * filter chips, view switcher), then Columns with density, and the overflow menu. Selection fills
 * the same row. Spreadsheet interactions fill slots without drawing controls over the grid body.
 */
export function GridToolbar({
  accessibleName,
  featureItems,
  overflowItems,
  selectionBanner,
  selectionActive,
  refresh,
  layoutControls,
  fullScreen,
}: GridToolbarProps): ReactElement {
  const toolbar = useContext(ToolbarContext);
  const setSlot = toolbar?.setSlot;
  const supplementRef = useCallback(
    (element: HTMLDivElement | null) => setSlot?.("supplement", element),
    [setSlot],
  );
  const fullScreenLabel = fullScreen?.active === true ? "Exit full screen" : "Full screen";
  return (
    <div
      role="group"
      aria-label={`Tools for ${accessibleName}`}
      className="mb-2 flex h-11 min-w-0 shrink-0 items-center gap-2 overflow-x-auto whitespace-nowrap"
    >
      <div className={selectionActive ? "flex min-w-max flex-1 items-center gap-2" : "hidden"}>
        {selectionBanner}
      </div>
      <div className={selectionActive ? "hidden" : "flex min-w-max flex-1 items-center gap-2"}>
        {featureItems}
      </div>
      <div
        ref={supplementRef}
        className={selectionActive ? "hidden" : "flex min-w-0 shrink-0 items-center gap-2"}
      />
      {selectionActive ? null : (
        <>
          {refresh === undefined ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Refresh ${accessibleName}`}
                    onClick={refresh}
                  />
                }
              >
                <Icon name="redo" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
          )}
          {layoutControls === undefined ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="sm" aria-label={`Columns of ${accessibleName}`} />
                }
              >
                <Icon name="sliders-horizontal" aria-hidden="true" />
                Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ColumnChoices {...layoutControls} />
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Row density</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={layoutControls.layout.density}
                      onValueChange={(value: unknown) => {
                        const density = pickDensity(value);
                        if (density === undefined) return;
                        layoutControls.layout.setDensity(density);
                        layoutControls.announce(`${DENSITY_LABELS[density]} rows`);
                      }}
                    >
                      {recordsTableDensities.map((density) => (
                        <DropdownMenuRadioItem key={density} value={density}>
                          {DENSITY_LABELS[density]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  ref={fullScreen?.buttonRef}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More tools for ${accessibleName}`}
                />
              }
            >
              <Icon name="more-horizontal" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {overflowItems}
              {toolbar?.find === undefined ? null : (
                <DropdownMenuItem onClick={toolbar.find}>
                  <Icon name="search" aria-hidden="true" />
                  Find on page
                </DropdownMenuItem>
              )}
              {fullScreen === undefined ? null : (
                <DropdownMenuItem
                  aria-keyshortcuts={FULL_SCREEN_ARIA_KEYS}
                  onClick={fullScreen.toggle}
                >
                  <Icon name={fullScreen.active ? "minimize" : "maximize"} aria-hidden="true" />
                  {fullScreenLabel}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
