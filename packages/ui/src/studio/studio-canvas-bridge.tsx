"use client";

import { Puck, createUsePuck, useGetPuck, type Content, type Data } from "@puckeditor/core";
import { useEffect, useRef, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";
import type {
  ApplicationShell,
  ProjectedApplicationFrame,
  ProjectedNavigation,
} from "@vortex/platform/schema";
import type { Breakpoint } from "../definition-error";
import type { FieldInputControlReleaseMap, PlatformComponentRegistry } from "../registry";
import type { ApplicationTheme, PlatformThemeTokens } from "../theme";
import { PagePuckRenderer } from "../page-puck-renderer";

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
}>;

const usePuckSelector = createUsePuck();

/** A slot's items; a plain list setting is an array too, but of values, not items. */
const isContent = (value: unknown): value is Content =>
  Array.isArray(value) && value.every((entry) =>
    entry !== null && typeof entry === "object" && "type" in entry && "props" in entry);

type SlotOrder = Readonly<{ tablet?: readonly string[] | undefined; phone?: readonly string[] | undefined }>;

/**
 * The canvas shows a smaller screen in that screen's own order: the root slot's stored order and
 * each block's stored slot orders. The arrays are reordered for display only; a canvas showing
 * another size than desktop never sends its data back as an edit.
 */
export const puckDataForBreakpoint = (
  data: Data,
  breakpoint: Breakpoint,
  rootOrder: SlotOrder | undefined,
): Data => {
  if (breakpoint === "desktop") return data;
  const reorder = (content: Content, order: SlotOrder | undefined): Content => {
    const sequence = breakpoint === "phone" ? order?.phone ?? order?.tablet : order?.tablet;
    const position = new Map(sequence?.map((id, index) => [id, index]) ?? []);
    const sorted = sequence === undefined ? [...content] : [...content].sort((left, right) =>
      (position.get(String(left.props.id)) ?? 0) - (position.get(String(right.props.id)) ?? 0));
    return sorted.map((item) => {
      const orders = (item.props as { vortex?: { slot_orders?: Record<string, SlotOrder> } })
        .vortex?.slot_orders;
      return {
        ...item,
        props: Object.fromEntries(Object.entries(item.props).map(([key, value]) =>
          [key, key !== "id" && key !== "vortex" && isContent(value)
            ? reorder(value, orders?.[key]) : value])),
      };
    }) as Content;
  };
  return { ...data, content: reorder(data.content, rootOrder) };
};

const sameContent = (left: Data, right: Data): boolean =>
  JSON.stringify(left.content) === JSON.stringify(right.content);

/**
 * Runs inside Puck: keeps Puck's private state in step with the workspace draft and its shared
 * selection, and draws Puck's canvas in the application's frame. The workspace draft is the
 * source of truth; Puck only ever receives data derived from it.
 */
export function StudioCanvasBridge({
  data,
  resync,
  selectedAlias,
  onSelect,
  frame,
  breakpoint,
  registry,
  fieldInputControlReleases,
  platformThemeTokens,
}: Readonly<{
  data: Data;
  /** Changes when Puck holds a change the draft refused, so the draft is shown again. */
  resync: number;
  selectedAlias: string | null;
  /** Reports a canvas selection; `false` means the workspace kept its own selection. */
  onSelect: (alias: string | null) => Promise<boolean>;
  frame: StudioCanvasFrame | undefined;
  breakpoint: Breakpoint;
  registry: PlatformComponentRegistry;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
}>) {
  const getPuck = useGetPuck();
  const puckSelected = usePuckSelector((state) => {
    const id = state.selectedItem?.props.id;
    return typeof id === "string" ? id : null;
  });
  const selectedRef = useRef(selectedAlias);
  selectedRef.current = selectedAlias;
  // The selection the canvas and the workspace last agreed on. Each side reacts only to a change
  // away from it, so neither echoes the other's change back while that change is on its way.
  const agreed = useRef<string | null>(selectedAlias);

  const puckSelection = (): string | null => {
    const id = getPuck().selectedItem?.props.id;
    return typeof id === "string" ? id : null;
  };
  const showSelection = (alias: string | null) => {
    if (puckSelection() === alias) return;
    const { getSelectorForId, dispatch } = getPuck();
    const selector = alias === null ? null : getSelectorForId(alias);
    // A placement drawn elsewhere (another content area or the frame) clears the canvas selection.
    dispatch({ type: "setUi", ui: { itemSelector: selector ?? null } });
  };

  // The workspace draft changed (an edit, Undo, Redo, a save or Revert): show exactly that draft,
  // keeping the selected block selected while it is still on the canvas.
  useEffect(() => {
    const { appState, dispatch } = getPuck();
    if (sameContent(appState.data, data)) return;
    const kept = puckSelection();
    dispatch({ type: "setData", data: { ...appState.data, root: data.root, content: data.content } });
    showSelection(kept);
  }, [data, resync]);

  // The outline or the inspector selected something: select it on the canvas too.
  useEffect(() => {
    if (selectedAlias === agreed.current) return;
    agreed.current = selectedAlias;
    showSelection(selectedAlias);
  }, [selectedAlias]);

  // A click on the canvas selects the block in the outline and the inspector.
  useEffect(() => {
    if (puckSelected === agreed.current) return;
    agreed.current = puckSelected;
    void onSelect(puckSelected).then((accepted) => {
      if (accepted || agreed.current !== puckSelected) return;
      agreed.current = selectedRef.current;
      showSelection(selectedRef.current);
    });
  }, [puckSelected]);

  // The canvas is a design surface: no link in it (menu pages, external addresses, links inside
  // blocks) leaves Studio, so unsaved edits are never lost to a click.
  const inert = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest("a[href]") !== null) event.preventDefault();
  };
  // The canvas is the frame's page outlet, edited: the frame keeps its region while the page is empty,
  // and empty slots of the page's blocks stay, so each remains a drop target.
  const canvas = <div data-vortex-studio-canvas="" data-vortex-shell-outlet="" data-vortex-editing="" className="min-h-24">
    <Puck.Preview id="vortex-studio-canvas" /></div>;
  if (frame === undefined)
    return <div className="contents" onClickCapture={inert} onAuxClickCapture={inert}>{canvas}</div>;
  const shellId = frame.frame.shellId;
  const shell = shellId === undefined ? undefined
    : frame.shells.find((candidate) => String(candidate.shellId) === shellId);
  const ignoreNavigation = (_pageId: string, event: MouseEvent<HTMLAnchorElement>) => event.preventDefault();
  return (
    <div className="contents" data-vortex-studio-frame="" onClickCapture={inert} onAuxClickCapture={inert}>
    <PagePuckRenderer
      composition={frame.frame}
      breakpoint={breakpoint}
      registry={registry}
      fieldInputControlReleases={fieldInputControlReleases}
      platformThemeTokens={platformThemeTokens}
      {...(shell === undefined ? {} : { shell })}
      theme={frame.theme}
      projectedNavigation={frame.navigation}
      resolvePageHref={() => "#"}
      onNavigatePage={ignoreNavigation}
      currentPageId={frame.pageId}
      applicationShellRuntime={{
        applicationName: frame.applicationName,
        applicationHref: "#",
        organizationName: "",
        pageName: frame.pageName,
        // The switcher names only the application being designed.
        applicationSwitcherState: "available",
        applications: [{ key: frame.applicationName, name: frame.applicationName, href: "#" }],
      }}
      outlet={{ location: frame.frame.outlet, content: canvas as ReactNode }}
    />
    </div>
  );
}
