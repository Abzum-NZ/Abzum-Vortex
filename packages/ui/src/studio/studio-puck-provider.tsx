"use client";

import { IndexedSlotsProvider } from "../puck-config";
import {
  Puck,
  createUsePuck,
  useGetPuck,
  type AppState,
  type Config,
  type Data,
  type PuckAction,
  type UiState,
} from "@puckeditor/core";
import "@puckeditor/core/no-external.css";
import {
  compiledItemSettings,
  definitionLimitReached,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type StudioCanvasOwner,
  type StudioDraftChange,
  type StudioCompositionOutcome,
  type StudioCompositionAddTargetsModel,
  type StudioCompositionDestination,
  type StudioCompositionOwner,
  type StudioSemanticSelection,
  type StudioPlacementDescriber,
  studioBlockName,
  studioCanvasReferences,
  sameCompositionValue,
  type StudioCompileFailure,
  type StudioSettingsEdit,
} from "@vortex/platform/schema";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { Breakpoint } from "../definition-error";
import type { FieldInputControlReleaseMap } from "../registry";
import type { PlatformThemeTokens } from "../theme";
import type { StudioCanvasFrame } from "./studio-canvas-projection";
import {
  classifyCanvasChange,
  isCanvasDataAction,
  isNoOpCanvasAction,
} from "./studio-canvas-change";
import {
  destinationOfZone,
  itemsHold,
  puckItemsHold,
  puckNeighbourOf,
  puckSelectedAlias,
  puckSelectorOf,
  rootSlotHolding,
  type StudioCanvasCompiledSlot,
  type StudioPuckLocate,
  type StudioPuckSelector,
} from "./studio-canvas-data";
import { toast } from "../components/sonner";
import { studioCanvasOverrides } from "./studio-canvas-actions";
import type { StudioCanvasGridChange, StudioCanvasGridRead } from "./studio-canvas-grid";
import { useStudioCanvasModel, type StudioCanvasModel } from "./studio-canvas-model";
import {
  studioInitialBreakpoint,
  studioInitialUi,
  studioScreenOfBreakpoint,
  studioScreenOfWidth,
  studioViewports,
} from "./studio-canvas-screen";
import {
  StudioCanvasChannelContext,
  type StudioCanvasMetadata,
  type StudioCanvasViewer,
} from "./studio-canvas-metadata";
import { studioPuckStyle } from "./studio-puck-style";
import { studioPuckWords } from "./studio-puck-words";
import type { StudioCanvasRecordsReader } from "./use-studio-canvas-records";
import { useStudioCanvasChannelValue } from "./use-studio-canvas-channel";
import { useSettledValue } from "./use-settled-value";
import { createSlotLockStore, SlotLockProvider, type SlotLockStore } from "../slot-lock";

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
  /** The places on the open page a new block can go, worked out when first asked for a draft. */
  targets: () => StudioCompositionAddTargetsModel;
  /** The blocks the application holds, which the composition limit counts. */
  placed: number;
  /** Whose blocks the palette adds to: the open page's content slots, or the selected layout. */
  owner: StudioCompositionOwner["kind"];
  message: string;
  /** Adds a block through Studio's one add command; `false` when nothing was added yet. */
  /** `true` when the block was added, `false` when nothing was added yet (its setup is asked), or why it was refused. */
  onAdd: (request: StudioCanvasAddRequest) => true | false | string;
}>;

/** The one Undo toast of a removal: a new removal replaces it. */
const REMOVED_TOAST = "studio-block-removed";

/** The dialogs a block's More menu opens in the workspace. */
export type StudioBlockDialogKind = "move" | "wrap" | "usedIn";

/** What the selected block's More menu asks of the workspace. */
export type StudioBlockActions = Readonly<{
  /** Why Move to and Wrap are unavailable for a block, read from the draft when the menu opens. */
  availability: (alias: string) => Readonly<{ move: string | undefined; wrap: string | undefined }>;
  /** Opens a dialog for the selected block; the workspace refuses a block that is not selected. */
  open: (alias: string, dialog: StudioBlockDialogKind) => void;
  /** A token for the draft as it is now (its history entry). */
  mark: () => unknown;
  /** Takes back the last draft change when the draft is still the one `mark` named; else `false`. */
  undoIf: (mark: unknown) => boolean;
}>;

