"use client";
import { useState, type FormEvent } from "react";
import {
  createOwnedInlineModule,
  deriveOwnedModuleKey,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { StudioField } from "./studio-field";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/** A module is part of the application's draft and is published with the application. */
export function StudioModuleDialog({
  open,
  source,
  edit,
  onClose,
  onCreated,
}: Readonly<{
  open: boolean;
  source: ApplicationSourceDocument;
  edit: StudioDataEdit;
  onClose: () => void;
  onCreated: (moduleKey: string) => void;
}>) {
  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>();
  const effectiveKey = key ?? deriveOwnedModuleKey(source, name) ?? "";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = edit((current) => createOwnedInlineModule(current, { name, key: effectiveKey }));
    if (result.kind !== "changed") {
      setProblem(studioEditProblem(result));
      return;
    }
    onClose();
    onCreated(result.moduleKey);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-lg" aria-label="New module">
        <DialogHeader>
          <DialogTitle>New module</DialogTitle>
          <DialogDescription>
            Group related record types. Modules publish with this application.
          </DialogDescription>
        </DialogHeader>
        <form id="studio-module-form" className="grid gap-4" onSubmit={submit} noValidate>
          <StudioField label="Module name" hint="For example Assets or People.">
            {(control) => (
              <Input
                {...control}
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setProblem(undefined);
                }}
              />
            )}
          </StudioField>
          <StudioInspectorGroup title="Details" defaultOpen={false}>
            <StudioField
              label="Module key"
              hint="Made from the name. It is permanent after creation."
            >
              {(control) => (
                <Input
                  {...control}
                  required
                  maxLength={120}
                  value={effectiveKey}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setProblem(undefined);
                  }}
                />
              )}
            </StudioField>
          </StudioInspectorGroup>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="studio-module-form">
            Add module
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
