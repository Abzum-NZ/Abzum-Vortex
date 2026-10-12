"use client";

import { Puck, type Data } from "@puckeditor/core";
import "@puckeditor/core/puck.css";
import {
  applicationSourceDocumentV2Schema,
  sourcePlacementSlotV2Schema,
  type ApplicationSourceDocumentV2,
} from "@vortex/contracts";
import { createFullPlatformComponentRegistry, getVortexPuckConfig } from "@vortex/ui";
import { useMemo, useRef, useState } from "react";
import { createVortexAuthoredPuckAdapterV2 } from "./vortex-authored-puck-adapter";

const registry = createFullPlatformComponentRegistry();
const config = getVortexPuckConfig(registry);
const adapter = createVortexAuthoredPuckAdapterV2(registry.toPlatformBlockCatalogue());
type SourcePage = ApplicationSourceDocumentV2["body"]["pages"][number];
type EditablePageSlot = Readonly<{
  key: string;
  slot: ReturnType<typeof sourcePlacementSlotV2Schema.parse>;
}>;

const editablePageSlot = (page: SourcePage): EditablePageSlot | undefined => {
  const composition = page.composition;
  if ("main" in composition) return { key: "main", slot: composition.main };
  if ("content" in composition) {
    const entries = Object.entries(composition.content);
    if (entries.length === 1) return { key: entries[0]![0], slot: entries[0]![1] };
  }
  return undefined;
};

export type ApplicationPagePuckEditorProps = Readonly<{
  source: ApplicationSourceDocumentV2;
  pageAlias: string;
  disabled: boolean;
  onChange: (
    expectedSource: ApplicationSourceDocumentV2,
    source: ApplicationSourceDocumentV2,
  ) => void;
}>;

export function ApplicationPagePuckEditor({
  source,
  pageAlias,
  disabled,
  onChange,
}: ApplicationPagePuckEditorProps) {
  const [message, setMessage] = useState("");
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const page = source.body.pages.find((candidate) => candidate.id === pageAlias);
  const pageSlot = page === undefined ? undefined : editablePageSlot(page);
  const slot = pageSlot?.slot;
  const data = useMemo(() => {
    if (slot === undefined) return undefined;
    return adapter.toPuckData(slot);
  }, [slot]);

  const change = (candidate: Data) => {
    try {
      const current = sourceRef.current;
      const matches = current.body.pages.filter((item) => item.id === pageAlias);
      const target = matches[0];
      const targetSlot = target === undefined ? undefined : editablePageSlot(target);
      if (
        matches.length !== 1 ||
        target === undefined ||
        pageSlot === undefined ||
        targetSlot?.key !== pageSlot.key
      )
        throw new TypeError("The selected page is unavailable.");
      const editedSlot = adapter.fromPuckData(targetSlot.slot, candidate);
      const next = structuredClone(current);
      const nextPage = next.body.pages.find((item) => item.id === pageAlias);
      const nextPageSlot = nextPage === undefined ? undefined : editablePageSlot(nextPage);
      if (nextPage === undefined || nextPageSlot?.key !== pageSlot.key)
        throw new TypeError("The selected page is unavailable.");
      const parsedSlot = sourcePlacementSlotV2Schema.parse(editedSlot);
      if ("main" in nextPage.composition) nextPage.composition.main = parsedSlot;
      else if ("content" in nextPage.composition)
        nextPage.composition.content[pageSlot.key] = parsedSlot;
      else throw new TypeError("The selected page is unavailable.");
      const parsed = applicationSourceDocumentV2Schema.safeParse(next);
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

  if (page === undefined || slot === undefined || data === undefined)
    return <p role="status">Visual editing is available for pages with one page content slot.</p>;

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