export type StudioPuckInput = Readonly<{
  source: ApplicationSourceDocument;
  compiledSource: ApplicationSourceDocument;
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  /** Absent until the draft's canvas view has loaded. */
  fieldInputControlReleases: FieldInputControlReleaseMap | null;
  platformThemeTokens: PlatformThemeTokens | null;
  /** The page on the canvas, or the page that frames the selected layout; `undefined` when the workspace shows none. */
  pageAlias: string | undefined;
  /** The selected layout, whose blocks are then the canvas's: the page above only draws the frame around them. */
  layoutAlias: string | undefined;
  /** The compiled items of each content slot of this page (or step), keyed by page slot address key. */
  compiledSlots?: Readonly<Record<string, StudioCanvasCompiledSlot>> | undefined;
  disabled: boolean;
  /** Why the draft takes no change now (a conflict, a publication), when `disabled` says it does not. */
  disabledReason?: string | undefined;
  /** Why the saved draft would not compile; the page stays open so the cause can be corrected. */
  compileFailure?: StudioCompileFailure | null | undefined;
  /**
   * A change of the canvas, run against the draft as the canvas showed it (`expectedSource`)
   * through the one composition command route; a change made since makes it stale.
   */
  onCanvasChange: (
    selection: StudioSemanticSelection | null,
    change: StudioDraftChange,
    expectedSource: ApplicationSourceDocument,
  ) => StudioCompositionOutcome;
  /**
   * One block's settings edited in the inspector, run against the draft as it is now through the
   * one composition command route; `merge` joins a run of edits to one value into one Undo step.
   */
  onSettingsEdit: (edit: StudioSettingsEdit, merge: string) => StudioCompositionOutcome;
  /** Names a placed block as the outline and the inspector do; the action bar shows it. */
  describePlacement: StudioPlacementDescriber;
  /** The block selected in the workspace, shown selected on the canvas. */
  selectedPlacementAlias: string | null;
  /** A block clicked on the canvas (`null`: the page itself); `false` keeps the workspace selection. */
  onSelectPlacement: (alias: string | null) => Promise<boolean>;
  /** Whether the open rail tab shows the canvas. Elsewhere nothing is selected and nothing can change. */
  canvasShown: boolean;
  appearance: "light" | "dark";
  /** The application frame the page is drawn inside, when the draft compiled. */
  frame?: StudioCanvasFrame | undefined;
  /** Reads the records of one content slot's data blocks for the saved revision, once. */
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
  /** The More menu of the selected block's action bar. */
  blockActions: StudioBlockActions;
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
  /** Why the last canvas change was refused; empty while the draft shows as it was edited. */
  refusal: string;
  /** The document of the canvas's iframe, which Puck's `iframe` override hands to Studio's own. */
  frameDocument: Document | null;
}>;

/** What the iframe override sets once the canvas document exists; it changes for no edit. */
const StudioFrameDocumentSetter = createContext<(document: Document | null) => void>(() => {});

export const useStudioFrameDocumentSetter = (): ((document: Document | null) => void) =>
  useContext(StudioFrameDocumentSetter);

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

/** The Puck iframe the canvas draws the page in; its styles come from the host. */
const IFRAME = { enabled: true, waitForStyles: true, syncHostStyles: true } as const;

/**
 * Whether a document has a script animation (`element.animate`, which is what a drop uses) with an
 * end that is still running. CSS animations and transitions (a toast, a tooltip, a hover) are not
 * waited for; they are told apart by their own properties, as the frame document's animations come
 * from another realm.
 */
