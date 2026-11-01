"use client";
import { NavigationLink } from "@vortex/ui/routing";
import { useState } from "react";
import {
  StudioAddButton,
  StudioInspectorActions,
  StudioInspectorGroup,
  StudioOptionControl,
  type StudioDataSelection,
} from "@vortex/ui/studio";
import {
  deleteInlineRecordType,
  renameInlineModule,
  renameInlineRecordType,
  recordTitleFieldEligible,
  setInlineRecordTitleField,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
  type RecordSettingsContext,
  type ModuleExtensionPointUse,
} from "@vortex/platform/schema";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";
import { StudioDataPanel } from "./studio-data-panel";
import { StudioDataCentre, StudioDataEmpty } from "./studio-data-centre";
import { StudioRecordTypeDialog } from "./studio-record-type-dialog";
import { StudioModuleDialog } from "./studio-module-dialog";
import { StudioReferencesAlert, StudioUsedIn } from "./studio-used-in";
import { studioUseTargetOf } from "../_lib/studio-places";
import { StudioQueryEditor, queryInputTypeLabel } from "./studio-query-editor";
import { StudioQueryCatalogue } from "./studio-query-catalogue";
import { StudioQuerySheet } from "./studio-query-sheet";
import { StudioRecordTypeSearch, StudioSearchOverview } from "./studio-search-settings";
import { StudioRelationshipsSection } from "./studio-relationships-section";
import { StudioModuleEvents } from "./studio-module-events";
import { StudioModuleActions } from "./studio-module-actions";
import { StudioModuleExtensionPoints } from "./studio-module-extension-points";
import { StudioRecordPipelines } from "./studio-record-pipelines";
import { StudioRecordRules } from "./studio-record-rules";
import { StudioRecordSubscribers } from "./studio-record-subscribers";
import { StudioRecordStorageOwnership } from "./studio-record-storage-ownership";
import { StudioRecordStandardActions } from "./studio-record-standard-actions";
import { useStudioDraftText } from "./use-studio-draft-text";
import type { StudioDraft } from "./use-studio-draft";
import {
  ModuleFieldsEditor,
  type ModuleFieldEditorContext,
  type StudioModuleOwnerApplication,
} from "./module-fields-editor";
import {
  fieldTypeLabel,
  studioEditProblem,
  type StudioDataEdit,
  type StudioDataModule,
} from "../_lib/studio-data-model";
import type { describeStudioCompileFailure } from "../_lib/studio-compile-failure";
import { describeSelection, recordIn } from "./studio-data-tab";

type Source = ApplicationSourceDocument;

/**
 * What the Data tab's panel, centre, inspector and dialogs draw: the state and derived values of
 * `useStudioDataTab`, which stays in the workspace's first load while this file loads when the tab
 * is first shown.
 */
export type StudioDataModel = Readonly<{
  draft: StudioDraft;
  applications: readonly StudioModuleOwnerApplication[];
  hidden: boolean;
  disabled: boolean;
  edit: StudioDataEdit;
  owned: readonly StudioDataModule[];
  used: readonly StudioDataModule[] | null;
  modules: readonly StudioDataModule[];
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  current: StudioDataSelection | null;
  select: (next: StudioDataSelection | null) => void;
  showingSearch: boolean;
  showingQueries: boolean;
  showSearch: () => void;
  showQueries: () => void;
  section: string;
  setSection: (section: string) => void;
  unsaved: boolean;
  isOwned: boolean;
  module: StudioDataModule | undefined;
  record: StudioDataModule["recordTypes"][number] | undefined;
  scope: string;
  publication: ModuleFieldEditorContext["publication"];
  fieldContext: ModuleFieldEditorContext;
  settingsContext: RecordSettingsContext;
  targetLabel: (key: string) => string;
  adding: Readonly<{ scope: string; type: "text" | "link" }> | null;
  setAdding: (adding: Readonly<{ scope: string; type: "text" | "link" }> | null) => void;
  addField: (type: "text" | "link") => void;
  compileProblem: ReturnType<typeof describeStudioCompileFailure> | null;
  creatingModule: boolean;
  setCreatingModule: (open: boolean) => void;
  creating: boolean;
  setCreating: (open: boolean) => void;
  newQuery: boolean;
  setNewQuery: (open: boolean) => void;
  /** Fills the home dashboard for a record type just added. */
  fillHome: (recordType: string) => void;
}>;

