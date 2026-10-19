"use client";
import { useMemo, useState } from "react";
import { StudioReferencePicker } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { Label } from "@vortex/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@vortex/ui/components/sheet";
import { StudioNewQueryForm, StudioQueryEditor } from "./studio-query-editor";
import type { StudioDraft } from "./use-studio-draft";
import { studioDataEdit } from "../_lib/studio-data-model";

/** The query the sheet is making: its record type first, then the query itself once it exists. */
type Step =
  | Readonly<{ kind: "name"; recordType: string }>
  | Readonly<{ kind: "edit"; moduleKey: string; queryKey: string }>;

/**
 * "New query" from anywhere in Studio: a side sheet that names a new query of one of the
 * application's own record types, creates it in that record type's Module (private, so only this
 * application reads it) and then opens the query editor on it, so its filter and inputs are set
 * there. `onDone` hands the new query's reference back to where the sheet was opened.
 */
export function StudioQuerySheet({
  open,
  draft,
  doneLabel,
  onClose,
  onDone,
}: Readonly<{
  open: boolean;
  draft: StudioDraft;
  /** What the finishing button says, for example "Use this query". */
  doneLabel: string;
  onClose: () => void;
  /** The new query, as the qualified reference a block stores: `<module>:<query>`. */
  onDone: (reference: string) => void;
}>) {
  const { source, view } = draft;
  const edit = studioDataEdit(draft);
  const owned = useMemo(
    () =>
      source.body.modules.flatMap((module) =>
        module.record_types.map((record) => ({
          value: `${module.key}:${record.key}`,
          label: record.plural_name,
          group: source.body.modules.length > 1 ? module.name : undefined,
        })),
      ),
    [source],
  );
  // A record input of the new query may name any record type the application owns or uses.
  const recordTypes = useMemo(
    () => [
      ...owned.map((record) => ({ key: record.value, label: record.label })),
      ...(view.usedModules ?? []).flatMap((module) =>
        module.recordTypes
          .filter((record) => record.linkable)
          .map((record) => ({
            key: `${module.key}:${record.key}`,
            label: `${record.pluralName} (${module.name})`,
          })),
      ),
    ],
    [owned, view.usedModules],
  );
  const [step, setStep] = useState<Step>({ kind: "name", recordType: owned[0]?.value ?? "" });
  const [moduleKey, recordKey] = step.kind === "name" ? step.recordType.split(":") : [];
  const exists =
    step.kind === "edit" &&
    source.body.modules
      .find((module) => module.key === step.moduleKey)
      ?.queries.some((query) => query.key === step.queryKey) === true;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>New query</SheetTitle>
          <SheetDescription>
            {step.kind === "name"
              ? "Lists records of one of this application's record types."
              : "Set what it lists. Inputs are values the page gives it, such as the company a page shows."}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          {step.kind === "name" ? (
            owned.length === 0 ? (
              <p role="status" className="text-sm">
                This application has no record types yet. Add one in the Data tab first.
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="new-query-record-type">Records it lists</Label>
                  <StudioReferencePicker
                    id="new-query-record-type"
                    value={step.recordType}
                    options={owned}
                    disabled={draft.locked}
                    onChange={(recordType) => {
                      if (recordType !== "") setStep({ kind: "name", recordType });
                    }}
                  />
                </div>
                {moduleKey === undefined || recordKey === undefined ? null : (
                  <StudioNewQueryForm
                    key={step.recordType}
                    source={source}
                    moduleKey={moduleKey}
                    recordKey={recordKey}
                    disabled={draft.locked}
                    edit={edit}
                    onCreated={(queryKey) => setStep({ kind: "edit", moduleKey, queryKey })}
                  />
                )}
              </>
            )
          ) : (
            <StudioQueryEditor
              key={`${step.moduleKey}:${step.queryKey}`}
              source={source}
              moduleKey={step.moduleKey}
              queryKey={step.queryKey}
              compiledFields={view.compiledFields}
              draftCompiles={view.failure === null}
              recordTypes={recordTypes}
              disabled={draft.locked}
              edit={edit}
              onDeleted={() => setStep({ kind: "name", recordType: owned[0]?.value ?? "" })}
            />
          )}
        </div>
        {step.kind === "edit" && exists && (
          // The way back stays in view while the editor scrolls.
          <SheetFooter className="sticky bottom-0 border-t bg-background">
            <Button type="button" onClick={() => onDone(`${step.moduleKey}:${step.queryKey}`)}>
              {doneLabel}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
