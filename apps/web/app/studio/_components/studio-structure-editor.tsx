"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  sourcePageShell,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import { Icon } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@vortex/ui/components/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { toast } from "@vortex/ui/components/sonner";
import type { StudioSemanticSelection } from "@vortex/ui/studio";
import {
  studioStructureDefaultShell,
  studioStructureShellChoices,
  studioRecordPageChoices,
  type StudioPageLayoutPlan,
  type StudioStructureCommand,
  type StudioStructureResult,
} from "@vortex/ui/studio";
import { studioAccessGateChoices } from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { StudioRecordPageForm } from "./studio-record-page-form";
import { StudioPlaceList } from "./studio-used-in";
import { useStudioDraftText } from "./use-studio-draft-text";
import { StudioPageLayoutDialog } from "./studio-page-layout-dialog";

type Refusal = Readonly<{
  message: string;
  where?: readonly ApplicationUsePlace[] | undefined;
}>;
export type StudioStructureForm = "none" | "page" | "record" | "shell";

/**
 * The Structure tab's controls: add a page or a layout, and rename, remove or make home the page or
 * layout selected in the tree. Each control sends one command; a refusal uses the shared toast
 * region with a way to inspect references, and nothing changes.
 */
export function StudioStructureEditor({
  source,
  selected,
  disabled,
  onCommand,
  onPreview,
  onLayoutPlan,
  onOpenAccess,
  form,
  onFormChange,
}: Readonly<{
  form: StudioStructureForm;
  onFormChange: (form: StudioStructureForm) => void;
  source: ApplicationSourceDocument;
  selected: StudioSemanticSelection | null;
  disabled: boolean;
  /** One Structure edit; `merge` joins a run of edits to one value (typing a name) into one Undo step. */
  onCommand: (command: StudioStructureCommand, merge?: string) => StudioStructureResult;
  /** Runs a command on the current draft without keeping it, for a preview of what it adds. */
  onPreview: (command: StudioStructureCommand) => StudioStructureResult;
  onLayoutPlan: (pageAlias: string, shellAlias: string | null) => StudioPageLayoutPlan;
  /** Opens the Access tab, where who can open a page is set. */
  onOpenAccess: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const setForm = onFormChange;
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [showReferences, setShowReferences] = useState(false);
  const [newName, setNewName] = useState("");
  const [pageKind, setPageKind] = useState<"dashboard" | "form">("dashboard");
  const [recordType, setRecordType] = useState("");
  const [shellChoice, setShellChoice] = useState("");
  const [addToMenu, setAddToMenu] = useState(true);
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

  const run = (command: StudioStructureCommand, merge?: string): boolean => {
    const result = onCommand(command, merge);
    if (result.kind === "refused") {
      const hasReferences = result.where !== undefined && result.where.length > 0;
      toast.error("Nothing was changed", {
        id: "studio-structure-refusal",
        description: <span className="text-muted-foreground">{result.message}</span>,
        duration: Infinity,
        closeButton: true,
        action: {
          label: hasReferences ? "Show me where" : "Dismiss",
          onClick: () => {
            if (hasReferences) {
              setRefusal(result);
              setShowReferences(true);
            }
          },
        },
      });
    }
    return result.kind === "applied";
  };
  useEffect(() => {
    setNewName("");
    setPageKind("dashboard");
    setRecordType("");
    setRefusal(null);
    setShowReferences(false);
    setAddToMenu(true);
    setShellChoice(studioStructureDefaultShell(source) ?? "");
    // Opening a form starts a fresh command, independent of later draft changes.
  }, [form]);
  const submitNew = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const applied =
      form === "page"
        ? run({
            kind: "add_page",
            ...(pageKind === "form" ? { type: "form", recordType } : { type: "dashboard" }),
            name: newName,
            shellAlias: shellChoice === "" ? null : shellChoice,
            addToMenu,
          })
        : run({ kind: "add_shell", name: newName });
    if (applied) setForm("none");
  };
  const rename = useStudioDraftText(target?.name ?? "", (next) =>
    next.trim().length === 0
      ? `Enter a name for the ${what}.`
      : selected?.kind === "page" || selected?.kind === "shell"
        ? run(
            { kind: "rename", selection: selected, name: next },
            `structure-name:${target?.id ?? ""}`,
          ) || ""
        : "",
  );
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
    run(
      page !== undefined
        ? { kind: "remove_page", pageAlias: page.id }
        : { kind: "remove_shell", shellAlias: shell!.id },
    );
  };

  return (
    <div className="space-y-4">
      {form === "record" && (
        <StudioRecordPageForm
          source={source}
          disabled={disabled}
          onPreview={onPreview}
          onCommand={(command) => run(command)}
          onClose={() => setForm("none")}
        />
      )}
      {(form === "page" || form === "shell") && (
        <form
          className="space-y-4"
          onSubmit={submitNew}
          aria-label={form === "page" ? "New page" : "New layout"}
        >
          <StudioField label={form === "page" ? "Page name" : "Layout name"}>
            {(control) => (
              <Input
                {...control}
                value={newName}
                maxLength={60}
                disabled={disabled}
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
              />
            )}
          </StudioField>
          {form === "page" && (
            <>
              <StudioField label="Page kind">
                {(control) => (
                  <NativeSelect
                    {...control}
                    value={pageKind}
                    disabled={disabled}
                    onChange={(event) =>
                      setPageKind(event.target.value === "form" ? "form" : "dashboard")
                    }
                  >
                    <NativeSelectOption value="dashboard">Dashboard</NativeSelectOption>
                    <NativeSelectOption value="form">Form</NativeSelectOption>
                  </NativeSelect>
                )}
              </StudioField>
              {pageKind === "form" && (
                <>
                  <StudioField
                    label="Record context"
                    hint="Required. Choose the record type this form works with. Add inputs and bind its Submit event to an operation flow in the page editor."
                  >
                    {(control) => (
                      <NativeSelect
                        {...control}
                        value={recordType}
                        required
                        disabled={disabled}
                        onChange={(event) => setRecordType(event.target.value)}
                      >
                        <NativeSelectOption value="">Choose a record type</NativeSelectOption>
                        {studioRecordPageChoices(source).map((choice) => (
                          <NativeSelectOption key={choice.recordType} value={choice.recordType}>
                            {choice.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    )}
                  </StudioField>
                  {source.body.modules.every((module) => module.record_types.length === 0) && (
                    <p className="text-sm text-muted-foreground">
                      Add a record type in Data before creating a form page.
                    </p>
                  )}
                </>
              )}
              <StudioField
                label="Layout"
                hint="The frame the page is drawn in. People who can open the home page can open the new page."
              >
                {(control) => (
                  <NativeSelect
                    {...control}
                    value={shellChoice}
                    disabled={disabled}
                    onChange={(event) => setShellChoice(event.target.value)}
                  >
                    {choices.map((choice) => (
                      <NativeSelectOption
                        key={choice.shellAlias ?? ""}
                        value={choice.shellAlias ?? ""}
                      >
                        {choice.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </StudioField>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={addToMenu}
                  disabled={disabled}
                  onCheckedChange={(checked) => setAddToMenu(checked === true)}
                />
                Show it in the menu
              </label>
            </>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                disabled ||
                newName.trim().length === 0 ||
                (form === "page" && pageKind === "form" && recordType === "")
              }
            >
              {form === "page" ? "Add page" : "Add layout"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setForm("none")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {target !== undefined && (
        <section key={target.id} className="space-y-4" aria-label={`Selected ${what}`}>
          <p className="text-sm font-medium">
            {page !== undefined ? "Selected page" : "Selected layout"}
            {page !== undefined && page.key === source.body.home_page && (
              <span className="text-muted-foreground"> · home page</span>
            )}
          </p>
          <StudioField
            label="Name"
            error={rename.problem === "" ? undefined : rename.problem}
            onUndo={rename.reset}
          >
            {(control) => (
              <Input
                {...control}
                value={rename.text}
                maxLength={60}
                disabled={disabled}
                onChange={(event) => rename.change(event.target.value)}
              />
            )}
          </StudioField>
          <div className="flex flex-wrap gap-2">
            {page !== undefined && page.key !== source.body.home_page && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => run({ kind: "set_home_page", pageAlias: page.id })}
              >
                Make home page
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Remove ${what}`}
                    onClick={() => {
                      void remove();
                    }}
                  />
                }
              >
                <Icon name="close" />
              </TooltipTrigger>
              <TooltipContent>Remove {what}</TooltipContent>
            </Tooltip>
          </div>
          {page !== undefined && (
            <StudioField label="Layout" hint="Choose where your blocks go when you change layout.">
              {(control) => (
                <NativeSelect
                  {...control}
                  value={pageShell ?? ""}
                  disabled={disabled}
                  onChange={(event) => {
                    const shellAlias = event.target.value === "" ? null : event.target.value;
                    if (shellAlias !== pageShell)
                      setLayoutChange({ pageAlias: page.id, shellAlias });
                  }}
                >
                  {choices.map((choice) => (
                    <NativeSelectOption
                      key={choice.shellAlias ?? ""}
                      value={choice.shellAlias ?? ""}
                    >
                      {choice.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </StudioField>
          )}
          {page !== undefined && (
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
          )}
        </section>
      )}
      <Dialog open={showReferences} onOpenChange={setShowReferences}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Where it is used</DialogTitle>
            <DialogDescription>{refusal?.message}</DialogDescription>
          </DialogHeader>
          <StudioPlaceList
            places={refusal?.where ?? []}
            label="Where it is used"
            onBeforeOpen={() => setShowReferences(false)}
          />
        </DialogContent>
      </Dialog>
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
    </div>
  );
}

/** The one add menu in the Structure pane header. */
export function StudioStructureAdd({
  disabled,
  onAdd,
}: Readonly<{ disabled: boolean; onAdd: (form: StudioStructureForm) => void }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" size="sm" variant="secondary" disabled={disabled} />}
      >
        <Icon name="plus" />
        Add
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onAdd("page")}>Page</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAdd("record")}>Page for a record type</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAdd("shell")}>Layout</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