function Problems({ issues }: Readonly<{ issues: readonly string[] }>) {
  return issues.length === 0 ? null : (
    <ul role="alert" className="space-y-1 text-sm text-destructive">
      {issues.map((issue, index) => (
        <li key={index} className="break-words">
          {issue}
        </li>
      ))}
    </ul>
  );
}

/** The owned module's name, applied as it is typed; its key is permanent. */
function ModuleInspector({
  source,
  moduleKey,
  disabled,
  edit,
  extensionPointUses,
}: Readonly<{
  source: Source;
  moduleKey: string;
  disabled: boolean;
  edit: StudioDataEdit;
  extensionPointUses: readonly ModuleExtensionPointUse[] | null;
}>) {
  const module = source.body.modules.find((item) => item.key === moduleKey)!;
  const name = useStudioDraftText(
    module.name,
    (next) =>
      studioEditProblem(
        edit((current) => renameInlineModule(current, { moduleKey, name: next }), {
          merge: `module-name:${moduleKey}`,
        }),
      ) ?? true,
  );
  return (
    <div className="space-y-3">
      <StudioField
        label="Module name"
        error={name.problem === "" ? undefined : name.problem}
        onUndo={name.reset}
      >
        {(control) => (
          <Input
            {...control}
            maxLength={120}
            value={name.text}
            disabled={disabled}
            onChange={(event) => name.change(event.target.value)}
          />
        )}
      </StudioField>
      <StudioModuleExtensionPoints
        source={source}
        moduleKey={moduleKey}
        disabled={disabled}
        edit={edit}
        uses={extensionPointUses}
      />
      <StudioInspectorGroup title="Details" defaultOpen={false}>
        <p className="text-xs font-mono">{module.key}</p>
      </StudioInspectorGroup>
    </div>
  );
}