const animating = (target: Document | null): boolean =>
  target
    ?.getAnimations()
    .some(
      (animation) =>
        !("animationName" in animation) &&
        !("transitionProperty" in animation) &&
        animation.playState === "running" &&
        animation.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY,
    ) === true;

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
 * Puck decides once per page load, at its first mount, whether its stylesheet is already applied (and
 * keeps that answer), and injects its
 * own default styles (which import a third-party font the page's policy refuses) when it is not.
 * The stylesheet is imported above. On a client navigation into the editor React puts the stylesheet
 * in the document in the same commit that first renders Puck, so Puck looks too early. The editor
 * therefore opens one commit after it is mounted by navigation. During hydration the document's head
 * already holds the stylesheet, and the server render draws the editor, so neither waits.
 */
const noSubscription = () => () => {};
function useStylesheetApplied(): boolean {
  const hydrating = useSyncExternalStore(
    noSubscription,
    () => false,
    () => true,
  );
  const [committed, setCommitted] = useState(false);
  useLayoutEffect(() => {
    setCommitted(true);
  }, []);
  return hydrating || committed;
}

/**
 * The one Puck editor of the workspace. Puck holds the page on the canvas as a projection of
 * Studio's draft and is never the source of truth: Studio's draft history is the one undo, its
 * selection store the one selection, and every canvas change goes back through the definition
 * before the draft takes it. The frame, the panels, the canvas and the inspector are drawn inside
 * this editor, so Puck's parts (the canvas preview, the block drag) work from any of them.
 *
 * Studio uses Puck's public API only (components, props, `overrides`, `metadata`, `usePuck`
 * selectors, `dispatch`, documented attributes). What it still depends on beyond that, to re-check
 * after a Puck upgrade:
 * - Puck takes a new config and new data one effect after this component sees them; the sync below
 *   walks the data again once `usePuck().config` is the page's (`held`), and holds Puck's history
 *   at one entry because Puck records its own drags and deletes a moment after they happen.
 * - Puck draws each drawer row twice, a visual copy under the draggable one, and puts its keyboard
 *   attributes on the draggable row: `StudioDrawerItem` hides the copy that mounts first.
 * - A drop animates with the Web Animations API: the page waits for script animations to end.
 * - Puck's Outline draws Copy and Trash on every row and has no override for them (`LayerActions`
 *   follow Puck's per-item permissions, which Studio no longer resolves): a Trash is answered by
 *   `onAction` (the block's own reason first, else "select it first"), a Copy by the canvas change.
 *   The Outline also names a root slot by its raw key (accepted).
 * - Puck's `iframe` element is reached through the document its override receives
 *   (`frameElement`) to take it out of the Tab path while blocks are edited.
 * - Puck keeps a 16px drag handle at a selected block's top right corner: the action bar ends
 *   before it.
 * Nothing page-sized goes into Puck's `metadata` (Puck walks it once for every block it draws):
 * it travels in `StudioCanvasChannel`.
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
  const stylesheetApplied = useStylesheetApplied();
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(studioInitialBreakpoint);
  const model = useStudioCanvasModel(input, breakpoint);
  // Why a block's delete, drag or duplicate is unavailable is read from the live draft, so a block
  // added a moment ago already says what it cannot do, and a reason clears as soon as what caused
  // it is gone. The read is cheap (it does not grow faster than the page) and is made at lower
  // priority than typing: the deferred draft is the one a keystroke has not just replaced.
  const referenceSource = useSettledValue(input.source);
  const readReferences = useMemo(
    () => studioCanvasReferences(referenceSource, model.catalogue),
    [referenceSource, model.catalogue],
  );
  // A new revision usually leaves every reason as it was (a label changed, say); the object held
  // stays while the reasons are the same, so the canvas channel changes only for a real change.
  const heldReferences = useRef(readReferences);
  if (!sameCompositionValue(heldReferences.current, readReferences))
    heldReferences.current = readReferences;
  const references = heldReferences.current;
  // The reasons are Studio's, not Puck's per-block permissions: Puck would resolve every block's
  // permissions through its store (a copy of two maps of every block per block, so work that grows
  // with the square of the page). The bar and the removal guard read the reasons from the canvas
  // channel instead.
  const config = model.config;
  const referencesRef = useRef(references);
  referencesRef.current = references;
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const [refused, setRefused] = useState<Readonly<{ area: string; message: string }> | null>(null);
  const [resync, setResync] = useState(0);
  // Puck's callbacks run while Studio shows its own data or selection: they must not echo back.
  const synchronizing = useRef(false);
  const deriving = useRef(false);
  const showSelection = useRef<((alias: string | null) => void) | null>(null);
  // The name of the interim block Puck holds between an insert from the drawer and Studio's add.
  const inserted = useRef<Set<string>>(new Set());
  // The block a refused removal named: the change that carries the removal is refused with it.
  const refusedRemoval = useRef<string | null>(null);
  // The data actions Puck ran since it last reported its data: the report is classified from them.
  const pending = useRef<PuckAction[]>([]);
  // Where a block sat when it was pressed, so a drag on Tablet or Phone offers only its own slot.
  const slotLock = useMemo(
    () =>
      createSlotLockStore({
        zoneOf: (alias) => getPuckRef.current?.().getSelectorForId(alias)?.zone,
        armed: () => latest.current.breakpoint !== "desktop" && latest.current.reorderable,
      }),
    [],
  );
  // Puck's own reader of where a block sits, set by `StudioPuckSync`.
  const getPuckRef = useRef<(() => { getSelectorForId: StudioPuckLocate }) | null>(null);
  // Typing into one field of one block is a run of edits, so one Undo; a new run starts when the
  // focused field or the selected block changes.
  const run = useRef({ focus: null as string | null, selector: "", count: 0 });
  const permitted = model.editable && input.canvasShown;
  // A drag inside one slot is taken on every screen (it writes that screen's order); the rest of
  // the page's edits stay on the desktop.
  const reorderable = model.orderable && input.canvasShown;
  // Settings are not per screen and do not need the page to be arrangeable: only a locked or
  // hidden canvas stops them.
  const settingsPermitted = !input.disabled && input.canvasShown;
  const latest = useRef({ input, model, permitted, reorderable, settingsPermitted, breakpoint });
  latest.current = { input, model, permitted, reorderable, settingsPermitted, breakpoint };

  // Every canvas change goes back through the definition: the Puck actions that made it say what
  // it is (`classifyCanvasChange`), and the one command route places it in the current draft and
  // validates it before the history takes it. A refused change is shown as the draft still is.
  const change = useCallback((candidate: Data) => {
    const {
      input: now,
      model: shown,
      permitted: allowed,
      reorderable: arrangeAllowed,
      settingsPermitted: settingsAllowed,
      breakpoint: screen,
    } = latest.current;
    const actions = pending.current;
    pending.current = [];
    if (synchronizing.current) return;
    const refusedId = refusedRemoval.current;
    if (refusedId !== null) {
      refusedRemoval.current = null;
      if (!puckItemsHold(candidate, refusedId)) {
        setResync((generation) => generation + 1);
        return;
      }
    }
    const owner: StudioCanvasOwner | undefined =
      shown.owner === "layout"
        ? now.layoutAlias === undefined
          ? undefined
          : { kind: "layout", shellAlias: now.layoutAlias }
        : now.pageAlias === undefined
          ? undefined
          : { kind: "page", pageAlias: now.pageAlias, step: shown.step };
    if (owner === undefined || shown.shown === undefined) return;
    // A block inserted from the drawer is added by Studio's add command, not by this edit.
    for (const id of inserted.current) if (puckItemsHold(candidate, id)) return;
    const classified = classifyCanvasChange({
      catalogue: shown.catalogue,
      source: now.source,
      owner,
      shown: shown.shown,
      candidate,
      actions,
      selected: now.selectedPlacementAlias,
      locate: (alias) => getPuckRef.current?.().getSelectorForId(alias),
      permitted: allowed,
      reorderable: arrangeAllowed,
      breakpoint: screen,
      settingsPermitted: settingsAllowed,
    });
    if (classified.kind === "unchanged") return;
    // A change made while the canvas cannot take it (hidden, read-only, locked) is never kept:
    // Puck shows the draft again, so the move cannot be committed later.
    if (classified.kind === "forbidden") {
      setResync((generation) => generation + 1);
      return;
    }
    if (classified.kind === "refused") {
      setResync((generation) => generation + 1);
      setRefused({ area: shown.area, message: classified.message });
      return;
    }
    // The name of a removed block is read before the draft takes the removal (the Undo toast
    // names it).
    const removedAlias =
      classified.kind === "change" &&
      classified.change.kind === "remove" &&
      classified.selection?.kind === "placement"
        ? classified.selection.placementAlias
        : null;
    const removedName =
      removedAlias === null
        ? null
        : (studioBlockName(now.describePlacement, shown.items, removedAlias) ?? "block");
    const before = now.blockActions.mark();
    // A run of edits to one field of one block is one Undo step.
    const merge =
      classified.kind === "settings"
        ? `settings:${classified.edit.alias}:${classified.edit.keys.join(",")}:${run.current.count}`
        : "";
    const outcome: StudioCompositionOutcome =
      classified.kind === "settings"
        ? now.onSettingsEdit(classified.edit, merge)
        : now.onCanvasChange(classified.selection, classified.change, classified.expectedSource);
    if (outcome.kind === "applied") {
      setRefused(null);
      // Duplicate selects the copy, as it does in Puck.
      if (classified.kind === "change" && classified.select !== undefined)
        void now.onSelectPlacement(classified.select);
      const after = now.blockActions.mark();
      // An edit that changed nothing leaves the draft, and so the removal's Undo offer, as it was.
      if (after === before) return;
      // The draft took the change. One delete for the Delete key and the bar's Remove: it is
      // immediate, and Undo is offered for exactly the draft the removal produced; a later change
      // of any kind withdraws the offer.
      if (removedName === null) {
        toast.dismiss(REMOVED_TOAST);
        return;
      }
      toast(`Removed ${removedName}`, {
        id: REMOVED_TOAST,
        action: {
          label: "Undo",
          onClick: () => {
            if (!latest.current.input.blockActions.undoIf(after))
              console.info(
                "[studio] the removal's Undo was offered for an older draft; nothing was undone",
              );
          },
        },
      });
      return;
    }
    // A refusal is logged once, by the command that refused it.
    if (outcome.kind === "stale" || outcome.kind === "unsupported")
      console.info(`[studio] a canvas change was not applied: ${outcome.kind}`);
    else if (outcome.kind !== "refused")
      console.error(`[studio] the canvas change failed: ${outcome.kind}`);
    setResync((generation) => generation + 1);
    setRefused({
      area: shown.area,
      message:
        outcome.kind === "refused" && outcome.reason !== undefined
          ? outcome.reason
          : classified.kind === "settings"
            ? "That setting could not be changed. The block stays as it was."
            : "This change could not be applied. The saved draft and current edits are preserved.",
    });
  }, []);

  const onAction = useCallback((action: PuckAction, state: AppState, previous: AppState) => {
    const focus = state.ui.field.focus ?? null;
    const selector = JSON.stringify(state.ui.itemSelector ?? null);
    if (focus !== run.current.focus || selector !== run.current.selector)
      run.current = { focus, selector, count: run.current.count + 1 };
    // The screen changed: the model and metadata follow in the same render as Puck's own state.
    if (
      action.type === "setUi" &&
      state.ui.viewports.current.width !== previous.ui.viewports.current.width
    )
      setBreakpoint(studioScreenOfWidth(state.ui.viewports.current.width).breakpoint);
    if (synchronizing.current || deriving.current) return;
    const { input: now, model: shown } = latest.current;
    // A removal acts only on the block that is selected in Studio. Puck's own Delete key and the
    // action bar both remove what Puck's selector points at; if that is another block (a selection
    // that lags behind the draft), the removal is refused and the draft shown again.
    if (action.type === "remove") {
      const removed = puckSelectedAlias(previous.data, {
        index: action.index,
        zone: action.zone,
      });
      // Puck's Delete key and the Outline's Trash act on any block; the reason a block cannot be
      // removed is Studio's and is said first, whichever block Puck was pointed at.
      const unremovable = removed === null ? undefined : referencesRef.current[removed]?.delete;
      const notSelected = removed !== null && removed !== now.selectedPlacementAlias;
      if (removed !== null && (unremovable !== undefined || notSelected)) {
        console.info(
          unremovable !== undefined
            ? `[studio] refused a removal of '${removed}': ${unremovable}`
            : `[studio] refused a removal of '${removed}': the selected block is '${String(now.selectedPlacementAlias)}'`,
        );
        refusedRemoval.current = removed;
        setResync((generation) => generation + 1);
        setRefused({
          area: shown.area,
          message:
            unremovable ?? "That block was not deleted. Select the block first, then delete it.",
        });
        return;
      }
    }
    // What the next report of Puck's data is classified from. An action that changes nothing is
    // never reported, so it is not kept (it would turn the next edit into a whole-page write).
    if (
      isCanvasDataAction(action) &&
      !isNoOpCanvasAction(action, previous.data, (alias) =>
        getPuckRef.current?.().getSelectorForId(alias),
      )
    ) {
      const last = pending.current[pending.current.length - 1];
      if (
        last?.type === "replace" &&
        action.type === "replace" &&
        last.destinationZone === action.destinationZone &&
        last.destinationIndex === action.destinationIndex
      )
        pending.current.pop();
      pending.current.push(action);
    }
    // A drop or an Add from the drawer: Puck has put an interim block (the release defaults) in its
    // own data; Studio adds the real one.
    if (action.type === "insert") {
      if (shown.data === undefined) return;
      const id = action.id;
      if (id !== undefined) inserted.current.add(id);
      const request: StudioCanvasAddRequest = {
        area: shown.zoneKeyOfSlot(rootSlotHolding(state.data, action.destinationZone)),
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
    // A removed block hands the selection to its neighbour (the next, the one before, or the block
    // holding the slot), for the Delete key and the action bar alike. Puck keeps its selector as it
    // was, which would now name the neighbour while Studio still names the removed block.
    if (action.type === "remove" && now.canvasShown) {
      const neighbour = puckNeighbourOf(previous.data, {
        index: action.index,
        zone: action.zone,
      });
      queueMicrotask(() => {
        void latest.current.input.onSelectPlacement(neighbour ?? null).then((accepted) => {
          if (!accepted) showSelection.current?.(latest.current.input.selectedPlacementAlias);
        });
      });
      return;
    }
    if (notSelectionActions.has(action.type) || !now.canvasShown) return;
    // A click, a drop, a duplicate or a delete moved Puck's selection: it becomes Studio's.
    if (sameSelector(state.ui.itemSelector, previous.ui.itemSelector)) return;
    const alias = puckSelectedAlias(state.data, state.ui.itemSelector);
    if (alias === now.selectedPlacementAlias) return;
    // Only a block of the open page is a selection; a block dropped elsewhere (another page's block
    // carried over by a drag that outlived a page change) is not.
    if (alias !== null && !itemsHold(shown.items, alias)) return;
    // Puck calls this while it is changing its state; Studio's selection follows right after.
    queueMicrotask(() => {
      void latest.current.input.onSelectPlacement(alias).then((accepted) => {
        if (!accepted) showSelection.current?.(latest.current.input.selectedPlacementAlias);
      });
    });
  }, []);

  const channel = useStudioCanvasChannelValue(input, model, references);
  // Puck walks this object once for every block it draws: it stays small.
  const metadata = useMemo(
    (): StudioCanvasMetadata => ({ breakpoint, readSettings: compiledItemSettings }),
    [breakpoint],
  );
  // The application holds every block it may: Duplicate and every other insert are off.
  const placed = input.palette?.placed ?? 0;
  const full = definitionLimitReached("compositionPlacements", placed);
  const permissions = useMemo(
    () => ({
      drag: reorderable,
      duplicate: permitted && !full,
      delete: permitted,
      edit: settingsPermitted,
      insert: permitted && !full,
    }),
    [permitted, reorderable, settingsPermitted, full],
  );
  const empty = useMemo((): Data => ({ root: { props: {} }, content: [] }), []);
  const shown = model.shown ?? empty;
  // Puck takes its data once, when it opens; every later change reaches it through `StudioPuckSync`.
  // A page whose shell has other content slots needs another config, which Puck keeps its old root
  // props across: it is opened again with the new page's data (the key below), only for such a page.
  const opened = useRef<{ key: string; data: Data; ui: Partial<UiState> } | null>(null);
  if (opened.current === null || opened.current.key !== model.slotsKey) {
    // The keyboard focus is found again after a reopen (the first open has nothing to remember).
    if (opened.current !== null) rememberFocus();
    opened.current = {
      key: model.slotsKey,
      data: shown,
      // A reopened Puck keeps the screen and the mode the person had chosen.
      ui: {
        ...studioInitialUi,
        viewports: {
          ...studioInitialUi.viewports!,
          current: { width: studioScreenOfBreakpoint(breakpoint).width, height: "auto" },
        },
        previewMode: input.arrangeGrid === true ? "interactive" : "edit",
      },
    };
  }
  const initial = opened.current.data;
  // The repeating slots (tabs) Puck has indexed: a slot is drawn only once its zone is known.
  const [indexedJson, setIndexedJson] = useState<string | undefined>(undefined);
  const indexedSlots = useMemo(
    () => (indexedJson === undefined ? undefined : new Set(JSON.parse(indexedJson) as string[])),
    [indexedJson],
  );
  const refusal = refused?.area === model.area ? refused.message : "";
  const value = useMemo(
    (): StudioCanvasContextValue => ({ input, model, refusal, frameDocument }),
    [input, model, refusal, frameDocument],
  );
  if (!stylesheetApplied) return null;
  return (
    <StudioFrameDocumentSetter.Provider value={setFrameDocument}>
      <StudioCanvasContext.Provider value={value}>
        <StudioCanvasChannelContext.Provider value={channel}>
          {/* Puck's own wrapper reads its font and spacing from the tokens too, so the map sits above it.
          The Outline and Blocks regions repeat it on their own roots: below the wide breakpoint they
          are drawn in a Sheet outside this element. */}
          <div className="contents" style={studioPuckStyle}>
            <SlotLockProvider store={slotLock}>
              <IndexedSlotsProvider keys={indexedSlots}>
                <Puck
                  key={model.slotsKey}
                  config={config}
                  data={initial}
                  onChange={change}
                  onAction={onAction}
                  iframe={IFRAME}
                  viewports={studioViewports}
                  ui={opened.current.ui}
                  // Puck's own wrapper fills the workspace, so the canvas has the height of its
                  // well.
                  height="100%"
                  overrides={studioCanvasOverrides}
                  metadata={metadata}
                  permissions={permissions}
                  dictionary={studioPuckWords}
                >
                  <StudioPuckSync
                    config={config}
                    repeatingKeys={model.repeatingKeys}
                    onIndexed={setIndexedJson}
                    frameDocument={frameDocument}
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
                    getPuckRef={getPuckRef}
                    slotLock={slotLock}
                  />
                  <div className="flex h-full min-h-0 flex-col">{children}</div>
                </Puck>
              </IndexedSlotsProvider>
            </SlotLockProvider>
          </div>
        </StudioCanvasChannelContext.Provider>
      </StudioCanvasContext.Provider>
    </StudioFrameDocumentSetter.Provider>
  );
}

