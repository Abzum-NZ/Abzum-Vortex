"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { describeFailure, sameId } from "@vortex/platform/schema";
import {
  createFlowInvokeClient,
  createFlowRuntime,
  createFlowRuntimeState,
  useFlowIntentHost,
  type FlowDispatchResult,
  type FlowMessageIntent,
  type LinkNavigationEnvironment,
  type PlacementFlowBinding,
} from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { DialogFooter } from "@vortex/ui/components/dialog";
import { toast } from "@vortex/ui/components/sonner";
import { noteCommittedWrite, useNavigator } from "@vortex/ui/routing";
import { applicationPageAddressPath } from "../../_lib/address-paths";
import { bindingCallerInputs } from "../../_lib/binding-caller-inputs";
import type { StudioActionFlows } from "../../_lib/studio-action-flows";
import type { StudioActionToken } from "../../_lib/studio-action-tokens";
import { resolveApplicationPagePathAction } from "../../[tenantShortName]/[organizationShortName]/[applicationKey]/frame-actions";
import { finishedRunNotice } from "../../[tenantShortName]/[organizationShortName]/[applicationKey]/[[...pageAddress]]/_components/application-page-view/notices";
import { readStudioActionFlows } from "../action-flow-actions";
import { studioNotice } from "./studio-save-state";

/** One problem at a time: a new action clears the last one's notice, which stays until it is read. */
const noticeId = "studio-action-flow";
const tell = (message: string, link?: Readonly<{ label: string; href: string }>): void => {
  studioNotice(message, "error", link, { id: noticeId });
};

const notAvailable = "That is not available right now. Your changes are kept. Try again shortly.";

/** What each action is called in a sentence that says the person may not do it. */
const refusedSentence: Readonly<Record<StudioActionToken, string>> = {
  publish: "You cannot publish this application: you need permission to publish versions.",
  install: "You cannot install or upgrade this application here.",
};

/**
 * Starts the App Store's action flows over the editor: Publish and Install or upgrade. They are
 * the very flows the App Store's own page runs, through the same flow endpoint and with the same
 * dialogs (the review, the release note, signing in again, the confirmation), so the builder never
 * leaves the editor and the editor keeps its selection, tab and undo history. The page that owns
 * the flows is read when an action starts, so each run sees the bindings and record as they are
 * now; the endpoint decides the person's access again on every request.
 */
