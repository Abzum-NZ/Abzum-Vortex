"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  type ApplicationSourceDocument,
  studioRecordPageChoices,
  type StudioStructureResult,
  studioStructureDefaultShell,
  studioStructureShellChoices,
  type StudioStructureCommand,
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
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { StudioLimitNote, Reasoned, studioLimitReason } from "@vortex/ui/studio";
import { StudioOptionControl } from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { StudioRecordPageForm } from "./studio-record-page-form";
import { useStudioStructureRun } from "./use-studio-structure-run";

export type StudioStructureForm = "none" | "page" | "record" | "shell";

/**
 * The Structure tab's controls: add a page, a page for a record type or a layout. Each control sends
 * one command; a refusal uses the shared toast region with a way to inspect references, and nothing
 * changes. The selected page's or layout's own settings are in the inspector.
 */
export function StudioStructureEditor({
  source,
  disabled,
  onCommand,
  onPreview,
  form,
  onFormChange,
}: Readonly<{
  form: StudioStructureForm;
  onFormChange: (form: StudioStructureForm) => void;
  source: ApplicationSourceDocument;
  disabled: boolean;
  onCommand: (command: StudioStructureCommand) => StudioStructureResult;
  /** Runs a command on the current draft without keeping it, for a preview of what it adds. */
  onPreview: (command: StudioStructureCommand) => StudioStructureResult;
}>) {
  const setForm = onFormChange;
  const structure = useStudioStructureRun(onCommand);
  const [newName, setNewName] = useState("");
  const [pageKind, setPageKind] = useState<"dashboard" | "form">("dashboard");
  const [recordType, setRecordType] = useState("");
  const [shellChoice, setShellChoice] = useState("");
  const [addToMenu, setAddToMenu] = useState(true);
  const choices = useMemo(() => studioStructureShellChoices(source), [source]);

  const run = structure.run;
  useEffect(() => {
    setNewName("");
    setPageKind("dashboard");
    setRecordType("");
    structure.reset();
    setAddToMenu(true);
    setShellChoice(studioStructureDefaultShell(source) ?? "");
    // Opening a form starts a fresh command, independent of later draft changes.
  }, [form]);
  const newLimit = form === "page" ? "pagesPerApplication" : "layoutsPerApplication";
  const newUsed = form === "page" ? source.body.pages.length : source.body.shells.length;
  const newLimitReason = studioLimitReason(newLimit, newUsed);
  const submitNew = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newLimitReason !== undefined) return;
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
                  <StudioOptionControl
                    {...control}
                    value={pageKind}
                    disabled={disabled}
                    options={[
                      { value: "dashboard", label: "Dashboard" },
                      { value: "form", label: "Form" },
                    ]}
                    onChange={(value) => setPageKind(value === "form" ? "form" : "dashboard")}
                  />
                )}
              </StudioField>
              {pageKind === "form" && (
                <>
                  <StudioField
                    label="Record context"
                    hint="Required. Choose the record type this form works with. Add inputs and bind its Submit event to an operation flow in the page editor."
                  >
                    {(control) => (
                      <StudioOptionControl
                        {...control}
                        value={recordType}
                        disabled={disabled}
                        unset="Choose a record type"
                        options={studioRecordPageChoices(source).map((choice) => ({
                          value: choice.recordType,
                          label: choice.label,
                        }))}
                        onChange={setRecordType}
                      />
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
                  <StudioOptionControl
                    {...control}
                    value={shellChoice}
                    disabled={disabled}
                    options={choices.map((choice) => ({
                      value: choice.shellAlias ?? "",
                      label: choice.label,
                    }))}
                    onChange={setShellChoice}
                  />
                )}
              </StudioField>
              <Label>
                <Checkbox
                  checked={addToMenu}
                  disabled={disabled}
                  onCheckedChange={(checked) => setAddToMenu(checked === true)}
                />
                Show it in the menu
              </Label>
            </>
          )}
          <StudioLimitNote
            limit={newLimit}
            used={newUsed}
            label={form === "page" ? "Pages" : "Layouts"}
          />
          <div className="flex gap-2">
            <Reasoned reason={newLimitReason}>
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
            </Reasoned>
            <Button type="button" size="sm" variant="ghost" onClick={() => setForm("none")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {structure.dialog}
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
