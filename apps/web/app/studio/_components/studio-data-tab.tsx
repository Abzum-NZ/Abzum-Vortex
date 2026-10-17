"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { StudioCompositionContext, StudioDataSelection, StudioRecordReader, StudioSemanticSelection } from "@vortex/ui/studio";
import {
  deleteInlineRecordType, peopleDirectory as directory, rekeyUnsavedInlineModule, rekeyUnsavedInlineRecordType,
  renameInlineModule, renameInlineRecordType, type ApplicationSourceDocument, type InlineRecordTypeReference,
  type PeopleDirectoryOwner,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";
import { StudioDataPanel } from "./studio-data-panel";
import { StudioDataCentre } from "./studio-data-centre";
import { StudioRecordTypeDialog } from "./studio-record-type-dialog";
import { StudioReferencesAlert } from "./studio-references-alert";
import { StudioNewQueryForm, StudioQueryEditor } from "./studio-query-editor";
import { StudioRecordTypeSearch, StudioSearchOverview } from "./studio-search-settings";
import { StudioRelationshipsSection } from "./studio-relationships-section";
import { StudioModuleActions } from "./studio-module-actions";
import { StudioRecordPipelines } from "./studio-record-pipelines";
import { StudioRecordRules } from "./studio-record-rules";
import {
  ModuleFieldsEditor, studioFieldPublication, type ModuleFieldEditorContext, type StudioLinkTarget,
  type StudioModuleOwnerApplication,
} from "./module-fields-editor";
import {
  fieldTypeLabel, ownedDataModules, type StudioCompiledFields, type StudioDataModule, type StudioPublishedData,
} from "../_lib/studio-data-model";

/** Applies a changed source to the draft history as one edit; false when the draft moved on or is busy. */
type ApplyDataChange = (expected: ApplicationSourceDocument, next: ApplicationSourceDocument, message: string) => boolean;

function Problems({ issues }: Readonly<{ issues: readonly string[] }>) {
  return issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
    {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>;
}

/** The owned module's name, and its key while it is not saved yet. */
function ModuleInspector({ source, saved, moduleKey, disabled, apply }: Readonly<{
  source: ApplicationSourceDocument; saved: ApplicationSourceDocument; moduleKey: string; disabled: boolean;
  apply: (next: ApplicationSourceDocument, message: string, select?: StudioDataSelection) => boolean;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey)!;
  const keyEditable = !saved.body.modules.some((item) => item.key === moduleKey);
  const [name, setName] = useState(module.name);
  const [key, setKey] = useState(module.key);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let result = renameInlineModule(source, { moduleKey, name });
    if (result.kind === "changed" && keyEditable && key.trim() !== moduleKey)
      result = rekeyUnsavedInlineModule(result.source, saved, { moduleKey, key });
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!apply(result.source, "Module changed. Save to keep it.", { kind: "module", moduleKey: result.moduleKey }))
      setIssues(["The draft changed or is busy, so nothing was changed. Try again in a moment."]);
  };
  return <form className="space-y-3" onSubmit={submit}>
    <StudioField label="Module name">
      {(control) => <Input {...control} maxLength={120} value={name} disabled={disabled}
        onChange={(event) => { setName(event.target.value); setIssues([]); }} />}
    </StudioField>
    {keyEditable
      ? <StudioField label="Module key" hint="You can change it until you save the draft; after that it is permanent.">
        {(control) => <Input {...control} maxLength={120} value={key} disabled={disabled}
          onChange={(event) => { setKey(event.target.value); setIssues([]); }} />}
      </StudioField>
      : <p className="text-sm text-muted-foreground">Key: {module.key}. It is permanent.</p>}
    <Button type="submit" size="sm" disabled={disabled || (name === module.name && key === module.key)}>Apply</Button>
    <Problems issues={issues} />
  </form>;
}

