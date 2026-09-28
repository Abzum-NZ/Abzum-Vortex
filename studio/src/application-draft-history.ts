import {
  applicationSourceDocumentV2Schema,
  storedDefinitionDraftSchema,
  type ApplicationRootId,
  type ApplicationSourceDocumentV2,
  type SaveDefinitionDraftCommand,
  type StoredDefinitionDraft,
} from "@vortex/contracts";

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly unknown[]
    ? { readonly [Index in keyof Value]: DeepReadonly<Value[Index]> }
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type StudioStoredApplicationDraft = Extract<StoredDefinitionDraft, { kind: "application" }>;

export type StudioApplicationDraftSaveCommand = Readonly<
  Pick<SaveDefinitionDraftCommand, "rootId" | "expectedDraftRevision"> & {
    source: ApplicationSourceDocumentV2;
  }
>;

/** The only write boundary used by Studio application draft history. */
export interface StudioApplicationDefinitionDraftPort {
  saveDraft(command: StudioApplicationDraftSaveCommand): Promise<StoredDefinitionDraft>;
}

export type StudioApplicationDraftSaveOutcome =
  | Readonly<{ kind: "saved"; draftRevision: number }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "busy" }>;

export type StudioApplicationDraftHistoryState = Readonly<{
  rootId: ApplicationRootId;
  draftRevision: number;
  source: DeepReadonly<ApplicationSourceDocumentV2>;
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
  edit(source: ApplicationSourceDocumentV2): boolean;
  undo(): boolean;
  redo(): boolean;
  save(): Promise<StudioApplicationDraftSaveOutcome>;
  /** Replaces local history only when given an explicitly loaded draft for this root. */
  reopen(draft: StudioStoredApplicationDraft): boolean;
  subscribe(listener: StudioApplicationDraftHistoryListener): () => void;
}

const snapshotSource = (
  source: ApplicationSourceDocumentV2,
): DeepReadonly<ApplicationSourceDocumentV2> => {
  // Definition persists authored source as JSON, which omits optional undefined properties.
  const snapshot = JSON.parse(JSON.stringify(source)) as ApplicationSourceDocumentV2;
  return deepFreeze(snapshot);
};

const deepFreeze = <Value>(value: Value): DeepReadonly<Value> => {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
};

const mutableSourceCopy = (
  source: DeepReadonly<ApplicationSourceDocumentV2>,
): ApplicationSourceDocumentV2 => structuredClone(source) as ApplicationSourceDocumentV2;

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
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
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
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "DEFINITION_DRAFT_STALE_OR_MISSING") return Object.freeze({ kind: "conflict" });
  if (code === "DEFINITION_CONTEXT_REFUSED") return Object.freeze({ kind: "refused" });
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
  let baseline = snapshotSource(parsedInitialDraft.source);
  let history = [baseline];
  let historyIndex = 0;
  let isSaving = false;
  let lastSaveOutcome: StudioApplicationDraftSaveOutcome | null = null;
  const listeners = new Set<StudioApplicationDraftHistoryListener>();

  const getState = (): StudioApplicationDraftHistoryState =>
    Object.freeze({
      rootId,
      draftRevision,
      source: history[historyIndex]!,
      canUndo: historyIndex > 0,
      canRedo: historyIndex < history.length - 1,
      isDirty: !sameValue(history[historyIndex], baseline),
      isSaving,
      lastSaveOutcome,
    });

  const notify = (): void => {
    const state = getState();
    for (const listener of [...listeners]) listener(state);
  };

  return Object.freeze({
    getState,
    edit: (source: ApplicationSourceDocumentV2): boolean => {
      const parsed = applicationSourceDocumentV2Schema.safeParse(source);
      if (!parsed.success || parsed.data.key !== key) return false;

      const next = snapshotSource(parsed.data);
      if (sameValue(next, history[historyIndex])) return false;

      history = history.slice(0, historyIndex + 1);
      history.push(next);
      historyIndex = history.length - 1;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    undo: (): boolean => {
      if (historyIndex === 0) return false;
      historyIndex -= 1;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    redo: (): boolean => {
      if (historyIndex >= history.length - 1) return false;
      historyIndex += 1;
      lastSaveOutcome = null;
      notify();
      return true;
    },
    save: async (): Promise<StudioApplicationDraftSaveOutcome> => {
      if (isSaving) return Object.freeze({ kind: "busy" });

      const expectedDraftRevision = draftRevision;
      const submittedSource = history[historyIndex]!;
      const command: StudioApplicationDraftSaveCommand = Object.freeze({
        rootId: rootId as SaveDefinitionDraftCommand["rootId"],
        expectedDraftRevision,
        source: mutableSourceCopy(submittedSource),
      });

      isSaving = true;
      lastSaveOutcome = null;
      notify();

      let outcome: StudioApplicationDraftSaveOutcome;
      try {
        const response = await port.saveDraft(command);
        const parsed = storedDefinitionDraftSchema.safeParse(response);
        const returnedSource =
          parsed.success && parsed.data.kind === "application"
            ? snapshotSource(parsed.data.source)
            : undefined;
        if (
          !parsed.success ||
          parsed.data.kind !== "application" ||
          returnedSource === undefined ||
          parsed.data.rootId !== rootId ||
          parsed.data.organizationId !== organizationId ||
          parsed.data.draftRevision <= expectedDraftRevision ||
          parsed.data.key !== key ||
          !sameValue(returnedSource, submittedSource)
        ) {
          outcome = Object.freeze({ kind: "failed" });
        } else {
          draftRevision = parsed.data.draftRevision;
          baseline = returnedSource;
          outcome = Object.freeze({ kind: "saved", draftRevision });
        }
      } catch (error) {
        outcome = saveFailureOutcome(error);
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

      const next = snapshotSource(parsed.source);
      if (parsed.draftRevision === draftRevision && !sameValue(next, baseline)) return false;

      draftRevision = parsed.draftRevision;
      baseline = next;
      history = [next];
      historyIndex = 0;
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