export function useStudioActionFlows({
  organizationId,
  rootId,
  hold,
  onCommitted,
}: Readonly<{
  organizationId: string;
  rootId: string;
  /** Holds the draft while a flow runs, so nothing edits it meanwhile. */
  hold: (on: boolean) => void;
  /** A flow committed a change: the editor's own reads of the release standing are now old. */
  onCommitted: (action: StudioActionToken | undefined) => void;
}>): Readonly<{
  start: (action: StudioActionToken) => Promise<boolean>;
  /** The action whose page is being read before its first dialog opens. */
  pending: StudioActionToken | undefined;
  element: ReactElement;
  banner: ReactElement;
}> {
  const navigator = useNavigator();
  const runtimeState = useMemo(() => createFlowRuntimeState(), []);
  const [pending, setPending] = useState<StudioActionToken | undefined>(undefined);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = useRef({ hold, onCommitted });
  latest.current = { hold, onCommitted };
  const active = useRef<
    | {
        flows: StudioActionFlows;
        runtime: ReturnType<typeof createFlowRuntime>;
        action: StudioActionToken | undefined;
      }
    | undefined
  >(undefined);

  // Two runs can overlap for a moment (a message action starts as the dialog that offered it closes).
  const holding = useRef(0);
  const holdDraft = useCallback((on: boolean): void => {
    holding.current += on ? 1 : -1;
    latest.current.hold(holding.current > 0);
  }, []);

  const addressOf = useCallback((applicationKey: string, pageKey: string): string | undefined => {
    const flows = active.current?.flows;
    return flows === undefined
      ? undefined
      : applicationPageAddressPath(
          flows.address.tenantShortName,
          flows.address.organizationShortName,
          applicationKey,
          pageKey,
        );
  }, []);

  /** Tells the person how a run came out; a run that finished well says so through its own steps. */
  const report = useCallback(
    (result: FlowDispatchResult, action: StudioActionToken | undefined): void => {
      switch (result.kind) {
        case "finished": {
          if (result.descriptor.commit === "confirmed" || result.descriptor.commit === "partial") {
            noteCommittedWrite();
            latest.current.onCommitted(action);
          }
          if (["completed", "committed"].includes(result.descriptor.outcome) && !result.failure)
            return;
          const notice = finishedRunNotice(result, {
            destinationHref: (applicationKey, pageKey) =>
              addressOf(applicationKey, pageKey) ?? window.location.pathname,
            // Signing in again comes back to this editor, on this tab.
            continuation: JSON.stringify({
              kind: "studio",
              address: `${window.location.pathname}${window.location.search}`,
            }),
          });
          tell(
            notice.text,
            notice.action?.kind === "link"
              ? { label: notice.action.label, href: notice.action.href }
              : undefined,
          );
          return;
        }
        case "reload":
          tell("Studio changed while you worked. Reload this page and try again.");
          return;
        case "unknown":
          tell("The outcome is not known. Check the Releases tab before trying again.");
          return;
        case "refused":
          tell(result.reason ?? notAvailable);
          return;
        case "unavailable":
        case "cells_refused":
          tell(notAvailable);
          return;
        case "skipped":
        case "abandoned":
          return;
      }
    },
    [addressOf],
  );

  const navigation = useMemo<LinkNavigationEnvironment>(
    () => ({
      resolveTarget: async (target) => {
        const flows = active.current?.flows;
        if (flows === undefined) return undefined;
        const parameters = new URLSearchParams();
        for (const [name, value] of Object.entries(target.parameters ?? {}))
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            parameters.set(name, String(value));
        const query = parameters.toString();
        const { tenantShortName, organizationShortName } = flows.address;
        const path =
          target.applicationKey === undefined
            ? (() => {
                const page = flows.pages.find((entry) => sameId(entry.pageId, target.page));
                return page === undefined
                  ? undefined
                  : applicationPageAddressPath(
                      tenantShortName,
                      organizationShortName,
                      flows.address.applicationKey,
                      page.key,
                    );
              })()
            : await resolveApplicationPagePathAction(
                tenantShortName,
                organizationShortName,
                target.applicationKey,
                target.page,
              ).catch((error: unknown) => {
                console.error(
                  `[studio] navigate target could not be resolved: ${describeFailure(error)}`,
                );
                return undefined;
              });
        if (path === undefined) {
          tell(notAvailable);
          return undefined;
        }
        return `${path}${query === "" ? "" : `?${query}`}`;
      },
      navigate: (path) => {
        noteCommittedWrite();
        navigator.navigate(path);
      },
    }),
    [navigator],
  );

  const messageActionRef = useRef<(message: FlowMessageIntent) => void>(() => undefined);
  const { host, element, banner } = useFlowIntentHost({
    // Every form a flow shows here declares its own fields; none is a form placed on a page.
    renderForm: (form, controls) => ({
      title: "Form unavailable",
      body: (
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              console.error(`[studio] action flow names page form '${form.formId}'`);
              controls.cancel();
            }}
          >
            Cancel
          </Button>
        </DialogFooter>
      ),
    }),
    navigation,
    state: runtimeState,
    onMessageAction: (message) => messageActionRef.current(message),
  });

  // A message's action (Install or upgrade, after a publish) runs the flow it names through the
  // binding the page derived for it.
  messageActionRef.current = (message) => {
    const current = active.current;
    if (current === undefined) return;
    const all = Object.values(current.flows.bindings).flat();
    const source = all.find((binding) => binding.bindingId === message.originBindingId);
    const authoredId = source?.messageAction?.authoredBindingId ?? source?.bindingId;
    const action = all.find(
      (binding) =>
        authoredId !== undefined &&
        binding.messageAction !== undefined &&
        binding.messageAction.authoredBindingId === authoredId &&
        binding.messageAction.sourceFlowId === message.sourceFlowId &&
        binding.messageAction.taskId === message.taskId &&
        binding.flowId === message.actionFlow,
    );
    if (action === undefined) {
      console.error("[studio] message action binding unavailable");
      tell(notAvailable);
      return;
    }
    holdDraft(true);
    void current.runtime
      .dispatch(
        action,
        message.actionInputs,
        crypto.randomUUID(),
        message.subject ?? current.flows.subject,
        message.sourceTablePlacementId,
      )
      .then((result) => report(result, "install"))
      .catch((error: unknown) => {
        console.error(`[studio] action flow failed: ${describeFailure(error)}`);
        tell(notAvailable);
      })
      .finally(() => holdDraft(false));
  };

  const start = useCallback(
    async (action: StudioActionToken): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      toast.dismiss(noticeId);
      let started = false;
      setPending(action);
      try {
        const read = await readStudioActionFlows(organizationId, rootId).catch((error: unknown) => {
          console.error(`[studio] action flows read failed: ${describeFailure(error)}`);
          return undefined;
        });
        if (read?.kind !== "available") {
          tell(notAvailable);
          return false;
        }
        const { flows } = read;
        const target = flows.startable[action];
        const binding: PlacementFlowBinding | undefined =
          target === undefined
            ? undefined
            : flows.bindings[target.placementId]?.find(
                (held) => held.bindingId === target.bindingId,
              );
        if (binding === undefined) {
          tell(refusedSentence[action]);
          return false;
        }
        const all = Object.values(flows.bindings).flat();
        const settings = new Map(
          all.map((held) => [
            held.bindingId,
            {
              controlId: held.controlId,
              concurrency: held.settings.concurrency,
              condition: held.settings.condition,
              debounceMs: held.settings.debounceMs,
              exclusive: held.settings.exclusive,
              timeoutMs: held.settings.timeoutMs,
              event: held.event,
              flowName: held.flowName,
              controlName: held.controlName,
              ...(held.formId === undefined ? {} : { formId: held.formId }),
              ...(held.agentConfirmation === true ? { agentConfirmation: true } : {}),
            },
          ]),
        );
        const browser = new Map(
          all.flatMap((held) =>
            held.browser === undefined ? [] : [[held.bindingId, held.browser] as const],
          ),
        );
        const client = createFlowInvokeClient(
          {
            address: flows.address,
            pageInputs: () => ({ parameters: flows.pageParameters, controls: {} }),
            subject: flows.subject,
          },
          async () => (loaded) => loaded,
        );
        const runtime = createFlowRuntime({
          client,
          host,
          state: runtimeState,
          bindingSettings: (bindingId) => settings.get(bindingId),
          browserBinding: (bindingId) => browser.get(bindingId),
          subject: flows.subject,
          ...(flows.flowTimeZone === undefined ? {} : { timeZone: flows.flowTimeZone }),
        });
        active.current = { flows, runtime, action };
        // The flow runs on while the person answers its dialogs; this call is done once it has started.
        holdDraft(true);
        void runtime
          .dispatch(
            binding,
            bindingCallerInputs(binding, { record_id: rootId }, rootId),
            crypto.randomUUID(),
            flows.subject,
          )
          .then((result) => report(result, action))
          .catch((error: unknown) => {
            console.error(`[studio] action flow failed: ${describeFailure(error)}`);
            tell(notAvailable);
          })
          .finally(() => {
            holdDraft(false);
            running.current = false;
          });
        started = true;
        return true;
      } catch (error) {
        console.error(`[studio] action flow failed: ${describeFailure(error)}`);
        tell(notAvailable);
        return false;
      } finally {
        if (!started) running.current = false;
        if (mounted.current) setPending(undefined);
      }
    },
    [organizationId, rootId, host, runtimeState, report, holdDraft],
  );

  return { start, pending, element, banner };
}