/** The owned record type's names, its key while unsaved, and Delete, refused with where it is used. */
function RecordTypeInspector({ source, saved, moduleKey, recordKey, disabled, fieldContext, dataModule, targetLabel, apply, applyInPlace,
  applyField, applyChange, onFieldPending, onSearchPending, onSelect, onChoose, onShow }: Readonly<{
  source: ApplicationSourceDocument; saved: ApplicationSourceDocument; moduleKey: string; recordKey: string; disabled: boolean;
  fieldContext: ModuleFieldEditorContext;
  /** The module as the Data tab shows it, for the record type's search settings. */
  dataModule: StudioDataModule;
  /** The name of a record type a link points at. */
  targetLabel: (key: string) => string;
  /** Applies a query or search edit as one draft edit. */
  applyChange: ApplyDataChange;
  apply: (next: ApplicationSourceDocument, message: string, select?: StudioDataSelection | null) => boolean;
  /** Applies an edit while the inspector's open forms keep what the person has set. */
  applyInPlace: (next: ApplicationSourceDocument, message: string) => boolean;
  applyField: (expected: ApplicationSourceDocument, next: ApplicationSourceDocument) => boolean;
  onFieldPending: (pending: boolean) => void;
  onSearchPending: (pending: boolean) => void;
  onSelect: (selection: StudioDataSelection) => void;
  /** Selects another item, asking first when input is not applied. */
  onChoose: (selection: StudioDataSelection) => void;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  // A new field, a new relationship (a new link field) or a new query is being added.
  const [adding, setAdding] = useState<"field" | "relationship" | "query" | null>(null);
  const module = source.body.modules.find((item) => item.key === moduleKey)!;
  const record = module.record_types.find((item) => item.key === recordKey)!;
  const keyEditable = !saved.body.modules.some((item) => item.key === moduleKey &&
    item.record_types.some((candidate) => candidate.key === recordKey));
  const [name, setName] = useState(record.name);
  const [plural, setPlural] = useState(record.plural_name);
  const [key, setKey] = useState(record.key);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly InlineRecordTypeReference[]>([]);
  const [refusals, setRefusals] = useState(0);
  const dataRecord = dataModule.recordTypes.find((item) => item.key === recordKey);
  const title = record.fields.find((field) => field.key === record.title_field);
  const pending = name !== record.name || plural !== record.plural_name || key !== record.key;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let result = renameInlineRecordType(source, { moduleKey, recordKey, name, pluralName: plural });
    if (result.kind === "changed" && keyEditable && key.trim() !== recordKey)
      result = rekeyUnsavedInlineRecordType(result.source, saved, { moduleKey, recordKey, key });
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!apply(result.source, "Record type changed. Save to keep it.", { kind: "record_type", moduleKey, recordKey: result.recordKey }))
      setIssues(["The draft changed or is busy, so nothing was changed. Try again in a moment."]);
  };
  const remove = async () => {
    setIssues([]);
    const result = deleteInlineRecordType(source, moduleKey, recordKey);
    if (result.kind === "referenced") { setReferences(result.references); setRefusals((value) => value + 1); return; }
    if (result.kind === "invalid") { setIssues(result.issues); return; }
    if (!await confirm({
      title: `Delete ${record.name}?`,
      description: `${record.plural_name} and its fields leave the draft. Records already kept in the running application stay until you publish and upgrade.`,
      confirmLabel: "Delete record type",
    })) return;
    if (!apply(result.source, `${record.name} deleted from the draft. Save to keep it.`, null))
      setIssues(["The draft changed or is busy, so nothing was deleted. Try again in a moment."]);
  };
  return <div className="space-y-4">
    <form className="space-y-3" onSubmit={submit}>
      <StudioField label="Name of one record">
        {(control) => <Input {...control} maxLength={60} value={name} disabled={disabled}
          onChange={(event) => { setName(event.target.value); setIssues([]); }} />}
      </StudioField>
      <StudioField label="Name of several records">
        {(control) => <Input {...control} maxLength={60} value={plural} disabled={disabled}
          onChange={(event) => { setPlural(event.target.value); setIssues([]); }} />}
      </StudioField>
      {keyEditable
        ? <StudioField label="Key" hint="You can change it until you save the draft; after that it is permanent.">
          {(control) => <Input {...control} maxLength={40} value={key} disabled={disabled}
            onChange={(event) => { setKey(event.target.value); setIssues([]); }} />}
        </StudioField>
        : <p className="text-sm text-muted-foreground">Key: {record.key}. It stays the same when you rename the record type.</p>}
      <p className="text-sm">Title field: {title?.label ?? record.title_field}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={disabled || !pending}>Apply</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !pending}
          onClick={() => { setName(record.name); setPlural(record.plural_name); setKey(record.key); setIssues([]); }}>Discard</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled}
          aria-expanded={adding === "field"} onClick={() => setAdding(adding === "field" ? null : "field")}>Add a field</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled}
          aria-expanded={adding === "query"} onClick={() => setAdding(adding === "query" ? null : "query")}>Add a query</Button>
      </div>
    </form>
    <StudioRelationshipsSection source={source} moduleKey={moduleKey} recordKey={recordKey} publication={fieldContext.publication}
      disabled={disabled} targetLabel={targetLabel} adding={adding === "relationship"}
      onAdd={() => setAdding(adding === "relationship" ? null : "relationship")}
      onEdit={(owner, linking, fieldKey) => onChoose({ kind: "field", moduleKey: owner, recordKey: linking, fieldKey })}
      onApply={(expected, next, message) => expected === source &&
        apply(next, message, { kind: "record_type", moduleKey, recordKey })}
      onShow={onShow} />
    {adding === "query" && <section className="space-y-2 border-t border-border pt-3" aria-label={`New query of ${record.name}`}>
      <h3 className="text-sm font-semibold">New query of {record.plural_name}</h3>
      <StudioNewQueryForm source={source} moduleKey={moduleKey} recordKey={recordKey} disabled={disabled} onApply={applyChange}
        onCreated={(queryKey) => onSelect({ kind: "query", moduleKey, queryKey })} />
    </section>}
    {(adding === "field" || adding === "relationship") && <section key={adding} className="space-y-2 border-t border-border pt-3"
      aria-label={adding === "field" ? `New field of ${record.name}` : `New relationship of ${record.name}`}>
      <h3 className="text-sm font-semibold">{adding === "field" ? "New field" : "New relationship"}</h3>
      {adding === "relationship" && <p className="text-sm text-muted-foreground">A relationship is a link field: each
        {` ${record.name.toLowerCase()} `}holds a link to the record it relates to. Name it as {record.name} sees it, for example Company.</p>}
      <ModuleFieldsEditor source={source} moduleKey={moduleKey} recordKey={recordKey} fieldKey={undefined}
        initialType={adding === "relationship" ? "link" : "text"}
        disabled={disabled} context={fieldContext} onPendingChange={onFieldPending} onApply={applyField}
        onApplied={(fieldKey) => onSelect({ kind: "field", moduleKey, recordKey, fieldKey })} onShow={onShow} />
    </section>}
    <StudioModuleActions source={source} moduleKey={moduleKey} recordKey={recordKey} disabled={disabled} onShow={onShow}
      apply={(next, message) => apply(next, message)} />
    <StudioRecordPipelines source={source} moduleKey={moduleKey} recordKey={recordKey} publication={fieldContext.publication}
      disabled={disabled} onShow={onShow} apply={(next, message) => apply(next, message)} applyAction={applyInPlace} />
    <StudioRecordRules source={source} moduleKey={moduleKey} recordKey={recordKey} disabled={disabled} onShow={onShow}
      apply={(next, message) => apply(next, message)} />
    <section className="space-y-2 border-t border-border pt-3" aria-label="Delete">
      <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>Delete record type</Button>
      <StudioReferencesAlert key={refusals} name={record.name} action="deleted" references={references} onShow={onShow} />
      <Problems issues={issues} />
    </section>
    {dataRecord === undefined ? null : <StudioRecordTypeSearch key={JSON.stringify(source.body.search ?? null)} source={source}
      module={dataModule} record={dataRecord} disabled={disabled} onPendingChange={onSearchPending} onApply={applyChange} />}
    {confirmDialog}
  </div>;
}

