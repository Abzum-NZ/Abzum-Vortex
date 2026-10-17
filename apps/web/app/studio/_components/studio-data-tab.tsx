"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isStudioDataSelection, type StudioCompositionContext, type StudioDataSelection, type StudioRecordReader, type StudioSemanticSelection,
} from "@vortex/ui/studio";
import {
  deleteInlineRecordType, peopleDirectory as directory, renameInlineModule, renameInlineRecordType,
  type ApplicationSourceDocument, type InlineRecordTypeReference,
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
import { useStudioDraftText } from "./use-studio-draft-text";
import type { StudioDraft } from "./use-studio-draft";
import {
  ModuleFieldsEditor, studioFieldPublication, type ModuleFieldEditorContext, type StudioLinkTarget,
  type StudioModuleOwnerApplication,
} from "./module-fields-editor";
import {
  fieldTypeLabel, ownedDataModules, studioEditProblem, type StudioDataEdit, type StudioDataModule,
} from "../_lib/studio-data-model";

type Source = ApplicationSourceDocument;

function Problems({ issues }: Readonly<{ issues: readonly string[] }>) {
  return issues.length === 0 ? null : <ul role="alert" className="space-y-1 text-sm text-destructive">
    {issues.map((issue, index) => <li key={index} className="break-words">{issue}</li>)}</ul>;
}

const recordIn = (source: Source, moduleKey: string, recordKey: string) =>
  source.body.modules.find((item) => item.key === moduleKey)?.record_types.find((item) => item.key === recordKey);

/** The owned module's name, applied as it is typed; its key is permanent. */
function ModuleInspector({ source, moduleKey, disabled, edit }: Readonly<{
  source: Source; moduleKey: string; disabled: boolean; edit: StudioDataEdit;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey)!;
  const name = useStudioDraftText(module.name, (next) =>
    studioEditProblem(edit((current) => renameInlineModule(current, { moduleKey, name: next }), { merge: `module-name:${moduleKey}` })) ?? true);
  return <div className="space-y-3">
    <StudioField label="Module name" error={name.problem === "" ? undefined : name.problem}>
      {(control) => <Input {...control} maxLength={120} value={name.text} disabled={disabled}
        onChange={(event) => name.change(event.target.value)} />}
    </StudioField>
    <p className="text-sm text-muted-foreground">Key: {module.key}. It is permanent.</p>
  </div>;
}

/** The owned record type's names, applied as they are typed, and Delete, refused with where it is used. */
function RecordTypeInspector({ source, moduleKey, recordKey, disabled, fieldContext, dataModule, targetLabel, edit, onSelect, onShow }: Readonly<{
  source: Source; moduleKey: string; recordKey: string; disabled: boolean;
  fieldContext: ModuleFieldEditorContext;
  /** The module as the Data tab shows it, for the record type's search settings. */
  dataModule: StudioDataModule;
  /** The name of a record type a link points at. */
  targetLabel: (key: string) => string;
  edit: StudioDataEdit;
  onSelect: (selection: StudioDataSelection | null) => void;
  onShow: (reference: InlineRecordTypeReference) => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  // A new field, a new relationship (a new link field) or a new query is being added.
  const [adding, setAdding] = useState<"field" | "relationship" | "query" | null>(null);
  const record = recordIn(source, moduleKey, recordKey)!;
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly InlineRecordTypeReference[]>([]);
  const [refusals, setRefusals] = useState(0);
  const rename = (names: Readonly<{ name?: string; pluralName?: string }>, merge: string) => studioEditProblem(edit((current) => {
    const now = recordIn(current, moduleKey, recordKey);
    if (now === undefined) return { kind: "invalid" as const, issues: ["The record type is not in this application's modules any more."] };
    return renameInlineRecordType(current, { moduleKey, recordKey, name: now.name, pluralName: now.plural_name, ...names });
  }, { merge })) ?? true;
  const name = useStudioDraftText(record.name, (next) => rename({ name: next }, `record-name:${moduleKey}:${recordKey}`));
  const plural = useStudioDraftText(record.plural_name, (next) => rename({ pluralName: next }, `record-plural:${moduleKey}:${recordKey}`));
  const dataRecord = dataModule.recordTypes.find((item) => item.key === recordKey);
  const title = record.fields.find((field) => field.key === record.title_field);
  const remove = async () => {
    setIssues([]);
    const check = deleteInlineRecordType(source, moduleKey, recordKey);
    if (check.kind === "referenced") { setReferences(check.references); setRefusals((value) => value + 1); return; }
    if (check.kind === "invalid") { setIssues(check.issues); return; }
    if (!await confirm({
      title: `Delete ${record.name}?`,
      description: `${record.plural_name} and its fields leave the draft. Records already kept in the running application stay until you publish and upgrade.`,
      confirmLabel: "Delete record type",
    })) return;
    const result = edit((current) => deleteInlineRecordType(current, moduleKey, recordKey));
    if (result.kind === "changed") onSelect(null);
    else if (result.kind === "referenced") { setReferences(result.references); setRefusals((value) => value + 1); }
    else setIssues([studioEditProblem(result) ?? "The record type was not deleted."]);
  };
  return <div className="space-y-4">
    <section className="space-y-3" aria-label={`Names of ${record.plural_name}`}>
      <StudioField label="Name of one record" error={name.problem === "" ? undefined : name.problem}>
        {(control) => <Input {...control} maxLength={60} value={name.text} disabled={disabled}
          onChange={(event) => name.change(event.target.value)} />}
      </StudioField>
      <StudioField label="Name of several records" error={plural.problem === "" ? undefined : plural.problem}>
        {(control) => <Input {...control} maxLength={60} value={plural.text} disabled={disabled}
          onChange={(event) => plural.change(event.target.value)} />}
      </StudioField>
      <p className="text-sm text-muted-foreground">Key: {record.key}. It stays the same when you rename the record type.</p>
      <p className="text-sm">Title field: {title?.label ?? record.title_field}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled}
          aria-expanded={adding === "field"} onClick={() => setAdding(adding === "field" ? null : "field")}>Add a field</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled}
          aria-expanded={adding === "query"} onClick={() => setAdding(adding === "query" ? null : "query")}>Add a query</Button>
      </div>
    </section>
    <StudioRelationshipsSection source={source} moduleKey={moduleKey} recordKey={recordKey} publication={fieldContext.publication}
      disabled={disabled} targetLabel={targetLabel} adding={adding === "relationship"}
      onAdd={() => setAdding(adding === "relationship" ? null : "relationship")}
      onEdit={(owner, linking, fieldKey) => onSelect({ kind: "field", moduleKey: owner, recordKey: linking, fieldKey })}
      edit={edit} onShow={onShow} />
    {adding === "query" && <section className="space-y-2 border-t border-border pt-3" aria-label={`New query of ${record.name}`}>
      <h3 className="text-sm font-semibold">New query of {record.plural_name}</h3>
      <StudioNewQueryForm source={source} moduleKey={moduleKey} recordKey={recordKey} disabled={disabled} edit={edit}
        onCreated={(queryKey) => onSelect({ kind: "query", moduleKey, queryKey })} />
    </section>}
    {(adding === "field" || adding === "relationship") && <section key={adding} className="space-y-2 border-t border-border pt-3"
      aria-label={adding === "field" ? `New field of ${record.name}` : `New relationship of ${record.name}`}>
      <h3 className="text-sm font-semibold">{adding === "field" ? "New field" : "New relationship"}</h3>
      {adding === "relationship" && <p className="text-sm text-muted-foreground">A relationship is a link field: each
        {` ${record.name.toLowerCase()} `}holds a link to the record it relates to. Name it as {record.name} sees it, for example Company.</p>}
      <ModuleFieldsEditor source={source} moduleKey={moduleKey} recordKey={recordKey} fieldKey={undefined}
        initialType={adding === "relationship" ? "link" : "text"} disabled={disabled} context={fieldContext} edit={edit}
        onAdded={(fieldKey) => onSelect({ kind: "field", moduleKey, recordKey, fieldKey })} onShow={onShow} />
    </section>}
    <StudioModuleActions source={source} moduleKey={moduleKey} recordKey={recordKey} disabled={disabled} onShow={onShow} edit={edit} />
    <StudioRecordPipelines source={source} moduleKey={moduleKey} recordKey={recordKey} publication={fieldContext.publication}
      disabled={disabled} onShow={onShow} edit={edit} />
    <section className="space-y-2 border-t border-border pt-3" aria-label="Delete">
      <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>Delete record type</Button>
      <StudioReferencesAlert key={refusals} name={record.name} action="deleted" references={references} onShow={onShow} />
      <Problems issues={issues} />
    </section>
    {dataRecord === undefined ? null
      : <StudioRecordTypeSearch source={source} module={dataModule} record={dataRecord} disabled={disabled} edit={edit} />}
    {confirmDialog}
  </div>;
}

