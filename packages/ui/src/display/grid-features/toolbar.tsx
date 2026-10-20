"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
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
import { Kbd } from "../../components/kbd";
import { ToggleGroup, ToggleGroupItem } from "../../components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/tooltip";
import { Icon } from "../../icons/icon";
import { LAYOUT_BREAKPOINT_MEDIA } from "../../layout-styles";
import type { GridLayoutControls } from "../table-layout";

const DENSITY_LABELS: Readonly<Record<RecordsTableDensity, string>> = Object.freeze({
  comfortable: "Comfortable",
  compact: "Compact",
});

/** The full screen shortcut, as the tooltip shows it and as `aria-keyshortcuts` names it. */
const FULL_SCREEN_KEYS = "Ctrl+Shift+F";
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
  // portalled outside the table, so their own Escape never reaches this listener.
  useEffect(() => {
    const element = container.current;
    if (element === null || !allowed) return;
    const onKeyDown = (event: KeyboardEvent): void => {
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
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
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

const PHONE_QUERY = LAYOUT_BREAKPOINT_MEDIA.phone;
const subscribeToPhone = (notify: () => void): (() => void) => {
  const media = window.matchMedia(PHONE_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const usePhone = (): boolean =>
  useSyncExternalStore(
    subscribeToPhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );

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
  /**
   * The bulk actions over the selection and the selection band, when the projection offers them;
   * the band takes a row of its own below the toolbar.
   */
  selectionBanner: ReactNode;
  /** The layout controls (density, columns) show when the page has rows to arrange. */
  layoutControls: (ColumnChoicesProps & Readonly<{ layout: GridLayoutControls }>) | undefined;
  /** Full screen, when the block allows it. */
  fullScreen: GridFullScreen | undefined;
}>;

/**
 * The one toolbar of the Records table, in a fixed order: the projected features' items (search,
 * filter chips, view switcher), then density, columns and full screen. Feature items show only when
 * the viewer's projection turns the feature on; density, columns and full screen are the table's
 * own and read nothing. On a phone the table's own controls fold into one More menu so the toolbar
 * stays usable at 390 pixels.
 */
export function GridToolbar({
  accessibleName,
  featureItems,
  selectionBanner,
  layoutControls,
  fullScreen,
}: GridToolbarProps): ReactElement {
  const phone = usePhone();
  const fullScreenLabel = fullScreen?.active === true ? "Exit full screen" : "Full screen";
  const own = ((): ReactNode => {
    if (layoutControls === undefined && fullScreen === undefined) return null;
    if (phone)
      return (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      ref={fullScreen?.buttonRef}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More tools for ${accessibleName}`}
                    />
                  }
                />
              }
            >
              <Icon name="more-horizontal" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-48">
            {layoutControls === undefined ? null : (
              <>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Row density</DropdownMenuLabel>
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
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Icon name="sliders-horizontal" aria-hidden="true" />
                    Columns
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <ColumnChoices {...layoutControls} />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
            {fullScreen === undefined ? null : (
              <>
                {layoutControls === undefined ? null : <DropdownMenuSeparator />}
                <DropdownMenuItem onClick={fullScreen.toggle}>
                  <Icon name={fullScreen.active ? "minimize" : "maximize"} aria-hidden="true" />
                  {fullScreenLabel}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    return (
      <>
        {layoutControls === undefined ? null : (
          <>
            <ToggleGroup
              aria-label={`Row density of ${accessibleName}`}
              variant="outline"
              size="sm"
              value={[layoutControls.layout.density]}
              onValueChange={(values: unknown[]) => {
                // Pressing the chosen density again keeps it: one density is always chosen.
                const density = pickDensity(values[0]);
                if (density === undefined) return;
                layoutControls.layout.setDensity(density);
                layoutControls.announce(`${DENSITY_LABELS[density]} rows`);
              }}
            >
              {recordsTableDensities.map((density) => (
                <ToggleGroupItem key={density} value={density}>
                  {DENSITY_LABELS[density]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="sm" aria-label={`Columns of ${accessibleName}`} />
                }
              >
                <Icon name="sliders-horizontal" data-icon="inline-start" aria-hidden="true" />
                Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <ColumnChoices {...layoutControls} />
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {fullScreen === undefined ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  ref={fullScreen.buttonRef}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={fullScreenLabel}
                  aria-keyshortcuts={FULL_SCREEN_ARIA_KEYS}
                  onClick={fullScreen.toggle}
                />
              }
            >
              <Icon name={fullScreen.active ? "minimize" : "maximize"} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent className="flex items-center gap-2">
              {fullScreenLabel}
              <Kbd>{fullScreen.active ? "Esc" : FULL_SCREEN_KEYS}</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </>
    );
  })();
  return (
    <div className="mb-2 flex shrink-0 flex-wrap items-end gap-2">
      {featureItems}
      {selectionBanner}
      {own === null ? null : <div className="ms-auto flex flex-wrap items-center gap-2">{own}</div>}
    </div>
  );
}
