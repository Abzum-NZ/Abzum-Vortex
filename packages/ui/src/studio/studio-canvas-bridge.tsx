"use client";

import { createUsePuck, useGetPuck, type Content, type Data } from "@puckeditor/core";
import { useEffect, useRef, type RefObject } from "react";
import type {
  ApplicationShell,
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
}>;

const usePuckSelector = createUsePuck();

/** A slot's items; a plain list setting is an array too, but of values, not items. */
const isContent = (value: unknown): value is Content =>
  Array.isArray(value) &&
  value.every(
    (entry) => entry !== null && typeof entry === "object" && "type" in entry && "props" in entry,
  );

type SlotOrder = Readonly<{
  tablet?: readonly string[] | undefined;
  phone?: readonly string[] | undefined;
}>;

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
  return { ...data, content: reorder(data.content, rootOrder) };
};

const sameContent = (left: Data, right: Data): boolean =>
  JSON.stringify(left.content) === JSON.stringify(right.content);

/**
 * Runs inside Puck and draws nothing: it keeps Puck's private state in step with the workspace
 * draft and its shared selection, and Puck's preview mode in step with the toolbar. The workspace
 * draft is the source of truth; Puck only ever receives data derived from it.
 */
export function StudioCanvasBridge({
  arrangeGrid,
  onArrangeGrid,
  data,
  resync,
  synchronizing,
  selectedAlias,
  onSelect,
  onDragging,
}: Readonly<{
  arrangeGrid: boolean;
  /** Puck's own hotkey changed the preview mode: the toolbar follows. */
  onArrangeGrid: (arrange: boolean) => void;
  data: Data;
  /** Changes when Puck holds a change the draft refused, so the draft is shown again. */
  resync: number;
  /** Prevents Puck's synchronous change callbacks from echoing intermediate draft updates. */
  synchronizing: RefObject<boolean>;
  selectedAlias: string | null;
  /** Reports a canvas selection; `false` means the workspace kept its own selection. */
  onSelect: (alias: string | null) => Promise<boolean>;
  /** A block is being dragged (from the palette or on the canvas). */
  onDragging?: ((dragging: boolean) => void) | undefined;
}>) {
  const getPuck = useGetPuck();
  const puckSelected = usePuckSelector((state) => {
    const id = state.selectedItem?.props.id;
    return typeof id === "string" ? id : null;
  });
  const previewMode = usePuckSelector((state) => state.appState.ui.previewMode);
  const dragging = usePuckSelector((state) => state.appState.ui.isDragging);
  const recorded = usePuckSelector((state) => state.history.histories.length);
  // Studio's draft history is the one undo. Puck records its own drags and deletes and answers
  // Ctrl+Z / Ctrl+Y with its older states, which Studio would then take as new edits, so Puck's
  // history is kept at the current state alone and its Undo and Redo have nothing to go back to.
  useEffect(() => {
    const { history, appState, dispatch } = getPuck();
    // The newest entry carries Puck's indexes, so setting it is cheap and warns of nothing.
    const kept = history.histories[history.histories.length - 1];
    if (history.histories.length <= 1 || kept === undefined) return;
    // Puck records 250 ms after an action, so the entry can be older than the screen: what Studio
    // pushed since (the real block after a palette drop, a refused change shown again, an Undo, a
    // selection) is put back, and Studio's own `change` is held while it is.
    synchronizing.current = true;
    try {
      history.setHistories([kept]);
      if (kept.state.data !== appState.data)
        dispatch({ type: "setData", data: () => appState.data, recordHistory: false });
      if (kept.state.ui !== appState.ui) dispatch({ type: "setUi", ui: appState.ui });
    } finally {
      synchronizing.current = false;
    }
  }, [recorded]);
  useEffect(() => {
    onDragging?.(dragging);
  }, [dragging]);
  const selectedRef = useRef(selectedAlias);
  selectedRef.current = selectedAlias;
  // The selection the canvas and the workspace last agreed on. Each side reacts only to a change
  // away from it, so neither echoes the other's change back while that change is on its way.
  // It starts empty: a canvas opened with a block already selected (from another tab, a "Used in"
  // entry or "Show me where") selects that block on its first render.
  const agreed = useRef<string | null>(null);
  // The canvas's own empty selection before it ever selected a block is not a click, so it is not reported.
  const everSelected = useRef(false);

  // The toolbar owns the mode; Puck's own hotkey for it is reported back, so both agree.
  useEffect(() => {
    getPuck().dispatch({
      type: "setUi",
      ui: { previewMode: arrangeGrid ? "interactive" : "edit" },
    });
  }, [arrangeGrid, getPuck]);
  useEffect(() => {
    if ((previewMode === "interactive") !== arrangeGrid)
      onArrangeGrid(previewMode === "interactive");
  }, [previewMode]);

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
  // keeping the selected block selected while it is still on the canvas. One Puck action replaces
  // the data; it is draft synchronization, not an entry in Puck's separate history.
  useEffect(() => {
    const { appState, dispatch } = getPuck();
    if (
      sameContent(appState.data, data) &&
      JSON.stringify(appState.data.root) === JSON.stringify(data.root)
    )
      return;
    const kept = puckSelection();
    synchronizing.current = true;
    try {
      // One walk of the data per outside draft change (an edit, Undo, Revert); the function form is
      // the same action without Puck's warning about the object form.
      dispatch({ type: "setData", data: () => data, recordHistory: false });
      showSelection(kept);
    } finally {
      synchronizing.current = false;
    }
  }, [data, resync]);

  // The outline or the inspector selected something: select it on the canvas too.
  useEffect(() => {
    if (selectedAlias === agreed.current) return;
    agreed.current = selectedAlias;
    showSelection(selectedAlias);
    // Chosen outside the canvas (the outline, the inspector): bring the block into the frame's view.
    if (selectedAlias !== null)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLIFrameElement>("iframe#preview-frame")
          ?.contentDocument?.querySelector(`[data-puck-component="${CSS.escape(selectedAlias)}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
  }, [selectedAlias]);

  // A click on the canvas selects the block in the outline and the inspector.
  useEffect(() => {
    if (puckSelected !== null) everSelected.current = true;
    else if (!everSelected.current) return;
    if (puckSelected === agreed.current) return;
    agreed.current = puckSelected;
    void onSelect(puckSelected).then((accepted) => {
      if (accepted || agreed.current !== puckSelected) return;
      agreed.current = selectedRef.current;
      showSelection(selectedRef.current);
    });
  }, [puckSelected]);

  return null;
}
