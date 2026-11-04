"use client";
import { useMemo, useRef, useState } from "react";
import { applicationUses, type ApplicationSourceDocument } from "@vortex/platform/schema";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import {
  StudioDialog,
  StudioField,
  StudioReferencePicker,
  studioActionBarMore,
  studioMoveUnavailableReason,
  studioOutcomeText,
  describeStudioCompositionDestinations,
  describeStudioCompositionWrap,
  type StudioCompositionCommand,
  type StudioCompositionContext,
  type StudioCompositionOutcome,
  type StudioCompositionSettings,
  type StudioSemanticSelection,
  type StudioSettingChoices,
} from "@vortex/ui/studio";
import type { StudioBlockDialogKind } from "@vortex/ui/studio/puck-provider";
import { studioPlacementLabel } from "../_lib/studio-labels";
import { StudioBlockSetupDialog, type StudioBlockSetupRequest } from "./studio-block-setup-dialog";
import { StudioPlaceList } from "./studio-used-in";
import { studioNotice } from "./studio-save-state";

type Props = Readonly<{
  /** The dialog open for the selected block, or `null`. */
  open: StudioBlockDialogKind | null;
  onClose: () => void;
  context: StudioCompositionContext;
  selection: StudioSemanticSelection;
  source: ApplicationSourceDocument;
  /** Selection key to the label Studio shows, from the draft's one outline. */
  labels: ReadonlyMap<string, string>;
  disabled: boolean;
  choices: StudioSettingChoices;
  onCommand: (
    expected: StudioCompositionContext,
    selection: StudioSemanticSelection,
    command: StudioCompositionCommand,
  ) => StudioCompositionOutcome;
}>;

/** Stable option key of a move destination: its closed descriptor, not a serialised object. */
const destinationOptionKey = (destination: {
  readonly kind: string;
  readonly parentAlias?: string;
  readonly slotKey?: string;
}): string =>
  destination.kind === "child"
    ? `child:${encodeURIComponent(destination.parentAlias ?? "")}:${encodeURIComponent(destination.slotKey ?? "")}`
    : destination.kind;

/**
 * Move to and Wrap in container for the selected block, and where it is used. Each is one
 * composition command (or a read of the draft's reference index), opened from the block's action
 * bar; a refusal is said in the dialog and the dialog stays open.
 */
