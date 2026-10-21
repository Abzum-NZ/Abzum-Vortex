"use client";
import Link from "next/link";
import { useState } from "react";
import { StudioInspectorGroup, type StudioDataSelection } from "@vortex/ui/studio";
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
import { Icon } from "@vortex/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import { Button } from "@vortex/ui/components/button";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { StudioPanelShell } from "./studio-frame";
import { StudioField } from "./studio-field";
import { StudioDataPanel } from "./studio-data-panel";
import { StudioDataCentre, StudioDataEmpty } from "./studio-data-centre";
import { StudioRecordTypeDialog } from "./studio-record-type-dialog";
import { StudioModuleDialog } from "./studio-module-dialog";
import { StudioReferencesAlert, StudioUsedIn } from "./studio-used-in";
import { studioUseTargetOf } from "../_lib/studio-places";
import { StudioNewQueryForm, StudioQueryEditor, queryInputTypeLabel } from "./studio-query-editor";
import { StudioQueryCatalogue } from "./studio-query-catalogue";
import { StudioQuerySheet } from "./studio-query-sheet";
import { StudioRecordTypeSearch, StudioSearchOverview } from "./studio-search-settings";
import { StudioRelationshipsSection } from "./studio-relationships-section";
import { StudioModuleEvents } from "./studio-module-events";
import { StudioModuleActions } from "./studio-module-actions";
import { StudioModuleExtensionPoints } from "./studio-module-extension-points";
import { StudioRecordPipelines } from "./studio-record-pipelines";
import { StudioRecordRules } from "./studio-record-rules";
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
}>) {
  const [confirm, confirmDialog] = useConfirm();
  // A new field, a new relationship (a new link field) or a new query is being added.
  const [adding, setAdding] = useState(false);
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
  return (
    <div className="space-y-4">
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
          hint="Names records in pickers and headings. Changing a published title requires a major version."
        >
          {(control) => (
            <NativeSelect
              {...control}
              className="w-full"
              value={record.title_field}
              disabled={disabled}
              onChange={(event) => {
                const problem = studioEditProblem(
                  edit((current) =>
                    setInlineRecordTitleField(current, {
                      moduleKey,
                      recordKey,
                      fieldKey: event.target.value,
                    }),
                  ),
                );
                setIssues(problem === undefined ? [] : [problem]);
              }}
            >
              {record.fields.filter(recordTitleFieldEligible).map((field) => (
                <NativeSelectOption key={field.key} value={field.key}>
                  {field.label} ({fieldTypeLabel(field.type)})
                </NativeSelectOption>
              ))}
            </NativeSelect>
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
      <StudioInspectorGroup title="Queries" defaultOpen={false}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          Add a query
        </Button>
        {adding && (
          <section
            className="space-y-2 border-t border-border pt-3"
            aria-label={`New query of ${record.name}`}
          >
            <h3 className="text-sm font-semibold">New query of {record.plural_name}</h3>
            <StudioNewQueryForm
              source={source}
              moduleKey={moduleKey}
              recordKey={recordKey}
              disabled={disabled}
              edit={edit}
              onCreated={(queryKey) => onSelect({ kind: "query", moduleKey, queryKey })}
            />
          </section>
        )}
      </StudioInspectorGroup>
      <StudioInspectorGroup title="Behaviour" defaultOpen={false}>
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
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" />}>
          <Icon name="more-horizontal" />
          More
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            variant="destructive"
            disabled={disabled}
            onClick={() => {
              void remove();
            }}
          >
            Delete record type
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <section className="space-y-2 border-t border-border pt-3" aria-label="Delete">
        <StudioReferencesAlert
          key={refusals}
          name={record.name}
          action="deleted"
          references={references}
        />
        <Problems issues={issues} />
      </section>
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
              <Link
                className="underline underline-offset-4"
                href={`/studio/${encodeURIComponent(organizationId)}/${encodeURIComponent(owner.rootId)}?tab=data&module=${encodeURIComponent(module.key)}`}
              >
                Open {owner.name} in Studio
              </Link>
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
          <StudioRecordRules
            key={scope}
            source={source}
            moduleKey={module.key}
            recordKey={record.key}
            disabled={disabled}
            edit={edit}
          />
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
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">New field</h3>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(null)}>
              Cancel
            </Button>
          </div>
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
        onRemoved={() =>
          select({
            kind: "record_type",
            moduleKey: current.moduleKey,
            recordKey: current.recordKey,
          })
        }
      />
    );
  const hasOwnUsedIn =
    isOwned &&
    (current?.kind === "field" || (current?.kind === "record_type" && adding?.scope !== scope));
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
        onCreated={(moduleKey, recordKey) => select({ kind: "record_type", moduleKey, recordKey })}
      />
      <StudioQuerySheet
        key={newQuery ? "query-open" : "query-closed"}
        open={newQuery}
        draft={draft}
        doneLabel="Done"
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
