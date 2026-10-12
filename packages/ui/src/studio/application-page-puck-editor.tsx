"use client";

import { Puck, type Data } from "@puckeditor/core";
import "@puckeditor/core/puck.css";
import {
  applicationSourceDocumentSchema,
  setSourcePageSlot,
  sourcePageSlotAddresses,
  sourcePageSlotAt,
  sourcePlacementSlotSchema,
  type ApplicationSourceDocument,
  type PageSlotAddress,
} from "@vortex/platform/schema";
import type { placementSlotSchema } from "@vortex/platform/schema";
import {
  createFullPlatformComponentRegistry,
  createVortexPuckAdapter,
  getVortexPuckConfig,
} from "@vortex/ui";
import { useMemo, useRef, useState } from "react";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { createVortexAuthoredPuckAdapter } from "./vortex-authored-puck-adapter";

const registry = createFullPlatformComponentRegistry();
const config = getVortexPuckConfig(registry);
const adapter = createVortexAuthoredPuckAdapter(registry.toPlatformBlockCatalogue());
const runtimeAdapter = createVortexPuckAdapter(registry.toPlatformBlockCatalogue());
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
  pageAlias: string;
  /** The compiled slots of this page keyed by page slot address key. */
  compiledSlots?: Readonly<Record<string, CompiledSlot>> | undefined;
  disabled: boolean;
  onChange: (
    expectedSource: ApplicationSourceDocument,
    source: ApplicationSourceDocument,
  ) => void;
}>;

/** Edits one content slot of a page; a page with several slots or guided steps lets the person pick. */
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
  at,
  disabled,
  onChange,
}: ApplicationPagePuckEditorProps & { at: PageSlotAddress }) {
  const compiledSlot = compiledSlots?.[at.key];
  const [message, setMessage] = useState("");
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
  const slot = page === undefined ? undefined : sourcePageSlotAt(page, at);
  const originalPage = compiledSource.body.pages.find((candidate) => candidate.id === pageAlias);
  const originalSlot = originalPage === undefined ? undefined : sourcePageSlotAt(originalPage, at);
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
        !setSourcePageSlot(nextPage, at, sourcePlacementSlotSchema.parse(editedSlot))
      )
        throw new TypeError("The selected page is unavailable.");
      const parsed = applicationSourceDocumentSchema.safeParse(next);
      if (!parsed.success) throw parsed.error;
      setMessage("");
      onChange(current, parsed.data);
    } catch (error: unknown) {
      console.error("Failed to apply Puck page changes", error);
      setMessage(
        "This page change could not be applied. The saved draft and current edits are preserved.",
      );
    }
  };

  if (page === undefined || slot === undefined)
    return <p role="status">This page content slot is unavailable.</p>;
  if (data === undefined)
    return <p role="status">This page needs a current compiled version before visual editing is available.</p>;

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
      <Puck
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