/**
 * What held the keyboard focus when Puck was reopened (the workspace is drawn inside it, so its
 * controls are drawn again): found again by id or by name inside the rail panel, once the new
 * workspace is on screen.
 */
let focusBeforeReopen: Readonly<{ id: string; label: string }> | null = null;
const rememberFocus = (): void => {
  const active = document.activeElement;
  focusBeforeReopen =
    active instanceof HTMLElement && active !== document.body
      ? {
          id: active.id,
          label: active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "",
        }
      : null;
};
const restoreFocus = (final: boolean): void => {
  const wanted = focusBeforeReopen;
  if (wanted === null) return;
  const byId = wanted.id === "" ? null : document.getElementById(wanted.id);
  const byLabel =
    wanted.label === ""
      ? undefined
      : [
          ...document.querySelectorAll<HTMLElement>(
            "[data-studio-rail-panel] button, [data-studio-rail-panel] [role=treeitem], [data-studio-rail-panel] a",
          ),
        ].find(
          (element) =>
            (element.getAttribute("aria-label") ?? element.textContent?.trim()) === wanted.label,
        );
  const found = byId ?? byLabel;
  if (found !== undefined && found !== null) {
    focusBeforeReopen = null;
    found.focus();
  } else if (final) focusBeforeReopen = null;
};

