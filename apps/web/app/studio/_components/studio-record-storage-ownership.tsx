"use client";
import { useState } from "react";
import {
  recordOwnershipSources,
  setInlineRecordStorageOwnership,
  type ApplicationSourceDocument,
  type RecordOwnershipChoice,
  type RecordOwnershipMode,
  type RecordSettingsContext,
  type RecordStorageScope,
} from "@vortex/platform/schema";
import {
  StudioInspectorGroup,
  StudioReferencePicker,
  StudioSegmentedControl,
} from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { StudioField } from "./studio-field";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

export const recordStorageLabels: Readonly<Record<RecordStorageScope, string>> = {
  organization_shared: "Shared within organisation",
  application_contained: "Only this application",
};

export const recordOwnershipLabels: Readonly<Record<RecordOwnershipMode, string>> = {
  none: "No owner",
  organization_account: "Person",
  group: "Group",
  inherited: "From linked record",
};

const ownershipHints: Readonly<Record<RecordOwnershipMode, string>> = {
  none: "Records belong to nobody; roles alone decide who may act on them.",
  organization_account: "Each record belongs to the person who created it.",
  group: "Each record belongs to a group of the person who created it.",
  inherited: "Each record has the owner of the record it links to.",
};

const storageScopes = Object.keys(recordStorageLabels) as RecordStorageScope[];
const ownershipModes = Object.keys(recordOwnershipLabels) as RecordOwnershipMode[];

/**
 * Where a record type's records are kept and who owns each one. Both are chosen before the first
 * publication and fixed afterwards, when they are shown read-only. Ownership from a linked record is
 * applied only together with the link it follows: choosing it first asks for the link.
 */
export function StudioRecordStorageOwnership({
  source,
  moduleKey,
  recordKey,
  context,
  name,
  disabled,
  edit,
  onAddLink,
}: Readonly<{
  source: ApplicationSourceDocument;
  moduleKey: string;
  recordKey: string;
  context: RecordSettingsContext;
  /** A record type's business name from its qualified key (`module:record`). */
  name: (qualified: string) => string;
  disabled: boolean;
  edit: StudioDataEdit;
  /** Starts a new link field on this record type, for a link to take the owner from. */
  onAddLink: () => void;
}>) {
  const record = source.body.modules
    .find((module) => module.key === moduleKey)
    ?.record_types.find((item) => item.key === recordKey);
  // "From linked record" chosen while no link is chosen yet: nothing is saved until one is.
  const [choosingLink, setChoosingLink] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  if (record === undefined) return null;
  const published = context.publication.recordTypes.has(`${moduleKey}:${recordKey}`);
  const sources = recordOwnershipSources(source, moduleKey, recordKey, context, name);
  const relationship = record.ownership_relationship;
  const current = sources.find((item) => item.key === relationship);
  const mode: RecordOwnershipMode = choosingLink ? "inherited" : record.ownership_mode;

  if (published)
    return (
      <StudioInspectorGroup title="Storage and ownership">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Records are kept</dt>
          <dd>{recordStorageLabels[record.storage_scope]}</dd>
          <dt className="text-muted-foreground">Owner</dt>
          <dd>
            {recordOwnershipLabels[record.ownership_mode]}
            {current === undefined ? null : ` (${current.label})`}
          </dd>
        </dl>
        <p className="text-sm text-muted-foreground">
          Fixed since the first publication: records are already kept this way.
        </p>
      </StudioInspectorGroup>
    );

  const apply = (storageScope: RecordStorageScope, ownership: RecordOwnershipChoice) => {
    const result = edit((now) =>
      setInlineRecordStorageOwnership(
        now,
        { moduleKey, recordKey, storageScope, ownership },
        context,
        name,
      ),
    );
    const refused = studioEditProblem(result);
    setProblem(refused);
    if (refused === undefined) setChoosingLink(false);
  };
  const ownership: RecordOwnershipChoice =
    record.ownership_mode === "inherited" && relationship !== undefined
      ? { mode: "inherited", relationship }
      : { mode: record.ownership_mode as "none" | "organization_account" | "group" };
  const eligible = sources.filter((item) => item.problem === undefined);
  return (
    <StudioInspectorGroup title="Storage and ownership">
      <StudioField label="Records are kept" hint="Fixed once the record type is published.">
        {() => (
          <StudioSegmentedControl
            label="Records are kept"
            value={record.storage_scope}
            disabled={disabled}
            options={storageScopes.map((value) => ({ value, label: recordStorageLabels[value] }))}
            onChange={(value) => apply(value, ownership)}
          />
        )}
      </StudioField>
      <StudioField label="Owner" hint={ownershipHints[mode]} error={problem}>
        {(control) => (
          <NativeSelect
            {...control}
            className="w-full"
            value={mode}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value as RecordOwnershipMode;
              if (next === "inherited") {
                setProblem(undefined);
                setChoosingLink(true);
                return;
              }
              setChoosingLink(false);
              apply(record.storage_scope, { mode: next });
            }}
          >
            {ownershipModes.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {recordOwnershipLabels[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </StudioField>
      {mode !== "inherited" ? null : (
        <StudioField
          label="Linked record"
          hint="A required link to one record; that record's owner owns this one."
        >
          {(control) => (
            <div className="space-y-2">
              <StudioReferencePicker
                {...control}
                value={choosingLink ? "" : (relationship ?? "")}
                disabled={disabled || sources.length === 0}
                unset={eligible.length === 0 ? "No link can give an owner yet" : "Choose a link"}
                options={sources.map((item) => ({
                  value: item.key,
                  label: item.label,
                  description: item.problem ?? item.targets.map(name).join(", "),
                  disabled: item.problem !== undefined,
                }))}
                onChange={(value) => {
                  if (value !== "")
                    apply(record.storage_scope, { mode: "inherited", relationship: value });
                }}
              />
              {eligible.length > 0 ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={onAddLink}
                >
                  Add a link
                </Button>
              )}
              {choosingLink ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setChoosingLink(false)}
                >
                  Keep {recordOwnershipLabels[record.ownership_mode].toLowerCase()}
                </Button>
              ) : null}
            </div>
          )}
        </StudioField>
      )}
    </StudioInspectorGroup>
  );
}
