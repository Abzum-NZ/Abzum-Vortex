"use client";
import type { FormEvent, ReactNode } from "react";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";
import type { resolveStudioSelectionInspectorContext } from "@vortex/ui/studio";
import { StudioPanelShell } from "./studio-frame";
import { studioKindLabel } from "../_lib/studio-labels";

type InspectorContext = ReturnType<typeof resolveStudioSelectionInspectorContext>;

/** The name and description of the application or a page, edited into the draft with Apply. */
export type StudioLabelsForm = Readonly<{
  isApplication: boolean;
  label: string; description: string;
  inputDisabled: boolean; applyDisabled: boolean; discardDisabled: boolean;
  onLabel: (value: string) => void; onDescription: (value: string) => void;
  onApply: (event: FormEvent<HTMLFormElement>) => void; onDiscard: () => void;
}>;

/**
 * The right-hand inspector: what is selected, its name (when it has one) and the editors for it,
 * which the workspace passes in as `children` because they edit its one draft history.
 */
export function StudioInspector({ inspector, title, labels, note, children }: Readonly<{
  inspector: InspectorContext;
  title: string;
  /** Present when the selection's name can be edited here. */
  labels: StudioLabelsForm | undefined;
  /** Shown instead of the name form when the selection has none and no editor below. */
  note: string | undefined;
  children: ReactNode;
}>) {
  return <StudioPanelShell title="Inspector"
    description={inspector.status === "resolved" ? `${studioKindLabel(inspector.descriptor.kind)}: ${title}` : "Select an item to change it."}>
    {inspector.status === "resolved" && <TechnicalDetails>
      <dl className="space-y-1">
        <div><dt className="font-semibold">Kind</dt><dd>{inspector.descriptor.kind}</dd></div>
        <div><dt className="font-semibold">Alias</dt><dd className="break-all"><code>{inspector.descriptor.alias}</code></dd></div>
        <div><dt className="font-semibold">Source path</dt><dd className="break-all"><code>{inspector.descriptor.sourcePath || "/"}</code></dd></div>
      </dl>
    </TechnicalDetails>}
    {labels !== undefined ? <form className="space-y-3" onSubmit={labels.onApply}>
      <label className="block space-y-1"><span className="text-sm">Name</span>
        <Input className="w-full" required maxLength={labels.isApplication ? 120 : 60}
          disabled={labels.inputDisabled} value={labels.label} onChange={(event) => labels.onLabel(event.target.value)} /></label>
      {labels.isApplication && <label className="block space-y-1"><span className="text-sm">Description</span>
        <Textarea className="w-full" required maxLength={1000} disabled={labels.inputDisabled}
          value={labels.description} onChange={(event) => labels.onDescription(event.target.value)} /></label>}
      <div className="flex gap-2">
        <Button disabled={labels.applyDisabled} type="submit" size="sm">Apply</Button>
        <Button disabled={labels.discardDisabled} type="button" size="sm" variant="outline" onClick={labels.onDiscard}>Discard</Button>
      </div>
      <p className="text-sm text-muted-foreground">Apply puts the change in your draft. Save keeps it.</p>
    </form> : note === undefined ? null : <p className="text-sm">{note}</p>}
    {children}
  </StudioPanelShell>;
}
