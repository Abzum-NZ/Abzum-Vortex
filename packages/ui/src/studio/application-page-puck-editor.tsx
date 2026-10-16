"use client";

import { Puck, type Data } from "@puckeditor/core";
import "@puckeditor/core/puck.css";
import {
  applicationSourceDocumentSchema,
  setSourcePageSlot,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  type ApplicationSourceDocument,
  type PageSlotAddress,
  type ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import type { placementSlotSchema } from "@vortex/platform/schema";
import type { FieldInputControlReleaseMap } from "../registry";
import type { PlatformThemeTokens } from "../theme";
import {
  createFullPlatformComponentRegistry,
  createVortexPuckAdapter,
  getVortexPuckConfig,
} from "@vortex/ui";
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
  AuthoredPuckSettingRefusal,
  createVortexAuthoredPuckAdapter,
} from "./vortex-authored-puck-adapter";

type CompiledSlot = ReturnType<typeof placementSlotSchema.parse>;
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Compiled Puck page data is invalid.");
  return value as Record<string, unknown>;
};

const compiledSettingsFor = (
  authoredData: Data,
  compiledData: Data,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> => {
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  const visit = (authoredContent: unknown, compiledContent: unknown): void => {
    if (!Array.isArray(authoredContent) || !Array.isArray(compiledContent) ||
      authoredContent.length !== compiledContent.length)
      throw new TypeError("Compiled Puck page placements do not match their authored page.");
    for (const [index, authoredRaw] of authoredContent.entries()) {
      const authoredNode = record(authoredRaw);
      const compiledNode = record(compiledContent[index]);
      const authoredProps = record(authoredNode.props);
      const compiledProps = record(compiledNode.props);
      const alias = authoredProps.id;
      if (authoredNode.type !== compiledNode.type || typeof alias !== "string")
        throw new TypeError("Compiled Puck page placements do not match their authored page.");
      result[alias] = record(compiledProps.settings);
      const authoredSlots = Object.keys(authoredProps).filter((key) =>
        key !== "id" && key !== "settings" && key !== "vortex" && Array.isArray(authoredProps[key]));
      const compiledSlots = Object.keys(compiledProps).filter((key) =>
        key !== "id" && key !== "settings" && key !== "vortex" && Array.isArray(compiledProps[key]));
      if (authoredSlots.length !== compiledSlots.length ||
        authoredSlots.some((key) => !compiledSlots.includes(key)))
        throw new TypeError("Compiled Puck page slots do not match their authored page.");
      for (const key of authoredSlots) visit(authoredProps[key], compiledProps[key]);
    }
  };
  visit(authoredData.content, compiledData.content);
  return result;
};

export type ApplicationPagePuckEditorProps = Readonly<{
  source: ApplicationSourceDocument;
  compiledSource: ApplicationSourceDocument;
  platformBlockCatalogue: ImmutablePlatformBlockCatalogue;
  fieldInputControlReleases: FieldInputControlReleaseMap;
  platformThemeTokens: PlatformThemeTokens;
  pageAlias: string;
  /** The compiled slots of this page keyed by page slot address key. */
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

export function ApplicationPagePuckEditor(props: ApplicationPagePuckEditorProps) {
  const page = props.source.body.pages.find((candidate) => candidate.id === props.pageAlias);
  const addresses = page === undefined ? [] : sourcePageSlotAddresses(page);
  const [selectedKey, setSelectedKey] = useState("");
  const at = addresses.find((candidate) => candidate.key === selectedKey) ?? addresses[0];
  const selectorId = `puck-slot-${props.pageAlias}`;
  if (at === undefined)
    return <p role="status">This page has no content slot to edit visually.</p>;
  return (
    <div className="space-y-3">
      {addresses.length < 2 ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={selectorId}>Content slot</Label>
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
}: ApplicationPagePuckEditorProps & { at: PageSlotAddress }) {
  const registry = useMemo(
    () => createFullPlatformComponentRegistry(platformBlockCatalogue.releases),
    [platformBlockCatalogue],
  );
  const catalogue = useMemo(() => registry.toPlatformBlockCatalogue(), [registry]);
  const config = useMemo(
    () => getVortexPuckConfig(registry, fieldInputControlReleases, platformThemeTokens),
    [registry, fieldInputControlReleases, platformThemeTokens],
  );
  const adapter = useMemo(() => createVortexAuthoredPuckAdapter(catalogue), [catalogue]);
  const runtimeAdapter = useMemo(() => createVortexPuckAdapter(catalogue), [catalogue]);
  const compiledSlot = compiledSlots?.[at.key];
  const [message, setMessage] = useState("");
  const [canvasGeneration, setCanvasGeneration] = useState(0);
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
  const runtimeSettings = useMemo(() => {
    if (originalSlot === undefined || compiledSlot === undefined) return undefined;
    const authoredData = adapter.toPuckData(originalSlot);
    const compiledData = runtimeAdapter.toPuckData(compiledSlot, undefined, { kind: "default" });
    return compiledSettingsFor(authoredData, compiledData);
  }, [compiledSlot, originalSlot]);
  const data = useMemo(() => {
    if (slot === undefined || runtimeSettings === undefined) return undefined;
    return adapter.toPuckData(slot, runtimeSettings);
  }, [runtimeSettings, slot]);

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

  const change = (candidate: Data) => {
    try {
      const current = sourceRef.current;
      const matches = current.body.pages.filter((item) => item.id === pageAlias);
      const target = matches[0];
      const targetSlot = target === undefined ? undefined : sourcePageSlotAt(target, at);
      if (matches.length !== 1 || targetSlot === undefined)
        throw new TypeError("The selected page is unavailable.");
      const editedSlot = adapter.fromPuckData(targetSlot, candidate);
      const next = structuredClone(current);
      const nextPage = next.body.pages.find((item) => item.id === pageAlias);
      if (
        nextPage === undefined ||
        !setSourcePageSlot(nextPage, at, editedSlot)
      )
        throw new TypeError("The selected page is unavailable.");
      syncPlatformBlockDependencies(next);
      const parsed = applicationSourceDocumentSchema.safeParse(next);
      if (!parsed.success) throw parsed.error;
      setMessage("");
      onChange(current, parsed.data);
    } catch (error: unknown) {
      console.error("Failed to apply Puck page changes", error);
      // Puck keeps the refused block in its own state; remounting restores the accepted draft.
      setCanvasGeneration((generation) => generation + 1);
      setMessage(
        error instanceof AuthoredPuckSettingRefusal
          ? `This page change could not be applied. ${error.message}. The saved draft and current edits are preserved.`
          : "This page change could not be applied. The saved draft and current edits are preserved.",
      );
    }
  };

  if (page === undefined || slot === undefined)
    return <p role="status">This page content slot is unavailable.</p>;
  if (data === undefined)
    return (
      <section className="space-y-3" aria-label="Visual page editor">
        <p role="status">
          This page needs a current compiled version before visual editing is available.
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

  return (
    <section className="space-y-3" aria-label="Visual page editor" aria-busy={disabled}>
      <header className="space-y-1">
        <h3 className="font-semibold">Visual page editor</h3>
        <p className="text-sm text-muted-foreground">
          Arrange blocks and edit their declared settings. Save the draft before preparing a
          release.
        </p>
      </header>
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
      <Puck
        key={canvasGeneration}
        config={config}
        data={data}
        onChange={change}
        permissions={{
          drag: !disabled,
          duplicate: !disabled,
          delete: !disabled,
          edit: !disabled,
          insert: !disabled,
        }}
        height="72vh"
        headerTitle={page.name}
      />
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