/**
 * A used module, record type, field or query: read-only here, with where to change it. Whether the
 * application's search finds a used record type is this application's own setting, so it is edited here.
 */
function ReadOnlyInspector({ module, selection, organizationId, applications, source, disabled, edit }: Readonly<{
  module: StudioDataModule; selection: StudioDataSelection; organizationId: string;
  applications: readonly StudioModuleOwnerApplication[];
  source: Source; disabled: boolean; edit: StudioDataEdit;
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
      <StudioRecordTypeSearch source={source} module={module} record={record} disabled={disabled} edit={edit} />}
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
 * types and edits fields, queries, actions, pipelines and search. What is selected is the
 * workspace's one selection; every change is one edit of the draft through `draft.run`, applied as
 * soon as it is valid and saved by the draft's autosave.
 */
export function useStudioDataTab({ draft, applications, initialModule, hidden, compositionContext, readRecords, openInTab }: Readonly<{
  draft: StudioDraft;
  applications: readonly StudioModuleOwnerApplication[];
  /** The module the Studio address opens first, if any. */
  initialModule: string | null;
  hidden: boolean;
  /** The composition context the "Also show it on" placements are made through. */
  compositionContext: StudioCompositionContext;
  /** Reads records of the installed application, for a link field's default. */
  readRecords: StudioRecordReader | null;
  /** Opens another tab with an item of it selected, for "Show me where". */
  openInTab: (tab: "structure" | "flows" | "menu", selection: StudioSemanticSelection) => void;
}>) {
  const { source, organizationId, view } = draft;
  const disabled = draft.locked;
  const select = (next: StudioDataSelection | null) => { draft.select(next); };
  // A Studio address that names a module opens it once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || initialModule === null) return;
    opened.current = true;
    draft.select({ kind: "module", moduleKey: initialModule });
  }, [initialModule, draft]);
  /** The Data tab's one edit path: a platform command over the current draft source, as one edit of the draft. */
  const edit: StudioDataEdit = (command, options) => {
    const outcome = draft.run((current) => {
      const result = command(current);
      const changed = result.kind === "changed" ? (result as Readonly<{ source?: Source }>).source : undefined;
      return changed === undefined ? { kind: "keep", result } : { kind: "edit", source: changed, result };
    }, options);
    return outcome.kind === "blocked" ? outcome : outcome.result;
  };
  const onShow = ({ open }: InlineRecordTypeReference) => {
    if (open.kind === "record_type") select(open.fieldKey === undefined
      ? { kind: "record_type", moduleKey: open.moduleKey, recordKey: open.recordKey }
      : { kind: "field", moduleKey: open.moduleKey, recordKey: open.recordKey, fieldKey: open.fieldKey });
    else if (open.kind === "query") select({ kind: "query", moduleKey: open.moduleKey, queryKey: open.queryKey });
    else if (open.kind === "page") openInTab("structure", { kind: "page", pageAlias: open.pageAlias });
    else if (open.kind === "flow") openInTab("flows", { kind: "flow", flowAlias: open.flowAlias, moduleKey: open.moduleKey });
    else if (open.kind === "menu") openInTab("menu", { kind: "navigation", navigationItemAlias: open.navigationAlias });
  };
  const saved = useMemo(() => draft.parsed(draft.saved.source), [draft, draft.saved.source]);
  const used = view.usedModules;
  const owned = useMemo(() => ownedDataModules(source), [source]);
  const publication = useMemo(() => studioFieldPublication(view.published, saved), [view.published, saved]);
  // A link may point at a record type of a module the application uses, or at a person of the
  // people directory, which the link then adds to the modules it uses.
  const usedRecordTypes = useMemo((): readonly StudioLinkTarget[] => {
    const targets: StudioLinkTarget[] = (used ?? []).flatMap((module) => module.recordTypes.map((record) => {
      const key = `${module.key}:${record.key}`;
      return { key, label: key === directory.recordType ? `${record.name} (people directory)` : `${record.name} (${module.name})`,
        titleLabel: record.fields.find((field) => field.key === record.titleFieldKey)?.label };
    }));
    if (view.peopleDirectory !== null && !targets.some((target) => target.key === directory.recordType))
      targets.push({ key: directory.recordType, label: "Person (people directory)", titleLabel: view.peopleDirectory.titleLabel });
    return targets;
  }, [used, view.peopleDirectory]);
  const fieldContext: ModuleFieldEditorContext = { publication, composition: compositionContext, usedRecordTypes,
    peopleDirectory: view.peopleDirectory, readRecords };
  const targetLabel = (key: string): string => {
    const [owner, local] = key.split(":");
    return recordIn(source, owner ?? "", local ?? "")?.name ?? usedRecordTypes.find((target) => target.key === key)?.label ?? key;
  };
  const savedOwned = useMemo(() => ownedDataModules(saved), [saved]);
  const modules = useMemo(() => [...owned, ...(used ?? [])], [owned, used]);
  const [creating, setCreating] = useState(false);
  const selection = isStudioDataSelection(draft.selected) ? draft.selected : null;
  const current = selection !== null && selectionExists(modules, selection) ? selection : null;

  const recordTypes = useMemo(() => [...owned.flatMap((item) => item.recordTypes.map((record) =>
    ({ key: `${item.key}:${record.key}`, label: record.name }))), ...usedRecordTypes], [owned, usedRecordTypes]);
  const isOwned = current !== null && owned.some((module) => module.key === current.moduleKey);
  const draftOnly = current !== null && isOwned && !selectionExists(savedOwned, current.kind === "field"
    ? { kind: "record_type", moduleKey: current.moduleKey, recordKey: current.recordKey } : current);
  const module = current === null ? undefined : modules.find((item) => item.key === current.moduleKey);

  const panel = <StudioDataPanel hidden={hidden} owned={owned} used={used} applications={applications}
    selected={current} onSelect={select} onCreate={() => setCreating(true)} disabled={disabled}
    search={<StudioSearchOverview source={source} modules={modules} disabled={disabled} edit={edit} onSelect={select} />} />;
  const centre = <StudioDataCentre organizationId={organizationId} rootId={draft.state.rootId} modules={modules}
    selection={current} draftOnly={draftOnly} refresh={view.generation} />;
  // Each editor is keyed by the item it edits only, so an applied edit never draws it afresh.
  const inspectorBody = current === null || module === undefined
    ? <p className="text-sm text-muted-foreground">Select a module, record type, field or query in the Data panel.</p>
    : !isOwned
      ? <ReadOnlyInspector key={JSON.stringify(current)} module={module} selection={current} organizationId={organizationId}
        applications={applications} source={source} disabled={disabled} edit={edit} />
      : current.kind === "query"
        ? <StudioQueryEditor key={`query:${current.moduleKey}:${current.queryKey}`} source={source} moduleKey={current.moduleKey}
          queryKey={current.queryKey} compiledFields={view.compiledFields} recordTypes={recordTypes} disabled={disabled}
          edit={edit} onShow={onShow}
          onDeleted={(recordKey) => select(recordKey === undefined ? { kind: "module", moduleKey: current.moduleKey }
            : { kind: "record_type", moduleKey: current.moduleKey, recordKey })} />
      : current.kind === "module"
        ? <ModuleInspector key={`module:${current.moduleKey}`} source={source} moduleKey={current.moduleKey} disabled={disabled} edit={edit} />
        : current.kind === "record_type"
          ? <RecordTypeInspector key={`record:${current.moduleKey}:${current.recordKey}`} source={source}
            moduleKey={current.moduleKey} recordKey={current.recordKey} disabled={disabled} fieldContext={fieldContext}
            dataModule={module} targetLabel={targetLabel} edit={edit} onSelect={select} onShow={onShow} />
          : <ModuleFieldsEditor key={`field:${current.moduleKey}:${current.recordKey}:${current.fieldKey}`}
            source={source} moduleKey={current.moduleKey} recordKey={current.recordKey} fieldKey={current.fieldKey}
            disabled={disabled} context={fieldContext} edit={edit} onShow={onShow}
            onRemoved={() => select({ kind: "record_type", moduleKey: current.moduleKey, recordKey: current.recordKey })} />;
  const inspector = <StudioPanelShell title="Inspector"
    description={current === null ? "Select an item to change it." : describeSelection(modules, current)}>
    {inspectorBody}
  </StudioPanelShell>;
  const dialog = <StudioRecordTypeDialog key={creating ? "open" : "closed"} open={creating} source={source} edit={edit}
    onClose={() => setCreating(false)}
    onCreated={(moduleKey, recordKey) => select({ kind: "record_type", moduleKey, recordKey })} />;
  return { panel, centre, inspector, dialog, title: describeSelection(modules, current) };
}
