"use client";

import { Puck, type Data } from "@puckeditor/core";
import "@puckeditor/core/puck.css";
import {
  applicationSourceDocumentSchema,
  canonicalJson,
  compiledItemSlots,
  compiledPropsSettings,
  readSourceItem,
  setSourcePageSlot,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type ApplicationSourceDocument,
  type PageSlotAddress,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import type {
  BlockPropertyValueContract,
  CompiledItem,
  SourceItem,
  SourcePageZone,
} from "@vortex/platform/schema";
import type { FieldInputControlReleaseMap } from "../registry";
import type { PlatformThemeTokens } from "../theme";
import { createFullPlatformComponentRegistry } from "../combined-registry";
import { getVortexPuckConfig } from "../puck-config";
import { contentConfigFor } from "../shell-outlet";
import type { Breakpoint } from "../definition-error";

export type { Breakpoint as StudioCanvasBreakpoint } from "../definition-error";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/button";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import type { StudioApplicationTheme } from "./application-appearance";
import {
  clearPlacementThemeOverrides,
  placementsWithThemeOverrides,
  type StudioCompileFailure,
  type StudioPlacementThemeFailure,
  type StudioPlacementThemeOverrides,
  type StudioPlacementThemeResult,
} from "./placement-theme-overrides";
import {
  StoredCompositionRefusal,
  storedItemRelease,
  storedZoneFromPuck,
  validateStoredZone,
  withCopiedFlowBindings,
} from "./stored-composition";
import { StudioCanvasCompiledSettings, studioCanvasConfig } from "./studio-canvas-render";
import { puckDataForBreakpoint, StudioCanvasBridge, type StudioCanvasFrame } from "./studio-canvas-bridge";

export type { StudioCanvasFrame } from "./studio-canvas-bridge";

/** One compiled content area: its items, exactly as the published definition holds them. */
type CompiledSlot = readonly CompiledItem[];
type SourceSlot = SourcePageZone;
type CompiledSettings = Readonly<Record<string, Readonly<Record<string, BlockPropertyValueContract>>>>;

/**
 * The settings of each block's last compiled version, by block name. The compiled slot holds the
 * compiled version of the same stored items, in the same desktop order and with the same slots,
 * so each stored item reads its compiled item at the same position.
 */
const compiledSettingsFor = (
  catalogue: ImmutablePlatformBlockCatalogue,
  stored: readonly SourceItem[],
  compiled: CompiledSlot,
): CompiledSettings => {
  const result: Record<string, Readonly<Record<string, BlockPropertyValueContract>>> = {};
  const visit = (items: readonly SourceItem[], compiledItems: readonly CompiledItem[]): void => {
    if (items.length !== compiledItems.length)
      throw new TypeError("Compiled page placements do not match their stored page.");
    for (const [index, item] of items.entries()) {
      const compiledItem = compiledItems[index]!;
      const release = storedItemRelease(catalogue, item);
      if (release === undefined || item.type !== compiledItem.type)
        throw new TypeError("Compiled page placements do not match their stored page.");
      result[item.props.id] = compiledPropsSettings(compiledItem.props);
      const compiledSlots = new Map(compiledItemSlots(compiledItem));
      for (const [key, { items: children }] of readSourceItem(item, release).slots) {
        if (children === undefined) continue;
        const compiledChildren = compiledSlots.get(key);
        if (compiledChildren === undefined)
          throw new TypeError("Compiled page slots do not match their stored page.");
        visit(children, compiledChildren);
      }
    }
  };
  visit(stored, compiled);
  return result;
};

export type ApplicationPagePuckEditorProps = Readonly<{
  source: ApplicationSourceDocument;
  compiledSource: ApplicationSourceDocument;
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  pageAlias: string;
  /** The compiled items of each content area of this page, keyed by page slot address key. */
  compiledSlots?: Readonly<Record<string, CompiledSlot>> | undefined;
  disabled: boolean;
  /** Why the saved draft would not compile; the page stays open so the cause can be corrected. */
  compileFailure?: StudioCompileFailure | null | undefined;
  /** Judges placement theme overrides with the checks publication applies. */
  validateThemeOverrides?: (
    theme: StudioApplicationTheme,
    placements: readonly StudioPlacementThemeOverrides[],
  ) => Promise<StudioPlacementThemeResult>;
  /** Reports whether any placement theme override is currently refused, so Save can wait. */
  onThemeOverrideProblems?: (hasProblems: boolean) => void;
  onChange: (
    expectedSource: ApplicationSourceDocument,
    source: ApplicationSourceDocument,
  ) => void;
  /** The block selected in the workspace, shown selected on the canvas. */
  selectedPlacementAlias: string | null;
  /** A block clicked on the canvas (`null`: the page itself); `false` keeps the workspace selection. */
  onSelectPlacement: (alias: string | null) => Promise<boolean>;
  /** The screen size the canvas shows; the workspace keeps it while pages change. */
  breakpoint: Breakpoint;
  onBreakpointChange: (breakpoint: Breakpoint) => void;
  /** The application frame the page is drawn inside, when the draft compiled. */
  frame?: StudioCanvasFrame | undefined;
}>;

/** Edits one content slot of a page; a page with several slots or guided steps lets the person pick. */
/** The dependency list must name exactly the releases the placements use; a Puck edit can add or drop one. */
type PlatformBlockDependency = ApplicationSourceDocument["body"]["platform_block_dependencies"][number];
const syncPlatformBlockDependencies = (source: ApplicationSourceDocument): void => {
  const used = new Map<string, { block_id: string; release_version: string }>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const block = record.block as Record<string, unknown> | undefined;
    if (typeof block?.block_id === "string" && typeof block.release_version === "string")
      used.set(`${block.block_id}@${block.release_version}`,
        { block_id: block.block_id, release_version: block.release_version });
    Object.values(record).forEach(collect);
  };
  collect(source.body.pages);
  collect(source.body.shells);
  const kept = source.body.platform_block_dependencies.filter((dependency) =>
    used.has(`${dependency.block_id}@${dependency.release_version}`));
  for (const [identity, release] of used)
    if (!kept.some((dependency) => `${dependency.block_id}@${dependency.release_version}` === identity))
      kept.push({ kind: "platform_block", ...release } as PlatformBlockDependency);
  kept.sort((left, right) => left.block_id < right.block_id ? -1 : left.block_id > right.block_id ? 1
    : left.release_version < right.release_version ? -1 : left.release_version > right.release_version ? 1 : 0);
  source.body.platform_block_dependencies = kept;
};

