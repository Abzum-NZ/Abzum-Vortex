"use client";
import { Alert, AlertDescription } from "@vortex/ui/components/alert";
import { useState } from "react";
import {
  setInlineRecordStandardActions,
  standardRecordActions,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Label } from "@vortex/ui/components/label";
import { StudioReferencesAlert } from "./studio-used-in";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/** Each checkbox changes the operation, generated permission and ordinary role references together. */
export function StudioRecordStandardActions({
  source,
  moduleKey,
  recordKey,
  disabled,
  edit,
}: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  recordKey: string;
  disabled: boolean;
  edit: StudioDataEdit;
}>) {
  const [problem, setProblem] = useState<string>();
  const [references, setReferences] = useState<readonly ApplicationUsePlace[]>([]);
  const [refusals, setRefusals] = useState(0);
  const record = source.body.modules
    .find((module) => module.key === moduleKey)
    ?.record_types.find((item) => item.key === recordKey);
  if (record === undefined) return null;
  const on = standardRecordActions.filter((entry) =>
    record.standard_actions.includes(entry.action),
  ).length;
  return (
    <StudioInspectorGroup
      title="Standard actions"
      defaultOpen={false}
      hint="Turning an action on creates its permission. Give access groups that permission in Access."
      summary={`${on} of ${standardRecordActions.length} on`}
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {standardRecordActions.map((entry) => {
          const id = `standard-action-${moduleKey}-${recordKey}-${entry.action}`;
          return (
            <div key={entry.action} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={record.standard_actions.includes(entry.action)}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const result = edit((current) => {
                    const now = current.body.modules
                      .find((module) => module.key === moduleKey)
                      ?.record_types.find((item) => item.key === recordKey);
                    return setInlineRecordStandardActions(current, {
                      moduleKey,
                      recordKey,
                      actions: checked
                        ? [...(now?.standard_actions ?? []), entry.action]
                        : (now?.standard_actions ?? []).filter((action) => action !== entry.action),
                    });
                  });
                  setReferences(result.kind === "referenced" ? result.references : []);
                  setProblem(result.kind === "referenced" ? undefined : studioEditProblem(result));
                  setRefusals((value) => value + 1);
                }}
              />
              <Label htmlFor={id} className="font-normal">
                {entry.verb}
              </Label>
            </div>
          );
        })}
      </div>
      {problem === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <StudioReferencesAlert
        key={refusals}
        name="This action"
        action="disabled"
        references={references}
      />
    </StudioInspectorGroup>
  );
}
