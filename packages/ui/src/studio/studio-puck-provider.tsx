"use client";

import {
  Puck,
  createUsePuck,
  useGetPuck,
  type AppState,
  type Config,
  type Data,
  type PuckAction,
} from "@puckeditor/core";
import "@puckeditor/core/no-external.css";
import {
  compiledItemSettings,
  definitionLimitReached,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { Breakpoint } from "../definition-error";
import type { FieldInputControlReleaseMap } from "../registry";
import type { PlatformThemeTokens } from "../theme";
import type { StudioCompileFailure } from "./compile-failure";
import type {
  StudioCompositionAddTargetsModel,
  StudioCompositionDestination,
  StudioCompositionOwner,
} from "./application-composition-commands";
import type { StudioCanvasFrame } from "./studio-canvas-projection";
import { applyStudioCanvasChange } from "./studio-canvas-change";
import {
  destinationOfZone,
  itemsHold,
  puckItemsHold,
  puckSelectedAlias,
  withoutEmptyPuckZones,
  type StudioCanvasCompiledSlot,
  type StudioPuckSelector,
} from "./studio-canvas-data";
import { studioCanvasOverrides } from "./studio-canvas-actions";
import type { StudioCanvasGridChange, StudioCanvasGridRead } from "./studio-canvas-grid";
import { useStudioCanvasModel, type StudioCanvasModel } from "./studio-canvas-model";
import {
  studioInitialBreakpoint,
  studioInitialUi,
  studioScreenOfWidth,
  studioViewports,
} from "./studio-canvas-screen";
import {
  StudioCanvasChannelContext,
  type StudioCanvasMetadata,
  type StudioCanvasViewer,
} from "./studio-canvas-metadata";
import { StudioDrawerItem } from "./studio-puck-drawer";
import { studioPuckWords } from "./studio-puck-words";
import type { StudioCanvasRecordsReader } from "./use-studio-canvas-records";
import { useStudioCanvasChannelValue } from "./use-studio-canvas-channel";
import { studioCanvasReferences, type StudioCanvasReferences } from "./studio-canvas-permissions";
import { sameCompositionValue } from "./composition-references";

export { studioScreens, useStudioScreen } from "./studio-canvas-screen";
export type { StudioCanvasFrame } from "./studio-canvas-projection";
export type { StudioCanvasViewer } from "./studio-canvas-metadata";
export type {
  StudioCanvasRecordsRead,
  StudioCanvasRecordsReader,
} from "./use-studio-canvas-records";

/** A new block for one place on the page, from a drop on the canvas or the drawer's Add button. */
export type StudioCanvasAddRequest = Readonly<{
  area: string;
  destination: StudioCompositionDestination;
  /** The position in the slot; a position past its end adds the block last. */
  index: number;
  /** The Puck component the person dragged or chose: the block's renderer key. */
  rendererKey: string;
}>;

/** Studio's block palette: where a new block can go and how Studio adds it. */
export type StudioCanvasPalette = Readonly<{
  /** The places on the open page a new block can go. */
  targets: StudioCompositionAddTargetsModel;
  /** Whose blocks the palette adds to: the open page's content areas, or its layout. */
  owner: StudioCompositionOwner["kind"];
  message: string;
  /** Adds a block through Studio's one add command; `false` when nothing was added yet. */
  /** `true` when the block was added, `false` when nothing was added yet (its setup is asked), or why it was refused. */
  onAdd: (request: StudioCanvasAddRequest) => true | false | string;
}>;

export type StudioPuckInput = Readonly<{
  source: ApplicationSourceDocument;
  compiledSource: ApplicationSourceDocument;
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  /** Absent until the draft's canvas view has loaded. */
  fieldInputControlReleases: FieldInputControlReleaseMap | null;
  platformThemeTokens: PlatformThemeTokens | null;
  /** The page on the canvas; `undefined` when the workspace shows no page. */
  pageAlias: string | undefined;
  /** The compiled items of each content area of this page, keyed by page slot address key. */
  compiledSlots?: Readonly<Record<string, StudioCanvasCompiledSlot>> | undefined;
  disabled: boolean;
  /** Why the draft takes no change now (a conflict, a publication), when `disabled` says it does not. */
  disabledReason?: string | undefined;
  /** Why the saved draft would not compile; the page stays open so the cause can be corrected. */
  compileFailure?: StudioCompileFailure | null | undefined;
  onChange: (expectedSource: ApplicationSourceDocument, source: ApplicationSourceDocument) => void;
  /** The block selected in the workspace, shown selected on the canvas. */
  selectedPlacementAlias: string | null;
  /** A block clicked on the canvas (`null`: the page itself); `false` keeps the workspace selection. */
  onSelectPlacement: (alias: string | null) => Promise<boolean>;
  /** Whether the open rail tab shows the canvas. Elsewhere nothing is selected and nothing can change. */
  canvasShown: boolean;
  appearance: "light" | "dark";
  /** The application frame the page is drawn inside, when the draft compiled. */
  frame?: StudioCanvasFrame | undefined;
  /** Reads the records of one content area's data blocks for the saved revision, once. */
  readRecords?: StudioCanvasRecordsReader | undefined;
  /** A newer saved revision than `compiledSource` is being compiled. */
  updating?: boolean | undefined;
  /** The role the canvas previews, hiding what it may not see; `null` or absent is the design view. */
  viewer?: StudioCanvasViewer | null | undefined;
  /** Lets the normal grid controls arrange its live canvas preview. */
  arrangeGrid?: boolean | undefined;
  /** Puck's own hotkey for the preview mode changed it; the toolbar follows. */
  onArrangeGrid?: ((arrange: boolean) => void) | undefined;
  /** Reports whether any data grid on the open page has columns to arrange. */
  onArrangeableGrids?: ((arrangeable: boolean) => void) | undefined;
  /** The one channel the grid's layout, sort, filter, search and refresh events arrive on. */
  onGridChange?: ((change: StudioCanvasGridChange) => void) | undefined;
  /** The query state and projection each grid is read with; changes only when a grid is read again. */
  gridReads?: Readonly<Record<string, StudioCanvasGridRead>> | undefined;
  /** The block palette; absent when no page is open. */
  palette?: StudioCanvasPalette | undefined;
}>;

/**
 * What the workspace must not change while a block is being dragged: the rail tab and the open
 * page. The drag lives in the canvas preview, which a change would unmount under it. The latest
 * request made during the drag is kept and applied once the drop has settled.
 */
export type StudioDragGate = { dragging: boolean; pending: (() => void) | null };

/** The gate of one workspace: create it once and hand it to `StudioPuckProvider`. */
export const useStudioDragGate = (): RefObject<StudioDragGate> =>
  useRef<StudioDragGate>({ dragging: false, pending: null });

/** Applies `apply` now, or after the drag in progress has dropped. */
export const whenNotDragging = (gate: RefObject<StudioDragGate>, apply: () => void): void => {
  if (gate.current.dragging) gate.current.pending = apply;
  else apply();
};

/** What the canvas and the palette read from the one Puck editor around the workspace. */
export type StudioCanvasContextValue = Readonly<{
  input: StudioPuckInput;
  model: StudioCanvasModel;
  /** Why a block's delete, drag or duplicate is unavailable, by block name. */
  references: StudioCanvasReferences;
  /** Why the last canvas change was refused; empty while the draft shows as it was edited. */
  refusal: string;
}>;

const StudioCanvasContext = createContext<StudioCanvasContextValue | null>(null);

/** The open page's canvas model; only inside the workspace's Puck editor. */
export function useStudioCanvas(): StudioCanvasContextValue {
  const value = useContext(StudioCanvasContext);
  if (value === null) throw new Error("The Studio canvas is used outside its Puck editor");
  return value;
}

const usePuckSelector = createUsePuck();

/** Whether a block is being dragged, from the palette or on the canvas. */
export const useStudioCanvasDragging = (): boolean =>
  usePuckSelector((state) => state.appState.ui.isDragging);

/** Puck compares overrides by identity: one object, with the drawer's block row and the canvas's. */
const OVERRIDES = { ...studioCanvasOverrides, drawerItem: StudioDrawerItem } as const;

/** The Puck iframe the canvas draws the page in; its styles come from the host. */
const IFRAME = { enabled: true, waitForStyles: true, syncHostStyles: true } as const;

const sameSelector = (
  left: StudioPuckSelector | null | undefined,
  right: StudioPuckSelector | null | undefined,
): boolean =>
  (left ?? null) === (right ?? null) ||
  (left != null && right != null && left.index === right.index && left.zone === right.zone);

/** The actions that put a block in or take it out of the draft; Studio's add command owns those. */
const notSelectionActions: ReadonlySet<PuckAction["type"]> = new Set([
  "insert",
  "setData",
  "set",
  "registerZone",
  "unregisterZone",
  "replaceRoot",
]);

/**
 * The one Puck editor of the workspace. Puck holds the page on the canvas as a projection of
 * Studio's draft and is never the source of truth: Studio's draft history is the one undo, its
 * selection store the one selection, and every canvas change goes back through the definition
 * before the draft takes it. The frame, the panels, the canvas and the inspector are drawn inside
 * this editor, so Puck's parts (the canvas preview, the block drag) work from any of them.
 */
export function StudioPuckProvider({
  input,
  dragGate,
  children,
}: Readonly<{
  input: StudioPuckInput;
  dragGate: RefObject<StudioDragGate>;
  children: ReactNode;
}>) {
  // The screen is kept by Puck (`ui.viewports.current`); `onAction` reports its breakpoint
  // here, because the model and the metadata that depend on it are made outside the editor.
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(studioInitialBreakpoint);
  const model = useStudioCanvasModel(input, breakpoint);
  // Why a block's delete, drag or duplicate is unavailable is read once per saved revision (the
  // compiled one), not at every edit. The change itself is checked against the live draft when it
  // is made (`applyStudioCanvasChange`), so a reason that is a moment late refuses nothing wrongly.
  const readReferences = useMemo(
    () => studioCanvasReferences(input.compiledSource, model.catalogue),
    [input.compiledSource, model.catalogue],
  );
  // A new revision usually leaves every reason as it was (a label changed, say); Puck asks every
  // block's permissions again for a new object, so the one held stays while the reasons are the same.
  const heldReferences = useRef(readReferences);
  if (!sameCompositionValue(heldReferences.current, readReferences))
    heldReferences.current = readReferences;
  const references = heldReferences.current;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  // The config remains stable while its permission resolver reads the current draft's map.
  const config = useMemo(
    (): Config =>
      ({
        ...model.config,
        components: Object.fromEntries(
          Object.entries(model.config.components).map(([type, component]) => [
            type,
            {
              ...component,
              resolvePermissions: (data: { props: { id: string } }) => {
                const reasons = referencesRef.current[data.props.id];
                return {
                  ...(component.permissions?.insert === false ? { insert: false } : {}),
                  ...(reasons?.delete === undefined ? {} : { delete: false }),
                  ...(reasons?.drag === undefined ? {} : { drag: false }),
                  ...(reasons?.duplicate === undefined ? {} : { duplicate: false }),
                };
              },
            },
          ]),
        ),
      }) as Config,
    [model.config],
  );
  const [refused, setRefused] = useState<Readonly<{ area: string; message: string }> | null>(null);
  const [resync, setResync] = useState(0);
  // Puck's callbacks run while Studio shows its own data or selection: they must not echo back.
  const synchronizing = useRef(false);
  const deriving = useRef(false);
  const showSelection = useRef<((alias: string | null) => void) | null>(null);
  // The name of the interim block Puck holds between an insert from the drawer and Studio's add.
  const inserted = useRef<Set<string>>(new Set());
  const permitted = model.editable && input.canvasShown;
  const latest = useRef({ input, model, permitted });
  latest.current = { input, model, permitted };

  // Every canvas change goes back through the definition: it is placed in the current draft and
  // validated before the history takes it. A refused change is shown as the draft still is.
  const change = useCallback((candidate: Data) => {
    const { input: now, model: shown, permitted: allowed } = latest.current;
    if (synchronizing.current) return;
    // A change made while the canvas cannot take edits (hidden, read-only, locked) is never kept:
    // Puck shows the draft again, so the move cannot be committed later.
    if (!allowed) {
      setResync((generation) => generation + 1);
      return;
    }
    if (now.pageAlias === undefined || shown.at === undefined) return;
    // A block inserted from the drawer is added by Studio's add command, not by this edit.
    for (const id of inserted.current) if (puckItemsHold(candidate.content, id)) return;
    const result = applyStudioCanvasChange(
      shown.catalogue,
      now.source,
      now.pageAlias,
      shown.at,
      withoutEmptyPuckZones(candidate),
      shown.rootProps,
    );
    if (result.kind === "unchanged") return;
    if (result.kind === "refused") {
      setResync((generation) => generation + 1);
      setRefused({ area: shown.area, message: result.message });
      return;
    }
    setRefused(null);
    now.onChange(now.source, result.source);
  }, []);

  const onAction = useCallback((action: PuckAction, state: AppState, previous: AppState) => {
    // The screen changed: the model and metadata follow in the same render as Puck's own state.
    if (
      action.type === "setUi" &&
      state.ui.viewports.current.width !== previous.ui.viewports.current.width
    )
      setBreakpoint(studioScreenOfWidth(state.ui.viewports.current.width).breakpoint);
    if (synchronizing.current || deriving.current) return;
    const { input: now, model: shown } = latest.current;
    // A drop or an Add from the drawer: Puck has put an interim block (the release defaults) in its
    // own data; Studio adds the real one.
    if (action.type === "insert") {
      if (shown.at === undefined) return;
      const id = action.id;
      if (id !== undefined) inserted.current.add(id);
      const request: StudioCanvasAddRequest = {
        area: shown.at.key,
        destination: destinationOfZone(action.destinationZone),
        index: action.destinationIndex,
        rendererKey: action.componentType,
      };
      // After Puck finishes its own insert: show the stored draft again unless the add went through.
      setTimeout(() => {
        const { input: current, model: open, permitted: allowed } = latest.current;
        const outcome = allowed ? current.palette?.onAdd(request) : undefined;
        if (outcome !== true) setResync((generation) => generation + 1);
        // A refused add is said where a refused canvas change is: in the canvas strip.
        if (typeof outcome === "string") setRefused({ area: open.area, message: outcome });
        else if (outcome === true) setRefused(null);
        if (id !== undefined) inserted.current.delete(id);
      }, 0);
      return;
    }
    if (notSelectionActions.has(action.type) || !now.canvasShown) return;
    // A click, a drop, a duplicate or a delete moved Puck's selection: it becomes Studio's.
    if (sameSelector(state.ui.itemSelector, previous.ui.itemSelector)) return;
    const alias = puckSelectedAlias(state.data.content, state.ui.itemSelector);
    if (alias === now.selectedPlacementAlias) return;
    // Only a block of the open page is a selection; a block dropped elsewhere (another page's block
    // carried over by a drag that outlived a page change) is not.
    if (alias !== null && (shown.slot === undefined || !itemsHold(shown.slot.items, alias))) return;
    // Puck calls this while it is changing its state; Studio's selection follows right after.
    queueMicrotask(() => {
      void latest.current.input.onSelectPlacement(alias).then((accepted) => {
        if (!accepted) showSelection.current?.(latest.current.input.selectedPlacementAlias);
      });
    });
  }, []);

  const channel = useStudioCanvasChannelValue(input, model);
  // Puck walks this object once for every block it draws: it stays small.
  const metadata = useMemo(
    (): StudioCanvasMetadata => ({ breakpoint, readSettings: compiledItemSettings }),
    [breakpoint],
  );
  // The application holds every block it may: Duplicate and every other insert are off.
  const placed =
    input.palette?.targets.kind === "available"
      ? (input.palette.targets.targets[0]?.placed ?? 0)
      : 0;
  const full = definitionLimitReached("compositionPlacements", placed);
  const permissions = useMemo(
    () => ({
      drag: permitted,
      duplicate: permitted && !full,
      delete: permitted,
      edit: false,
      // The drawer's blocks drag onto the canvas; a layout's blocks are added with Add.
      insert: permitted && !full && input.palette?.owner !== "layout",
    }),
    [permitted, full, input.palette?.owner],
  );
  const empty = useMemo(
    (): Data => ({ root: { props: model.rootProps }, content: [] }),
    [model.rootProps],
  );
  const shown = model.shown ?? empty;
  // Puck takes its data once, when it opens; every later change reaches it through `StudioPuckSync`.
  const [initial] = useState(shown);
  const refusal = refused?.area === model.area ? refused.message : "";
  const value = useMemo(
    (): StudioCanvasContextValue => ({ input, model, references, refusal }),
    [input, model, references, refusal],
  );
  return (
    <StudioCanvasContext.Provider value={value}>
      <StudioCanvasChannelContext.Provider value={channel}>
        <Puck
          config={config}
          data={initial}
          onChange={change}
          onAction={onAction}
          iframe={IFRAME}
          viewports={studioViewports}
          ui={studioInitialUi}
          // Puck's own wrapper fills the workspace, so the canvas has the height of its well.
          height="100%"
          overrides={OVERRIDES}
          metadata={metadata}
          permissions={permissions}
          dictionary={studioPuckWords}
        >
          <StudioPuckSync
            config={config}
            references={references}
            data={shown}
            resync={resync}
            area={model.area}
            dragGate={dragGate}
            canvasShown={input.canvasShown}
            arrangeGrid={input.arrangeGrid === true}
            onArrangeGrid={input.onArrangeGrid}
            onArrangeableGrids={input.onArrangeableGrids}
            arrangeable={model.arrangeable}
            selectedAlias={input.selectedPlacementAlias}
            synchronizing={synchronizing}
            deriving={deriving}
            showSelection={showSelection}
          />
          <div className="flex h-full min-h-0 flex-col">{children}</div>
        </Puck>
      </StudioCanvasChannelContext.Provider>
    </StudioCanvasContext.Provider>
  );
}

/**
 * Runs inside Puck and draws nothing: it keeps Puck's private state in step with Studio. The
 * workspace draft is the source of truth; Puck only ever receives data derived from it, its
 * history is held at the one current state, its selection is derived from Studio's selection and
 * its preview mode follows the toolbar. Where the canvas is not on show nothing is selected.
 */
function StudioPuckSync({
  config,
  references,
  data,
  resync,
  area,
  dragGate,
  canvasShown,
  arrangeGrid,
  onArrangeGrid,
  onArrangeableGrids,
  arrangeable,
  selectedAlias,
  synchronizing,
  deriving,
  showSelection,
}: Readonly<{
  /** The config the page on the canvas is drawn with. */
  config: Config;
  references: StudioCanvasReferences;
  data: Data;
  /** The page and content area on the canvas. */
  area: string;
  dragGate: RefObject<StudioDragGate>;
  /** Changes when Puck holds a change the draft refused, so the draft is shown again. */
  resync: number;
  canvasShown: boolean;
  arrangeGrid: boolean;
  /** Puck's own hotkey changed the preview mode: the toolbar follows. */
  onArrangeGrid: ((arrange: boolean) => void) | undefined;
  onArrangeableGrids: ((arrangeable: boolean) => void) | undefined;
  /** Whether a data grid on the open page has columns to arrange. */
  arrangeable: boolean;
  selectedAlias: string | null;
  synchronizing: RefObject<boolean>;
  deriving: RefObject<boolean>;
  /** Lets the provider put Studio's selection back on the canvas. */
  showSelection: RefObject<((alias: string | null) => void) | null>;
}>) {
  const getPuck = useGetPuck();
  const previewMode = usePuckSelector((state) => state.appState.ui.previewMode);
  const recorded = usePuckSelector((state) => state.history.histories.length);
  // The config Puck holds: it takes the page's config a moment after this component sees it.
  const held = usePuckSelector((state) => state.config);
  useEffect(() => {
    getPuck().refreshPermissions();
  }, [getPuck, held, references]);
  // The config Puck's data was last walked under; Puck walked its first data under `held`.
  const walked = useRef(held);
  const latestData = useRef(data);
  latestData.current = data;
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

  // Puck's selection is derived from Studio's: the block selected in the workspace, and nothing
  // where the canvas is not on show, so a key like Delete has no block to act on.
  const wanted = canvasShown ? selectedAlias : null;
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const select = useCallback(
    (alias: string | null) => {
      const { getSelectorForId, dispatch, appState } = getPuck();
      // A placement drawn elsewhere (another content area or the frame) clears the canvas selection.
      const selector = alias === null ? null : (getSelectorForId(alias) ?? null);
      if (sameSelector(appState.ui.itemSelector, selector)) return;
      deriving.current = true;
      try {
        dispatch({ type: "setUi", ui: { itemSelector: selector } });
      } finally {
        deriving.current = false;
      }
    },
    [getPuck, deriving],
  );
  useEffect(() => {
    showSelection.current = (alias) => select(canvasShown ? alias : null);
    return () => {
      showSelection.current = null;
    };
  }, [select, canvasShown, showSelection]);

  // The toolbar owns the mode; Puck's own hotkey for it is reported back, so both agree.
  useEffect(() => {
    getPuck().dispatch({
      type: "setUi",
      ui: { previewMode: arrangeGrid ? "interactive" : "edit" },
    });
  }, [arrangeGrid, getPuck]);
  useEffect(() => {
    if ((previewMode === "interactive") !== arrangeGrid)
      onArrangeGrid?.(previewMode === "interactive");
  }, [previewMode]);
  useEffect(() => {
    onArrangeableGrids?.(arrangeable);
    // A page change must not leave the previous page's answer behind.
    return () => onArrangeableGrids?.(false);
  }, [arrangeable, onArrangeableGrids]);

  // Puck finds a block's slots through the config its data was last walked under, and takes a new
  // config only after this component's effects have run. Data walked under the previous config (the
  // empty one before the blocks are known) has no nested blocks indexed, so it is walked again once
  // Puck holds the config the page is drawn with. A walk replaces every node's data, so one that
  // only follows a config change waits for a drag in progress to drop.
  const walk = useCallback(
    (shownData: Data) => {
      walked.current = held;
      synchronizing.current = true;
      try {
        // One walk per outside draft change and one per config Puck takes; the function form is the
        // same action without Puck's warning about the object form.
        getPuck().dispatch({ type: "setData", data: () => shownData, recordHistory: false });
      } finally {
        synchronizing.current = false;
      }
    },
    [getPuck, held, synchronizing],
  );
  // The workspace draft changed (an edit, Undo, Redo, a save, Revert, another page, or the config
  // the page is drawn with): show exactly that draft, with the selection derived again. One Puck
  // action replaces the data; it is draft synchronization, not an entry in Puck's separate history.
  useEffect(() => {
    // Puck does not hold the page's config yet; this runs again once it does.
    if (held !== config) return;
    const { appState } = getPuck();
    const changed =
      !sameCompositionValue(appState.data.content, data.content) ||
      !sameCompositionValue(appState.data.root, data.root);
    if (changed || (walked.current !== held && !appState.ui.isDragging)) walk(data);
    select(wantedRef.current);
    // The draft is shown again every time the canvas comes into view, so nothing Puck held while
    // it was hidden survives.
  }, [data, resync, canvasShown, area, held, config]);

  // A drag keeps the rail tab and the open page where they are (the workspace asks the gate), and
  // what was asked meanwhile is applied once the drop's own animation has finished with the preview.
  const dragging = usePuckSelector((state) => state.appState.ui.isDragging);
  useEffect(() => {
    // The config walk that waited for the drop.
    if (!dragging && held === config && walked.current !== held) {
      walk(latestData.current);
      select(wantedRef.current);
    }
  }, [dragging]);
  useEffect(() => {
    dragGate.current.dragging = dragging;
    if (dragging) return;
    const pending = dragGate.current.pending;
    dragGate.current.pending = null;
    if (pending === null) return;
    let frames = 0;
    let frame = 0;
    const settle = () => {
      const previewDocument =
        document.querySelector<HTMLIFrameElement>("iframe#preview-frame")?.contentDocument;
      const moving = (target: Document | null | undefined) =>
        target?.querySelector("[data-dnd-dragging], [data-dnd-dropping]") != null;
      if ((moving(document) || moving(previewDocument)) && frames++ < 90)
        frame = requestAnimationFrame(settle);
      else pending();
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [dragging, dragGate]);

  // The outline or the inspector selected something, or the canvas came into or left view.
  useEffect(() => {
    select(wanted);
    // Chosen outside the canvas (the outline, the inspector): bring the block into the frame's view.
    if (wanted !== null)
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLIFrameElement>("iframe#preview-frame")
          ?.contentDocument?.querySelector(`[data-puck-component="${CSS.escape(wanted)}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
  }, [wanted, select]);

  return null;
}
