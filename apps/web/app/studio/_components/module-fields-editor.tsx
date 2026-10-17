"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  calculationProblems, changeInlineModuleField, deleteInlineModuleField, deriveFieldKey, fieldTypeKeys,
  moduleFieldDefaultDeclaration, moduleFieldSettingDeclarations, moduleFieldTypeLabels, moveInlineModuleField,
  readModuleFieldDefault, readModuleFieldSettings, starterModuleFieldSettings, totalProblems, totalRelationships,
  writeModuleFieldDefault, writeModuleFieldSettings, type ApplicationSourceDocument, type CalculationSettings,
  type FormulaField, type InlineRecordTypeReference, type ModuleFieldPublication, type ModuleFieldType, type TotalSettings,
} from "@vortex/platform/schema";
import type { StudioCompiledFields } from "../_lib/studio-data-model";
import { StudioCalculationEditor } from "./studio-calculation-editor";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-references-alert";
import { StudioTotalEditor } from "./studio-total-editor";

/** An application in this organisation, for the link to the owner of a used module. */
export type StudioModuleOwnerApplication = Readonly<{ key: string; rootId: string; name: string }>;

type Source = ApplicationSourceDocument;
type SourceRecord = Source["body"]["modules"][number]["record_types"][number];
type SourceField = SourceRecord["fields"][number];

/** What the field editor reads besides the draft: where it can link, and what is published. */
export type ModuleFieldEditorContext = Readonly<{
  publication: ModuleFieldPublication;
  composition: StudioCompositionContext;
  /** Record types of the modules the application uses, which a link may point at. */
  usedRecordTypes: readonly Readonly<{ key: string; label: string }>[];
  readRecords: StudioRecordReader | null;
  /** The saved draft's compiled fields, which a calculation's condition and a total's filter need. */
  compiledFields: StudioCompiledFields | null;
}>;

type FormState = Readonly<{
  label: string; helpText: string; type: ModuleFieldType;
  required: boolean; unique: boolean; filterable: boolean; sortable: boolean;
  settings: StudioSettingValues; defaultValue: StudioSettingValues;
  /** A calculation's or a total's settings, as its formula or total editor holds them; empty for other types. */
  computed: Readonly<Record<string, unknown>>;
}>;

/** Field types whose settings the formula and total editors edit, rather than the typed setting controls. */
const computedTypes: ReadonlySet<ModuleFieldType> = new Set(["calculation", "total"]);


/**
 * The one field editor of the Data tab: it adds a field to a record type of a module this
 * application owns, or changes one, with every setting its type declares, edited with Studio's
 * typed setting controls. A new field can also be shown on the record type's pages in the same
 * edit. A field can be moved or removed; removal is refused while anything uses it. Each change is
 * one edit of the application draft. A field in a published version keeps its stored shape.
 */
