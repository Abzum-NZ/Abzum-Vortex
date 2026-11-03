import {
  describeFailure,
  applicationSourceDocumentSchema,
  storedDefinitionDraftSchema,
  type ApplicationRootId,
  type ApplicationSourceDocument,
  type SaveDefinitionDraftCommand,
  type StoredDefinitionDraft,
  platformIdSchema,
} from "@vortex/platform/schema";

export type StudioStoredApplicationDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

type StudioApplicationSourceSnapshot = Readonly<ApplicationSourceDocument>;

export type StudioApplicationDraftSaveCommand = Readonly<{
  rootId: SaveDefinitionDraftCommand["rootId"];
  expectedDraftRevision: SaveDefinitionDraftCommand["expectedDraftRevision"];
  source: ApplicationSourceDocument;
}>;

/** The only write boundary used by Studio application draft history. */
export interface StudioApplicationDefinitionDraftPort {
  saveDraft(command: StudioApplicationDraftSaveCommand): Promise<StoredDefinitionDraft>;
}

/** What the person can act on when a save is refused; absent when the writer gave no reason. */
export type StudioApplicationDraftRefusalReason =
  | "permission_missing"
  | "source_invalid"
  | "context_changed"
  | "session_ended"
  | "recent_authentication_required"
  | "identity_retired";
export type StudioApplicationDraftConflictReason =
  "draft_changed" | "key_exists" | "alias_conflict" | "draft_missing";

export type StudioApplicationDraftSaveOutcome =
  | Readonly<{ kind: "saved"; draftRevision: number }>
  | Readonly<{ kind: "conflict"; reason?: StudioApplicationDraftConflictReason }>
  | Readonly<{ kind: "refused"; reason?: StudioApplicationDraftRefusalReason; sentence?: string }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "busy" }>;

export type StudioApplicationDraftHistoryState = Readonly<{
  rootId: ApplicationRootId;
  draftRevision: number;
  source: StudioApplicationSourceSnapshot;
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;
  isSaving: boolean;
  lastSaveOutcome: StudioApplicationDraftSaveOutcome | null;
}>;

export type StudioApplicationDraftHistoryListener = (
  state: StudioApplicationDraftHistoryState,
) => void;

export interface StudioApplicationDraftHistoryController {
  getState(): StudioApplicationDraftHistoryState;
  /**
   * Takes one edit. Consecutive edits with the same `merge` key (typing into one field) replace the
   * newest entry instead of adding one, so Undo restores the value from before the whole run.
   */
  edit(source: ApplicationSourceDocument, merge?: string): boolean;
  undo(): boolean;
  redo(): boolean;
  save(): Promise<StudioApplicationDraftSaveOutcome>;
  /** Replaces local history only when given an explicitly loaded draft for this root. */
  reopen(draft: StudioStoredApplicationDraft): boolean;
  subscribe(listener: StudioApplicationDraftHistoryListener): () => void;
}

/** Every node a snapshot owns: deeply frozen, free of `undefined` properties, shared between entries. */
const owned = new WeakSet<object>();

/** Undo and Redo keep at most this many entries; the oldest are dropped. */
const maximumHistoryEntries = 100;

/**
 * The frozen copy of `value` that shares every node equal to the one at the same place in
 * `previous`, so an edit costs one comparison and the nodes it did not touch keep their identity
 * (memos keyed on a page or slot object keep hitting). Nodes this module already froze are reused
 * without a look. Like the JSON the draft is stored as, an `undefined` property is left out.
 */
const share = (value: unknown, previous: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (owned.has(value)) return value;
  if (Array.isArray(value)) {
    const before = Array.isArray(previous) ? previous : undefined;
    const items = value.map((item, index) => share(item, before?.[index]));
    if (
      before !== undefined &&
      before.length === items.length &&
      items.every((item, index) => item === before[index])
    )
      return before;
    owned.add(items);
    return Object.freeze(items);
  }
  const before =
    previous !== null && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : undefined;
  const entries = Object.entries(value).filter(([, nested]) => nested !== undefined);
  const copy: Record<string, unknown> = {};
  let same = before !== undefined && Object.keys(before).length === entries.length;
  for (const [key, nested] of entries) {
    const shared = share(nested, before?.[key]);
    copy[key] = shared;
    if (same && !(before !== undefined && Object.hasOwn(before, key) && before[key] === shared))
      same = false;
  }
  if (same && before !== undefined) return before;
  owned.add(copy);
  return Object.freeze(copy);
};