/**
 * Runs inside Puck and draws nothing: it keeps Puck's private state in step with Studio. The
 * workspace draft is the source of truth; Puck only ever receives data derived from it, its
 * history is held at the one current state, its selection is derived from Studio's selection and
 * its preview mode follows the toolbar. Where the canvas is not on show nothing is selected.
 */
function StudioPuckSync({
  config,
  repeatingKeys,
  onIndexed,
  frameDocument,
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
  getPuckRef,
  slotLock,
}: Readonly<{
  /** The config the page on the canvas is drawn with. */
  config: Config;
  /** The repeating slot keys that config declares. */
  repeatingKeys: readonly string[];
  /** Told the repeating slot keys Puck has indexed. */
  onIndexed: (keys: string) => void;
  frameDocument: Document | null;
  data: Data;
  /** The page and step on the canvas. */
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
  /** Lets the provider ask Puck where a block sits. */
  getPuckRef: RefObject<(() => { getSelectorForId: StudioPuckLocate }) | null>;
  slotLock: SlotLockStore;
}>) {
  const getPuck = useGetPuck();
  useLayoutEffect(() => {
    getPuckRef.current = getPuck;
    return () => {
      getPuckRef.current = null;
    };
  }, [getPuck, getPuckRef]);
  // A workspace opened again after a page with other outlets: the focus it had comes back.
  useLayoutEffect(() => {
    restoreFocus(false);
    const frame = requestAnimationFrame(() => restoreFocus(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const previewMode = usePuckSelector((state) => state.appState.ui.previewMode);
  const recorded = usePuckSelector((state) => state.history.histories.length);
  // The config Puck holds: it takes the page's config a moment after this component sees it.
  const held = usePuckSelector((state) => state.config);
  // The config Puck's data was last walked under; Puck walked its first data under `held`.
  const walked = useRef(held);
  const latestData = useRef(data);
  const frameRef = useRef(frameDocument);
  frameRef.current = frameDocument;
  latestData.current = data;
  // Studio's draft history is the one undo. Puck records its own drags and deletes and answers
  // Ctrl+Z / Ctrl+Y with its older states, which Studio would then take as new edits, so Puck's
  // history is kept at the current state alone and its Undo and Redo have nothing to go back to.
  useEffect(() => {
    const { history, appState, dispatch } = getPuck();
    // The newest entry carries Puck's indexes, so setting it is cheap and warns of nothing.
    const kept = history.histories[history.histories.length - 1];
    if (history.histories.length <= 1 || kept === undefined) return;
    // Puck records a moment after an action, so the entry may be older than the screen however
    // long that moment is: the screen's own data and ui are what is put back when they differ
    // (the real block after a palette drop, a refused change shown again, an Undo, a selection),
    // and Studio's own `change` is held while it is. Nothing here waits for Puck's timer.
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
      const { dispatch, appState } = getPuck();
      // A placement drawn elsewhere (another page, step or the frame) clears the canvas selection.
      // Where it sits is read from Puck's data, not from Puck's index of it: after data replaced
      // from outside (an Undo) the index can still name the old place, and the selection would then
      // point at, and a Delete would remove, another block.
      const selector = alias === null ? null : (puckSelectorOf(appState.data, alias) ?? null);
      if (
        sameSelector(appState.ui.itemSelector, selector) &&
        puckSelectedAlias(appState.data, appState.ui.itemSelector) === alias
      )
        return;
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
    // Puck gives every slot it knows an empty list: those are not a difference.
    const changed =
      !sameCompositionValue(appState.data.content, data.content, true) ||
      !sameCompositionValue(appState.data.root, data.root, true);
    if (changed || (walked.current !== held && !appState.ui.isDragging)) walk(data);
    // Puck has indexed the data under this config, so its tabs may be drawn.
    if (walked.current === held) onIndexed(JSON.stringify(repeatingKeys));
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
    slotLock.drag(dragging);
  }, [dragging, slotLock]);
  useEffect(() => {
    dragGate.current.dragging = dragging;
    if (dragging) return;
    const pending = dragGate.current.pending;
    dragGate.current.pending = null;
    if (pending === null) return;
    let frames = 0;
    let frame = 0;
    let ran = false;
    // The drop's own animation runs in the page it lands in (the canvas's document, or this one for
    // a block dropped from the drawer): the page is left alone while a script animation of either
    // document is still running (the Web Animations API, not Puck's markup), for at most 90 frames.
    const settle = () => {
      if ((animating(document) || animating(frameRef.current)) && frames++ < 90)
        frame = requestAnimationFrame(settle);
      else {
        ran = true;
        pending();
      }
    };
    frame = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(frame);
      // Another drag began before the request ran: it waits for that drag too.
      if (!ran) dragGate.current.pending ??= pending;
    };
  }, [dragging, dragGate]);

  // The outline or the inspector selected something, or the canvas came into or left view.
  useEffect(() => {
    select(wanted);
  }, [wanted, select]);

  return null;
}
