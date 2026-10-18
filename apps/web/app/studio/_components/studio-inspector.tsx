"use client";
import type { ReactNode } from "react";
import { Input } from "@vortex/ui/components/input";
import { Textarea } from "@vortex/ui/components/textarea";
import {
  StudioField,
  StudioInspectorGroup,
  StudioInspectorActions,
  StudioCopyButton,
} from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@vortex/ui/components/empty";
import type { resolveStudioSelectionInspectorContext } from "@vortex/ui/studio";
import { StudioPanelShell } from "./studio-frame";
import { studioKindLabel } from "../_lib/studio-labels";
import { useStudioDraftText } from "./use-studio-draft-text";

type InspectorContext = ReturnType<typeof resolveStudioSelectionInspectorContext>;

/** The name and description of the application or a page, edited into the draft as they are typed. */
export type StudioLabelsForm = Readonly<{
  isApplication: boolean;
  label: string;
  description: string;
  disabled: boolean;
  /** Puts a name or description in the draft; answers `true` or why the text was not taken. */
  onLabel: (value: string) => string | true;
  onDescription: (value: string) => string | true;
}>;

function LabelsForm({ labels }: Readonly<{ labels: StudioLabelsForm }>) {
  const name = useStudioDraftText(labels.label, labels.onLabel);
  const description = useStudioDraftText(labels.description, labels.onDescription);
  return (
    <div className="space-y-4">
      <StudioField label="Name" error={name.problem || undefined} onUndo={name.reset}>
        {(control) => (
          <Input
            {...control}
            className="w-full"
            required
            maxLength={labels.isApplication ? 120 : 60}
            disabled={labels.disabled}
            value={name.text}
            onChange={(event) => name.change(event.target.value)}
          />
        )}
      </StudioField>
      {labels.isApplication && (
        <StudioField label="Description" error={description.problem || undefined} onUndo={description.reset}>
          {(control) => (
            <Textarea
              {...control}
              className="w-full"
              required
              maxLength={1000}
              disabled={labels.disabled}
              value={description.text}
              onChange={(event) => description.change(event.target.value)}
            />
          )}
        </StudioField>
      )}
    </div>
  );
}

/**
 * The right-hand inspector: what is selected, its name (when it has one) and the editors for it,
 * which the workspace passes in as `children` because they edit its one draft history.
 */
export function StudioInspector({
  inspector,
  title,
  labels,
  labelsKey,
  note,
  children,
}: Readonly<{
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
  if (inspector.status !== "resolved")
    return (
      <StudioPanelShell title="Inspector" description="Select an item to change it.">
        <Empty>
          <EmptyMedia variant="icon">
            <Icon name="list-tree" />
          </EmptyMedia>
          <EmptyTitle>Nothing selected</EmptyTitle>
          <EmptyDescription>Select a page, block, field or step to change it.</EmptyDescription>
        </Empty>
      </StudioPanelShell>
    );
  const descriptor = inspector.descriptor;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {descriptor.kind !== "placement" && descriptor.kind !== "flow_step" && (
        <header className="flex shrink-0 items-start justify-between gap-2 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Icon name="sliders-horizontal" className="size-4 shrink-0" />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{title}</h2>
              <p className="text-xs text-muted-foreground">{studioKindLabel(descriptor.kind)}</p>
            </div>
          </div>
          <StudioInspectorActions
            actions={[
              {
                label: "Copy alias",
                onSelect: () => {
                  void navigator.clipboard.writeText(descriptor.alias);
                },
              },
            ]}
          />
        </header>
      )}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-3">
        {labels !== undefined ? (
          <StudioInspectorGroup title="General">
            <LabelsForm key={labelsKey} labels={labels} />
          </StudioInspectorGroup>
        ) : note === undefined ? null : (
          <p className="text-sm">{note}</p>
        )}
        {children}
        <StudioInspectorGroup title="Details" defaultOpen={false}>
          <dl className="space-y-3 font-mono text-xs">
            {[
              ["Kind", descriptor.kind],
              ["Alias", descriptor.alias],
              ["Source path", descriptor.sourcePath || "/"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <dt className="font-semibold">{label}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
                <StudioCopyButton label={`Copy ${label?.toLowerCase()}`} value={value!} />
              </div>
            ))}
          </dl>
        </StudioInspectorGroup>
      </div>
    </div>
  );
}
