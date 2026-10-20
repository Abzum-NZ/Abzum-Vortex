"use client";
import { useState } from "react";
import type {
  ApplicationSourceDocument,
  ImmutablePlatformBlockCatalogue,
} from "@vortex/platform/schema";
import {
  applyStudioStructureCommand,
  studioLayoutOutletTargets,
  studioLayoutOutletPlacementUses,
  StudioField,
  StudioInspectorGroup,
  StudioReferencePicker,
  StudioIconButton,
  type StudioStructureCommand,
  type StudioStructureResult,
  type StudioLayoutOutletValues,
} from "@vortex/ui/studio";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { Switch } from "@vortex/ui/components/switch";
import { Checkbox } from "@vortex/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@vortex/ui/components/dialog";
import { toast } from "@vortex/ui/components/sonner";
import type { StudioDraft } from "./use-studio-draft";
import { useStudioDraftText } from "./use-studio-draft-text";
import { StudioPlaceList } from "./studio-used-in";

type Shell = ApplicationSourceDocument["body"]["shells"][number];
type Outlet = Shell["content_slots"][number];
type Run = (command: StudioStructureCommand, merge?: string) => string | true;

/** A reserved target cannot be removed; its uses open the Layout inspector or affected page. */
export function StudioLayoutOutletUses({
  source,
  placementAlias,
}: Readonly<{
  source: ApplicationSourceDocument;
  placementAlias: string;
}>) {
  const [open, setOpen] = useState(false);
  const uses = studioLayoutOutletPlacementUses(source, placementAlias);
  if (uses.length === 0) return null;
  return (
    <StudioInspectorGroup title="Content outlet references">
      <p className="text-sm text-muted-foreground">
        A content outlet reserves this block or a block inside it. Retarget the outlet before
        removing this block.
      </p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Show me where
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Where it is used</DialogTitle>
            <DialogDescription>
              Open the layout to retarget its outlet, or inspect a page that binds it.
            </DialogDescription>
          </DialogHeader>
          <StudioPlaceList
            places={uses}
            label="Content outlet references"
            onBeforeOpen={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </StudioInspectorGroup>
  );
}

function OutletSettings({
  shell,
  outlet,
  catalogue,
  disabled,
  run,
}: Readonly<{
  shell: Shell;
  outlet: Outlet;
  catalogue: ImmutablePlatformBlockCatalogue;
  disabled: boolean;
  run: Run;
}>) {
  const targets = studioLayoutOutletTargets(
    {
      catalogue,
      describePlacement: ({ block, settings }) =>
        typeof settings.title === "string" && settings.title.trim() !== ""
          ? settings.title
          : catalogue.releases.find(
              (release) =>
                String(release.blockId) === block.block_id &&
                String(release.releaseVersion) === block.release_version,
            )?.name,
    },
    shell,
    outlet.id,
  );
  const target = targets.find(
    (entry) =>
      entry.parentPlacement === outlet.parent_placement && entry.parentSlot === outlet.parent_slot,
  );
  const edit = (values: StudioLayoutOutletValues, merge?: string) =>
    run(
      {
        kind: "edit_layout_outlet",
        shellAlias: shell.id,
        outletId: outlet.id,
        values,
      },
      merge,
    );
  const label = useStudioDraftText(outlet.label, (value) =>
    edit({ ...outlet, label: value }, `outlet-label:${outlet.id}`),
  );
  return (
    <div className="space-y-4 py-3">
      <StudioField label="Label" error={label.problem || undefined} onUndo={label.reset}>
        {(control) => (
          <Input
            {...control}
            value={label.text}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => label.change(event.target.value)}
          />
        )}
      </StudioField>
      <StudioField label="Target container and slot">
        {(control) => (
          <StudioReferencePicker
            {...control}
            disabled={disabled}
            value={`${outlet.parent_placement}:${outlet.parent_slot}`}
            options={targets.map((entry) => ({
              value: `${entry.parentPlacement}:${entry.parentSlot}`,
              label: entry.label,
            }))}
            onChange={(value) => {
              const next = targets.find(
                (entry) => `${entry.parentPlacement}:${entry.parentSlot}` === value,
              );
              if (next === undefined) return;
              // A retarget retains the authored categories. If the new declaration is narrower,
              // the command explains the refusal; it never silently changes this selection.
              edit({
                ...outlet,
                parent_placement: next.parentPlacement,
                parent_slot: next.parentSlot,
              });
            }}
          />
        )}
      </StudioField>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium">Allowed child categories</legend>
        {target?.categories.map((category) => (
          <label key={category} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={outlet.allowed_child_categories.includes(category)}
              onCheckedChange={(checked) =>
                edit({
                  ...outlet,
                  allowed_child_categories:
                    checked === true
                      ? [...outlet.allowed_child_categories, category]
                      : outlet.allowed_child_categories.filter((entry) => entry !== category),
                })
              }
            />
            {category.replaceAll("_", " ")}
          </label>
        ))}
      </fieldset>
      <StudioInspectorGroup title="Outlet details" defaultOpen={false}>
        <dl className="space-y-2 break-all text-xs">
          <dt>Key</dt>
          <dd>{outlet.key}</dd>
          <dt>Binding</dt>
          <dd>{outlet.id}</dd>
          <dt>Target</dt>
          <dd>
            {outlet.parent_placement}.{outlet.parent_slot}
          </dd>
        </dl>
      </StudioInspectorGroup>
    </div>
  );
}