const snapshotSource = (
  source: ApplicationSourceDocument,
  previous?: StudioApplicationSourceSnapshot,
): StudioApplicationSourceSnapshot => share(source, previous) as StudioApplicationSourceSnapshot;

/** Whether `source` is a snapshot a history holds (frozen, shared) rather than a copy someone made. */
export const isStudioDraftSnapshot = (source: unknown): boolean =>
  source !== null && typeof source === "object" && owned.has(source);

/**
 * The full parse the platform will run, taken once per save: a mutable copy in the shape the
 * source contract defines. Edits are typed commands' output and are not parsed one by one.
 */
const mutableSourceCopy = (source: StudioApplicationSourceSnapshot): ApplicationSourceDocument => {
  const cloned: unknown = structuredClone(source);
  return applicationSourceDocumentSchema.parse(cloned);
};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;

  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
};

const applicationDraft = (draft: unknown): StudioStoredApplicationDraft | undefined => {
  const parsed = storedDefinitionDraftSchema.safeParse(draft);
  if (
    !parsed.success ||
    parsed.data.kind !== "application" ||
    parsed.data.key !== parsed.data.source.key
  )
    return undefined;
  return parsed.data;
};

const saveFailureOutcome = (error: unknown): StudioApplicationDraftSaveOutcome => {
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const reason =
    error !== null && typeof error === "object" && "reason" in error ? error.reason : undefined;
  if (code === "DEFINITION_DRAFT_STALE_OR_MISSING")
    return Object.freeze({
      kind: "conflict",
      ...(reason === "draft_changed" ||
      reason === "key_exists" ||
      reason === "alias_conflict" ||
      reason === "draft_missing"
        ? { reason }
        : {}),
    });
  if (code === "DEFINITION_CONTEXT_REFUSED")
    return Object.freeze({
      kind: "refused",
      ...(reason === "permission_missing" ||
      reason === "source_invalid" ||
      reason === "context_changed" ||
      reason === "session_ended" ||
      reason === "recent_authentication_required" ||
      reason === "identity_retired"
        ? { reason }
        : {}),
      ...(reason === "identity_retired" &&
      error !== null &&
      typeof error === "object" &&
      "sentence" in error &&
      typeof error.sentence === "string"
        ? { sentence: error.sentence }
        : {}),
    });
  return Object.freeze({ kind: "failed" });
};

