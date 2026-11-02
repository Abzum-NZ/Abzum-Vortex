"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
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
import { FieldGroup } from "@vortex/ui/components/field";
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
        <form id="studio-module-form" onSubmit={submit} noValidate>
          <FieldGroup>
            <StudioField label="Module name">
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
            <StudioInspectorGroup
              title="Advanced"
              defaultOpen={false}
              persist={false}
              summary={`Key ${effectiveKey}`}
            >
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
              <Alert variant="destructive">
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
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
