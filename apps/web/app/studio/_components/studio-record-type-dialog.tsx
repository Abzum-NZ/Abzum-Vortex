"use client";
import { useState, type FormEvent } from "react";
import {
  createInlineRecordType,
  deriveOwnedModuleKey,
  deriveRecordTypeKey,
  type ApplicationSourceDocument,
  type ModuleFieldPublication,
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
import { FieldGroup, FieldLegend, FieldSet } from "@vortex/ui/components/field";
import { Input } from "@vortex/ui/components/input";
import {
  StudioInspectorGroup,
  StudioOptionControl,
  StudioReferencePicker,
  StudioSegmentedControl,
} from "@vortex/ui/studio";
import { StudioField } from "./studio-field";
import { recordOwnershipLabels } from "./studio-record-storage-ownership";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

type CreatedOwnership = "none" | "organization_account" | "group";
const createdOwnerships: readonly CreatedOwnership[] = ["organization_account", "group", "none"];
const storageScopes: readonly RecordStorageScope[] = [
  "organization_shared",
  "application_contained",
];
/** Short segment labels; the field's hint explains what each means. */
const storageShort: Readonly<Record<RecordStorageScope, string>> = {
  organization_shared: "Organisation",
  application_contained: "This application",
};

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
  publication,
  edit,
  onClose,
  onCreated,
}: Readonly<{
  open: boolean;
  source: ApplicationSourceDocument;
  initialModuleKey: string | undefined;
  publication: ModuleFieldPublication;
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
  const effectiveModuleName = newModuleName ?? `${source.body.name} data`.slice(0, 120);
  const effectiveModuleKey =
    newModuleKey ?? deriveOwnedModuleKey(source, effectiveModuleName) ?? "";
  const targetKey = target?.key ?? effectiveModuleKey;
  const derivedKey =
    deriveRecordTypeKey(
      name,
      new Set([
        ...(target?.record_types.map((record) => record.key) ?? []),
        ...[...publication.recordTypes]
          .filter((reference) => reference.startsWith(`${targetKey}:`))
          .map((reference) => reference.slice(targetKey.length + 1)),
      ]),
    ) ?? "";
  const effectiveKey = key ?? derivedKey;
  const effectivePlural = plural ?? pluralOf(name);
  const firstModule = modules.length === 0;

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
      createInlineRecordType(
        current,
        {
          ...(firstModule
            ? { newModule: { key: effectiveModuleKey, name: effectiveModuleName } }
            : { moduleKey: target!.key }),
          name,
          pluralName: effectivePlural,
          key: effectiveKey,
          titleLabel,
          storageScope,
          ownershipMode,
        },
        publication,
      ),
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
      <DialogContent className="max-w-lg" aria-label="New record type">
        <DialogHeader>
          <DialogTitle>New record type</DialogTitle>
          <DialogDescription>Name this kind of record, then add its fields.</DialogDescription>
        </DialogHeader>
        <form id="studio-record-type-form" onSubmit={submit} noValidate>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <StudioField label="Name of one record">
                {(control) => (
                  <Input
                    {...control}
                    required
                    maxLength={60}
                    placeholder="Asset"
                    value={name}
                    autoFocus
                    onChange={(event) => {
                      setName(event.target.value);
                      setIssues([]);
                    }}
                  />
                )}
              </StudioField>
              <StudioField label="Name of several records">
                {(control) => (
                  <Input
                    {...control}
                    required
                    maxLength={60}
                    placeholder="Assets"
                    value={effectivePlural}
                    onChange={(event) => {
                      setPlural(event.target.value);
                      setIssues([]);
                    }}
                  />
                )}
              </StudioField>
            </div>
            <StudioInspectorGroup
              title="Advanced"
              defaultOpen={false}
              persist={false}
              summary={`Key ${effectiveKey || "…"} · Title field ${titleLabel || "…"} · ${storageShort[storageScope]} · ${recordOwnershipLabels[ownershipMode]}`}
            >
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
                hint="The label of the field that names each record, such as Name."
              >
                {(control) => (
                  <Input
                    {...control}
                    required
                    maxLength={60}
                    placeholder="Name"
                    value={titleLabel}
                    onChange={(event) => {
                      setTitleLabel(event.target.value);
                      setIssues([]);
                    }}
                  />
                )}
              </StudioField>
              <StudioField
                label="Records are kept"
                hint="Organisation: every application of the organisation may use them. This application: only this application reads them. Fixed once the record type is published."
              >
                {() => (
                  <StudioSegmentedControl
                    label="Records are kept"
                    value={storageScope}
                    options={storageScopes.map((value) => ({
                      value,
                      label: storageShort[value],
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
                  <StudioOptionControl
                    {...control}
                    value={ownershipMode}
                    disabled={false}
                    options={createdOwnerships.map((value) => ({
                      value,
                      label: recordOwnershipLabels[value],
                    }))}
                    onChange={(value) => setOwnershipMode(value as CreatedOwnership)}
                  />
                )}
              </StudioField>
            </StudioInspectorGroup>
            {firstModule ? (
              <FieldSet>
                <FieldLegend variant="label">Module</FieldLegend>
                <FieldGroup>
                  <StudioField
                    label="Module name"
                    hint="This is the application's first record type, so its module is created with it."
                  >
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
                  <StudioInspectorGroup
                    title="Advanced"
                    defaultOpen={false}
                    persist={false}
                    summary={`Key ${effectiveModuleKey || "…"}`}
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
                          value={effectiveModuleKey}
                          onChange={(event) => {
                            setNewModuleKey(event.target.value);
                            setIssues([]);
                          }}
                        />
                      )}
                    </StudioField>
                  </StudioInspectorGroup>
                </FieldGroup>
              </FieldSet>
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
          </FieldGroup>
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
