import type { PuckContext } from "@puckeditor/core";
import type { NavigationPermissionDecisions } from "@vortex/platform/schema";
import type { Breakpoint } from "../definition-error";
import type { VortexPuckMetadata } from "../puck-config";
import type { PlatformThemeTokens } from "../theme";
import type { StudioCompileFailure } from "./compile-failure";
import type { StudioCanvasCompiledSettings } from "./studio-canvas-data";
import type { StudioCanvasGridChannel } from "./studio-canvas-grid";
import type { StudioCanvasFrame } from "./studio-canvas-projection";

/**
 * The records the canvas's data blocks show: read from the builder's preview of one saved draft
 * revision with their preview access, by block name, with what each block looked like in that
 * saved revision. A block is given its records only while it is still exactly as it was saved; a
 * block edited since shows that it needs a save, never the records of its old settings.
 * `refused` means the builder may not preview this application, so no records are read;
 * `not_runnable` means the saved draft has a problem to fix before it can run, named by `sentence`.
 */
export type StudioCanvasRecords = Readonly<{
  state: "loading" | "ready" | "refused" | "not_runnable" | "unavailable";
  /** Why the saved draft cannot run yet, when `state` is `not_runnable`. */
  sentence?: string;
  /** The publication refusal, including the placement and its own corrective guidance. */
  refusal?: StudioCompileFailure;
  /** The records of each data block of the saved revision, by block name. */
  records: Readonly<Record<string, unknown>>;
  /** Each block's release, settings and query in the saved revision the records were read for. */
  saved: Readonly<Record<string, string>>;
  /** Each block's release, settings and query now, in the same spelling. */
  current: Readonly<Record<string, string>>;
  /** A newer saved revision is being compiled; its records follow. */
  updating: boolean;
  /** On a page of one record, the record its blocks show: absent elsewhere. */
  sample?: StudioCanvasSample;
}>;

/** The record a detail page's blocks show on the canvas: the first of its type in the preview, untitled when there is none. */
export type StudioCanvasSample = Readonly<{ recordTypeName: string; title?: string }>;

/**
 * Studio's "who can see this" preview: the role whose view the canvas shows and the permissions it
 * holds. A block is judged with the page projection's own view rule, so the canvas hides exactly the
 * blocks the running application drops for that role; `null` is the design view, where all show.
 */
export type StudioCanvasViewer = Readonly<{
  roleName: string;
  decisions: NavigationPermissionDecisions;
}>;

/**
 * What the canvas root draws the page in: the application frame the page belongs to and the
 * appearance the canvas previews. The registry and the field-input controls the frame's blocks
 * need are fixed per canvas config, so the root has them from the config.
 */
export type StudioCanvasFrameMetadata = Readonly<{
  frame: StudioCanvasFrame | undefined;
  appearance: "light" | "dark";
  platformThemeTokens: PlatformThemeTokens;
  /** The content area holds no block yet: the canvas says how to add one where it is empty. */
  empty: boolean;
}>;

/**
 * What Studio supplies to the canvas through Puck's `metadata`, beside what the page runtime
 * supplies. It is the only channel from Studio to the blocks on the canvas. Puck copies every
 * object a block is given in its props, so everything here is plain data or a function: a Map or
 * a class instance would reach the block as an empty object.
 */
export type StudioCanvasMetadata = VortexPuckMetadata &
  Readonly<{
    /** The canvas always previews one screen size. */
    breakpoint: Breakpoint;
    /** By block name, the plain settings each block's last compiled version holds. */
    compiled: StudioCanvasCompiledSettings;
    /** The records of the canvas's data blocks. */
    records: StudioCanvasRecords;
    /** The role the canvas previews, or `null` for the design view. */
    viewer: StudioCanvasViewer | null;
    /**
     * Records the value the builder chose in a control on the canvas, by the control's placement
     * name. The canvas then asks the server to read the blocks bound to that control again;
     * nothing is resolved in the browser.
     */
    controls: (placement: string, value: string) => void;
    /** The one channel the grid's layout, sort, filter, search and refresh events arrive on. */
    grid: StudioCanvasGridChannel;
    /** `null` until the draft's theme and field-input controls have loaded. */
    frame: StudioCanvasFrameMetadata | null;
  }>;

/** Studio's part of the metadata a canvas render function was given. */
export const studioCanvasMetadata = (puck: Pick<PuckContext, "metadata">): StudioCanvasMetadata =>
  puck.metadata as StudioCanvasMetadata;