/**
 * A used module, record type, field or query: read-only here, with where to change it. Whether the
 * application's search finds a used record type is this application's own setting, so it is edited here.
 */
function ReadOnlyInspector({ module, selection, organizationId, applications, source, disabled, onPendingChange, applyChange }: Readonly<{
  module: StudioDataModule; selection: StudioDataSelection; organizationId: string;
  applications: readonly StudioModuleOwnerApplication[];
  source: ApplicationSourceDocument; disabled: boolean; onPendingChange: (pending: boolean) => void; applyChange: ApplyDataChange;
}>) {
  const owner = applications.find((application) => application.key === module.ownerApplication);
  const record = selection.kind === "record_type" || selection.kind === "field"
    ? module.recordTypes.find((item) => item.key === selection.recordKey) : undefined;
  const field = selection.kind === "field" ? record?.fields.find((item) => item.key === selection.fieldKey) : undefined;
  const query = selection.kind === "query" ? module.queries.find((item) => item.key === selection.queryKey) : undefined;
  const queryRecord = query === undefined ? record : module.recordTypes.find((item) => item.key === query.recordKey);
  return <div className="space-y-3 text-sm">
    {field !== undefined && <dl className="space-y-1">
      <div><dt className="font-semibold">Field</dt><dd>{field.label}</dd></div>
      <div><dt className="font-semibold">Type</dt><dd>{fieldTypeLabel(field.type)}</dd></div>
      <div><dt className="font-semibold">Required</dt><dd>{field.required ? "Yes" : "No"}</dd></div>
    </dl>}
    {query !== undefined && <p>The query {query.label} lists {queryRecord?.pluralName.toLowerCase() ?? "records"} for pages and blocks.
      {query.summary ? " It groups records or adds totals, so it reads as a summary." : ""}</p>}
    {module.ownerApplication === undefined ? null : <p role="note">
      {module.name} is owned by {owner?.name ?? module.ownerApplication}. It is read-only here: change it in its owner&apos;s
      Studio, publish the owner, and then publish this application to use the new version.
      {owner === undefined ? null : <> <Link className="underline underline-offset-4"
        href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(owner.rootId)}?tab=data&module=${encodeURIComponent(module.key)}`}>
        Open {owner.name} in Studio</Link></>}
    </p>}
    {selection.kind === "record_type" && record !== undefined &&
      <StudioRecordTypeSearch key={JSON.stringify(source.body.search ?? null)} source={source} module={module} record={record}
        disabled={disabled} onPendingChange={onPendingChange} onApply={applyChange} />}
  </div>;
}

const selectionExists = (modules: readonly StudioDataModule[], selection: StudioDataSelection): boolean => {
  const module = modules.find((item) => item.key === selection.moduleKey);
  if (module === undefined) return false;
  if (selection.kind === "module") return true;
  if (selection.kind === "query") return module.queries.some((query) => query.key === selection.queryKey);
  const record = module.recordTypes.find((item) => item.key === selection.recordKey);
  return record !== undefined && (selection.kind === "record_type" || record.fields.some((field) => field.key === selection.fieldKey));
};

const describeSelection = (modules: readonly StudioDataModule[], selection: StudioDataSelection | null): string => {
  const module = selection === null ? undefined : modules.find((item) => item.key === selection.moduleKey);
  if (selection === null || module === undefined) return "Data";
  if (selection.kind === "module") return module.name;
  if (selection.kind === "query") return module.queries.find((query) => query.key === selection.queryKey)?.label ?? "Query";
  const record = module.recordTypes.find((item) => item.key === selection.recordKey);
  if (selection.kind === "record_type") return record?.pluralName ?? "Record type";
  return record?.fields.find((field) => field.key === selection.fieldKey)?.label ?? "Field";
};

/**
 * The Data tab's controller: the tree of owned and used modules, the schema grid and live records
 * of the selected record type or query, and the inspector that creates, renames and deletes record
 * types and edits fields. What is selected is the workspace's one selection; every change is one
 * edit of the application draft, saved and published with it.
 */
export function useStudioDataTab({ organizationId, rootId, source, saved, used, published, peopleDirectory, compiledFields, applications,
  initialModule, selection, hidden, disabled, refresh, apply, choose, selectAfterEdit, onFieldPending, onSearchPending, openInTab,
  compositionContext, readRecords }: Readonly<{
  organizationId: string; rootId: string;
  source: ApplicationSourceDocument;
  /** The saved draft: a key is permanent once it is saved. */
  saved: ApplicationSourceDocument;
  used: readonly StudioDataModule[] | null;
  /** What the published versions of its own modules hold; null when the draft did not compile. */
  published: StudioPublishedData | null;
  /** The compiled fields of the saved draft, for a query filter's typed controls; null when it did not compile. */
  compiledFields: StudioCompiledFields | null;
  /** The organisation's people directory, which a Person link points at; null when it could not be read. */
  peopleDirectory: PeopleDirectoryOwner | null;
  /** The composition context the "Also show it on" placements are applied through. */
  compositionContext: StudioCompositionContext;
  /** Reads records of the installed application, for a link field's default. */
  readRecords: StudioRecordReader | null;
  applications: readonly StudioModuleOwnerApplication[];
  /** The workspace's selection, when it is a Data item. */
  selection: StudioDataSelection | null;
  hidden: boolean;
  disabled: boolean;
  refresh: number;
  apply: ApplyDataChange;
  /** Selects an item, asking before unapplied input is discarded. */
  choose: (selection: StudioDataSelection) => void;
  /** Selects the item an applied edit made or changed. */
  selectAfterEdit: (selection: StudioDataSelection | null) => void;
  onFieldPending: (pending: boolean) => void;
  /** Whether a record type's search settings hold input that is not applied yet. */
  onSearchPending: (pending: boolean) => void;
  /** The module the Studio address opens first, if any. */
  initialModule: string | null;
  /** Opens another tab with an item of it selected, for "Show me where". */
  openInTab: (tab: "structure" | "flows" | "menu", selection: StudioSemanticSelection) => void;
}>) {
  // A Studio address that names a module opens it once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || initialModule === null) return;
    opened.current = true;
    selectAfterEdit({ kind: "module", moduleKey: initialModule });
  }, [initialModule, selectAfterEdit]);
  const onShow = ({ open }: InlineRecordTypeReference) => {
    if (open.kind === "record_type") choose(open.fieldKey === undefined
      ? { kind: "record_type", moduleKey: open.moduleKey, recordKey: open.recordKey }
      : { kind: "field", moduleKey: open.moduleKey, recordKey: open.recordKey, fieldKey: open.fieldKey });
    else if (open.kind === "query") choose({ kind: "query", moduleKey: open.moduleKey, queryKey: open.queryKey });
    else if (open.kind === "page") openInTab("structure", { kind: "page", pageAlias: open.pageAlias });
    else if (open.kind === "flow") openInTab("flows", { kind: "flow", flowAlias: open.flowAlias, moduleKey: open.moduleKey });
    else if (open.kind === "menu") openInTab("menu", { kind: "navigation", navigationItemAlias: open.navigationAlias });
  };
  const owned = useMemo(() => ownedDataModules(source), [source]);
  const publication = useMemo(() => studioFieldPublication(published, saved), [published, saved]);
  // A link may point at a record type of a module the application uses, or at a person of the
  // people directory, which the link then adds to the modules it uses.
  const usedRecordTypes = useMemo((): readonly StudioLinkTarget[] => {
    const targets: StudioLinkTarget[] = (used ?? []).flatMap((module) => module.recordTypes.map((record) => {
      const key = `${module.key}:${record.key}`;
      return { key, label: key === directory.recordType ? `${record.name} (people directory)` : `${record.name} (${module.name})`,
        titleLabel: record.fields.find((field) => field.key === record.titleFieldKey)?.label };
    }));
    if (peopleDirectory !== null && !targets.some((target) => target.key === directory.recordType))
      targets.push({ key: directory.recordType, label: "Person (people directory)", titleLabel: peopleDirectory.titleLabel });
    return targets;
  }, [used, peopleDirectory]);
  const fieldContext: ModuleFieldEditorContext = { publication, composition: compositionContext, usedRecordTypes, peopleDirectory, readRecords };
  const targetLabel = (key: string): string => {
    const [owner, local] = key.split(":");
    const record = source.body.modules.find((module) => module.key === owner)?.record_types.find((item) => item.key === local);
    return record?.name ?? usedRecordTypes.find((target) => target.key === key)?.label ?? key;
  };
  const savedOwned = useMemo(() => ownedDataModules(saved), [saved]);
  const modules = useMemo(() => [...owned, ...(used ?? [])], [owned, used]);
  const [creating, setCreating] = useState(false);
  // Each applied edit renews the inspector's forms from the draft.
  const [epoch, setEpoch] = useState(0);
  const current = selection !== null && selectionExists(modules, selection) ? selection : null;

  const applyAndSelect = (next: ApplicationSourceDocument, message: string, then?: StudioDataSelection | null): boolean => {
    if (!apply(source, next, message)) return false;
    if (then !== undefined) selectAfterEdit(then);
    setEpoch((value) => value + 1);
    return true;
  };
  const applyField = (expected: ApplicationSourceDocument, next: ApplicationSourceDocument) =>
    apply(expected, next, "Field changed. Save to keep it.");
  /** A query or search edit: one draft edit, after which the inspector's forms are read again. */
  const applyChange: ApplyDataChange = (expected, next, message) => {
    if (!apply(expected, next, message)) return false;
    setEpoch((value) => value + 1);
    return true;
  };
  const recordTypes = useMemo(() => [...owned.flatMap((item) => item.recordTypes.map((record) =>
    ({ key: `${item.key}:${record.key}`, label: record.name }))), ...usedRecordTypes], [owned, usedRecordTypes]);
  const isOwned = current !== null && owned.some((module) => module.key === current.moduleKey);
  const draftOnly = current !== null && isOwned && !selectionExists(savedOwned, current.kind === "field"
    ? { kind: "record_type", moduleKey: current.moduleKey, recordKey: current.recordKey } : current);
  const module = current === null ? undefined : modules.find((item) => item.key === current.moduleKey);

  const panel = <StudioDataPanel hidden={hidden} owned={owned} used={used} applications={applications}
    selected={current} onSelect={choose} onCreate={() => setCreating(true)} disabled={disabled}
    search={<StudioSearchOverview source={source} modules={modules} disabled={disabled} onApply={applyChange} onSelect={choose} />} />;
  const centre = <StudioDataCentre organizationId={organizationId} rootId={rootId} modules={modules}
    selection={current} draftOnly={draftOnly} refresh={refresh} />;
  const inspectorBody = current === null || module === undefined
    ? <p className="text-sm text-muted-foreground">Select a module, record type, field or query in the Data panel.</p>
    : !isOwned
      ? <ReadOnlyInspector key={`${epoch}:${JSON.stringify(current)}`} module={module} selection={current} organizationId={organizationId}
        applications={applications} source={source} disabled={disabled} onPendingChange={onSearchPending} applyChange={applyChange} />
      : current.kind === "query"
        ? <StudioQueryEditor key={`${epoch}:${current.moduleKey}:${current.queryKey}`} source={source} moduleKey={current.moduleKey}
          queryKey={current.queryKey} compiledFields={compiledFields} recordTypes={recordTypes} disabled={disabled}
          onPendingChange={onFieldPending} onApply={applyChange} onShow={onShow}
          onDeleted={(recordKey) => selectAfterEdit(recordKey === undefined ? { kind: "module", moduleKey: current.moduleKey }
            : { kind: "record_type", moduleKey: current.moduleKey, recordKey })} />
      : current.kind === "module"
        ? <ModuleInspector key={`${epoch}:${current.moduleKey}`} source={source} saved={saved} moduleKey={current.moduleKey}
          disabled={disabled} apply={applyAndSelect} />
        : current.kind === "record_type"
          ? <RecordTypeInspector key={`${epoch}:${current.moduleKey}:${current.recordKey}`} source={source} saved={saved}
            moduleKey={current.moduleKey} recordKey={current.recordKey} disabled={disabled} fieldContext={fieldContext}
            dataModule={module} targetLabel={targetLabel} apply={applyAndSelect} applyInPlace={(next, message) => apply(source, next, message)}
            applyChange={applyChange} applyField={applyField} onFieldPending={onFieldPending} onSearchPending={onSearchPending}
            onSelect={selectAfterEdit} onChoose={choose} onShow={onShow} />
          : <ModuleFieldsEditor key={`${epoch}:${current.moduleKey}:${current.recordKey}:${current.fieldKey}`}
            source={source} moduleKey={current.moduleKey} recordKey={current.recordKey} fieldKey={current.fieldKey}
            disabled={disabled} context={fieldContext} onPendingChange={onFieldPending} onApply={applyField}
            onApplied={() => setEpoch((value) => value + 1)} onShow={onShow}
            onRemoved={() => { selectAfterEdit({ kind: "record_type", moduleKey: current.moduleKey, recordKey: current.recordKey }); setEpoch((value) => value + 1); }} />;
  const inspector = <StudioPanelShell title="Inspector"
    description={current === null ? "Select an item to change it." : describeSelection(modules, current)}>
    {inspectorBody}
  </StudioPanelShell>;
  const dialog = <StudioRecordTypeDialog key={creating ? "open" : "closed"} open={creating} source={source}
    onClose={() => setCreating(false)}
    onCreate={(expected, next, moduleKey, recordKey) => {
      if (!apply(expected, next, "Record type added. Save to keep it.")) return false;
      selectAfterEdit({ kind: "record_type", moduleKey, recordKey });
      setEpoch((value) => value + 1);
      return true;
    }} />;
  return { panel, centre, inspector, dialog, title: describeSelection(modules, current) };
}
