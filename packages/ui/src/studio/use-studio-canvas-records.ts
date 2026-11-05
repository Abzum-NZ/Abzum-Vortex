import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalJson,
  type ApplicationSourceDocument,
  type ImmutablePlatformBlockCatalogue,
  type SourceItem,
} from "@vortex/platform/schema";
import type { StudioCompileFailure } from "./compile-failure";
import { itemsHold, recordKeys } from "./studio-canvas-data";
import type { StudioCanvasGridChange, StudioCanvasGridRead } from "./studio-canvas-grid";
import type { StudioCanvasRecords, StudioCanvasSample } from "./studio-canvas-metadata";

/**
 * The records of the canvas's data blocks for one saved revision, as the workspace read them.
 * `superseded`: a newer saved revision replaced this one; its own read follows, so what is shown
 * stays.
 */
export type StudioCanvasRecordsRead = Readonly<{
  state: StudioCanvasRecords["state"] | "superseded";
  /** Why the saved draft cannot run yet, when `state` is `not_runnable`. */
  sentence?: string;
  refusal?: StudioCompileFailure;
  records: Readonly<Record<string, unknown>>;
  /** On a page of one record, the record its blocks were read with. */
  sample?: StudioCanvasSample;
}>;

/** Reads the records of one content slot's data blocks for the saved revision, once. */
export type StudioCanvasRecordsReader = (
  area: string,
  signal: AbortSignal,
  controlValues: Readonly<Record<string, string>>,
  tableStates: Readonly<Record<string, StudioCanvasGridRead>>,
) => Promise<StudioCanvasRecordsRead>;

/**
 * The records of every zone of the area (a page's zones, or the layout's one zone) as one read: all
 * that was read, and the first zone that could not be read says why the area's records are not.
 */
const mergedRead = (reads: readonly StudioCanvasRecordsRead[]): StudioCanvasRecordsRead => {
  const failed = reads.find((read) => read.state !== "ready");
  const sample = reads.find((read) => read.sample !== undefined)?.sample;
  return {
    ...(failed ?? { state: "ready" as const }),
    records: Object.assign({}, ...reads.map((read) => read.records)) as Record<string, unknown>,
    ...(sample === undefined ? {} : { sample }),
  };
};

type HeldRead = StudioCanvasRecordsRead & {
  state: StudioCanvasRecords["state"];
  /** The page and step, or the layout, the records were read for. */
  area: string;
  source?: ApplicationSourceDocument;
  keys?: ReadonlyMap<string, string>;
};

const LOADING: StudioCanvasRecords["state"] = "loading";
const NO_VALUES: Readonly<Record<string, string>> = Object.freeze({});
/**
 * The keys of the data blocks as a plain object that keeps its identity while they are unchanged,
 * so an edit that touches no data block leaves the canvas metadata, and every block, as it was.
 */
const useStableKeys = (keys: ReadonlyMap<string, string>): Readonly<Record<string, string>> => {
  const held = useRef<{ text: string; value: Readonly<Record<string, string>> } | null>(null);
  const text = canonicalJson([...keys]);
  if (held.current?.text !== text) held.current = { text, value: Object.fromEntries(keys) };
  return held.current.value;
};

const NO_VALUES_READ: StudioCanvasRecords["records"] = Object.freeze({});

/**
 * The records the data blocks of the open page or layout show, the value chosen in each control on
 * the canvas and the channel the grid's events arrive on. Reads follow the visible area only: one
 * per page (or step, or layout) and compiled revision, and one more (debounced, the earlier one
 * cancelled) per control or grid-state change, sent once the preview runs this revision's data
 * shape.
 */