/** The owned record type's names, applied as they are typed, and Delete, refused with where it is used. */
function RecordTypeInspector({
  source,
  moduleKey,
  recordKey,
  disabled,
  edit,
  onSelect,
  settings,
  name: recordName,
  onAddLink,
  onNewQuery,
}: Readonly<{
  source: Source;
  moduleKey: string;
  recordKey: string;
  disabled: boolean;
  edit: StudioDataEdit;
  onSelect: (selection: StudioDataSelection | null) => void;
  settings: RecordSettingsContext;
  name: (qualified: string) => string;
  onAddLink: () => void;
  /** Opens the new query sheet on this record type. */
  onNewQuery: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const record = recordIn(source, moduleKey, recordKey)!;
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly ApplicationUsePlace[]>([]);
  const [refusals, setRefusals] = useState(0);
  const rename = (names: Readonly<{ name?: string; pluralName?: string }>, merge: string) =>
    studioEditProblem(
      edit(
        (current) => {
          const now = recordIn(current, moduleKey, recordKey);
          if (now === undefined)
            return {
              kind: "invalid" as const,
              issues: ["The record type is not in this application's modules any more."],
            };
          return renameInlineRecordType(current, {
            moduleKey,
            recordKey,
            name: now.name,
            pluralName: now.plural_name,
            ...names,
          });
        },
        { merge },
      ),
    ) ?? true;
  const name = useStudioDraftText(record.name, (next) =>
    rename({ name: next }, `record-name:${moduleKey}:${recordKey}`),
  );
  const plural = useStudioDraftText(record.plural_name, (next) =>
    rename({ pluralName: next }, `record-plural:${moduleKey}:${recordKey}`),
  );
  const remove = async () => {
    setIssues([]);
    const check = deleteInlineRecordType(source, moduleKey, recordKey);
    if (check.kind === "referenced") {
      setReferences(check.references);
      setRefusals((value) => value + 1);
      return;
    }
    if (check.kind === "invalid") {
      setIssues(check.issues);
      return;
    }
    if (
      !(await confirm({
        title: `Delete ${record.name}?`,
        description: `${record.plural_name} and its fields leave the draft. Records already kept in the running application stay until you publish and upgrade.`,
        confirmLabel: "Delete record type",
      }))
    )
      return;
    const result = edit((current) => deleteInlineRecordType(current, moduleKey, recordKey));
    if (result.kind === "changed") onSelect(null);
    else if (result.kind === "referenced") {
      setReferences(result.references);
      setRefusals((value) => value + 1);
    } else setIssues([studioEditProblem(result) ?? "The record type was not deleted."]);
  };
  const queries =
    source.body.modules
      .find((module) => module.key === moduleKey)
      ?.queries.filter(
        (query) =>
          query.record_type === recordKey || query.record_type === `${moduleKey}:${recordKey}`,
      ) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{record.name}</h3>
          <p className="text-xs text-muted-foreground">Record type</p>
        </div>
        <StudioInspectorActions
          actions={[
            {
              label: "Delete record type",
              destructive: true,
              disabled,
              onSelect: () => {
                void remove();
              },
            },
          ]}
        />
      </div>
      {(references.length > 0 || issues.length > 0) && (
        <section className="space-y-2" aria-label="Delete">
          <StudioReferencesAlert
            key={refusals}
            name={record.name}
            action="deleted"
            references={references}
          />
          <Problems issues={issues} />
        </section>
      )}
      <div>
        <StudioInspectorGroup title="General">
          <StudioField
            label="Name of one record"
            error={name.problem === "" ? undefined : name.problem}
            onUndo={name.reset}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={60}
                value={name.text}
                disabled={disabled}
                onChange={(event) => name.change(event.target.value)}
              />
            )}
          </StudioField>
          <StudioField
            label="Name of several records"
            error={plural.problem === "" ? undefined : plural.problem}
            onUndo={plural.reset}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={60}
                value={plural.text}
                disabled={disabled}
                onChange={(event) => plural.change(event.target.value)}
              />
            )}
          </StudioField>
          <StudioField
            label="Title field"
            hint="Names records in pickers and headings, and is always filterable. Changing a published title requires a major version."
          >
            {(control) => (
              <StudioOptionControl
                {...control}
                value={record.title_field}
                disabled={disabled}
                options={record.fields.filter(recordTitleFieldEligible).map((field) => ({
                  value: field.key,
                  label: `${field.label} (${fieldTypeLabel(field.type)})`,
                }))}
                onChange={(value) => {
                  const problem = studioEditProblem(
                    edit((current) =>
                      setInlineRecordTitleField(current, {
                        moduleKey,
                        recordKey,
                        fieldKey: value,
                      }),
                    ),
                  );
                  setIssues(problem === undefined ? [] : [problem]);
                }}
              />
            )}
          </StudioField>
        </StudioInspectorGroup>
        <StudioRecordStandardActions
          source={source}
          moduleKey={moduleKey}
          recordKey={recordKey}
          disabled={disabled}
          edit={edit}
        />
        <StudioRecordStorageOwnership
          source={source}
          moduleKey={moduleKey}
          recordKey={recordKey}
          context={settings}
          name={recordName}
          disabled={disabled}
          edit={edit}
          onAddLink={onAddLink}
        />
        <StudioInspectorGroup
          title="Queries"
          defaultOpen={false}
          summary={queries.length === 1 ? "1 query" : `${queries.length} queries`}
          action={<StudioAddButton label="New query" disabled={disabled} onClick={onNewQuery} />}
        >
          {queries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No queries yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {queries.map((query) => (
                <li key={query.key}>
                  <button
                    type="button"
                    className="text-left text-sm text-foreground underline underline-offset-4 hover:no-underline"
                    onClick={() => onSelect({ kind: "query", moduleKey, queryKey: query.key })}
                  >
                    {query.label ?? query.key}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </StudioInspectorGroup>
        <StudioInspectorGroup title="Events and actions" defaultOpen={false}>
          <StudioModuleEvents
            source={source}
            moduleKey={moduleKey}
            recordKey={recordKey}
            disabled={disabled}
            edit={edit}
          />
          <StudioModuleActions
            source={source}
            moduleKey={moduleKey}
            recordKey={recordKey}
            disabled={disabled}
            edit={edit}
          />
        </StudioInspectorGroup>
        <StudioUsedIn
          source={source}
          target={{ kind: "record_type", moduleKey, recordKey }}
          name={record.name}
        />
        <StudioInspectorGroup title="Details" defaultOpen={false}>
          <dl className="text-xs font-mono">
            <dt>Key</dt>
            <dd>{record.key}</dd>
          </dl>
        </StudioInspectorGroup>
      </div>
      {confirmDialog}
    </div>
  );
}

/**
 * A used module, record type, field or query: read-only here, with where to change it. Whether the
 * application's search finds a used record type is this application's own setting, so it is edited here.
 */
function ReadOnlyInspector({
  module,
  selection,
  organizationId,
  applications,
}: Readonly<{
  module: StudioDataModule;
  selection: StudioDataSelection;
  organizationId: string;
  applications: readonly StudioModuleOwnerApplication[];
}>) {
  const owner = applications.find((application) => application.key === module.ownerApplication);
  const record =
    selection.kind === "record_type" || selection.kind === "field"
      ? module.recordTypes.find((item) => item.key === selection.recordKey)
      : undefined;
  const field =
    selection.kind === "field"
      ? record?.fields.find((item) => item.key === selection.fieldKey)
      : undefined;
  const query =
    selection.kind === "query"
      ? module.queries.find((item) => item.key === selection.queryKey)
      : undefined;
  const queryRecord =
    query === undefined ? record : module.recordTypes.find((item) => item.key === query.recordKey);
  return (
    <div className="space-y-3 text-sm">
      {field !== undefined && (
        <dl className="space-y-1">
          <div>
            <dt className="font-semibold">Field</dt>
            <dd>{field.label}</dd>
          </div>
          <div>
            <dt className="font-semibold">Type</dt>
            <dd>{fieldTypeLabel(field.type)}</dd>
          </div>
          <div>
            <dt className="font-semibold">Required</dt>
            <dd>{field.required ? "Yes" : "No"}</dd>
          </div>
        </dl>
      )}
      {query !== undefined && (
        <>
          <p>
            The query {query.label} lists {queryRecord?.pluralName.toLowerCase() ?? "records"} for
            pages and blocks. Its application exposes it, so this application can read it.
            {query.summary ? " It groups records or adds totals, so it reads as a summary." : ""}
          </p>
          {query.inputs.length === 0 ? null : (
            <dl className="space-y-1">
              <dt className="font-semibold">Inputs</dt>
              {query.inputs.map((input) => (
                <dd key={input.key}>
                  {input.label}{" "}
                  <span className="text-muted-foreground">
                    {queryInputTypeLabel(input.type)}, {input.required ? "required" : "optional"}
                  </span>
                </dd>
              ))}
            </dl>
          )}
        </>
      )}
      {module.ownerApplication === undefined ? null : (
        <p role="note">
          {module.name} is owned by {owner?.name ?? module.ownerApplication}. It is read-only here:
          change it in its owner&apos;s Studio, publish the owner, and then publish this application
          to use the new version.
          {owner === undefined ? null : (
            <>
              {" "}
              <NavigationLink
                className="underline underline-offset-4"
                href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(owner.rootId)}?tab=data&module=${encodeURIComponent(module.key)}`}
              >
                Open {owner.name} in Studio
              </NavigationLink>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** The Data tab's tree of owned and used modules. */
export function StudioDataTreePanel({ model }: Readonly<{ model: StudioDataModel }>) {
  const {
    hidden,
    owned,
    used,
    applications,
    current,
    select,
    setCreating,
    setCreatingModule,
    disabled,
    showingSearch,
    showingQueries,
    showSearch,
    showQueries,
  } = model;
  return (
    <StudioDataPanel
      hidden={hidden}
      owned={owned}
      used={used}
      applications={applications}
      selected={current}
      onSelect={select}
      onCreate={() => setCreating(true)}
      onCreateModule={() => setCreatingModule(true)}
      disabled={disabled}
      searchSelected={showingSearch}
      onSearch={showSearch}
      queriesSelected={showingQueries}
      onQueries={showQueries}
    />
  );
}

/** The Data tab's centre: the query catalogue, the search settings or the schema grid and live records. */
export function StudioDataCentreView({ model }: Readonly<{ model: StudioDataModel }>) {
  const {
    draft,
    applications,
    disabled,
    edit,
    owned,
    used,
    modules,
    current,
    select,
    showingSearch,
    showingQueries,
    section,
    setSection,
    unsaved,
    isOwned,
    module,
    record,
    scope,
    publication,
    targetLabel,
    adding,
    addField,
    setCreating,
    setNewQuery,
  } = model;
  const { source, organizationId, view } = draft;
  return showingQueries ? (
    <StudioQueryCatalogue
      source={source}
      owned={owned}
      used={used}
      applications={applications}
      selected={current}
      disabled={disabled}
      edit={edit}
      onSelect={select}
      onNew={() => setNewQuery(true)}
    />
  ) : showingSearch ? (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-8 py-6">
      <h2 className="text-xl font-semibold tracking-tight">Search settings</h2>
      <StudioSearchOverview
        source={source}
        modules={modules}
        disabled={disabled}
        edit={edit}
        onSelect={(selection) => {
          select(selection);
          setSection("search");
        }}
      />
    </div>
  ) : (
    <StudioDataCentre
      section={section}
      onSectionChange={setSection}
      organizationId={organizationId}
      rootId={draft.state.rootId}
      modules={modules}
      source={source}
      selection={current}
      unsaved={unsaved}
      draftRevision={view.draftRevision}
      previewShape={view.previewShape}
      preview={draft.preview}
      onSelect={select}
      onCreate={() => setCreating(true)}
      onAddField={isOwned && !disabled ? () => addField("text") : undefined}
      relationships={
        !isOwned || module === undefined || record === undefined ? null : (
          <StudioRelationshipsSection
            key={scope}
            source={source}
            moduleKey={module.key}
            recordKey={record.key}
            publication={publication}
            disabled={disabled}
            targetLabel={targetLabel}
            adding={adding?.scope === scope && adding.type === "link"}
            onAdd={() => addField("link")}
            onEdit={(owner, linking, fieldKey) =>
              select({ kind: "field", moduleKey: owner, recordKey: linking, fieldKey })
            }
            edit={edit}
          />
        )
      }
      rules={
        !isOwned || module === undefined || record === undefined ? null : (
          <div className="space-y-10">
            <StudioRecordRules
              key={scope}
              source={source}
              moduleKey={module.key}
              recordKey={record.key}
              disabled={disabled}
              edit={edit}
            />
            <StudioRecordSubscribers
              key={`${scope}-after`}
              source={source}
              moduleKey={module.key}
              recordKey={record.key}
              disabled={disabled}
              edit={edit}
            />
          </div>
        )
      }
      pipelines={
        !isOwned || module === undefined || record === undefined ? null : (
          <StudioRecordPipelines
            key={scope}
            source={source}
            moduleKey={module.key}
            recordKey={record.key}
            publication={publication}
            disabled={disabled}
            edit={edit}
          />
        )
      }
      search={
        module === undefined || record === undefined ? null : (
          <StudioRecordTypeSearch
            key={scope}
            source={source}
            module={module}
            record={record}
            disabled={disabled}
            edit={edit}
          />
        )
      }
    />
  );
}

/** The Data tab's inspector: what creates, renames and deletes the selected item. */
export function StudioDataInspectorView({ model }: Readonly<{ model: StudioDataModel }>) {
  const {
    draft,
    applications,
    disabled,
    edit,
    modules,
    recordTypes,
    current,
    select,
    isOwned,
    module,
    scope,
    settingsContext,
    fieldContext,
    targetLabel,
    adding,
    setAdding,
    addField,
    compileProblem,
    setNewQuery,
  } = model;
  const { source, organizationId, view } = draft;
  const inspectorBody =
    current === null || module === undefined ? (
      <StudioDataEmpty
        title="Nothing selected"
        description="Select a field or record type to change it."
      />
    ) : !isOwned ? (
      <ReadOnlyInspector
        key={JSON.stringify(current)}
        module={module}
        selection={current}
        organizationId={organizationId}
        applications={applications}
      />
    ) : current.kind === "query" ? (
      <StudioQueryEditor
        key={`query:${current.moduleKey}:${current.queryKey}`}
        source={source}
        moduleKey={current.moduleKey}
        queryKey={current.queryKey}
        compiledFields={view.compiledFields}
        draftCompiles={view.failure === null}
        recordTypes={recordTypes}
        disabled={disabled}
        edit={edit}
        onDeleted={(recordKey) =>
          select(
            recordKey === undefined
              ? { kind: "module", moduleKey: current.moduleKey }
              : { kind: "record_type", moduleKey: current.moduleKey, recordKey },
          )
        }
      />
    ) : current.kind === "module" ? (
      <ModuleInspector
        key={`module:${current.moduleKey}`}
        source={source}
        moduleKey={current.moduleKey}
        disabled={disabled}
        edit={edit}
        extensionPointUses={view.published?.extensionPointUses ?? null}
      />
    ) : current.kind === "record_type" ? (
      adding?.scope === scope ? (
        <div className="space-y-4">
          <h3 className="text-base font-semibold">New field</h3>
          <ModuleFieldsEditor
            key={`${scope}:${adding.type}`}
            source={source}
            moduleKey={current.moduleKey}
            recordKey={current.recordKey}
            fieldKey={undefined}
            initialType={adding.type}
            disabled={disabled}
            context={fieldContext}
            edit={edit}
            onSelect={select}
            onCancel={() => setAdding(null)}
            onAdded={(fieldKey) =>
              select({
                kind: "field",
                moduleKey: current.moduleKey,
                recordKey: current.recordKey,
                fieldKey,
              })
            }
          />
        </div>
      ) : (
        <RecordTypeInspector
          key={`record:${current.moduleKey}:${current.recordKey}`}
          source={source}
          moduleKey={current.moduleKey}
          recordKey={current.recordKey}
          disabled={disabled}
          edit={edit}
          onSelect={select}
          settings={settingsContext}
          name={targetLabel}
          onAddLink={() => addField("link")}
          onNewQuery={() => setNewQuery(true)}
        />
      )
    ) : (
      <ModuleFieldsEditor
        key={`field:${current.moduleKey}:${current.recordKey}:${current.fieldKey}`}
        source={source}
        moduleKey={current.moduleKey}
        recordKey={current.recordKey}
        fieldKey={current.fieldKey}
        disabled={disabled}
        context={fieldContext}
        edit={edit}
        onSelect={select}
        onRemoved={() =>
          select({
            kind: "record_type",
            moduleKey: current.moduleKey,
            recordKey: current.recordKey,
          })
        }
      />
    );
  const hasOwnUsedIn = isOwned && (current?.kind === "field" || current?.kind === "record_type");
  const usedIn = hasOwnUsedIn ? null : studioUseTargetOf(current);
  const problemHere =
    compileProblem?.selection != null &&
    current !== null &&
    JSON.stringify(compileProblem.selection) === JSON.stringify(current);
  return (
    <StudioPanelShell title="Inspector">
      {compileProblem === null ? null : (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/50 p-3 text-sm">
          <p className="font-semibold text-destructive">
            {problemHere
              ? "This stops the draft from compiling"
              : "The draft does not compile, so it can't be previewed or published yet"}
          </p>
          <p className="break-words">{compileProblem.message}</p>
          {compileProblem.selection === null || problemHere ? null : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => select(compileProblem.selection)}
            >
              Show me
            </Button>
          )}
        </div>
      )}
      {inspectorBody}
      {usedIn === null ? null : (
        <StudioUsedIn source={source} target={usedIn} name={describeSelection(modules, current)} />
      )}
    </StudioPanelShell>
  );
}

/** The Data tab's dialogs: new module, new record type and new query. */
export function StudioDataDialogs({ model }: Readonly<{ model: StudioDataModel }>) {
  const {
    draft,
    edit,
    current,
    select,
    isOwned,
    publication,
    creatingModule,
    setCreatingModule,
    creating,
    setCreating,
    newQuery,
    setNewQuery,
    fillHome,
  } = model;
  const { source } = draft;
  return (
    <>
      <StudioModuleDialog
        key={creatingModule ? "module-open" : "module-closed"}
        open={creatingModule}
        source={source}
        edit={edit}
        onClose={() => setCreatingModule(false)}
        onCreated={(moduleKey) => select({ kind: "module", moduleKey })}
      />
      <StudioRecordTypeDialog
        key={creating ? "open" : "closed"}
        open={creating}
        source={source}
        initialModuleKey={isOwned ? current?.moduleKey : undefined}
        publication={publication}
        edit={edit}
        onClose={() => setCreating(false)}
        onCreated={(moduleKey, recordKey) => {
          select({ kind: "record_type", moduleKey, recordKey });
          fillHome(`${moduleKey}:${recordKey}`);
        }}
      />
      <StudioQuerySheet
        key={newQuery ? "query-open" : "query-closed"}
        open={newQuery}
        draft={draft}
        doneLabel="Done"
        initialRecordType={
          isOwned && current?.kind === "record_type"
            ? `${current.moduleKey}:${current.recordKey}`
            : undefined
        }
        onClose={() => setNewQuery(false)}
        onDone={(reference) => {
          setNewQuery(false);
          const separator = reference.indexOf(":");
          select({
            kind: "query",
            moduleKey: reference.slice(0, separator),
            queryKey: reference.slice(separator + 1),
          });
        }}
      />
    </>
  );
}