export function StudioBlockDialogs(props: Props) {
  const { open, onClose, context, selection, source, labels, disabled, choices, onCommand } = props;
  const [problem, setProblem] = useState("");
  const [setup, setSetup] = useState<StudioBlockSetupRequest | null>(null);
  // The places a block can move to are worked out when the dialog is open: each is a check of the
  // whole content area.
  const move = useMemo(
    () => (open === "move" ? describeStudioCompositionDestinations(context, selection) : null),
    [open, context, selection],
  );
  const wrap = useMemo(
    () => (open === "wrap" ? describeStudioCompositionWrap(context, selection) : null),
    [open, context, selection],
  );
  const places = useMemo(
    () =>
      open === "usedIn" && selection.kind === "placement"
        ? applicationUses(source, { kind: "placement", placementAlias: selection.placementAlias })
        : [],
    [open, source, selection],
  );
  const name =
    selection.kind === "placement"
      ? (studioPlacementLabel(labels, selection.placementAlias) ?? "Block")
      : "Block";
  const close = () => {
    setProblem("");
    onClose();
  };
  // The block that was acted on takes the focus back: its More button in the action bar. A Wrap
  // that asks for settings first hands the focus to the setup dialog, which gives it back.
  const handedOff = useRef(false);
  const returnFocus = (): HTMLElement | false => {
    if (handedOff.current) {
      handedOff.current = false;
      return false;
    }
    return selection.kind === "placement" ? studioActionBarMore(selection.placementAlias) : false;
  };
  const destinations = move?.kind === "available" ? move.destinations : [];
  const moveReason = move === null ? undefined : studioMoveUnavailableReason(move);

  const moveTo = (key: string) => {
    // Option values identify a current closed descriptor, never a source path or an array index.
    const chosen = destinations.find((item) => destinationOptionKey(item.destination) === key);
    if (chosen === undefined) {
      setProblem("This destination is no longer available.");
      return;
    }
    const result = onCommand(context, selection, { kind: "move", destination: chosen.destination });
    if (result.kind !== "applied") {
      setProblem(studioOutcomeText(result, "Nothing changed."));
      return;
    }
    studioNotice("Block moved.", "success");
    close();
  };

  const wrapIn = (key: string) => {
    const chosen =
      wrap?.kind === "available"
        ? wrap.containers.find((item) => `${item.blockId}:${item.releaseVersion}` === key)
        : undefined;
    if (chosen === undefined) {
      setProblem("This container is no longer available.");
      return;
    }
    const place = (settings: StudioCompositionSettings): string | true => {
      if (disabled) return "Studio is read-only right now.";
      const result = onCommand(context, selection, {
        kind: "wrap",
        blockId: chosen.blockId,
        releaseVersion: chosen.releaseVersion,
        settings,
      });
      if (result.kind !== "applied") return studioOutcomeText(result, "Nothing changed.");
      studioNotice(`Block placed in a new ${chosen.name.toLowerCase()}.`, "success");
      return true;
    };
    // A container with required settings (a dialog's title) asks for them before it wraps.
    if (chosen.choice.setup.length === 0) {
      const outcome = place({});
      if (outcome === true) close();
      else setProblem(outcome);
      return;
    }
    handedOff.current = true;
    close();
    setSetup({
      choice: chosen.choice,
      description: `Place this block in a new ${chosen.name.toLowerCase()}.`,
      action: `Place in ${chosen.name.toLowerCase()}`,
      pageQuery: undefined,
      add: place,
    });
  };

  const problemAlert = problem !== "" && (
    <Alert variant="destructive">
      <AlertDescription>{problem}</AlertDescription>
    </Alert>
  );
  return (
    <>
      <StudioDialog
        open={open === "move"}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title="Move to another area"
        description={`Moves ${name}, with what is inside it, to the end of the area you choose in this page or layout. Required content and nesting limits are checked first.`}
        closeLabel="Cancel"
        finalFocus={returnFocus}
      >
        <StudioField label="Destination">
          {(control) => (
            <StudioReferencePicker
              {...control}
              value=""
              unset="Choose a destination"
              disabled={disabled || destinations.length === 0}
              options={destinations.map((item) => ({
                value: destinationOptionKey(item.destination),
                label:
                  item.destination.kind === "child"
                    ? `${studioPlacementLabel(labels, item.destination.parentAlias) ?? "Block"} / ${item.label.slice(item.label.indexOf(" / ") + 3)}`
                    : item.label,
              }))}
              onChange={(next) => {
                if (next !== "") moveTo(next);
              }}
            />
          )}
        </StudioField>
        {moveReason !== undefined && (
          <p role="status" className="text-sm text-muted-foreground">
            {moveReason}
          </p>
        )}
        {problemAlert}
      </StudioDialog>
      <StudioDialog
        open={open === "wrap"}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title="Wrap in container"
        description={`Puts ${name} into a new container that takes its place. The block keeps its name, settings and order. Containers that cannot hold it say why.`}
        closeLabel="Cancel"
        finalFocus={returnFocus}
      >
        {wrap?.kind === "available" && wrap.containers.length > 0 && (
          <StudioField label="Container">
            {(control) => (
              <StudioReferencePicker
                {...control}
                value=""
                unset="Choose a container"
                disabled={disabled}
                options={wrap.containers.map((item) => ({
                  value: `${item.blockId}:${item.releaseVersion}`,
                  label:
                    item.unavailable === undefined
                      ? item.name
                      : `${item.name} (not possible: ${item.unavailable})`,
                }))}
                onChange={(next) => {
                  if (next !== "") wrapIn(next);
                }}
              />
            )}
          </StudioField>
        )}
        {problemAlert}
      </StudioDialog>
      <StudioDialog
        open={open === "usedIn"}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={`Where ${name} is used`}
        closeLabel="Close"
        finalFocus={returnFocus}
      >
        {places.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Not used anywhere yet.
          </p>
        ) : (
          <StudioPlaceList places={places} label={`Where ${name} is used`} onBeforeOpen={close} />
        )}
      </StudioDialog>
      <StudioBlockSetupDialog
        request={setup}
        choices={choices}
        onClose={() => setSetup(null)}
        finalFocus={returnFocus}
      />
    </>
  );
}
