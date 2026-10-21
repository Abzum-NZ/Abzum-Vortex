"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isStudioDataSelection,
  type StudioCompositionContext,
  type StudioDataSelection,
  type StudioRecordReader,
} from "@vortex/ui/studio";
import {
  peopleDirectory as directory,
  type ApplicationSourceDocument,
  type RecordOwnershipMode,
  type RecordSettingsContext,
} from "@vortex/platform/schema";
import { useIntentPreload } from "../_lib/use-intent-preload";
import { deferredStudioPart } from "./studio-deferred-part";
import { useStudioTabVisited } from "./studio-frame";
import type { StudioDraft } from "./use-studio-draft";
import {
  studioFieldPublication,
  type ModuleFieldEditorContext,
  type StudioLinkTarget,
  type StudioModuleOwnerApplication,
} from "./module-fields-editor";
import {
  ownedDataModules,
  studioDataEdit,
  type StudioDataEdit,
  type StudioDataModule,
} from "../_lib/studio-data-model";
import { describeStudioCompileFailure } from "../_lib/studio-compile-failure";
import type { StudioDataModel } from "./studio-data-view";

type Source = ApplicationSourceDocument;

// The tab's panel, centre, inspector and dialogs load the first time the Data tab is shown; this
// hook keeps the state the workspace needs before then (the selection, the draft's edit path).
const StudioDataTreePanel = deferredStudioPart(
  () => import("./studio-data-view").then((module) => module.StudioDataTreePanel),
  "data panel",
);
const StudioDataCentreView = deferredStudioPart(
  () => import("./studio-data-view").then((module) => module.StudioDataCentreView),
  "data editor",
);
const StudioDataInspectorView = deferredStudioPart(
  () => import("./studio-data-view").then((module) => module.StudioDataInspectorView),
  "data inspector",
);
const StudioDataDialogs = deferredStudioPart(
  () => import("./studio-data-view").then((module) => module.StudioDataDialogs),
  "data dialogs",
);
const preloadDataView = () => import("./studio-data-view");

const peopleDirectoryLabel = "People";

export const recordIn = (source: Source, moduleKey: string, recordKey: string) =>
  source.body.modules
    .find((item) => item.key === moduleKey)
    ?.record_types.find((item) => item.key === recordKey);

const selectionExists = (
  modules: readonly StudioDataModule[],
  selection: StudioDataSelection,
): boolean => {
  const module = modules.find((item) => item.key === selection.moduleKey);
  if (module === undefined) return false;
  if (selection.kind === "module") return true;
  if (selection.kind === "query")
    return module.queries.some((query) => query.key === selection.queryKey);
  const record = module.recordTypes.find((item) => item.key === selection.recordKey);
  return (
    record !== undefined &&
    (selection.kind === "record_type" ||
      record.fields.some((field) => field.key === selection.fieldKey))
  );
};