export const useStudioCanvasRecords = ({
  area,
  areaKeys,
  readRecords,
  catalogue,
  compiledSource,
  originalItems,
  items,
  visible,
  gridReads,
  onGridChange,
  arrangeGrid,
  updating,
  compileFailure,
}: Readonly<{
  /** The page and step, or the layout, on the canvas. */
  area: string;
  /**
   * The slot address keys of the page's zones (or the layout's `[layout]`), which the reader is
   * asked for one by one.
   */
  areaKeys: readonly string[];
  readRecords: StudioCanvasRecordsReader | undefined;
  catalogue: ImmutablePlatformBlockCatalogue;
  compiledSource: ApplicationSourceDocument;
  originalItems: readonly SourceItem[];
  items: readonly SourceItem[];
  /** The area has been on screen. */
  visible: boolean;
  gridReads: Readonly<Record<string, StudioCanvasGridRead>> | undefined;
  onGridChange: ((change: StudioCanvasGridChange) => void) | undefined;
  arrangeGrid: boolean;
  updating: boolean;
  compileFailure: StudioCompileFailure | null | undefined;
}>) => {
  // The records of this area's data blocks, read for the saved revision the compiled version is,
  // with each data block's release, settings and query in that revision.
  const savedKeys = useMemo(() => recordKeys(catalogue, originalItems), [catalogue, originalItems]);
  const areaKeysKey = areaKeys.join(" ");
  const [held, setHeld] = useState<HeldRead>({ state: LOADING, records: {}, area });
  // The value chosen in each control on the canvas; a change reads the bound blocks again.
  const [controls, setControls] = useState<
    Readonly<{ area: string; values: Readonly<Record<string, string>> }>
  >({ area, values: {} });
  const controlValues = controls.area === area ? controls.values : NO_VALUES;
  const chooseControlValue = useCallback(
    (placement: string, value: string) =>
      setControls((current) => {
        const values = current.area === area ? current.values : NO_VALUES;
        return (values[placement] ?? "") === value
          ? current
          : { area, values: { ...values, [placement]: value } };
      }),
    [area],
  );
  // Only the controls and the query state of grids still on this area are sent, and only a
  // change to them re-reads this area: a grid change elsewhere leaves it as it is.
  const areaChosen = Object.fromEntries(
    Object.entries(controlValues).filter(([alias]) => itemsHold(originalItems, alias)),
  );
  const areaTables = Object.fromEntries(
    Object.entries(gridReads ?? {}).filter(([alias]) => itemsHold(originalItems, alias)),
  );
  const stateKey = canonicalJson([areaChosen, areaTables]);
  const sent = useRef({ chosen: areaChosen, tables: areaTables });
  sent.current = { chosen: areaChosen, tables: areaTables };
  const lastRead = useRef({ area, stateKey });
  const grid = useMemo(
    () => ({ report: onGridChange, interactive: arrangeGrid }),
    [onGridChange, arrangeGrid],
  );
  useEffect(() => {
    if (!visible || readRecords === undefined || savedKeys.size === 0) return;
    let cancelled = false;
    const controller = new AbortController();
    const { chosen, tables } = sent.current;
    const delay =
      lastRead.current.area === area && lastRead.current.stateKey !== stateKey ? 300 : 0;
    lastRead.current = { area, stateKey };
    const timer = setTimeout(() => {
      Promise.all(areaKeys.map((key) => readRecords(key, controller.signal, chosen, tables))).then(
        (reads) => {
          const read = mergedRead(reads);
          if (cancelled || controller.signal.aborted) return;
          // A newer saved revision replaced this one: its own read follows, and what is shown
          // stays.
          if (read.state === "superseded") return;
          setHeld({ ...read, state: read.state, area, source: compiledSource, keys: savedKeys });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          console.error("[studio] the canvas records could not be read", error);
          if (!cancelled)
            setHeld({
              state: "unavailable",
              records: {},
              area,
              source: compiledSource,
              keys: savedKeys,
            });
        },
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [readRecords, compiledSource, area, areaKeysKey, visible, stateKey]);
  // Records read for another page, step or layout are never shown as this one's.
  const read = useMemo(
    (): HeldRead => (held.area === area ? held : { state: LOADING, records: {}, area }),
    [held, area],
  );
  // Records read for another saved revision are never shown as this one's, except while this
  // revision's own read runs after a presentation edit: every data block is still exactly as it
  // was read (same release, settings and query), so its records are the same.
  const carried =
    read.source !== compiledSource &&
    read.state === "ready" &&
    read.keys !== undefined &&
    [...savedKeys].every(([id, key]) => read.keys?.get(id) === key);
  // Plain data only: Puck copies every object in a block's props, so a Map or the saved source
  // would arrive broken or copied once per block.
  const saved = useStableKeys(savedKeys);
  const current = useStableKeys(useMemo(() => recordKeys(catalogue, items), [catalogue, items]));
  const records = useMemo((): StudioCanvasRecords => {
    const shown = read.source === compiledSource || carried ? read : undefined;
    const refusal = compileFailure ?? shown?.refusal;
    return {
      state: shown?.state ?? LOADING,
      records: shown?.records ?? NO_VALUES_READ,
      saved,
      current,
      updating,
      ...(shown?.sentence === undefined ? {} : { sentence: shown.sentence }),
      ...(refusal === undefined ? {} : { refusal }),
      ...(shown?.sample === undefined ? {} : { sample: shown.sample }),
    };
  }, [read, compiledSource, carried, saved, current, updating, compileFailure]);
  return { records, controls: chooseControlValue, grid };
};