export function ModuleFieldsEditor({ source, moduleKey, recordKey, fieldKey, disabled, context, onPendingChange, onApply,
  onApplied, onRemoved, onShow }: Readonly<{
  source: Source;
  moduleKey: string;
  recordKey: string;
  /** The field to change; absent to add a new field. */
  fieldKey: string | undefined;
  disabled: boolean;
  context: ModuleFieldEditorContext;
  /** Whether the form holds input that is not applied to the draft yet. */
  onPendingChange: (pending: boolean) => void;
  /** Applies the changed source to the draft history; false when the draft moved on meanwhile. */
  onApply: (expected: Source, next: Source) => boolean;
  /** Called with the key of the field the change applied to. */
  onApplied?: (fieldKey: string) => void;
  /** Called after the field is removed from the draft. */
  onRemoved?: () => void;
  /** Opens a place that uses the field, for "Show me where". */
  onShow?: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  const existing = fieldKey === undefined ? undefined : record?.fields.find((item) => item.key === fieldKey);
  const adding = existing === undefined;
  const qualifiedRecord = `${moduleKey}:${recordKey}`;
  const published = existing !== undefined && context.publication.fields.has(`${qualifiedRecord}.${existing.key}`);
  const recordPublished = context.publication.recordTypes.has(qualifiedRecord);

  const recordTypes = useMemo(() => [...studioSourceRecordTypes(source), ...context.usedRecordTypes], [source, context.usedRecordTypes]);
  const relationships = useMemo(() => studioRelationshipChoices(source, null), [source]);
  const totalLinks = useMemo(() => totalRelationships(source, moduleKey, recordKey), [source, moduleKey, recordKey]);
  const formulaFields: readonly FormulaField[] = useMemo(() => (record?.fields ?? []).filter((item) => item.key !== existing?.key)
    .map((item) => ({ key: item.key, label: item.label, type: item.type, settings: item.settings })), [record, existing]);
  const otherFields = formulaFields.map(({ key, label, type }) => ({ key, label, type }));
  const declarationsFor = (type: ModuleFieldType) => moduleFieldSettingDeclarations(type, { fields: otherFields });
  const startSettings = (type: ModuleFieldType): Record<string, unknown> => starterModuleFieldSettings(type, {
    fieldKey: deriveFieldKey(existing?.label ?? "field", new Set()) ?? "field", recordKey,
    recordTypes: recordTypes.map((item) => item.key), titleField: record?.title_field ?? "",
    relationships: totalLinks.map((item) => item.reference),
  });
  const read = (type: ModuleFieldType, plain: Readonly<Record<string, unknown>>, stored: unknown) => {
    const reading = readModuleFieldSettings(type, plain, declarationsFor(type));
    const defaultDeclaration = moduleFieldDefaultDeclaration(type, plain);
    const typedDefault = defaultDeclaration.kind === "declared" ? readModuleFieldDefault(type, stored, defaultDeclaration.declaration) : undefined;
    return { reading, defaultValue: typedDefault === undefined ? {} : { default: typedDefault }, computed: computedTypes.has(type) ? plain : {} };
  };
  const initialType = (existing?.type ?? "text") as ModuleFieldType;
  const initialPlain = (existing?.settings ?? startSettings(initialType)) as Record<string, unknown>;
  const initialRead = read(initialType, initialPlain, (existing as { default?: unknown } | undefined)?.default);
  const initial: FormState = {
    label: existing?.label ?? "", helpText: existing?.help_text ?? "", type: initialType,
    required: existing?.required ?? false, unique: existing?.unique ?? false,
    filterable: existing?.filterable ?? false, sortable: existing?.sortable ?? false,
    settings: initialRead.reading.values, defaultValue: initialRead.defaultValue, computed: initialRead.computed,
  };
  const [form, setForm] = useState<FormState>(initial);
  const [plainBase, setPlainBase] = useState<Readonly<Record<string, unknown>>>(initialPlain);
  const [readFailures] = useState(initialRead.reading.failures);
  const [placements, setPlacements] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly InlineRecordTypeReference[]>([]);

  /** Whether the condition or filter the formula or total editor holds is complete. */
  const [computedValid, setComputedValid] = useState(true);

  const computed = computedTypes.has(form.type);
  const declarations = declarationsFor(form.type);
  const plainSettings = computed ? form.computed : writeModuleFieldSettings(form.type, form.settings, declarations, plainBase);
  const defaultModel = moduleFieldDefaultDeclaration(form.type, plainSettings);
  const compiledOf = (recordType: string) => context.compiledFields?.recordTypes[recordType];
  const choices: StudioSettingChoices = { fields: [], queries: [], pages: [], recordTypes, actions: [], pipelines: [],
    relationships, records: context.readRecords };
  const offered = adding ? studioFieldPlacements({ ...context.composition, source }, moduleKey, recordKey, form.type) : [];
  const nextKey = adding && record !== undefined && form.label.trim() !== ""
    ? deriveFieldKey(form.label, new Set(record.fields.map((item) => item.key))) : undefined;
  const pending = JSON.stringify(form) !== JSON.stringify(initial) || placements.size > 0;
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);

  if (module === undefined || record === undefined || (fieldKey !== undefined && existing === undefined))
    return <p role="status" className="text-sm">This field is not in the draft any more. Choose another item in the Data panel.</p>;

  const change = (next: Partial<FormState>) => { setForm((current) => ({ ...current, ...next })); setIssues([]); setMessage(""); };
  const changeType = (type: ModuleFieldType) => {
    // A field that is not published takes the new type's starting settings; no value is converted.
    const plain = existing !== undefined && existing.type === type ? existing.settings as Record<string, unknown> : startSettings(type);
    const fresh = read(type, plain, existing !== undefined && existing.type === type ? (existing as { default?: unknown }).default : undefined);
    setPlainBase(plain);
    setComputedValid(true);
    change({ type, settings: fresh.reading.values, defaultValue: fresh.defaultValue, computed: fresh.computed });
  };
  const reset = () => {
    setForm(initial); setPlainBase(initialPlain); setPlacements(new Set()); setIssues([]); setMessage(""); setReferences([]);
    setComputedValid(true);
  };

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !pending) return;
    // Settings Studio could not read stay exactly as stored (they are not shown for editing).
    const unreadable = readFailures.length > 0 && form.type === initial.type;
    const problems = [
      ...(unreadable ? [] : studioSettingProblems(form.settings, declarations).map((problem) => `Settings: ${problem}`)),
      ...(computed && !computedValid ? [`${form.type === "total" ? "Filter" : "Condition"}: complete or remove the comparisons marked above.`] : []),
      ...(form.type === "calculation"
        ? calculationProblems(form.computed as CalculationSettings, new Map(formulaFields.map((item) => [item.key, item]))) : []),
      ...(form.type === "total" ? totalProblems(form.computed as TotalSettings,
        totalLinks.find((item) => item.reference === (form.computed as TotalSettings).relationship)) : []),
      ...(defaultModel.kind === "declared" ? studioSettingProblems(form.defaultValue, [defaultModel.declaration]) : []),
    ];
    if (problems.length > 0) {
      setIssues(problems);
      setMessage("The field was not changed. Your entries are kept; correct them using the reasons below.");
      return;
    }
    const settings = unreadable && !computed ? plainBase : plainSettings;
    const result = changeInlineModuleField(source, {
      moduleKey, recordAlias: record.id, ...(existing === undefined ? {} : { fieldAlias: existing.id }),
      label: form.label, helpText: form.helpText, required: form.required, unique: form.unique,
      filterable: form.filterable, sortable: form.sortable, type: form.type, settings,
      defaultValue: defaultModel.kind === "declared" ? writeModuleFieldDefault(form.type, form.defaultValue.default)
        : (existing as { default?: unknown } | undefined)?.default,
    }, context.publication);
    if (result.kind === "invalid") {
      setIssues(result.issues);
      setMessage("The field was not changed. Your entries are kept; correct them using the reasons below.");
      return;
    }
    let next = result.source;
    if (placements.size > 0) {
      // "Also show it on": the same draft edit, through the one composition command path.
      const placed = applyStudioFieldPlacements({ ...context.composition, source: next },
        { moduleKey, recordKey, key: result.fieldKey, label: form.label.trim(), type: form.type }, [...placements]);
      if (placed.kind === "refused") {
        setIssues(placed.reasons);
        setMessage("The field was not added. Untick the places that can't show it, or correct them, and try again.");
        return;
      }
      next = placed.source;
    }
    if (!onApply(source, next)) {
      setMessage("The draft changed or is busy, so the field was not applied. Try again in a moment.");
      return;
    }
    onApplied?.(result.fieldKey);
  };

  const move = (by: -1 | 1) => {
    if (existing === undefined) return;
    const result = moveInlineModuleField(source, moduleKey, recordKey, existing.key, by);
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!onApply(source, result.source)) setMessage("The draft changed or is busy, so the field was not moved. Try again in a moment.");
    else onApplied?.(existing.key);
  };
  const remove = async () => {
    if (existing === undefined) return;
    setIssues([]); setReferences([]);
    const result = deleteInlineModuleField(source, moduleKey, recordKey, existing.key, context.publication);
    if (result.kind === "referenced") { setReferences(result.references); return; }
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!await confirm({
      title: `Remove ${existing.label}?`,
      description: `${existing.label} leaves ${record.plural_name} in the draft. It was never published, so no stored value is lost.`,
      confirmLabel: "Remove field",
    })) return;
    if (!onApply(source, result.source)) setMessage("The draft changed or is busy, so the field was not removed. Try again in a moment.");
    else onRemoved?.();
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

  return <form className="space-y-4" onSubmit={apply} aria-label={adding ? `New field of ${record.name}` : `Field ${existing.label}`}>
    <StudioField label="Label" hint={adding
      ? nextKey === undefined ? "The label people see on forms and lists. A short key is made from it."
        : `Its key will be "${nextKey}". It does not change later.`
      : `Key: ${existing.key}. It does not change when the label does.`}>
      {(control) => <Input {...control} className="w-full" value={form.label} disabled={disabled} maxLength={60}
        onChange={(event) => change({ label: event.target.value })} />}
    </StudioField>
    <StudioField label="Help text" hint="Shown under the field on forms. Optional.">
      {(control) => <Textarea {...control} value={form.helpText} disabled={disabled} maxLength={200}
        onChange={(event) => change({ helpText: event.target.value })} />}
    </StudioField>
    <StudioField label="Type" hint={shapeLocked ? "Published: the type is fixed. To hold another kind of value, add a new field."
      : existing !== undefined && existing.type !== form.type
        ? "Changing the type starts this field's settings and default afresh. No stored value is converted." : undefined}>
      {(control) => <StudioOptionControl id={control.id} value={form.type} disabled={disabled || shapeLocked}
        options={fieldTypeKeys.map((item) => ({ value: item, label: moduleFieldTypeLabels[item] }))}
        onChange={(next) => changeType(next as ModuleFieldType)} />}
    </StudioField>
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">Rules</legend>
      {flag("required", adding && recordPublished ? "A value is required (not for a new field of a published record type)" : "A value is required",
        adding && recordPublished)}
      {flag("unique", "Each record has a different value")}
      {flag("filterable", "People can filter by it")}
      {flag("sortable", "People can sort by it")}
    </fieldset>
    <section className="space-y-2" aria-label="Settings">
      <h3 className="text-sm font-semibold">Settings of {moduleFieldTypeLabels[form.type].toLowerCase()}</h3>
      {shapeHint === undefined ? null : <p className="text-sm text-muted-foreground" role="note">{shapeHint}</p>}
      {form.type === "calculation"
        ? <StudioCalculationEditor idPrefix="module-field-formula" settings={form.computed as CalculationSettings} fields={formulaFields}
          compiled={compiledOf(`${moduleKey}:${recordKey}`)} disabled={disabled || shapeLocked}
          onChange={(next, valid) => { setComputedValid(valid); change({ computed: next }); }} />
      : form.type === "total"
        ? <StudioTotalEditor settings={form.computed as TotalSettings} relationships={totalLinks} compiledOf={compiledOf}
          disabled={disabled || shapeLocked} onChange={(next, valid) => { setComputedValid(valid); change({ computed: next }); }} />
      : readFailures.length > 0 && form.type === initial.type
        ? <Alert variant="destructive" role="alert"><AlertTitle>These settings can&apos;t be read</AlertTitle>
          <AlertDescription>{`${[...new Set(readFailures.map((failure) => failure.path.join(", ")))].join("; ")}: ` +
            "not in a form Studio edits, so the settings are not changed here. Change them in the application source."}</AlertDescription></Alert>
        : declarations.length === 0
          ? <p className="text-sm text-muted-foreground">This type has no settings.</p>
          : <StudioSettingFields idPrefix="module-field-setting" properties={declarations} values={form.settings}
            choices={choices} disabled={disabled || shapeLocked} onChange={(settings) => change({ settings })} />}
    </section>
    <section className="space-y-2" aria-label="Default value">
      {defaultModel.kind === "declared"
        ? <StudioSettingFields idPrefix="module-field-default" properties={[defaultModel.declaration]} values={form.defaultValue}
          choices={choices} disabled={disabled} onChange={(defaultValue) => change({ defaultValue })} />
        : <p className="text-sm text-muted-foreground">Default value: {defaultModel.reason}</p>}
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
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={disabled || !pending}>{adding ? "Add field" : "Apply"}</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled || !pending} onClick={reset}>Discard</Button>
    </div>
    <p role="status" aria-live="polite" className="text-sm">{message}</p>
    {issues.length === 0 ? null : <ul className="space-y-1 text-sm text-destructive" aria-label="Why the field was not changed" role="alert">
      {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}
    </ul>}
    {existing !== undefined && <section className="space-y-2 border-t border-border pt-3" aria-label="Order and removal">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled || pending || record.fields[0]?.key === existing.key}
          onClick={() => move(-1)}>Move earlier</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || pending || record.fields.at(-1)?.key === existing.key}
          onClick={() => move(1)}>Move later</Button>
        <Button type="button" size="sm" variant="destructive" disabled={disabled || pending}
          onClick={() => { void remove(); }}>Remove field</Button>
      </div>
      <StudioReferencesAlert name={existing.label} action="removed" references={references} onShow={onShow} />
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