export const describeSelection = (
  modules: readonly StudioDataModule[],
  selection: StudioDataSelection | null,
): string => {
  const module =
    selection === null ? undefined : modules.find((item) => item.key === selection.moduleKey);
  if (selection === null || module === undefined) return "Data";
  if (selection.kind === "module") return module.name;
  if (selection.kind === "query")
    return module.queries.find((query) => query.key === selection.queryKey)?.label ?? "Query";
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
export function useStudioDataTab({
  draft,
  applications,
  initialModule,
  hidden,
  compositionContext,
  readRecords,
}: Readonly<{
  draft: StudioDraft;
  applications: readonly StudioModuleOwnerApplication[];
  /** The module the Studio address opens first, if any. */
  initialModule: string | null;
  hidden: boolean;
  /** The composition context the "Also show it on" placements are made through. */
  compositionContext: StudioCompositionContext;
  /** Reads records of the builder's preview of the saved draft, for a link field's default. */
  readRecords: StudioRecordReader | null;
}>) {
  useIntentPreload(preloadDataView, "#studio-rail-data");
  const visited = useStudioTabVisited(!hidden);
  const { source, view } = draft;
  const disabled = draft.locked;
  const [searchOpen, setSearchOpen] = useState(false);
  // The query catalogue stays in the centre while one of its queries is open in the inspector.
  const [queriesOpen, setQueriesOpen] = useState(false);
  const [newQuery, setNewQuery] = useState(false);
  const [creatingModule, setCreatingModule] = useState(false);
  const [section, setSection] = useState("fields");
  const [adding, setAdding] = useState<Readonly<{ scope: string; type: "text" | "link" }> | null>(
    null,
  );
  const select = (next: StudioDataSelection | null) => {
    setSearchOpen(false);
    if (next?.kind !== "query") setQueriesOpen(false);
    setSection("fields");
    setAdding(null);
    draft.select(next);
  };
  // A Studio address that names a module opens it once.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || initialModule === null) return;
    opened.current = true;
    draft.select({ kind: "module", moduleKey: initialModule });
  }, [initialModule, draft]);
  /** The Data tab's one edit path: a platform command over the current draft source, as one edit of the draft. */
  const edit: StudioDataEdit = studioDataEdit(draft);
  const saved = useMemo(() => draft.parsed(draft.saved.source), [draft, draft.saved.source]);
  // The compile refusal of the revision the view was compiled from, while no newer edit is on its way.
  const { parsed, updatingCanvas } = draft;
  const compileProblem = useMemo(
    () =>
      view.failure === null || updatingCanvas
        ? null
        : describeStudioCompileFailure(view.failure, parsed(view.source)),
    [parsed, updatingCanvas, view.failure, view.source],
  );
  const used = view.usedModules;
  const owned = useMemo(() => ownedDataModules(source), [source]);
  const publication = useMemo(
    () => studioFieldPublication(view.published, saved),
    [view.published, saved],
  );
  // A link may point at a record type of a module the application uses, or at a person of the
  // people directory, which the link then adds to the modules it uses.
  const usedRecordTypes = useMemo((): readonly StudioLinkTarget[] => {
    const targets: StudioLinkTarget[] = (used ?? []).flatMap((module) =>
      module.recordTypes
        .filter((record) => record.linkable)
        .map((record) => {
          const key = `${module.key}:${record.key}`;
          return {
            key,
            label:
              key === directory.recordType
                ? peopleDirectoryLabel
                : `${record.name} (${module.name})`,
            titleLabel: record.fields.find((field) => field.key === record.titleFieldKey)?.label,
          };
        }),
    );
    if (
      view.peopleDirectory !== null &&
      !targets.some((target) => target.key === directory.recordType)
    )
      targets.push({
        key: directory.recordType,
        label: peopleDirectoryLabel,
        titleLabel: view.peopleDirectory.titleLabel,
      });
    return targets;
  }, [used, view.peopleDirectory]);
  const settingsContext = useMemo((): RecordSettingsContext => {
    const ownership = new Map<string, RecordOwnershipMode>(
      (used ?? []).flatMap((module) =>
        module.recordTypes.map((record) => [`${module.key}:${record.key}`, record.ownershipMode]),
      ),
    );
    return { publication, usedOwnership: (qualified) => ownership.get(qualified) };
  }, [publication, used]);
  const fieldContext: ModuleFieldEditorContext = {
    publication,
    composition: compositionContext,
    usedRecordTypes,
    peopleDirectory: view.peopleDirectory,
    readRecords,
    compiledFields: view.compiledFields,
  };
  const targetLabel = (key: string): string => {
    const [owner, local] = key.split(":");
    return (
      recordIn(source, owner ?? "", local ?? "")?.name ??
      usedRecordTypes.find((target) => target.key === key)?.label ??
      (key === directory.recordType ? peopleDirectoryLabel : key)
    );
  };
  const savedOwned = useMemo(() => ownedDataModules(saved), [saved]);
  const modules = useMemo(() => [...owned, ...(used ?? [])], [owned, used]);
  const [creating, setCreating] = useState(false);
  const selection = isStudioDataSelection(draft.selected) ? draft.selected : null;
  const current = selection !== null && selectionExists(modules, selection) ? selection : null;
  // Reference links select through the workspace, outside this tab's navigator.
  const showingSearch = searchOpen && current === null;
  const showingQueries = queriesOpen && (current === null || current.kind === "query");

  const recordTypes = useMemo(
    () => [
      ...owned.flatMap((item) =>
        item.recordTypes.map((record) => ({
          key: `${item.key}:${record.key}`,
          label: record.name,
        })),
      ),
      ...usedRecordTypes,
    ],
    [owned, usedRecordTypes],
  );
  const isOwned = current !== null && owned.some((module) => module.key === current.moduleKey);
  const unsaved =
    current !== null &&
    isOwned &&
    !selectionExists(
      savedOwned,
      current.kind === "field"
        ? { kind: "record_type", moduleKey: current.moduleKey, recordKey: current.recordKey }
        : current,
    );
  const module =
    current === null ? undefined : modules.find((item) => item.key === current.moduleKey);

  const query =
    current?.kind === "query"
      ? module?.queries.find((item) => item.key === current.queryKey)
      : undefined;
  const recordKey =
    current?.kind === "field" || current?.kind === "record_type"
      ? current.recordKey
      : query?.recordKey;
  const record = module?.recordTypes.find((item) => item.key === recordKey);
  const scope = module === undefined || record === undefined ? "" : `${module.key}:${record.key}`;
  const addField = (type: "text" | "link") => {
    if (module === undefined || record === undefined) return;
    draft.select({ kind: "record_type", moduleKey: module.key, recordKey: record.key });
    setAdding({ scope, type });
  };
  const model: StudioDataModel = {
    draft,
    applications,
    hidden,
    disabled,
    edit,
    owned,
    used,
    modules,
    recordTypes,
    current,
    select,
    showingSearch,
    showingQueries,
    showSearch: () => {
      setSearchOpen(true);
      setQueriesOpen(false);
      setAdding(null);
      draft.select(null);
    },
    showQueries: () => {
      setQueriesOpen(true);
      setSearchOpen(false);
      setAdding(null);
      draft.select(null);
    },
    section,
    setSection,
    unsaved,
    isOwned,
    module,
    record,
    scope,
    publication,
    fieldContext,
    settingsContext,
    targetLabel,
    adding,
    setAdding,
    addField,
    compileProblem,
    creatingModule,
    setCreatingModule,
    creating,
    setCreating,
    newQuery,
    setNewQuery,
  };
  return {
    panel: visited ? <StudioDataTreePanel model={model} /> : null,
    centre: visited ? <StudioDataCentreView model={model} /> : null,
    inspector: visited ? <StudioDataInspectorView model={model} /> : null,
    dialog: visited ? <StudioDataDialogs model={model} /> : null,
    title:
      showingQueries && current === null
        ? "Queries"
        : showingSearch
          ? "Search settings"
          : describeSelection(modules, current),
  };
}
