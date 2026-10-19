"use client";
import { useState, type FormEvent } from "react";
import {
  createInlineRecordType,
  defaultOwnedModuleKey,
  deriveRecordTypeKey,
  type ApplicationSourceDocument,
  type RecordStorageScope,
} from "@vortex/platform/schema";
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
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { StudioReferencePicker, StudioSegmentedControl } from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { recordOwnershipLabels, recordStorageLabels } from "./studio-record-storage-ownership";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

type CreatedOwnership = "none" | "organization_account" | "group";
const createdOwnerships: readonly CreatedOwnership[] = ["organization_account", "group", "none"];
const storageScopes: readonly RecordStorageScope[] = [
  "organization_shared",
  "application_contained",
];

/** The plural a builder most likely means; they can change it. */
const pluralOf = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed === "") return "";
  if (/[^aeiou]y$/i.test(trimmed)) return `${trimmed.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(trimmed)) return `${trimmed}es`;
  return `${trimmed}s`;
};

/**
 * The new record type form: its names, its key (made from the name; it does not change later),
 * the label of its title field, where its records are kept and who owns them. An application that owns no module yet gets its
 * first module with it; the module's key is made from the application key.
 */
export function StudioRecordTypeDialog({
  open,
  source,
  initialModuleKey,
  edit,
  onClose,
  onCreated,
}: Readonly<{
  open: boolean;
  source: ApplicationSourceDocument;
  initialModuleKey: string | undefined;
  edit: StudioDataEdit;
  onClose: () => void;
  /** Called with the record type the form added. */
  onCreated: (moduleKey: string, recordKey: string) => void;
}>) {
  const modules = source.body.modules;
  const [name, setName] = useState("");
  const [plural, setPlural] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [titleLabel, setTitleLabel] = useState("Name");
  const [storageScope, setStorageScope] = useState<RecordStorageScope>("organization_shared");
  const [ownershipMode, setOwnershipMode] = useState<CreatedOwnership>("organization_account");
  const [moduleKey, setModuleKey] = useState(initialModuleKey ?? modules[0]?.key ?? "");
  const [newModuleKey, setNewModuleKey] = useState<string | null>(null);
  const [newModuleName, setNewModuleName] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const target = modules.find((module) => module.key === moduleKey) ?? modules[0];
  const derivedKey =
    deriveRecordTypeKey(name, new Set(target?.record_types.map((record) => record.key) ?? [])) ??
    "";
  const effectiveKey = key ?? derivedKey;
  const effectivePlural = plural ?? pluralOf(name);
  const firstModule = modules.length === 0;
  const effectiveModuleKey = newModuleKey ?? defaultOwnedModuleKey(source);
  const effectiveModuleName = newModuleName ?? `${source.body.name} data`.slice(0, 120);

  const reset = () => {
    setName("");
    setPlural(null);
    setKey(null);
    setTitleLabel("Name");
    setStorageScope("organization_shared");
    setOwnershipMode("organization_account");
    setNewModuleKey(null);
    setNewModuleName(null);
    setIssues([]);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = edit((current) =>
      createInlineRecordType(current, {
        ...(firstModule
          ? { newModule: { key: effectiveModuleKey, name: effectiveModuleName } }
          : { moduleKey: target!.key }),
        name,
        pluralName: effectivePlural,
        key: effectiveKey,
        titleLabel,
        storageScope,
        ownershipMode,
      }),
    );
    if (result.kind !== "changed") {
      setIssues([studioEditProblem(result) ?? "The record type was not added."]);
      return;
    }
    reset();
    onClose();
    onCreated(result.moduleKey, result.recordKey);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-screen max-w-lg overflow-y-auto" aria-label="New record type">
        <DialogHeader>
          <DialogTitle>New record type</DialogTitle>
          <DialogDescription>Name this kind of record, then add its fields.</DialogDescription>
        </DialogHeader>
        <form id="studio-record-type-form" className="grid gap-4" onSubmit={submit} noValidate>
          <StudioField label="Name of one record" hint="For example Asset.">
            {(control) => (
              <Input
                {...control}
                required
                maxLength={60}
                value={name}
                autoFocus
                onChange={(event) => {
                  setName(event.target.value);
                  setIssues([]);
                }}
              />
            )}
          </StudioField>
          <StudioField label="Name of several records" hint="For example Assets.">
            {(control) => (
              <Input
                {...control}
                required
                maxLength={60}
                value={effectivePlural}
                onChange={(event) => {
                  setPlural(event.target.value);
                  setIssues([]);
                }}
              />
            )}
          </StudioField>
          <StudioField label="Key" hint="Made from the name. It does not change later.">
            {(control) => (
              <Input
                {...control}
                required
                maxLength={40}
                value={effectiveKey}
                onChange={(event) => {
                  setKey(event.target.value);
                  setIssues([]);
                }}
              />
            )}
          </StudioField>
          <StudioField
            label="Title field"
            hint="The label of the field that names each record, for example Name."
          >
            {(control) => (
              <Input
                {...control}
                required
                maxLength={60}
                value={titleLabel}
                onChange={(event) => {
                  setTitleLabel(event.target.value);
                  setIssues([]);
                }}
              />
            )}
          </StudioField>
          <StudioField label="Records are kept" hint="Fixed once the record type is published.">
            {() => (
              <StudioSegmentedControl
                label="Records are kept"
                value={storageScope}
                options={storageScopes.map((value) => ({
                  value,
                  label: recordStorageLabels[value],
                }))}
                onChange={setStorageScope}
              />
            )}
          </StudioField>
          <StudioField
            label="Owner"
            hint="To take the owner from a linked record, add the link first, then choose it."
          >
            {(control) => (
              <NativeSelect
                {...control}
                className="w-full"
                value={ownershipMode}
                onChange={(event) => setOwnershipMode(event.target.value as CreatedOwnership)}
              >
                {createdOwnerships.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {recordOwnershipLabels[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </StudioField>
          {firstModule ? (
            <fieldset className="grid gap-3 border-t border-border pt-3">
              <legend className="text-sm font-medium">Module</legend>
              <p className="text-sm text-muted-foreground">
                This is the application&apos;s first record type, so its module is created with it.
              </p>
              <StudioField label="Module name">
                {(control) => (
                  <Input
                    {...control}
                    required
                    maxLength={120}
                    value={effectiveModuleName}
                    onChange={(event) => {
                      setNewModuleName(event.target.value);
                      setIssues([]);
                    }}
                  />
                )}
              </StudioField>
              <StudioField
                label="Module key"
                hint="Made from the application key. It does not change later."
              >
                {(control) => (
                  <Input
                    {...control}
                    required
                    maxLength={120}
                    value={effectiveModuleKey}
                    onChange={(event) => {
                      setNewModuleKey(event.target.value);
                      setIssues([]);
                    }}
                  />
                )}
              </StudioField>
            </fieldset>
          ) : (
            modules.length > 1 && (
              <StudioField label="Module">
                {(control) => (
                  <StudioReferencePicker
                    {...control}
                    value={target?.key ?? ""}
                    options={modules.map((module) => ({ value: module.key, label: module.name }))}
                    onChange={(value) => {
                      setModuleKey(value);
                      setKey(null);
                    }}
                  />
                )}
              </StudioField>
            )
          )}
          {issues.length === 0 ? null : (
            <ul
              role="alert"
              className="space-y-1 text-sm text-destructive"
              aria-label="Why the record type was not added"
            >
              {issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form="studio-record-type-form">
            Add record type
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
