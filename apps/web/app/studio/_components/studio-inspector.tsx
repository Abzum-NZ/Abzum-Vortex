"use client";
import type { ReactNode } from "react";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import { TechnicalDetails } from "@vortex/ui/components/technical-details";
import type { resolveStudioSelectionInspectorContext } from "@vortex/ui/studio";
import { StudioPanelShell } from "./studio-frame";
import { studioKindLabel } from "../_lib/studio-labels";
import { useStudioDraftText } from "./use-studio-draft-text";

type InspectorContext = ReturnType<typeof resolveStudioSelectionInspectorContext>;

/** The name and description of the application or a page, edited into the draft as they are typed. */
export type StudioLabelsForm = Readonly<{
  isApplication: boolean;
  label: string; description: string;
  disabled: boolean;
  /** Puts a name or description in the draft; answers `true` or why the text was not taken. */
  onLabel: (value: string) => string | true;
  onDescription: (value: string) => string | true;
}>;

function LabelsForm({ labels }: Readonly<{ labels: StudioLabelsForm }>) {
  const name = useStudioDraftText(labels.label, labels.onLabel);
  const description = useStudioDraftText(labels.description, labels.onDescription);
  return <div className="space-y-3">
    <label className="block space-y-1"><span className="text-sm">Name</span>
      <Input className="w-full" required maxLength={labels.isApplication ? 120 : 60} aria-invalid={name.problem !== ""}
        disabled={labels.disabled} value={name.text} onChange={(event) => name.change(event.target.value)} /></label>
    {name.problem !== "" && <p role="alert" className="text-sm text-destructive">{name.problem}</p>}
    {labels.isApplication && <>
      <label className="block space-y-1"><span className="text-sm">Description</span>
        <Textarea className="w-full" required maxLength={1000} disabled={labels.disabled} aria-invalid={description.problem !== ""}
          value={description.text} onChange={(event) => description.change(event.target.value)} /></label>
      {description.problem !== "" && <p role="alert" className="text-sm text-destructive">{description.problem}</p>}
    </>}
  </div>;
}

/**
 * The right-hand inspector: what is selected, its name (when it has one) and the editors for it,
 * which the workspace passes in as `children` because they edit its one draft history.
 */
export function StudioInspector({ inspector, title, labels, labelsKey, note, children }: Readonly<{
  inspector: InspectorContext;
  title: string;
  /** Present when the selection's name can be edited here. */
  labels: StudioLabelsForm | undefined;
  /** The selection the name form belongs to: another selection starts a new form. */
  labelsKey: string;
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
    {labels !== undefined ? <LabelsForm key={labelsKey} labels={labels} />
      : note === undefined ? null : <p className="text-sm">{note}</p>}
    {children}
  </StudioPanelShell>;
}
