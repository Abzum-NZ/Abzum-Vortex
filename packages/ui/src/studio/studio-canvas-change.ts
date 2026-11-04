import type { Data, PuckAction } from "@puckeditor/core";
import {
  StoredCompositionRefusal,
  storedPageDataFromPuck,
  storedShellReservations,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import { canvasOwnerData } from "./application-composition-page-data";
import type { StudioCanvasOwner, StudioCompositionCommand } from "./application-composition-model";
import type { StudioSemanticSelection } from "./semantic-selection";
import {
  pageDataJson,
  puckZoneItems,
  withoutEmptyPuckZones,
  type StudioPuckLocate,
} from "./studio-canvas-data";
import { changedProps, type PuckItem, type StudioSettingsEdit } from "./studio-settings-edit";

/** The Puck actions that change the page's data; Studio's classifier reads these, in order. */
const DATA_ACTIONS: ReadonlySet<PuckAction["type"]> = new Set([
  "insert",
  "duplicate",
  "replace",
  "replaceRoot",
  "reorder",
  "move",
  "remove",
]);

/** Whether an action puts something in, takes it out or changes the page's data. */
export const isCanvasDataAction = (action: PuckAction): boolean => DATA_ACTIONS.has(action.type);

/**
 * Whether an action changes nothing (a drop where the block was, a field set to its value). Puck
 * dispatches it but never reports it (its `onChange` skips equal data), so it must not wait in
 * the list the next report is classified from. `previous` is the data before the action.
 */
export const isNoOpCanvasAction = (
  action: PuckAction,
  previous: Data,
  locate: StudioPuckLocate,
): boolean => {
  if (action.type === "move")
    return (
      action.sourceZone === action.destinationZone && action.sourceIndex === action.destinationIndex
    );
  if (action.type === "reorder") return action.sourceIndex === action.destinationIndex;
  if (action.type !== "replace") return false;
  const item = puckZoneItems(previous, action.destinationZone, locate)?.[
    action.destinationIndex
  ] as PuckItem | undefined;
  const after = action.data as PuckItem;
  if (item === undefined || item.props.id !== after.props.id) return false;
  const { keys, slots } = changedProps(item, after);
  return keys.length === 0 && !slots;
};

/** What a change Puck reported on the canvas comes to in the definition. */
export type StudioCanvasClassification =
  /** The data Puck reports is the draft it was given (after Undo, Redo, a save or an echo). */
  | Readonly<{ kind: "unchanged" }>
  /** The canvas takes no such edit now (hidden, read-only, locked, or not the desktop screen). */
  | Readonly<{ kind: "forbidden" }>
  /** The change breaks a rule of the definition or is one the canvas cannot make (`message`). */
  | Readonly<{ kind: "refused"; message: string }>
  /** One block's settings edited in the inspector. */
  | Readonly<{ kind: "settings"; edit: StudioSettingsEdit }>
  /** A change for the one command route, to run against the draft the canvas showed. */
  | Readonly<{
      kind: "change";
      selection: StudioSemanticSelection | null;
      change: StudioCompositionCommand;
      expectedSource: ApplicationSourceDocument;
      /** The block to select once the draft has taken the change: the copy a Duplicate made. */
      select?: string;
    }>;

const SETTING_REFUSED = "That setting could not be changed. The block stays as it was.";

/** The settings of a block: its keys other than the slot order (`vortex`) and its name. */
const isSetting = (key: string): boolean => key !== "vortex" && key !== "id";

const idsOf = (items: readonly unknown[] | undefined): string[] | undefined =>
  items?.map((item) => (item as PuckItem).props.id as string);

/**
 * What a canvas change comes to, decided from the Puck action that made it and never from a diff of
 * the whole page. Exactly one data action has its typed rule (a field edit is a settings edit, a
 * drag inside one slot is an order, Delete is a removal); none, or several in one report (Puck
 * batched edits), go back through the definition as the whole data, which compares the candidate
 * and so cannot drop an edit. `locate` is Puck's own index of where a block sits, which finds a
 * block among `shown` by walking its parents (the depth of the block, not the size of the page).
 */
export const classifyCanvasChange = ({
  catalogue,
  source,
  owner,
  shown,
  candidate,
  actions,
  selected,
  locate,
  permitted,
  settingsPermitted,
}: Readonly<{
  catalogue: ImmutablePlatformBlockCatalogue;
  /** The draft the canvas was drawn from. */
  source: ApplicationSourceDocument;
  owner: StudioCanvasOwner;
  /** The data Puck was given. */
  shown: Data;
  /** The data Puck reports. */
  candidate: Data;
  /** The data actions Puck ran since its last report. */
  actions: readonly PuckAction[];
  /** The block selected in Studio. */
  selected: string | null;
  locate: StudioPuckLocate;
  /** Whether the canvas takes edits of the page (desktop, editable). */
  permitted: boolean;
  /** Whether it takes settings edits (any screen). */
  settingsPermitted: boolean;
}>): StudioCanvasClassification => {
  const expectedSource = source;
  const itemAt = (zone: string, index: number): PuckItem | undefined =>
    puckZoneItems(shown, zone, locate)?.[index] as PuckItem | undefined;
  const placement = (alias: string): StudioSemanticSelection => ({
    kind: "placement",
    placementAlias: alias,
  });

  /** Whole data: the changes the canvas cannot name more closely. */
  const pageData = (): StudioCanvasClassification => {
    if (!permitted) return { kind: "forbidden" };
    try {
      const { data: before, shell } = canvasOwnerData(source, owner);
      const { data, copies } = storedPageDataFromPuck(
        catalogue,
        before,
        withoutEmptyPuckZones(candidate),
        // A layout keeps its content slots empty: they hold the blocks of its pages.
        shell === undefined ? undefined : storedShellReservations(shell),
      );
      if (pageDataJson(data) === pageDataJson(before)) return { kind: "unchanged" };
      const [first] = actions;
      const duplicated =
        first?.type === "duplicate" ? itemAt(first.sourceZone, first.sourceIndex) : undefined;
      const select =
        duplicated === undefined ? undefined : copies.get(duplicated.props.id as string);
      return {
        kind: "change",
        selection: null,
        change: { kind: "pageData", owner, data, copies: [...copies] },
        expectedSource,
        ...(select === undefined ? {} : { select }),
      };
    } catch (error: unknown) {
      // A change the composition rules refuse (or a page removed under it) is an expected refusal,
      // already shown to the person as a sentence; anything else is a platform fault.
      if (error instanceof StoredCompositionRefusal) {
        console.info("[studio] canvas change refused", error.message);
        return { kind: "refused", message: `This change could not be applied. ${error.message}.` };
      }
      console.error("[studio] canvas change failed", error);
      return { kind: "refused", message: "This change could not be applied." };
    }
  };

  const [action, ...more] = actions;
  if (action === undefined || more.length > 0) return pageData();
  switch (action.type) {
    case "insert":
      // A block from the drawer is added by Studio's add command, not by this report.
      return { kind: "unchanged" };
    case "replace": {
      const before = itemAt(action.destinationZone, action.destinationIndex);
      const after = action.data as PuckItem;
      // Puck's index can lag behind data replaced from outside (an Undo, another page): a block
      // that is not the one the action names is a race, and the whole data compares the candidate.
      if (before === undefined || before.props.id !== after.props.id) return pageData();
      const { keys, slots } = changedProps(before, after);
      if (slots) return pageData();
      if (keys.length === 0) return { kind: "unchanged" };
      if (!keys.every(isSetting)) {
        // No Studio field writes the slot order or the name of a block.
        console.error("[studio] a field changed what it may not: STUDIO_CANVAS_VORTEX_PROP_CHANGE");
        return { kind: "refused", message: SETTING_REFUSED };
      }
      if (!settingsPermitted) return { kind: "forbidden" };
      const alias = after.props.id as string;
      // Only the selected block's settings are edited here.
      if (alias !== selected) {
        console.error("[studio] the settings of a block that is not selected were edited");
        return { kind: "refused", message: SETTING_REFUSED };
      }
      return { kind: "settings", edit: { alias, keys, props: after.props } };
    }
    case "move":
    case "reorder": {
      const zone = action.destinationZone;
      if (action.type === "move" && action.sourceZone !== zone) return pageData();
      if (!permitted) return { kind: "forbidden" };
      const moved = itemAt(zone, action.sourceIndex);
      const order = idsOf(puckZoneItems(candidate, zone, locate));
      const was = idsOf(puckZoneItems(shown, zone, locate));
      if (
        moved === undefined ||
        order === undefined ||
        was === undefined ||
        order[action.destinationIndex] !== moved.props.id
      )
        return pageData();
      if (order.length === was.length && order.every((id, index) => id === was[index]))
        return { kind: "unchanged" };
      return {
        kind: "change",
        selection: placement(moved.props.id as string),
        change: { kind: "order", breakpoint: "desktop", order },
        expectedSource,
      };
    }
    case "remove": {
      const removed = itemAt(action.zone, action.index);
      if (removed === undefined) return pageData();
      if (!permitted) return { kind: "forbidden" };
      return {
        kind: "change",
        selection: placement(removed.props.id as string),
        change: { kind: "remove" },
        expectedSource,
      };
    }
    default:
      return pageData();
  }
};