/** Creates one in-memory history for an Application draft and its Definition revision. */
export const createStudioApplicationDraftHistoryController = (
  initialDraft: StudioStoredApplicationDraft,
  port: StudioApplicationDefinitionDraftPort,
): StudioApplicationDraftHistoryController => {
  const parsedInitialDraft = applicationDraft(initialDraft);
  if (parsedInitialDraft === undefined)
    throw new TypeError("Studio draft history requires an application Definition draft");

  const rootId = parsedInitialDraft.rootId;
  const organizationId = parsedInitialDraft.organizationId;
  const key = parsedInitialDraft.key;
  let draftRevision = parsedInitialDraft.draftRevision;
  // The saved source, and the revision number of the history entry that holds it: the draft is
  // dirty exactly when the entry on screen is not that one, so no state is compared in depth.
  let baseline = snapshotSource(parsedInitialDraft.source);
  let revisions = 0;
  let baselineRevision = revisions;
  let history: { source: StudioApplicationSourceSnapshot; revision: number }[] = [
    { source: baseline, revision: baselineRevision },
  ];
  let historyIndex = 0;
  let isSaving = false;
  // The merge key of the newest entry, while the next edit may still extend it.
  let mergeKey: string | undefined;
  let lastSaveOutcome: StudioApplicationDraftSaveOutcome | null = null;
  const listeners = new Set<StudioApplicationDraftHistoryListener>();

  const getState = (): StudioApplicationDraftHistoryState =>
    Object.freeze({
      rootId,
      draftRevision,
      source: history[historyIndex]!.source,
      canUndo: historyIndex > 0,
      canRedo: historyIndex < history.length - 1,
      isDirty: history[historyIndex]!.revision !== baselineRevision,
      isSaving,
      lastSaveOutcome,
    });

  const notify = (): void => {
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // A subscriber must not interrupt a state transition or strand an in-flight save.
      }
    }
  };

  return Object.freeze({
    getState,
    edit: (source: ApplicationSourceDocument, merge?: string): boolean => {
      // A typed command's output is taken as it is: the one comparison below shares every node the
      // edit did not touch, and the full parse is made when the draft is saved.
      if (source.key !== key) return false;

      const current = history[historyIndex]!;
      const next = snapshotSource(source, current.source);
      if (next === current.source) return false;

      const extendsNewest =
        merge !== undefined &&
        merge === mergeKey &&
        historyIndex > 0 &&
        historyIndex === history.length - 1;
      history = history.slice(0, extendsNewest ? historyIndex : historyIndex + 1);
      history.push({ source: next, revision: ++revisions });
      if (history.length > maximumHistoryEntries)
        history = history.slice(history.length - maximumHistoryEntries);
      historyIndex = history.length - 1;
      mergeKey = merge;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    undo: (): boolean => {
      if (historyIndex === 0) return false;
      historyIndex -= 1;
      mergeKey = undefined;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    redo: (): boolean => {
      if (historyIndex >= history.length - 1) return false;
      historyIndex += 1;
      mergeKey = undefined;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    save: async (): Promise<StudioApplicationDraftSaveOutcome> => {
      if (isSaving) return Object.freeze({ kind: "busy" });

      const expectedDraftRevision = draftRevision;
      const submitted = history[historyIndex]!;

      isSaving = true;
      lastSaveOutcome = null;
      notify();

      let outcome: StudioApplicationDraftSaveOutcome;
      try {
        let command: StudioApplicationDraftSaveCommand;
        try {
          command = Object.freeze({
            rootId: platformIdSchema.parse(rootId),
            expectedDraftRevision,
            source: mutableSourceCopy(submitted.source),
          });
        } catch (error) {
          console.error(
            `[studio] the draft does not match the application source contract: ${describeFailure(error)}`,
          );
          throw Object.assign(new Error("STUDIO_DRAFT_SOURCE_INVALID"), {
            code: "DEFINITION_CONTEXT_REFUSED",
            reason: "source_invalid",
          });
        }
        const response = await port.saveDraft(command);
        const parsed = storedDefinitionDraftSchema.safeParse(response);
        if (!parsed.success)
          console.error(
            `[studio] application draft save response invalid: ${describeFailure(parsed.error)}`,
          );
        if (
          !parsed.success ||
          parsed.data.kind !== "application" ||
          parsed.data.rootId !== rootId ||
          parsed.data.organizationId !== organizationId ||
          parsed.data.draftRevision !== expectedDraftRevision + 1 ||
          parsed.data.key !== key ||
          !sameValue(parsed.data.source, command.source)
        ) {
          if (parsed.success)
            console.error(
              "[studio] application draft save response mismatch: STUDIO_DRAFT_SAVE_RESPONSE_MISMATCH",
            );
          outcome = Object.freeze({ kind: "failed" });
        } else {
          draftRevision = parsed.data.draftRevision;
          baseline = snapshotSource(parsed.data.source, submitted.source);
          baselineRevision = submitted.revision;
          outcome = Object.freeze({ kind: "saved", draftRevision });
        }
      } catch (error) {
        outcome = saveFailureOutcome(error);
        if (outcome.kind === "failed")
          console.error(`[studio] application draft save failed: ${describeFailure(error)}`);
        else
          console.info(
            `[studio] application draft save ${outcome.kind}: ${describeFailure(error)}`,
          );
      }

      isSaving = false;
      lastSaveOutcome = outcome;
      notify();
      return outcome;
    },
    reopen: (draft: StudioStoredApplicationDraft): boolean => {
      if (isSaving) return false;
      const parsed = applicationDraft(draft);
      if (
        parsed === undefined ||
        parsed.rootId !== rootId ||
        parsed.organizationId !== organizationId ||
        parsed.key !== key ||
        parsed.draftRevision < draftRevision
      )
        return false;

      const next = snapshotSource(parsed.source, baseline);
      if (parsed.draftRevision === draftRevision && next !== baseline) return false;

      draftRevision = parsed.draftRevision;
      baseline = next;
      baselineRevision = ++revisions;
      history = [{ source: next, revision: baselineRevision }];
      historyIndex = 0;
      mergeKey = undefined;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    subscribe: (listener: StudioApplicationDraftHistoryListener): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
};
