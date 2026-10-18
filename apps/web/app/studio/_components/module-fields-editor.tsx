"use client";
import { useMemo, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import {
  applyStudioFieldPlacements, studioFieldPlacements, studioRelationshipChoices, studioSettingProblems,
  StudioOptionControl, StudioSettingFields, studioSourceRecordTypes,
  type StudioCompositionContext, type StudioRecordReader, type StudioSettingChoices, type StudioSettingValues,
} from "@vortex/ui/studio";
import {
  changeInlineModuleField, deleteInlineModuleField, deriveFieldKey, fieldTypeKeys, moduleFieldDefaultDeclaration,
  moduleFieldKeptSettings, moduleFieldSettingDeclarations, moduleFieldTypeLabels, moveInlineModuleField,
  peopleDirectory, readModuleFieldDefault, readModuleFieldSettings, starterModuleFieldSettings, writeModuleFieldDefault,
  writeModuleFieldSettings, type ApplicationSourceDocument, type ApplicationUsePlace, type LinkCardinality,
  type ModuleFieldPublication, type ModuleFieldType, type PeopleDirectoryOwner,
} from "@vortex/platform/schema";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-used-in";
import { StudioLinkSection } from "./studio-link-section";
import { useStudioDraftText } from "./use-studio-draft-text";
import { useStudioDraftHeld } from "./use-studio-draft-held";
import { studioEditProblem, type StudioDataEdit } from "../_lib/studio-data-model";

/** An application in this organisation, for the link to the owner of a used module. */
export type StudioModuleOwnerApplication = Readonly<{ key: string; rootId: string; name: string }>;

type Source = ApplicationSourceDocument;
type SourceRecord = Source["body"]["modules"][number]["record_types"][number];
type SourceField = SourceRecord["fields"][number];
type Plain = Readonly<Record<string, unknown>>;

/** A record type a link may point at: its qualified key, its name, and the label each record is shown by. */
export type StudioLinkTarget = Readonly<{ key: string; label: string; titleLabel: string | undefined }>;

/** What the field editor reads besides the draft: where it can link, and what is published. */
export type ModuleFieldEditorContext = Readonly<{
  publication: ModuleFieldPublication;
  composition: StudioCompositionContext;
  /**
   * Record types outside the application's own modules a link may point at: those of the modules
   * it uses, and the people directory's Person, which a link adds to the modules it uses.
   */
  usedRecordTypes: readonly StudioLinkTarget[];
  peopleDirectory: PeopleDirectoryOwner | null;
  readRecords: StudioRecordReader | null;
}>;

type FormState = Readonly<{
  label: string; helpText: string; type: ModuleFieldType;
  required: boolean; unique: boolean; filterable: boolean; sortable: boolean;
  settings: StudioSettingValues; defaultValue: StudioSettingValues;
  /** How many records may link to one linked record; read only for a link. */
  cardinality: LinkCardinality;
}>;

const linkTypes: ReadonlySet<string> = new Set(["link", "link_to_one_of_several"]);
/** A person is linked with a Link to a record whose target is the people directory's Person, not this older type. */

/**
 * The one field editor of the Data tab. Without a field it is the form that adds a field to a
 * record type of a module this application owns, with every setting its type declares and, in the
 * same edit, the record type's pages it is also shown on. With a field it changes that field: each
 * valid change is one edit of the draft at once (typing is one Undo step); a label, setting or
 * default that is not valid yet stays in its control with why, and never holds back another change.
 * A field can be moved or removed; removal is refused while anything uses it. A field in a published
 * version keeps its stored shape.
 */
export function ModuleFieldsEditor({ source, moduleKey, recordKey, fieldKey, initialType = "text", disabled, context,
  edit, onAdded, onRemoved }: Readonly<{
  source: Source;
  moduleKey: string;
  recordKey: string;
  /** The field to change; absent to add a new field. */
  fieldKey: string | undefined;
  /** The type a new field starts as. */
  initialType?: ModuleFieldType;
  disabled: boolean;
  context: ModuleFieldEditorContext;
  edit: StudioDataEdit;
  /** Called with the key of the field the form added. */
  onAdded?: (fieldKey: string) => void;
  /** Called after the field is removed from the draft. */
  onRemoved?: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  const existing = fieldKey === undefined ? undefined : record?.fields.find((item) => item.key === fieldKey);
  const adding = fieldKey === undefined;
  const qualifiedRecord = `${moduleKey}:${recordKey}`;
  const published = existing !== undefined && context.publication.fields.has(`${qualifiedRecord}.${existing.key}`);
  const recordPublished = context.publication.recordTypes.has(qualifiedRecord);

  const recordTypes = useMemo((): readonly StudioLinkTarget[] => [...studioSourceRecordTypes(source).map((item) => {
    const [owner, local] = item.key.split(":");
    const target = source.body.modules.find((candidate) => candidate.key === owner)?.record_types.find((candidate) => candidate.key === local);
    return { ...item, titleLabel: target?.fields.find((field) => field.key === target.title_field)?.label };
  }), ...context.usedRecordTypes], [source, context.usedRecordTypes]);
  const relationships = useMemo(() => studioRelationshipChoices(source, null), [source]);
  const otherFields = (record?.fields ?? []).filter((item) => item.key !== existing?.key)
    .map((item) => ({ key: item.key, label: item.label, type: item.type }));
  const fieldsOf = (reference: string | undefined) => {
    if (reference === undefined) return [];
    const [owner, rest = ""] = reference.split(":");
    const [relatedRecord] = rest.split(".");
    return (source.body.modules.find((item) => item.key === owner)?.record_types.find((item) => item.key === relatedRecord)?.fields ?? [])
      .map((item) => ({ key: item.key, label: item.label, type: item.type }));
  };
  const declarationsFor = (type: ModuleFieldType, settings: StudioSettingValues, plain: Plain) => {
    const relationship = settings.relationship?.kind === "relationship_reference" ? settings.relationship.relationship : undefined;
    return moduleFieldSettingDeclarations(type, { fields: otherFields, relatedFields: fieldsOf(relationship) }, plain);
  };
  const startSettings = (type: ModuleFieldType): Record<string, unknown> => {
    const start = starterModuleFieldSettings(type, {
      fieldKey: deriveFieldKey(existing?.label ?? "field", new Set()) ?? "field", recordKey,
      recordTypes: recordTypes.map((item) => item.key), titleField: record?.title_field ?? "",
      relationships: relationships.map((item) => item.reference),
    });
    // A new link reads back from the linked record by this record type's plural name, for example assets.
    const back = type === "link" && record !== undefined ? deriveFieldKey(record.plural_name, new Set()) : undefined;
    return back === undefined ? start : { ...start, reverse_key: back };
  };
  /** The stored settings a type keeps: the field's own while it keeps its type, else the new type's starting settings. */
  const plainOf = (type: ModuleFieldType): Plain =>
    existing !== undefined && existing.type === type ? existing.settings as Plain : startSettings(type);
  const read = (type: ModuleFieldType, plain: Plain, stored: unknown) => {
    const first = readModuleFieldSettings(type, plain, moduleFieldSettingDeclarations(type, { fields: otherFields, relatedFields: [] }, plain));
    const declarations = declarationsFor(type, first.values, plain);
    const reading = readModuleFieldSettings(type, plain, declarations);
    const defaultDeclaration = moduleFieldDefaultDeclaration(type, plain);
    const typedDefault = defaultDeclaration.kind === "declared" ? readModuleFieldDefault(type, stored, defaultDeclaration.declaration) : undefined;
    return { reading, defaultValue: typedDefault === undefined ? {} : { default: typedDefault } };
  };
  const storedDefault = (existing as { default?: unknown } | undefined)?.default;
  // The field as the draft holds it, or a new field's starting form.
  const readForm = (): FormState => {
    const type = (existing?.type ?? initialType) as ModuleFieldType;
    const relationship = existing === undefined ? undefined : record?.relationships.find((item) => item.from_field === existing.key);
    const reading = read(type, plainOf(type), storedDefault);
    return {
      label: existing?.label ?? "", helpText: existing?.help_text ?? "", type,
      required: existing?.required ?? false, unique: existing?.unique ?? false,
      filterable: existing?.filterable ?? false, sortable: existing?.sortable ?? false,
      settings: reading.reading.values, defaultValue: reading.defaultValue,
      cardinality: relationship?.cardinality === "one_to_one" ? "one_to_one" : "many_to_one",
    };
  };
  const [created, setCreated] = useState<FormState>(readForm);
  const stored = adding || existing === undefined ? created : readForm();
  const readFailures = existing === undefined ? [] : read(existing.type as ModuleFieldType, existing.settings as Plain, storedDefault).reading.failures;
  const [placements, setPlacements] = useState<ReadonlySet<string>>(new Set());
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly ApplicationUsePlace[]>([]);

  /** One edit of the field: the patch over the field as the draft holds it. */
  const commit = (patch: Partial<FormState>, merge?: string): string | undefined => {
    if (existing === undefined || record === undefined) return "The field is not in this record type any more.";
    const next: FormState = { ...stored, ...patch };
    const typeChanged = next.type !== existing.type;
    const plain = plainOf(next.type);
    const declarations = declarationsFor(next.type, next.settings, plain);
    let settings: Plain;
    if (patch.settings === undefined && !typeChanged) settings = existing.settings as Plain;
    else if (readFailures.length > 0 && !typeChanged) settings = plain;
    else {
      const problems = studioSettingProblems(next.settings, declarations);
      if (problems.length > 0) return problems.map((problem) => `Settings: ${problem}`).join(" ");
      settings = writeModuleFieldSettings(next.type, next.settings, declarations, plain);
    }
    const defaultModel = moduleFieldDefaultDeclaration(next.type, settings);
    if (patch.defaultValue !== undefined && defaultModel.kind === "declared") {
      const problems = studioSettingProblems(next.defaultValue, [defaultModel.declaration]);
      if (problems.length > 0) return problems.join(" ");
    }
    return studioEditProblem(edit((current) => changeInlineModuleField(current, {
      moduleKey, recordAlias: record.id, fieldAlias: existing.id,
      label: next.label, helpText: next.helpText, required: next.required, unique: next.unique,
      filterable: next.filterable, sortable: next.sortable, type: next.type, settings,
      defaultValue: defaultModel.kind === "declared" ? writeModuleFieldDefault(next.type, next.defaultValue.default) : storedDefault,
      cardinality: linkTypes.has(next.type) ? next.cardinality : undefined,
    }, { publication: context.publication, peopleDirectory: context.peopleDirectory }), merge === undefined ? {} : { merge }));
  };
  const mergeKey = (part: string) => `field-${part}:${qualifiedRecord}.${fieldKey ?? ""}`;
  const label = useStudioDraftText(existing?.label ?? "", (next) =>
    adding ? true : commit({ label: next }, mergeKey("label")) ?? true);
  const helpText = useStudioDraftText(existing?.help_text ?? "", (next) =>
    adding ? true : commit({ helpText: next }, mergeKey("help")) ?? true);
  const settingsValue = useStudioDraftHeld(stored.settings);
  const defaultValue = useStudioDraftHeld(stored.defaultValue);
  const form: FormState = { ...stored, label: label.text, helpText: helpText.text, settings: settingsValue.value, defaultValue: defaultValue.value };

  const plainBase = plainOf(form.type);
  const declarations = declarationsFor(form.type, form.settings, plainBase);
  const defaultModel = moduleFieldDefaultDeclaration(form.type, writeModuleFieldSettings(form.type, form.settings, declarations, plainBase));
  const kept = moduleFieldKeptSettings(form.type, plainBase);
  const choices: StudioSettingChoices = { fields: [], queries: [], pages: [], recordTypes, actions: [],
    relationships, records: context.readRecords };
  const offered = adding ? studioFieldPlacements({ ...context.composition, source }, moduleKey, recordKey, form.type) : [];
  const nextKey = adding && record !== undefined && form.label.trim() !== ""
    ? deriveFieldKey(form.label, new Set(record.fields.map((item) => item.key))) : undefined;
  const unreadable = readFailures.length > 0 && existing !== undefined && form.type === existing.type;

  if (module === undefined || record === undefined || (fieldKey !== undefined && existing === undefined))
    return <p role="status" className="text-sm">This field is not in the draft any more. Choose another item in the Data panel.</p>;

  // A discrete choice applies at once; a refused one is answered with why and the draft keeps its value.
  const change = (patch: Partial<FormState>) => {
    if (adding) { setCreated({ ...created, ...patch }); setIssues([]); return; }
    const problem = commit(patch);
    setIssues(problem === undefined ? [] : [problem]);
  };
  const changeType = (type: ModuleFieldType) => {
    // A field that is not published takes the new type's starting settings; no value is converted.
    const fresh = read(type, plainOf(type), existing !== undefined && existing.type === type ? storedDefault : undefined);
    change({ type, settings: fresh.reading.values, defaultValue: fresh.defaultValue });
  };
  const changeSettings = (settings: StudioSettingValues) => {
    if (adding) { setCreated({ ...created, settings }); setIssues([]); return; }
    const problem = commit({ settings }, mergeKey("settings"));
    if (problem === undefined) settingsValue.applied(settings); else settingsValue.hold(settings, problem);
  };
  const changeDefault = (value: StudioSettingValues) => {
    if (adding) { setCreated({ ...created, defaultValue: value }); setIssues([]); return; }
    const problem = commit({ defaultValue: value }, mergeKey("default"));
    if (problem === undefined) defaultValue.applied(value); else defaultValue.hold(value, problem);
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !adding) return;
    const problems = [
      ...studioSettingProblems(form.settings, declarations).map((problem) => `Settings: ${problem}`),
      ...(defaultModel.kind === "declared" ? studioSettingProblems(form.defaultValue, [defaultModel.declaration]) : []),
    ];
    if (problems.length > 0) { setIssues(problems); return; }
    const settings = writeModuleFieldSettings(form.type, form.settings, declarations, plainBase);
    const result = edit((current) => {
      const added = changeInlineModuleField(current, {
        moduleKey, recordAlias: record.id, label: form.label, helpText: form.helpText, required: form.required, unique: form.unique,
        filterable: form.filterable, sortable: form.sortable, type: form.type, settings,
        defaultValue: defaultModel.kind === "declared" ? writeModuleFieldDefault(form.type, form.defaultValue.default) : undefined,
        cardinality: linkTypes.has(form.type) ? form.cardinality : undefined,
      }, { publication: context.publication, peopleDirectory: context.peopleDirectory });
      if (added.kind !== "changed" || placements.size === 0) return added;
      // "Also show it on": the same draft edit, through the one composition command path.
      const placed = applyStudioFieldPlacements({ ...context.composition, source: added.source },
        { moduleKey, recordKey, key: added.fieldKey, label: form.label.trim(), type: form.type }, [...placements]);
      return placed.kind === "refused"
        ? { kind: "refused" as const, issues: ["The field was not added. Untick the places that can't show it, or correct them, and try again.", ...placed.reasons] }
        : { ...added, source: placed.source };
    });
    if (result.kind !== "changed") {
      setIssues(result.kind === "blocked" ? [result.message] : result.issues);
      return;
    }
    onAdded?.(result.fieldKey);
  };

  const move = (by: -1 | 1) => {
    if (existing === undefined) return;
    const problem = studioEditProblem(edit((current) => moveInlineModuleField(current, moduleKey, recordKey, existing.key, by)));
    setIssues(problem === undefined ? [] : [problem]);
  };
  const remove = async () => {
    if (existing === undefined) return;
    setIssues([]); setReferences([]);
    const check = deleteInlineModuleField(source, moduleKey, recordKey, existing.key, context.publication);
    if (check.kind === "referenced") { setReferences(check.references); return; }
    if (check.kind === "invalid") { setIssues(check.issues); return; }
    if (!await confirm({
      title: `Remove ${existing.label}?`,
      description: `${existing.label} leaves ${record.plural_name} in the draft. It was never published, so no stored value is lost.`,
      confirmLabel: "Remove field",
    })) return;
    const result = edit((current) => deleteInlineModuleField(current, moduleKey, recordKey, existing.key, context.publication));
    if (result.kind === "changed") onRemoved?.();
    else if (result.kind === "referenced") setReferences(result.references);
    else setIssues([studioEditProblem(result) ?? "The field was not removed."]);
  };

  const shapeLocked = published;
  const shapeHint = shapeLocked
    ? "This field is in a published version, so its stored shape is fixed: type, settings, and the required, unique, filter and sort choices. Its label, help text and default can still change."
    : undefined;
  const flag = (key: "required" | "unique" | "filterable" | "sortable", text: string, extraDisabled = false) =>
    <div className="flex items-center gap-2">
      <Checkbox id={`module-field-${key}`} checked={form[key]} disabled={disabled || shapeLocked || extraDisabled}
        onCheckedChange={(checked) => change({ [key]: checked === true })} />
      <Label htmlFor={`module-field-${key}`}>{text}</Label>
    </div>;
  const problemOf = (text: string) => text === "" ? undefined : text;

  return <form className="space-y-4" onSubmit={add} aria-label={adding ? `New field of ${record.name}` : `Field ${existing!.label}`}>
    <StudioField label="Label" error={problemOf(label.problem)} hint={adding
      ? nextKey === undefined ? "The label people see on forms and lists. A short key is made from it."
        : `Its key will be "${nextKey}". It does not change later.`
      : `Key: ${existing!.key}. It does not change when the label does.`}>
      {(control) => <Input {...control} className="w-full" value={label.text} disabled={disabled} maxLength={60}
        onChange={(event) => { label.change(event.target.value); if (adding) setIssues([]); }} />}
    </StudioField>
    <StudioField label="Help text" hint="Shown under the field on forms. Optional." error={problemOf(helpText.problem)}>
      {(control) => <Textarea {...control} value={helpText.text} disabled={disabled} maxLength={200}
        onChange={(event) => helpText.change(event.target.value)} />}
    </StudioField>
    <StudioField label="Type" hint={shapeLocked ? "Published: the type is fixed. To hold another kind of value, add a new field."
      : existing !== undefined ? "Changing the type starts this field's settings and default afresh. No stored value is converted." : undefined}>
      {(control) => <StudioOptionControl id={control.id} value={form.type} disabled={disabled || shapeLocked}
        options={fieldTypeKeys.map((item) => ({ value: item, label: moduleFieldTypeLabels[item] }))}
        onChange={(next) => changeType(next as ModuleFieldType)} />}
    </StudioField>
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">Rules</legend>
      {flag("required", adding && recordPublished ? "A value is required (not for a new field of a published record type)" : "A value is required",
        adding && recordPublished)}
      {flag("unique", "Each record has a different value", linkTypes.has(form.type) && form.cardinality === "one_to_one")}
      {flag("filterable", "People can filter by it")}
      {flag("sortable", "People can sort by it")}
    </fieldset>
    <section className="space-y-2" aria-label="Settings">
      <h3 className="text-sm font-semibold">Settings of {moduleFieldTypeLabels[form.type].toLowerCase()}</h3>
      {shapeHint === undefined ? null : <p className="text-sm text-muted-foreground" role="note">{shapeHint}</p>}
      {unreadable
        ? <Alert variant="destructive" role="alert"><AlertTitle>These settings can&apos;t be read</AlertTitle>
          <AlertDescription>{`${[...new Set(readFailures.map((failure) => failure.path.join(", ")))].join("; ")}: ` +
            "not in a form Studio edits, so the settings are not changed here. Change them in the application source."}</AlertDescription></Alert>
        : declarations.length === 0
          ? <p className="text-sm text-muted-foreground">This type has no settings.</p>
          : <StudioSettingFields idPrefix="module-field-setting" properties={declarations} values={form.settings}
            choices={choices} disabled={disabled || shapeLocked} onChange={changeSettings} />}
      {settingsValue.problem === "" ? null : <p role="alert" className="text-sm text-destructive">{settingsValue.problem}</p>}
      {kept.map((note) => <p key={note} className="text-sm text-muted-foreground" role="note">{note}</p>)}
    </section>
    {linkTypes.has(form.type) && <StudioLinkSection settings={form.settings} cardinality={form.cardinality} label={form.label}
      recordName={record.name} recordPlural={record.plural_name} targets={recordTypes} disabled={disabled || shapeLocked}
      usesDirectory={source.body.uses.some((use) => use.module === peopleDirectory.module)}
      onCardinality={(cardinality) => change(cardinality === "one_to_one" ? { cardinality, unique: true } : { cardinality })} />}
    <section className="space-y-2" aria-label="Default value">
      {defaultModel.kind === "declared"
        ? <StudioSettingFields idPrefix="module-field-default" properties={[defaultModel.declaration]} values={form.defaultValue}
          choices={choices} disabled={disabled} onChange={changeDefault} />
        : <p className="text-sm text-muted-foreground">Default value: {defaultModel.reason}</p>}
      {defaultValue.problem === "" ? null : <p role="alert" className="text-sm text-destructive">{defaultValue.problem}</p>}
    </section>
    {adding && <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">Also show it on</legend>
      {offered.length === 0
        ? <p className="text-sm text-muted-foreground">{record.name} has no detail, list or form page with a list of fields yet.</p>
        : offered.map((place) => <div key={place.id} className="flex items-start gap-2">
          <Checkbox id={`module-field-place-${place.id}`} checked={placements.has(place.id)}
            disabled={disabled || place.unavailable !== undefined}
            onCheckedChange={(checked) => {
              const next = new Set(placements);
              if (checked === true) next.add(place.id); else next.delete(place.id);
              setPlacements(next); setIssues([]);
            }} />
          <Label htmlFor={`module-field-place-${place.id}`} className="font-normal">
            {place.label}{place.unavailable === undefined ? "" : ` (${place.unavailable})`}</Label>
        </div>)}
    </fieldset>}
    {adding && <Button type="submit" size="sm" disabled={disabled || form.label.trim() === ""}>Add field</Button>}
    {issues.length === 0 ? null : <ul className="space-y-1 text-sm text-destructive"
      aria-label={adding ? "Why the field was not added" : "Why the field was not changed"} role="alert">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}
    </ul>}
    {existing !== undefined && <section className="space-y-2 border-t border-border pt-3" aria-label="Order and removal">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled || record.fields[0]?.key === existing.key}
          onClick={() => move(-1)}>Move earlier</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || record.fields.at(-1)?.key === existing.key}
          onClick={() => move(1)}>Move later</Button>
        <Button type="button" size="sm" variant="destructive" disabled={disabled}
          onClick={() => { void remove(); }}>Remove field</Button>
      </div>
      <StudioReferencesAlert name={existing.label} action="removed" references={references} />
    </section>}
    {confirmDialog}
  </form>;
}

/** The published record types and fields, or, when they could not be read, every saved one. */
export const studioFieldPublication = (
  published: Readonly<{ recordTypes: readonly string[]; fields: readonly string[] }> | null, saved: Source,
): ModuleFieldPublication => {
  if (published !== null) return { recordTypes: new Set(published.recordTypes), fields: new Set(published.fields) };
  const records = saved.body.modules.flatMap((module) => module.record_types.map((record) => ({ module, record })));
  return {
    recordTypes: new Set(records.map(({ module, record }) => `${module.key}:${record.key}`)),
    fields: new Set(records.flatMap(({ module, record }) => record.fields.map((field: SourceField) => `${module.key}:${record.key}.${field.key}`))),
  };
};
