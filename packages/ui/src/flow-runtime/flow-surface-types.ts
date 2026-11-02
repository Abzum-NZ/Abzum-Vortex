import type { ReactNode } from "react";
import type { LinkNavigationEnvironment } from "../launcher/link-navigation";
import type {
  FlowBackAnswer,
  FlowConfirmAnswer,
  FlowConfirmIntent,
  FlowFormAnswer,
  FlowFormIntent,
  FlowInlineFormIntent,
  FlowIntentHost,
  FlowMessageAction,
  FlowMessageIntent,
  FlowVerification,
  FlowVerifyIntent,
} from "./intents";
import type { FlowRuntimeState } from "./flow-runtime";

/** What a surface answers: the person's answer, or that they went back a step. */
export type Answered<Answer> = Answer | FlowBackAnswer;

/** The run chain a dialog belongs to: guided steps wrap only the dialogs of the chain that opened them. */
type Chained = Readonly<{ chain: number }>;

export type Surface =
  | (Chained &
      Readonly<{ id: number; kind: "message"; message: FlowMessageIntent; settle: () => void }>)
  | (Chained &
      Readonly<{
        id: number;
        kind: "confirm";
        confirmation: FlowConfirmIntent;
        settle: (answer: Answered<FlowConfirmAnswer>) => void;
      }>)
  | (Chained &
      Readonly<{
        id: number;
        kind: "form";
        form: FlowFormIntent | FlowInlineFormIntent;
        settle: (answer: Answered<FlowFormAnswer>) => void;
      }>)
  | (Chained &
      Readonly<{
        id: number;
        kind: "verify";
        verification: FlowVerifyIntent;
        settle: (answer: Answered<FlowConfirmAnswer>) => void;
      }>);

/** The guided steps a flow has open: where the person is in them and what the flow is doing. */
export type Wizard = Readonly<{
  /** The run chain that opened the steps. */
  chain: number;
  title: string;
  steps: readonly string[];
  step: string;
  working: string | undefined;
}>;

/**
 * What the shell supplies to prove who the person is inside a flow. The platform decides, where
 * the protected step runs, whether the proof counts; this only collects it.
 */
export type FlowVerificationOptions = Readonly<{
  /** Whether the person has already given this proof recently enough that the step can be skipped. */
  status: (requires: FlowVerification, signal?: AbortSignal) => Promise<"satisfied" | "needed">;
  /** The challenge drawn inside the step; `verified` moves the flow on. */
  render: (requires: FlowVerification, controls: Readonly<{ verified: () => void }>) => ReactNode;
}>;

export type FlowIntentHostOptions = Readonly<{
  /**
   * Renders the form a Show form task names. Forms are Application data the shell resolves, so the
   * shell supplies its title and body and calls `submit` with the typed values or `cancel` when dismissed.
   */
  renderForm: (
    form: FlowFormIntent,
    controls: Readonly<{
      submit: (values: Extract<FlowFormAnswer, { kind: "submit" }>["values"]) => void;
      cancel: () => void;
    }>,
  ) => Readonly<{ title: string; body: ReactNode }>;
  navigation: LinkNavigationEnvironment;
  state: FlowRuntimeState;
  /**
   * Starts the flow a message action names. Returning its run keeps the guided steps open until
   * that run ends, so a flow can hand over to the next one inside the same dialog.
   */
  onMessageAction: (
    message: FlowMessageIntent,
    action: FlowMessageAction,
  ) => void | Promise<unknown>;
  /** Whether this person is offered an action; a shell that knows one is not theirs leaves it out. */
  actionOffered?: (action: FlowMessageAction) => boolean;
  /** Proves who the person is for a Verify step. */
  verification?: FlowVerificationOptions;
  /** What the button that leaves the guided steps is called ("Back to the editor"). */
  guidedLeaveLabel?: string;
  refresh?: FlowIntentHost["refresh"];
  setPanel?: FlowIntentHost["setPanel"];
  setFilter?: FlowIntentHost["setFilter"];
}>;