/** The Layout inspector edits the open draft, with the same history and autosave as Structure. */
export function StudioLayoutOutlets({
  draft,
  catalogue,
  shell,
}: Readonly<{
  draft: StudioDraft;
  catalogue: ImmutablePlatformBlockCatalogue;
  shell: Shell;
}>) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Extract<
    StudioStructureResult,
    { kind: "refused" }
  > | null>(null);
  const [showUses, setShowUses] = useState(false);
  const describePlacement = ({ block }: { block: { block_id: string; release_version: string } }) =>
    catalogue.releases.find(
      (entry) =>
        String(entry.blockId) === block.block_id &&
        String(entry.releaseVersion) === block.release_version,
    )?.name;
  const targets = studioLayoutOutletTargets({ catalogue, describePlacement }, shell);
  const [newTarget, setNewTarget] = useState("");
  if (catalogue.releases.length === 0)
    return (
      <StudioInspectorGroup title="Content outlets">
        <p role="status" className="text-sm text-muted-foreground">
          Loading layout blocks…
        </p>
      </StudioInspectorGroup>
    );
  const run: Run = (command, merge) => {
    const outcome = draft.run<StudioStructureResult>(
      (source) => {
        const result = applyStudioStructureCommand(
          { source, catalogue, describePlacement, publishedFields: new Set() },
          command,
        );
        return result.kind === "applied"
          ? { kind: "edit", source: result.source, result }
          : { kind: "keep", result };
      },
      { merge },
    );
    const result =
      outcome.kind === "done"
        ? outcome.result
        : { kind: "refused" as const, message: outcome.message };
    if (result.kind === "applied") {
      if (command.kind === "add_layout_outlet") {
        const added = result.source.body.shells
          .find((entry) => entry.id === shell.id)
          ?.content_slots.at(-1);
        if (added !== undefined) setExpanded(added.id);
      }
      return true;
    }
    setRefusal(result);
    toast.error("Nothing was changed", {
      description: result.message,
      closeButton: true,
      duration: Infinity,
      action: result.where?.length
        ? { label: "Show me where", onClick: () => setShowUses(true) }
        : undefined,
    });
    return result.message;
  };
  return (
    <StudioInspectorGroup title="Content outlets">
      <p className="text-xs text-muted-foreground">
        Required outlets bind every page. Empty content is valid.
      </p>
      <div className="divide-y">
        {shell.content_slots.map((outlet) => (
          <div key={outlet.id}>
            <div className="flex min-h-9 items-center gap-2 rounded-md hover:bg-accent/50">
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start"
                aria-expanded={expanded === outlet.id}
                onClick={() => setExpanded(expanded === outlet.id ? null : outlet.id)}
              >
                <Icon
                  name="chevron-down"
                  className={expanded === outlet.id ? "size-4" : "size-4 -rotate-90"}
                />
                <span className="truncate">{outlet.label}</span>
              </Button>
              <span className="text-xs text-muted-foreground">Required</span>
              <Switch
                aria-label={`Required: ${outlet.label}`}
                checked={outlet.required}
                disabled={draft.locked}
                onCheckedChange={(required) =>
                  run({
                    kind: "edit_layout_outlet",
                    shellAlias: shell.id,
                    outletId: outlet.id,
                    values: { ...outlet, required },
                  })
                }
              />
              <StudioIconButton
                label={`Remove outlet ${outlet.label}`}
                disabled={draft.locked}
                destructive
                onClick={() =>
                  run({ kind: "remove_layout_outlet", shellAlias: shell.id, outletId: outlet.id })
                }
              >
                <Icon name="close" />
              </StudioIconButton>
            </div>
            {expanded === outlet.id && (
              <OutletSettings
                shell={shell}
                outlet={outlet}
                catalogue={catalogue}
                disabled={draft.locked}
                run={run}
              />
            )}
          </div>
        ))}
      </div>
      <StudioField label="New outlet target">
        {(control) => (
          <StudioReferencePicker
            {...control}
            value={newTarget}
            disabled={draft.locked}
            unset="Choose an empty slot"
            options={targets.map((entry) => ({
              value: `${entry.parentPlacement}:${entry.parentSlot}`,
              label: entry.label,
            }))}
            onChange={setNewTarget}
          />
        )}
      </StudioField>
      <Button
        variant="secondary"
        size="sm"
        disabled={
          draft.locked ||
          !targets.some((entry) => `${entry.parentPlacement}:${entry.parentSlot}` === newTarget)
        }
        onClick={() => {
          const target = targets.find(
            (entry) => `${entry.parentPlacement}:${entry.parentSlot}` === newTarget,
          );
          if (target === undefined) return;
          if (
            run({
              kind: "add_layout_outlet",
              shellAlias: shell.id,
              values: {
                label: "Content",
                required: false,
                parent_placement: target.parentPlacement,
                parent_slot: target.parentSlot,
                allowed_child_categories: [...target.categories],
              },
            }) === true
          )
            setNewTarget("");
        }}
      >
        <Icon name="plus" />
        Add outlet
      </Button>
      <Dialog open={showUses} onOpenChange={setShowUses}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Where it is used</DialogTitle>
            <DialogDescription>{refusal?.message}</DialogDescription>
          </DialogHeader>
          <StudioPlaceList
            places={refusal?.where ?? []}
            label="Where it is used"
            onBeforeOpen={() => setShowUses(false)}
          />
        </DialogContent>
      </Dialog>
    </StudioInspectorGroup>
  );
}
