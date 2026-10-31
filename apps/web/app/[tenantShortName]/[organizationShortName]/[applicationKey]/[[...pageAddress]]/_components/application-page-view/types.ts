import type { ControlSemanticEvent, FormBlockRuntime, PageMessageDraft } from "@vortex/ui";
export type { PageMessageDraft } from "@vortex/ui";
import type {
  FlowFieldCorrection,
  JsonValue,
  RecordsSelectionInput,
  RecordsTableBatchEditProblem,
} from "@vortex/platform/schema";
import type { ApplicationPageModel, PageDataState } from "../../../../../../_lib/application-page";

export type EditFormBaseline = ApplicationPageModel["editFormBaselines"][string];

/** Explicitly selected drawn records, held at the revision of the selection gesture. */
export type SelectedRecords = readonly Extract<
  RecordsSelectionInput,
  { kind: "ids" }
>["items"][number][];
export type PageSelection = Readonly<Record<string, SelectedRecords>>;

export type TableContinuationTarget = Readonly<{
  placementId: string;
  fromAddress?: true;
  request: Readonly<{
    page: number;
    pageDirection: "forward" | "backward";
    continuationToken?: string;
  }>;
}>;

/**
 * The full component flow binding the browser runtime expects. A {@link PlacementFlowBinding} carries
 * only the identities the page needs; every event reaches the server by binding id and flow id, and
 * the server fills the flow's inputs from the installed binding, so its input map is not required here.
 */
export type ComponentFlowBinding = Parameters<FormBlockRuntime["submit"]>[0];

/**
 * A placement's event callbacks. Display events and control events (the form's ready, reset and
 * submit) are both delivered through the one runtime-inputs map, so the key is the event name.
 */
type FormResetEvent = Extract<ControlSemanticEvent, { event: "form_reset" }>;

export type EventHandlers = Record<string, (event: never) => void> & {
  form_reset?: (event: FormResetEvent) => void | Promise<void>;
};

/**
 * How a gesture's own control tells the person its outcome. A transient control (a grid row
 * action's toast) is gone in seconds, so a problem also stays on the page; an in-place control (a
 * cell editor) keeps its own refusal visible. Either way, a way forward (a link) stays on the page.
 */
export type ControlReport = "transient" | "in_place";

/**
 * What one dispatched gesture came to: the sentence the person is told, whether the server
 * confirmed the write, and whether the record changed under the person. A gesture that is shown on
 * its own control (a grid cell) is reported only here and not in the page notice.
 */
export type DispatchOutcome = Readonly<{
  notice: PageMessageDraft | undefined;
  confirmed: boolean;
  /** The run ended well, whether or not it committed a change of its own (it may only have started background work). */
  completed: boolean;
  changed: boolean;
  corrections?: readonly FlowFieldCorrection[];
  /** A pasted, filled or undone batch that stopped before any cell was written: each cell that stopped it. */
  cellProblems?: readonly RecordsTableBatchEditProblem[];
  /** What a batch flow reports it applied: each record's new revision and the values it replaced. */
  applied?: JsonValue;
  /** The run reference a flow that started background work reports. */
  run?: string;
}>;

export type SubmittedForm = Readonly<{
  formId: string;
  values: Readonly<Record<string, unknown>>;
  /** A guided step: its answers are saved when the flow answers, though no record is committed. */
  draftSaved?: true;
}>;

export type RefreshedPlacementData = Readonly<{
  navigationKey: string;
  data: Readonly<Record<string, PageDataState>>;
  editFormBaselines: Readonly<Record<string, EditFormBaseline | null>>;
  subject?: ApplicationPageModel["subject"] | null;
  /** The page's own placements as re-projected by the server after an action's write. */
  content?: Readonly<Record<string, unknown>>;
}>;