const isItemList = (value: unknown): value is SourceItem[] =>
  Array.isArray(value) && value.every((entry) =>
    entry !== null && typeof entry === "object" && "type" in entry && "props" in entry);

const itemsHold = (items: readonly SourceItem[], alias: string): boolean =>
  items.some((item) => item.props.id === alias ||
    Object.values(item.props).some((value) => isItemList(value) && itemsHold(value, alias)));

const slotHolds = (slot: SourceSlot, alias: string): boolean => itemsHold(slot.items, alias);

export function ApplicationPagePuckEditor(props: ApplicationPagePuckEditorProps) {
  const page = props.source.body.pages.find((candidate) => candidate.id === props.pageAlias);
  const addresses = page === undefined ? [] : sourcePageSlotAddresses(page);
  const [selectedKey, setSelectedKey] = useState("");
  // A block selected in the outline is shown in the content slot that holds it.
  const holding = props.selectedPlacementAlias === null || page === undefined ? undefined
    : addresses.find((candidate) => slotHolds(sourcePageSlotAt(page, candidate)!, props.selectedPlacementAlias!));
  useEffect(() => {
    if (holding !== undefined && holding.key !== selectedKey) setSelectedKey(holding.key);
  }, [holding?.key]);
  const at = addresses.find((candidate) => candidate.key === selectedKey) ?? holding ?? addresses[0];
  const selectorId = `puck-slot-${props.pageAlias}`;
  if (at === undefined)
    return <p role="status">This page has no content area to arrange.</p>;
  return (
    <div className="space-y-3">
      {addresses.length < 2 ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={selectorId}>Content area</Label>
          <NativeSelect
            id={selectorId}
            value={at.key}
            onChange={(event) => setSelectedKey(event.target.value)}
          >
            {addresses.map((candidate) => (
              <NativeSelectOption key={candidate.key} value={candidate.key}>
                {candidate.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      <ApplicationPageSlotPuckEditor key={`${props.pageAlias}:${at.key}`} {...props} at={at} />
    </div>
  );
}

const breakpoints: readonly Readonly<{ value: Breakpoint; label: string; width: string }>[] = [
  { value: "desktop", label: "Desktop", width: "100%" },
  { value: "tablet", label: "Tablet", width: "820px" },
  { value: "phone", label: "Phone", width: "390px" },
];

/**
 * The canonical form of an authored zone for comparison. A zone with no responsive order carries
 * `order: undefined`, and optional item metadata may be absent; JSON drops both, so equal zones
 * compare equal and canonicalJson never sees an undefined property.
 */
const zoneJson = (zone: SourceSlot): string =>
  canonicalJson(JSON.parse(JSON.stringify(zone)) as unknown);

/**
 * Why a content area is not editable on the canvas: its stored data does not pass the stored
 * composition check, or its compiled version does not match it. Such a content area is shown
 * read-only rather than risking a silent change to the definition.
 */
const storedDataProblem = (
  catalogue: ImmutablePlatformBlockCatalogue,
  slot: SourceSlot,
): string | undefined => {
  try {
    const checked = validateStoredZone(catalogue, slot);
    return zoneJson(checked) === zoneJson(slot)
      ? undefined : "STUDIO_CANVAS_STORED_DATA_MISMATCH: the stored content reads back differently";
  } catch (error: unknown) {
    return `STUDIO_CANVAS_STORED_DATA_REFUSED: ${error instanceof Error ? error.message : String(error)}`;
  }
};

function ApplicationPageSlotPuckEditor({
  source,
  compiledSource,
  pageAlias,
  compiledSlots,
  platformBlockCatalogue,
  fieldInputControlReleases,
  platformThemeTokens,
  at,
  disabled,
  compileFailure,
  validateThemeOverrides,
  onThemeOverrideProblems,
  onChange,
  selectedPlacementAlias,
  onSelectPlacement,
  frame,
  breakpoint,
  onBreakpointChange,
}: ApplicationPagePuckEditorProps & { at: PageSlotAddress }) {
  const registry = useMemo(
    () => createFullPlatformComponentRegistry(platformBlockCatalogue.releases),
    [platformBlockCatalogue],
  );
  const catalogue = useMemo(() => registry.toPlatformBlockCatalogue(), [registry]);
  // The content renders inside the frame's outlet, exactly as a running page's content does.
  const config = useMemo(
    () => studioCanvasConfig(
      contentConfigFor(getVortexPuckConfig(registry, fieldInputControlReleases, platformThemeTokens)),
      registry,
    ),
    [registry, fieldInputControlReleases, platformThemeTokens],
  );
  const compiledSlot = compiledSlots?.[at.key];
  const [message, setMessage] = useState("");
  const [resync, setResync] = useState(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
  // A zone is read fresh from its page, so it is kept per page object and address.
  const slot = useMemo(
    () => (page === undefined ? undefined : sourcePageSlotAt(page, at)),
    [page, at.key],
  );
  const originalPage = compiledSource.body.pages.find((candidate) => candidate.id === pageAlias);
  const originalSlot = useMemo(
    () => (originalPage === undefined ? undefined : sourcePageSlotAt(originalPage, at)),
    [originalPage, at.key],
  );
  // The compiled version is read once per compile; a mismatch keeps the canvas closed.
  const compiled = useMemo((): { settings?: CompiledSettings; problem?: string } => {
    if (originalSlot === undefined || compiledSlot === undefined) return {};
    try {
      return { settings: compiledSettingsFor(catalogue, originalSlot.items, compiledSlot) };
    } catch (error: unknown) {
      return { problem: `STUDIO_CANVAS_COMPILED_MISMATCH: ${error instanceof Error ? error.message : String(error)}` };
    }
  }, [catalogue, compiledSlot, originalSlot]);
  // Puck's data is the stored content area itself; Puck only needs a root beside it.
  const data = useMemo((): Data | undefined =>
    slot === undefined || compiled.settings === undefined ? undefined
      : { root: { props: {} }, content: slot.items as unknown as Data["content"] },
  [compiled.settings, slot]);
  // Checked whenever the content area or its compiled version changes, and closed until it passes.
  // Without a compiled version there is nothing to draw yet.
  const readOnlyCause = useMemo(() =>
    slot === undefined || compiled.settings === undefined
      ? compiled.problem ?? "STUDIO_CANVAS_COMPILED_PENDING: no compiled version to draw from"
      : storedDataProblem(catalogue, slot), [catalogue, slot, compiled]);
  useEffect(() => {
    if (readOnlyCause !== undefined && compiledSlot !== undefined)
      console.error(`[studio] canvas content area ${pageAlias}/${at.key} is read-only`, readOnlyCause);
  }, [readOnlyCause]);
  const shown = useMemo(() => data === undefined ? undefined
    : puckDataForBreakpoint(data, breakpoint, slot?.order), [data, breakpoint, slot]);
  const editable = !disabled && readOnlyCause === undefined && breakpoint === "desktop";

  const [themeProblems, setThemeProblems] = useState<readonly StudioPlacementThemeFailure[]>([]);
  const [themeCheckNote, setThemeCheckNote] = useState("");
  const placementOverrides = useMemo(
    () => (slot === undefined ? [] : placementsWithThemeOverrides(slot.items)),
    [slot],
  );
  const themeCheckKey = JSON.stringify([source.body.theme, placementOverrides]);
  useEffect(() => {
    if (validateThemeOverrides === undefined) return;
    if (placementOverrides.length === 0) {
      setThemeProblems([]);
      setThemeCheckNote("");
      onThemeOverrideProblems?.(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      validateThemeOverrides(source.body.theme, placementOverrides).then(
        (result) => {
          if (cancelled) return;
          const failures = result.kind === "available" ? result.failures : [];
          setThemeProblems(failures);
          setThemeCheckNote(
            result.kind === "available"
              ? ""
              : "Theme overrides could not be checked now. They are checked again when the draft is opened.",
          );
          onThemeOverrideProblems?.(failures.length > 0);
        },
        (error: unknown) => {
          console.error("Failed to check placement theme overrides", error);
          if (cancelled) return;
          setThemeProblems([]);
          setThemeCheckNote("Theme overrides could not be checked now.");
          onThemeOverrideProblems?.(false);
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [themeCheckKey]);

  useEffect(() => () => onThemeOverrideProblems?.(false), []);

  const removeThemeOverrides = (alias: string) => {
    try {
      const current = sourceRef.current;
      const next = structuredClone(current);
      const nextPage = next.body.pages.find((item) => item.id === pageAlias);
      const nextSlot = nextPage === undefined ? undefined : sourcePageSlotAt(nextPage, at);
      if (nextSlot === undefined || !clearPlacementThemeOverrides(nextSlot.items, alias))
        throw new TypeError("The block is not on this page content slot.");
      const parsed = applicationSourceDocumentSchema.safeParse(next);
      if (!parsed.success) throw parsed.error;
      setMessage("");
      onChange(current, parsed.data);
    } catch (error: unknown) {
      console.error("Failed to remove placement theme overrides", error);
      setMessage(
        "The theme overrides could not be removed. The saved draft and current edits are preserved.",
      );
    }
  };

  // Every canvas change goes back through the definition: Puck's data is converted to the
  // authored content area, placed in the current draft and validated before the history takes it.
  const change = (candidate: Data) => {
    if (!editable) return;
    try {
      const current = sourceRef.current;
      const matches = current.body.pages.filter((item) => item.id === pageAlias);
      const target = matches[0];
      const targetSlot = target === undefined ? undefined : sourcePageSlotAt(target, at);
      if (matches.length !== 1 || targetSlot === undefined)
        throw new TypeError("The selected page is unavailable.");
      const { zone: editedSlot, copies } = storedZoneFromPuck(catalogue, targetSlot, candidate);
      // Puck reports the draft it was just given (after Undo, Redo or a save) as a change too.
      if (zoneJson(editedSlot) === zoneJson(targetSlot)) return;
      const next = structuredClone(current);
      const nextPage = next.body.pages.find((item) => item.id === pageAlias);
      if (nextPage === undefined || !setSourcePageSlot(nextPage, at, editedSlot))
        throw new TypeError("The selected page is unavailable.");
      next.body.flow_bindings = withCopiedFlowBindings(next.body.flow_bindings, copies);
      syncPlatformBlockDependencies(next);
      const parsed = applicationSourceDocumentSchema.safeParse(next);
      if (!parsed.success) throw parsed.error;
      setMessage("");
      onChange(current, parsed.data);
    } catch (error: unknown) {
      console.error("Failed to apply Puck page changes", error);
      // Puck keeps the refused change in its own state; show the accepted draft again.
      setResync((generation) => generation + 1);
      setMessage(
        error instanceof StoredCompositionRefusal
          ? `This page change could not be applied. ${error.message}. The saved draft and current edits are preserved.`
          : "This page change could not be applied. The saved draft and current edits are preserved.",
      );
    }
  };

  if (page === undefined || slot === undefined)
    return <p role="status">This page content area is unavailable.</p>;
  if (data === undefined || shown === undefined)
    return (
      <section className="space-y-3" aria-label="Page canvas">
        <p role="status">
          This page needs a current compiled version before it can be arranged on the canvas.
        </p>
        {compileFailure === null || compileFailure === undefined ? null : (
          <CompileFailureNotice
            failure={compileFailure}
            hasOverrides={placementOverrides.some((entry) => entry.alias === compileFailure.blockAlias)}
            disabled={disabled}
            onRemoveOverrides={removeThemeOverrides}
          />
        )}
        {message.length === 0 ? null : <p role="status">{message}</p>}
      </section>
    );

  const width = breakpoints.find((entry) => entry.value === breakpoint)!.width;
  return (
    <section className="space-y-3" aria-label="Page canvas" aria-busy={disabled}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Screen size" className="flex gap-1">
          {breakpoints.map((entry) => (
            <Button key={entry.value} type="button" size="sm"
              variant={breakpoint === entry.value ? "secondary" : "outline"}
              aria-pressed={breakpoint === entry.value}
              onClick={() => onBreakpointChange(entry.value)}>
              {entry.label}
            </Button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          {readOnlyCause !== undefined
            ? "This part of the page can't be arranged on the canvas yet, so it is shown read-only to keep it exactly as it is. Its blocks can still be changed in the inspector."
            : breakpoint === "desktop"
              ? "Click a block to select it. Drag blocks to rearrange them."
              : `This is the ${breakpoint} layout and order. Rearrange blocks on Desktop, or change this screen's order in the inspector.`}
        </p>
      </div>
      {message.length === 0 ? null : <p role="status">{message}</p>}
      {themeCheckNote.length === 0 ? null : <p role="status">{themeCheckNote}</p>}
      {themeProblems.length === 0 ? null : (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p className="font-semibold">These theme overrides are refused and cannot be saved:</p>
          <ul className="list-disc pl-5">
            {themeProblems.map((problem, index) => (
              <li key={index}>
                Block {problem.alias}
                {problem.tokenKey === undefined ? "" : `, ${tokenLabel(problem.tokenKey)}`}:{" "}
                {problem.code.toLowerCase().replaceAll("_", " ")}. Change the colour or remove the
                override.
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-border bg-muted/30 p-2">
        <div className="mx-auto overflow-hidden rounded-lg bg-background" style={{ width, maxWidth: "100%" }}>
          <StudioCanvasCompiledSettings settings={compiled.settings ?? {}}>
          <Puck
            config={config}
            data={shown}
            onChange={change}
            iframe={{ enabled: false }}
            metadata={{ breakpoint }}
            permissions={{
              drag: editable,
              duplicate: editable,
              delete: editable,
              edit: false,
              insert: false,
            }}
          >
            <StudioCanvasBridge
              data={shown}
              resync={resync}
              selectedAlias={selectedPlacementAlias}
              onSelect={onSelectPlacement}
              frame={frame}
              breakpoint={breakpoint}
              registry={registry}
              fieldInputControlReleases={fieldInputControlReleases}
              platformThemeTokens={platformThemeTokens}
            />
          </Puck>
          </StudioCanvasCompiledSettings>
        </div>
      </div>
    </section>
  );
}

const tokenLabel = (key: string): string =>
  key.replace(/_/gu, " ").replace(/^./u, (first) => first.toUpperCase());

function CompileFailureNotice({
  failure,
  hasOverrides,
  disabled,
  onRemoveOverrides,
}: Readonly<{
  failure: StudioCompileFailure;
  hasOverrides: boolean;
  disabled: boolean;
  onRemoveOverrides: (alias: string) => void;
}>) {
  const alias = failure.blockAlias;
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p className="font-semibold text-destructive">This draft does not compile.</p>
      <p>
        Reason {failure.reasonCode} ({failure.family})
        {alias === undefined ? "" : `, block ${alias}`}
        {failure.tokenKey === undefined ? "" : `, ${tokenLabel(failure.tokenKey)}`}.
      </p>
      {hasOverrides && alias !== undefined ? (
        <>
          <p>
            Remove this block&apos;s theme overrides, save the draft and reload the page to open it
            for visual editing again.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onRemoveOverrides(alias)}
          >
            Remove theme overrides from {alias}
          </Button>
        </>
      ) : null}
    </div>
  );
}
