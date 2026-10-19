"use client";
import { useState } from "react";
import {
  setInlineRecordStandardActions,
  standardRecordActions,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
} from "@vortex/platform/schema";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { Switch } from "@vortex/ui/components/switch";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-used-in";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/** Each switch changes the operation, generated permission and ordinary role references together. */
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
  return (
    <StudioInspectorGroup title="Standard actions">
      <p className="text-sm text-muted-foreground">
        Enabling an action creates its permission. Give access groups that permission in Access.
      </p>
      {standardRecordActions.map((entry) => (
        <StudioField key={entry.action} label={entry.verb}>
          {(control) => (
            <Switch
              {...control}
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
          )}
        </StudioField>
      ))}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
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
