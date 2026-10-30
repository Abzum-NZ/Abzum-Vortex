import "server-only";

import type { HumanOrganizationRequestDependencies } from "../access/human-organization-request";
import { openBackendActorScope } from "../definition/flow-background-run";
import type { FlowDefinition } from "../workflows/flow-contracts";
import type { BackendAdapter } from "../workflows/backend-adapters";
import type { EventConsumerAdapter } from "./dispatcher";
import { eventOccurrenceEnvelopeSchema } from "./occurrence-contracts";

/** The record type and event an occurrence is about: all a subscriber is matched on. */
type OccurrenceEvent = Readonly<{ recordTypeId: string }> &
  (Readonly<{ kind: "standard"; eventKind: string }> | Readonly<{ kind: "declared"; key: string }>);

/** Whether an Event-triggered back-end flow subscribes to this record type and event. */
export const subscribes = (flow: FlowDefinition, descriptor: OccurrenceEvent): boolean =>
  flow.execution === "background" &&
  flow.triggers.some(
    (trigger) =>
      trigger.type === "Event" &&
      trigger.recordTypeId.toLowerCase() === descriptor.recordTypeId.toLowerCase() &&
      (descriptor.kind === "standard"
        ? trigger.event.kind === "standard" && trigger.event.eventKind === descriptor.eventKind
        : trigger.event.kind === "declared" && trigger.event.eventKey === descriptor.key),
  );

/**
 * Orders subscribers so each runs after the subscribers it names, otherwise in flow order. Publish
 * refuses a cycle; a flow left over is still run, last, rather than dropped.
 */
export const orderSubscribers = (flows: readonly FlowDefinition[]): FlowDefinition[] => {
  const byId = new Map(flows.map((flow) => [flow.id.toLowerCase(), flow]));
  const ordered: FlowDefinition[] = [];
  const placed = new Set<string>();
  const place = (flow: FlowDefinition, visiting: ReadonlySet<string>): void => {
    const key = flow.id.toLowerCase();
    if (placed.has(key) || visiting.has(key)) return;
    const next = new Set(visiting).add(key);
    for (const trigger of flow.triggers) {
      if (trigger.type !== "Event") continue;
      for (const afterId of trigger.runAfter ?? []) {
        const earlier = byId.get(afterId.toLowerCase());
        if (earlier !== undefined) place(earlier, next);
      }
    }
    placed.add(key);
    ordered.push(flow);
  };
  for (const flow of flows) place(flow, new Set());
  return ordered;
};

/**
 * Runs the after-save subscribers of one committed occurrence, each once, as the account that made
 * the change. A subscriber's result is its own row in the back-end run history, so a re-delivered
 * occurrence skips what finished and one subscriber failing never stops the others.
 */
export const createFlowSubscriberConsumer = (
  dependencies: Readonly<{
    requests: () => HumanOrganizationRequestDependencies;
    adapter: () => BackendAdapter;
  }>,
): EventConsumerAdapter => ({
  consumerKey: "flow-subscribers",
  policy: { leaseSeconds: 120, maxAttempts: 5, retryBackoffSeconds: 30 },
  async deliver(delivery) {
    const occurrence = eventOccurrenceEnvelopeSchema.safeParse(delivery.occurrence);
    if (!occurrence.success) return { outcome: "completed" };
    const { organizationId, installation, actorId, recordId, occurrenceId } = occurrence.data;
    const opened = await openBackendActorScope(
      dependencies.requests(),
      organizationId,
      installation.applicationRootId,
      actorId,
    );
    if ("reason" in opened) {
      // The account's scope is what lists the subscribers, so the history gets one refusal for the
      // whole occurrence, with the named reason.
      try {
        await dependencies.adapter().recordRefusal({
          organizationId,
          applicationRootId: installation.applicationRootId,
          actorId,
          origin: "event",
          sourceKey: occurrenceId,
          failureCode: opened.reason,
        });
      } catch (error) {
        console.error(`[subscribers] refusal of occurrence ${occurrenceId} not recorded`, error);
        return { outcome: "retryable_failure", failureCode: "unclassified" };
      }
      return { outcome: "completed" };
    }
    const subscribers = orderSubscribers(
      [...opened.release.flows.values()].filter((flow) =>
        subscribes(flow, occurrence.data.descriptor),
      ),
    );
    const adapter = dependencies.adapter();
    let infrastructureFailed = false;
    for (const flow of subscribers) {
      try {
        const backendRunId = await adapter.enqueue({
          organizationId,
          applicationRootId: installation.applicationRootId,
          actorId,
          flowId: flow.id,
          origin: "event",
          sourceKey: occurrenceId,
          mode: "start",
          inputs: { recordId, occurrenceId },
        });
        await adapter.runRecorded(backendRunId);
      } catch (error) {
        // A subscriber that could not be recorded or settled is retried with the delivery; the
        // others still ran.
        infrastructureFailed = true;
        console.error(`[subscribers] flow ${flow.id} for occurrence ${occurrenceId} failed`, error);
      }
    }
    return infrastructureFailed
      ? { outcome: "retryable_failure", failureCode: "unclassified" }
      : { outcome: "completed" };
  },
});
