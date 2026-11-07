"use client";
import { useMemo, useState, type ReactNode } from "react";
import {
  sourcePageShell,
  studioAccessGateChoices,
  studioStructureShellChoices,
  type ApplicationSourceDocument,
  type StudioPageLayoutPlan,
  type StudioSemanticSelection,
  type StudioStructureCommand,
  type StudioStructureResult,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import {
  StudioInspectorGroup,
  StudioOptionControl,
  type StudioInspectorAction,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { StudioPageLayoutDialog } from "./studio-page-layout-dialog";
import { useStudioStructureRun } from "./use-studio-structure-run";

/**
 * The selected page's or layout's structure settings in the inspector, the one place for them:
 * make home page, layout and who can open it for a page, and Delete for a page or a layout (its
 * name is the inspector's Name field). Each control sends one Structure command.
 */
export function useStudioStructureSettings({
  source,
  selected,
  disabled,
  onCommand,
  onPreview,
  onLayoutPlan,
  onOpenAccess,
}: Readonly<{
  source: ApplicationSourceDocument;
  selected: StudioSemanticSelection | null;
  disabled: boolean;
  onCommand: (command: StudioStructureCommand, merge?: string) => StudioStructureResult;
  onPreview: (command: StudioStructureCommand) => StudioStructureResult;
  onLayoutPlan: (pageAlias: string, shellAlias: string | null) => StudioPageLayoutPlan;
  /** Opens the Access tab, where who can open a page is set. */
  onOpenAccess: () => void;
}>): Readonly<{
  /** The header menu entries: Delete page or Delete layout. */
  actions: readonly StudioInspectorAction[];
  /** The page's settings group; nothing for a layout. */
  settings: ReactNode;
  /** The dialogs the controls open; drawn once beside the settings. */
  dialogs: ReactNode;
}> {
  const [confirm, confirmDialog] = useConfirm();
  const structure = useStudioStructureRun(onCommand);
  const [layoutChange, setLayoutChange] = useState<{
    pageAlias: string;
    shellAlias: string | null;
  } | null>(null);
  const choices = useMemo(() => studioStructureShellChoices(source), [source]);
  const page =
    selected?.kind === "page"
      ? source.body.pages.find((entry) => entry.id === selected.pageAlias)
      : undefined;
  const shell =
    selected?.kind === "shell"
      ? source.body.shells.find((entry) => entry.id === selected.shellAlias)
      : undefined;
  const target = page ?? shell;
  const what = page !== undefined ? "page" : "layout";
  const gate =
    page === undefined
      ? undefined
      : studioAccessGateChoices(source).find((choice) => choice.key === page.permission);
  const pageShell = page === undefined ? null : sourcePageShell(page.composition);
  const movingPage = source.body.pages.find((entry) => entry.id === layoutChange?.pageAlias);
  const remove = async () => {
    if (target === undefined) return;
    if (
      !(await confirm({
        title: `Remove the ${what} “${target.name}”?`,
        description:
          page !== undefined
            ? "The page, its blocks and its menu entries leave the draft. Undo brings them back."
            : "The layout and its blocks leave the draft. Undo brings them back.",
        confirmLabel: `Remove ${what}`,
      }))
    )
      return;
    structure.run(
      page !== undefined
        ? { kind: "remove_page", pageAlias: page.id }
        : { kind: "remove_shell", shellAlias: shell!.id },
    );
  };
  const actions: readonly StudioInspectorAction[] =
    target === undefined
      ? []
      : [
          {
            label: page !== undefined ? "Delete page" : "Delete layout",
            destructive: true,
            disabled,
            onSelect: () => {
              void remove();
            },
          },
        ];
  const settings =
    page === undefined ? null : (
      <StudioInspectorGroup title="Page settings">
        <div className="space-y-4">
          {page.key === source.body.home_page ? (
            <p className="text-sm text-muted-foreground">This is the home page.</p>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => structure.run({ kind: "set_home_page", pageAlias: page.id })}
            >
              Make home page
            </Button>
          )}
          <StudioField label="Layout" hint="Choose where your blocks go when you change layout.">
            {(control) => (
              <StudioOptionControl
                {...control}
                value={pageShell ?? ""}
                disabled={disabled}
                options={choices.map((choice) => ({
                  value: choice.shellAlias ?? "",
                  label: choice.label,
                }))}
                onChange={(value) => {
                  const shellAlias = value === "" ? null : value;
                  if (shellAlias !== pageShell) setLayoutChange({ pageAlias: page.id, shellAlias });
                }}
              />
            )}
          </StudioField>
          <div className="space-y-1">
            <p className="text-sm font-medium">Who can open it</p>
            <p className="text-sm text-muted-foreground">
              {gate === undefined
                ? "This page names a permission the application does not declare."
                : `People who hold “${gate.label}”: ${gate.roles.length === 0 ? "no role holds it yet" : gate.roles.join(", ")}.`}
            </p>
            <Button type="button" size="sm" variant="outline" onClick={onOpenAccess}>
              <Icon name="shield" />
              Change in Access
            </Button>
          </div>
        </div>
      </StudioInspectorGroup>
    );
  const dialogs = (
    <>
      {structure.dialog}
      {layoutChange !== null && movingPage !== undefined && (
        <StudioPageLayoutDialog
          key={`${layoutChange.pageAlias}:${layoutChange.shellAlias ?? ""}`}
          pageAlias={layoutChange.pageAlias}
          pageName={movingPage.name}
          shellAlias={layoutChange.shellAlias}
          layoutName={
            choices.find((choice) => choice.shellAlias === layoutChange.shellAlias)!.label
          }
          plan={onLayoutPlan(layoutChange.pageAlias, layoutChange.shellAlias)}
          disabled={disabled}
          onPreview={onPreview}
          onCommand={onCommand}
          onClose={() => setLayoutChange(null)}
        />
      )}
      {confirmDialog}
    </>
  );
  return { actions, settings, dialogs };
}
