import type {
  ControlSemanticEvent,
  FormBlockRuntime,
} from "@vortex/ui";
import type { ReferenceChoiceSelectionEvidenceMap } from "@vortex/platform/schema";
import type {
  ApplicationPageModel,
  PageDataState,
} from "../../../../../../_lib/application-page";
import type {
  GuidedFormAbandonRequest,
  GuidedFormConfirmRequest,
  GuidedFormConfirmResult,
  GuidedFormStepActionResult,
  GuidedFormStepRequest,
} from "@vortex/platform/server";

export type EditFormBaseline = ApplicationPageModel["editFormBaselines"][string];

export type TableContinuationTarget = Readonly<{
  placementId: string;
  fromAddress?: true;
  request: Readonly<{ page: number; pageDirection: "forward" | "backward"; continuationToken?: string }>;
}>;

export type GuidedFormActions = Readonly<{
  advance: (request: GuidedFormStepRequest) => Promise<GuidedFormStepActionResult>;
  confirm: (request: GuidedFormConfirmRequest) => Promise<GuidedFormConfirmResult>;
  abandon: (
    request: GuidedFormAbandonRequest,
  ) => Promise<Readonly<{ kind: "abandoned" | "conflict" | "unavailable" | "temporarily_unavailable" }>>;
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

export type Notice = Readonly<{ tone: "info" | "problem"; text: string; recovery?: "sign_in" }>;

export type SubmittedForm = Readonly<{
  formId: string;
  values: Readonly<Record<string, unknown>>;
  choiceEvidence?: ReferenceChoiceSelectionEvidenceMap;
}>;

export type RefreshedPlacementData = Readonly<{
  navigationKey: string;
  data: Readonly<Record<string, PageDataState>>;
  editFormBaselines: Readonly<Record<string, EditFormBaseline | null>>;
  subject?: ApplicationPageModel["subject"] | null;
  /** The page's own placements as re-projected by the server after an action's write. */
  content?: Readonly<Record<string, unknown>>;
}>;
