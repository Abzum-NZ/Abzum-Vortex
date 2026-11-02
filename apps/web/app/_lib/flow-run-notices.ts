import { flowRefusalFeedbackSentences, type FlowRefusalFeedback } from "@vortex/platform/schema";
import type { FormFlowFeedback, PageMessageDraft } from "@vortex/ui";

/**
 * The fixed sentence for each safe flow outcome. The endpoint returns the outcome and, for a rule
 * refusal, the rule's own authored message (shown instead of the sentence here); never a service message.
 */
export const outcomeNotices: Readonly<Record<string, PageMessageDraft>> = {
  completed: { target: "toast", severity: "success", text: "Done." },
  committed: { target: "toast", severity: "success", text: "Saved.", dismissAfterMs: 5_000 },
  refused: {
    target: "banner",
    severity: "error",
    text: "This was not allowed. Check your access and the values, or ask your administrator.",
  },
  conflict: {
    target: "banner",
    severity: "error",
    text: "This changed since you opened it. Refresh and review it.",
  },
  validation: {
    target: "banner",
    severity: "error",
    text: "Some values were not accepted. Check each field and try again.",
  },
  partial: {
    target: "banner",
    severity: "error",
    text: "Only part of this was saved. Refresh and review what changed.",
  },
  uncertain: {
    target: "banner",
    severity: "error",
    text: "The result is not certain yet. Refresh before trying again.",
  },
  background_pending: {
    target: "toast",
    severity: "success",
    text: "Started. It will finish in the background.",
  },
  failed: { target: "banner", severity: "error", text: "That did not work. Try again." },
};

/** A board move the person backed out of at its form: nothing was saved. */
export const cancelledMoveNotice: PageMessageDraft = {
  target: "toast",
  severity: "success",
  text: "Move cancelled.",
};

export const unavailableNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "That is not available right now.",
};

/** The home page of an installed application that the person may not open yet. */
export const cannotOpenApplicationNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "You cannot open this application yet: you hold no role in it.",
};

/**
 * A run that reached a task the platform cannot run yet. It is not a refusal, so the person is
 * never told they lack a permission for it.
 */
const notAvailableNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "This is not available yet.",
};

/** A failed run that committed nothing: the person may simply try again. */
const failedUnchangedNotice: PageMessageDraft = {
  target: "banner",
  severity: "error",
  text: "That did not work, and nothing was saved. Try again.",
};

/** The notice for a finished run: its safe outcome, unless a task was not available. */
export const finishedNotice = (
  outcome: string | undefined,
  failureCode: unknown,
  commit: string | undefined,
): PageMessageDraft =>
  failureCode === "task_not_available"
    ? notAvailableNotice
    : (outcome ?? "failed") === "failed" && commit === "none"
      ? failedUnchangedNotice
      : (outcomeNotices[outcome ?? "failed"] ?? unavailableNotice);

export const refusalNotices: Readonly<
  Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], PageMessageDraft>
> = Object.fromEntries(
  Object.entries(flowRefusalFeedbackSentences).map(([code, text]) => [
    code,
    { target: "banner", severity: "error", text },
  ]),
) as Readonly<Record<Extract<FormFlowFeedback, { kind: "refusal" }>["code"], PageMessageDraft>>;

/** The rule messages a refusal carries: the rule's own words and each field correction's, once each. */
export const ruleMessagesOf = (
  diagnostic: Pick<FlowRefusalFeedback, "ruleRefusal" | "corrections"> | undefined,
): readonly string[] | undefined => {
  const corrections = (diagnostic?.corrections ?? []).flatMap((correction) =>
    correction.message === undefined ? [] : [correction.message],
  );
  const messages = [
    ...new Set([
      ...(diagnostic?.ruleRefusal === undefined ? [] : [diagnostic.ruleRefusal.message]),
      ...corrections,
    ]),
  ];
  return messages.length > 0 ? messages : undefined;
};

/**
 * The one sentence a finished run's outcome is told in, wherever the run was started: the page
 * runtime and Studio's editor both use it. A refusal carries its own wording and, when the flow
 * names one, a link to where the person can put it right. A proof that ran out is not a link away:
 * the flow's own Verify step asks for it again when the person starts the action again.
 */
export const finishedRunNotice = (
  run: Readonly<{
    descriptor: Readonly<{ outcome: string; commit: string }>;
    failure?: Readonly<{ code: string; diagnostic?: FlowRefusalFeedback }> | undefined;
  }>,
  where: Readonly<{
    destinationHref: (applicationKey: string, pageKey: string) => string;
  }>,
): PageMessageDraft => {
  let notice = finishedNotice(run.descriptor.outcome, run.failure?.code, run.descriptor.commit);
  const diagnostic = run.failure?.diagnostic;
  if (diagnostic !== undefined) {
    const recovery =
      run.descriptor.outcome === "partial" || run.descriptor.outcome === "uncertain"
        ? run.descriptor.outcome
        : undefined;
    const ruleMessages = ruleMessagesOf(diagnostic);
    const reason: PageMessageDraft =
      ruleMessages === undefined
        ? refusalNotices[diagnostic.code]
        : { target: "banner", severity: "error", text: ruleMessages.join(" ") };
    const presentation = diagnostic.presentation;
    notice = {
      ...reason,
      ...(presentation?.link_label === undefined || presentation.destination === undefined
        ? {}
        : {
            action: {
              kind: "link" as const,
              label: presentation.link_label,
              href: where.destinationHref(
                presentation.destination.application_key,
                presentation.destination.page_key,
              ),
            },
          }),
      text:
        recovery === undefined
          ? (presentation?.message ?? reason.text)
          : `${presentation?.message ?? reason.text} ${notice.text}`,
    };
  }
  return notice;
};
